// Prints the summary table for one or more results files.
//
//   node bench/github-status/report.mjs <results.json> [more.json ...]
import fs from "node:fs";
import { percentile } from "./lib.mjs";

const fmt = (value) => (value === null || value === undefined ? "-" : String(value));

/** Rows of [scenario, case, surface, n, p50, max, timeouts, already shown, disagreement p50/max]. */
function lagRows(scenario, results, capS) {
  const rows = [];
  const groups = new Map();
  const add = (caseName, surface, lag, alreadyShown, disagreementS, note) => {
    const key = `${caseName}\u0000${surface}`;
    const group = groups.get(key) ?? {
      caseName,
      surface,
      lags: [],
      timeouts: 0,
      pre: 0,
      disagreements: [],
      notes: {},
    };
    if (note) group.notes[note] = (group.notes[note] ?? 0) + 1;
    if (alreadyShown) group.pre += 1;
    else if (lag === null) group.timeouts += 1;
    else group.lags.push(lag);
    if (disagreementS !== undefined) group.disagreements.push(disagreementS);
    groups.set(key, group);
  };
  for (const run of results.runs ?? []) {
    for (const flip of run.flips ?? []) {
      for (const [name, lag] of Object.entries(flip.lags)) {
        add(flip.flip, name, lag, flip.alreadyShown.includes(name), flip.disagreementS);
      }
    }
    if (run.lagsAfterReturn) {
      for (const [name, lag] of Object.entries(run.lagsAfterReturn)) {
        add(
          `${run.mode}: open→merged, after return`,
          name,
          lag,
          false,
          run.disagreementAfterReturnS,
          run.caughtUpWhileAway.includes(name) ? "caught up while away" : null,
        );
      }
    }
    if (run.kind === "cold") {
      add("cold: new thread ↓N, from pick", "header", run.lagS, false, undefined);
      add("cold: ↓N, from adding the project", "header", run.lagFromCreationS, false, undefined);
    }
    if (run.kind === "warm" || run.kind === "watched") {
      const caseName =
        run.kind === "warm"
          ? "warm: new thread ↓N, from pick"
          : "watched: new thread ↓N, from push";
      if (run.valid) add(caseName, "header", run.lagS, false, undefined);
      else add(caseName, "header", null, false, undefined, "invalid");
    }
  }
  for (const group of groups.values()) {
    const n = group.lags.length + group.timeouts + group.pre;
    rows.push([
      scenario,
      group.caseName,
      group.surface,
      n,
      fmt(percentile(group.lags, 50)),
      group.timeouts > 0 ? `>${capS} (${group.timeouts} never)` : fmt(percentile(group.lags, 100)),
      [
        group.pre > 0 ? `${group.pre} shown before` : "",
        ...Object.entries(group.notes).map(([note, count]) => `${count} ${note}`),
      ]
        .filter(Boolean)
        .join(", "),
      group.disagreements.length > 0
        ? `${fmt(percentile(group.disagreements, 50))} / ${fmt(percentile(group.disagreements, 100))}`
        : "",
    ]);
  }
  return rows;
}

function table(header, rows) {
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => String(row[index]).length)),
  );
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ");
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}

export function printSummary(results) {
  const out = [];
  out.push(
    `GitHub status benchmark  ${results.meta?.commit ?? ""}  ${results.meta?.startedAt ?? ""}`,
  );
  out.push(`options: ${JSON.stringify(results.meta?.options ?? {})}`);
  const lagTable = [];
  for (const [scenario, value] of Object.entries(results.scenarios ?? {})) {
    if (scenario === "E") continue;
    lagTable.push(...lagRows(scenario, value, results.meta?.options?.capSeconds ?? "cap"));
  }
  if (lagTable.length > 0) {
    out.push("");
    out.push(
      "Lag in seconds from the change on GitHub (C: from attention coming back; D: from picking the project).",
    );
    out.push(
      table(
        ["scn", "case", "surface", "n", "p50 s", "max s", "notes", "disagree s p50/max"],
        lagTable,
      ),
    );
  }
  const f = results.scenarios?.F;
  if (f) {
    const wrong = f.runs.flatMap((run) =>
      run.wrongStates.map((change) => ({ number: run.number, ...change })),
    );
    out.push("");
    out.push(
      `F: ${wrong.length} times a surface showed a state its own pull request had not had by then.`,
    );
    for (const change of wrong.slice(0, 20))
      out.push(
        `  #${change.number} phase ${change.phase}: ${change.surface} = ${change.value} at ${change.s}s`,
      );
    for (const run of f.runs) {
      out.push(
        `  #${run.number}: beta's composer row right after opening its thread ${fmt(run.betaComposer?.convergedS)} s, alpha's again ${fmt(run.alphaComposerAgain?.convergedS)} s ("-" = not within 90 s)`,
      );
    }
  }
  const e = results.scenarios?.E;
  if (e) {
    out.push("");
    out.push(
      "E: gh runs per minute by kind (steady window; the first window of each mode is listed apart).",
    );
    const rows = [];
    for (const phase of e.phases) {
      const first = phase.startup ?? phase.transition;
      const firstName = phase.startup ? "startup" : "transition";
      rows.push([
        phase.mode,
        `${firstName} (${first.minutes} min)`,
        first.totalPerMinute,
        kindsText(first.perMinute),
      ]);
      rows.push([
        phase.mode,
        `steady (${phase.steady.minutes} min)`,
        phase.steady.totalPerMinute,
        kindsText(phase.steady.perMinute),
      ]);
      rows.push([phase.mode, "git fetches/min (steady)", phase.fetchesPerMinute, ""]);
    }
    out.push(table(["mode", "window", "gh/min", "by kind"], rows));
  }
  if (results.ghCallsTotal !== undefined) {
    out.push("");
    out.push(
      `gh calls: ${results.ghCallsTotal}; failed (gh's own errors): ${results.failedGhCalls?.length ?? 0}; unfinished: ${results.unfinishedGhCalls?.length ?? 0}; refused ssh: ${results.refusedSsh?.length ?? 0}`,
    );
  }
  if (results.unknownGhCalls?.length) {
    out.push("");
    out.push(`UNKNOWN gh requests: ${results.unknownGhCalls.length}`);
    for (const call of results.unknownGhCalls.slice(0, 10))
      out.push(`  ${call.args.join(" ")}  (${call.error})`);
  }
  return out.join("\n");
}

function kindsText(perMinute) {
  return Object.entries(perMinute)
    .map(([kind, rate]) => `${kind} ${rate}`)
    .join(", ");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const file of process.argv.slice(2)) {
    console.log(printSummary(JSON.parse(fs.readFileSync(file, "utf8"))));
    console.log("");
  }
}

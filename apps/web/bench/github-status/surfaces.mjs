// Reading what each surface shows for one pull request, and timing how long
// each takes to show a change. Everything is read from what is on screen: the
// shared state colours (`pullRequestBadgeTone`), the sidebar badge's label,
// and the composer checks chip's word and dot.
import { sleep } from "./lib.mjs";

/**
 * Runs in the page. `targets` names one pull request: its number, its address
 * (for the chat chip) and the thread whose sidebar row carries its badge.
 * Each surface reads as a state word or null when it is not on screen:
 * open, draft, merged, closed, auto-merge, or unknown (the muted glyph a chip
 * wears before anything has listed its repository).
 */
function readSurfacesInPage(targets) {
  const toneOf = (className) => {
    const classes = ` ${className ?? ""} `;
    if (classes.includes(" text-violet-600 ")) return "merged";
    if (classes.includes(" text-zinc-500 ")) return "closed";
    if (classes.includes(" text-muted-foreground/60 ")) return "draft";
    if (classes.includes(" text-amber-600/90 ")) return "auto-merge";
    if (classes.includes(" text-emerald-600 ")) return "open";
    if (classes.includes(" text-muted-foreground ")) return "unknown";
    return `?${className}`;
  };
  const out = {};
  for (const target of targets) {
    const entry = {};
    // The composer row: the number's glyph and the checks chip.
    entry.composer = null;
    entry.checks = null;
    if (target.composer) {
      const rows = [...document.querySelectorAll("[data-composer-pull-request-row]")].filter(
        (row) => row.querySelector(`button[aria-label="Open pull request #${target.number}"]`),
      );
      // Rows are told apart only by number; two with this one is worth seeing.
      if (rows.length > 1) entry.composerRows = rows.length;
      const row = rows[0];
      if (row) {
        const open = row.querySelector(`button[aria-label="Open pull request #${target.number}"]`);
        entry.composer = toneOf(open.querySelector("svg")?.getAttribute("class"));
        const chip = row.querySelector('[class*="h-[22px]"]');
        if (chip) {
          const label = chip.textContent.trim();
          const dot = chip.querySelector('[class*="size-[7px]"]')?.getAttribute("class") ?? "";
          if (label === "CI") {
            entry.checks = dot.includes("bg-amber")
              ? "pending"
              : dot.includes("bg-success")
                ? "success"
                : dot.includes("bg-destructive")
                  ? "failure"
                  : "unknown";
          } else {
            entry.checks = label.toLowerCase().replace(/\s+/gu, "-");
          }
        }
      }
    }
    // The sidebar badge on the thread's row (live, or under Wrapped once the
    // thread is filed there); its label names the state in words.
    entry.sidebar = null;
    entry.sidebarSection = null;
    if (target.threadId) {
      let row = document.querySelector(`[data-testid="thread-row-${target.threadId}"]`);
      if (row) entry.sidebarSection = "active";
      if (!row) {
        row = document.querySelector(`[data-testid="done-row-${target.threadId}"]`);
        if (row) entry.sidebarSection = "wrapped";
      }
      if (!row) {
        // A wrapped thread that is not open in the chat only has a row while
        // the Wrapped shelf is open (the app remembers it open), and a long
        // list folds its tail behind "Show N more…". Uncover both.
        for (const selector of [
          '[data-testid="inbox-done-toggle"][aria-expanded="false"]',
          '[data-testid="inbox-live-show-more"]',
          '[data-testid="inbox-done-show-more"]',
        ]) {
          document.querySelector(selector)?.click();
        }
      }
      const badge = row?.querySelector('[data-testid="inbox-thread-pr-badge"]');
      if (badge) {
        const label = badge.getAttribute("aria-label") ?? "";
        const own = label.split("; ").find((part) => part.startsWith(`#${target.number} `)) ?? "";
        const word = / PR ([a-z-]+):/u.exec(own)?.[1] ?? null;
        entry.sidebar = word === null ? `?${label}` : word;
        entry.sidebarLead = badge.textContent.trim();
      } else {
        entry.sidebar = row ? "none" : null;
      }
    }
    // The chat chip for the pull request's address.
    entry.chip = null;
    if (target.url) {
      const chips = [...document.querySelectorAll(".chat-markdown-pull-request-chip")].filter(
        (chip) => chip.getAttribute("href") === target.url,
      );
      if (chips.length > 0) {
        const states = [
          ...new Set(chips.map((chip) => toneOf(chip.querySelector("svg")?.getAttribute("class")))),
        ];
        entry.chip = states.length === 1 ? states[0] : states.join("|");
      }
    }
    out[target.key] = entry;
  }
  return out;
}

export function readSurfaces(page, targets) {
  return page.evaluate(readSurfacesInPage, targets);
}

/**
 * Samples every surface every `sampleMs` from `t0`. `expect` is keyed by
 * `<target key>.<surface>`. Stops once every expected surface has shown its
 * value for `holdMs` without going back (or, with `fixedDuration`, only at the
 * cap), or at `capMs`. A surface's lag is when it last arrived at its value
 * and stayed (null when it is not there at the end). Also returns the time
 * any two state surfaces of one target disagreed, and every change seen.
 */
export async function watchUntil(
  page,
  { targets, expect, t0, capMs, sampleMs = 250, holdMs = 10_000, fixedDuration = false },
) {
  const lags = Object.fromEntries(Object.keys(expect).map((key) => [key, null]));
  const changes = [];
  const last = {};
  let disagreementMs = 0;
  let previousAt = null;
  let previousDisagreed = false;
  let doneSince = null;
  let sample = null;
  let lastReadAt = t0;
  const arrivedAt = {};
  const seconds = (at) => Number(((at - t0) / 1000).toFixed(2));
  while (true) {
    const at = Date.now();
    try {
      sample = await readSurfaces(page, targets);
    } catch (error) {
      // Nothing is known for this moment: the hold starts over after it.
      changes.push({ s: seconds(at), error: String(error).slice(0, 200) });
      doneSince = null;
      previousAt = null;
      if (at - t0 >= capMs) break;
      await sleep(sampleMs);
      continue;
    }
    lastReadAt = at;
    if (previousAt !== null && previousDisagreed) disagreementMs += at - previousAt;
    previousDisagreed = false;
    for (const [key, surfaces] of Object.entries(sample)) {
      for (const [surface, value] of Object.entries(surfaces)) {
        const name = `${key}.${surface}`;
        if (last[name] !== value) {
          changes.push({ s: seconds(at), surface: name, value });
          last[name] = value;
        }
        if (!(name in expect)) continue;
        if (lags[name] === null && value === expect[name]) {
          lags[name] = seconds(at);
          arrivedAt[name] = at;
        } else if (lags[name] !== null && value !== expect[name]) {
          // Went back after getting there: it only counts once it stays.
          lags[name] = null;
          changes.push({ s: seconds(at), surface: name, regressed: value });
        }
      }
      const shown = ["composer", "sidebar", "chip"]
        .map((surface) => surfaces[surface])
        .filter((value) => value !== null && value !== "unknown" && value !== "none");
      if (new Set(shown).size > 1) previousDisagreed = true;
    }
    previousAt = at;
    const done = Object.values(lags).every((lag) => lag !== null);
    doneSince = done ? (doneSince ?? at) : null;
    if (at - t0 >= capMs) break;
    if (!fixedDuration && done && at - doneSince >= holdMs) break;
    await sleep(Math.max(0, sampleMs - (Date.now() - at)));
  }
  // An arrival the cap cut short of its hold is not proven to stay.
  for (const name of Object.keys(lags)) {
    if (lags[name] !== null && lastReadAt - arrivedAt[name] < holdMs) {
      lags[name] = null;
      changes.push({ s: seconds(lastReadAt), surface: name, unconfirmedAtCap: true });
    }
  }
  return {
    lags,
    disagreementS: Number((disagreementMs / 1000).toFixed(2)),
    final: sample,
    changes,
    timedOut: Object.values(lags).some((lag) => lag === null),
  };
}

/** Waits until every listed surface shows its value; returns what it last read. */
export async function waitForSurfaces(page, { targets, expect, timeoutMs = 120_000 }) {
  const t0 = Date.now();
  const result = await watchUntil(page, {
    targets,
    expect,
    t0,
    capMs: timeoutMs,
    sampleMs: 500,
    holdMs: 2_000,
  });
  return { ...result, waitedS: Number(((Date.now() - t0) / 1000).toFixed(1)) };
}

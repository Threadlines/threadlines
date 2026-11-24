// @effect-diagnostics nodeBuiltinImport:off - a maintenance script with no Effect
// runtime; it shells out to gh and reads and writes files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Rewrites a sharded suite's weights (see scripts/lib/test-shards.ts) from the
 * per-file timings its CI shards uploaded. Reads the newest three green CI runs
 * on main (or the run ids given after the suite) and keeps each file's median,
 * since one file's time can swing by a third between runs; files missing from
 * the newest run are dropped. Local runs make poor weights: the server's
 * git-heavy files run several times slower on a Mac than on CI's Linux
 * runners. Needs a signed-in `gh`.
 *
 * Run with `node --run test:shard-weights -- <server|browser> [run-id ...]`.
 */

const SUITES = {
  server: { artifacts: "server-test-timings-*", weights: "apps/server/vitest.shard-weights.json" },
  browser: {
    artifacts: "browser-test-timings-*",
    weights: "apps/web/vitest.browser.shard-weights.json",
  },
} as const;
const TIMINGS_FILE = "test-timings.json";
const RUNS_TO_READ = 3;

const suiteName = process.argv[2];
if (suiteName !== "server" && suiteName !== "browser") {
  throw new Error("Usage: node --run test:shard-weights -- <server|browser> [run-id ...]");
}
const suite = SUITES[suiteName];
const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));

const gh = (args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("gh", args, { cwd: repoRoot, encoding: "utf8" }).trim();

const CANDIDATE_RUNS_PER_EVENT = 15;

type ListedRun = {
  readonly databaseId: number;
  readonly createdAt: string;
  readonly headSha: string;
  readonly headBranch: string;
};

const isOnOriginMain = (sha: string): boolean => {
  const result = NodeChildProcess.spawnSync(
    "git",
    ["merge-base", "--is-ancestor", sha, "origin/main"],
    {
      cwd: repoRoot,
      stdio: "ignore",
    },
  );
  return result.status === 0;
};

const givenRunIds = process.argv.slice(3);
let candidates: ReadonlyArray<{ readonly runId: string; readonly headSha?: string }>;
if (givenRunIds.length > 0) {
  candidates = givenRunIds.map((runId) => ({ runId }));
} else {
  // Fetch origin/main so we only sample merge_group runs whose commit actually
  // landed on main (ignoring green queue runs that were later dequeued).
  NodeChildProcess.execFileSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: repoRoot });

  const listRuns = (extraArgs: ReadonlyArray<string>): ReadonlyArray<ListedRun> =>
    JSON.parse(
      gh([
        "run",
        "list",
        "--workflow=ci.yml",
        "--status=success",
        `--limit=${CANDIDATE_RUNS_PER_EVENT}`,
        "--json=databaseId,createdAt,headSha,headBranch",
        ...extraArgs,
      ]),
    ) as ReadonlyArray<ListedRun>;

  // Query merge_group and main push separately so PR runs never crowd them out.
  candidates = [
    ...listRuns(["--event=merge_group"]).filter(
      (run) => run.headBranch.startsWith("gh-readonly-queue/main/") && isOnOriginMain(run.headSha),
    ),
    ...listRuns(["--branch=main", "--event=push"]),
  ]
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((run) => ({ runId: String(run.databaseId), headSha: run.headSha }));
}
if (candidates.length === 0) {
  throw new Error("Found no green CI run on main or landed merge_group to read test timings from.");
}

const downloadDir = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "threadlines-shard-weights-"),
);
// One map of file -> seconds per run, newest run first.
const runs: Array<Map<string, number>> = [];
const sampledShas = new Set<string>();
try {
  for (const { runId, headSha } of candidates) {
    if (givenRunIds.length === 0 && runs.length >= RUNS_TO_READ) {
      break;
    }
    if (headSha && sampledShas.has(headSha)) {
      continue;
    }
    const runDir = NodePath.join(downloadDir, runId);
    try {
      gh(["run", "download", runId, `--pattern=${suite.artifacts}`, `--dir=${runDir}`]);
    } catch (error) {
      // Skipped push runs on main upload no timings artifacts; keep scanning
      // unless the caller explicitly asked for this run id.
      if (givenRunIds.length > 0) {
        throw error;
      }
      continue;
    }
    const reports = NodeFS.readdirSync(runDir, { recursive: true, encoding: "utf8" }).filter(
      (entry) => NodePath.basename(entry) === TIMINGS_FILE,
    );
    if (reports.length === 0) {
      if (givenRunIds.length > 0) {
        throw new Error(`CI run ${runId} has no ${suiteName} test timings.`);
      }
      continue;
    }
    const timings = new Map<string, number>();
    for (const entry of reports) {
      const report: Record<string, number> = JSON.parse(
        NodeFS.readFileSync(NodePath.join(runDir, entry), "utf8"),
      );
      for (const [file, seconds] of Object.entries(report)) timings.set(file, seconds);
    }
    runs.push(timings);
    if (headSha) {
      sampledShas.add(headSha);
    }
    console.log(`Read ${reports.length} shard reports from CI run ${runId}.`);
  }
} finally {
  NodeFS.rmSync(downloadDir, { recursive: true, force: true });
}
if (runs.length === 0) {
  throw new Error(`Found no green CI run with ${suiteName} test timings.`);
}

const median = (values: ReadonlyArray<number>): number => {
  const ordered = values.toSorted((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const value =
    ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
  return Math.round(value * 10) / 10;
};
const [newest, ...older] = runs;
const sorted = [...newest!.keys()].toSorted().map((file) => {
  const samples = [newest!.get(file)!, ...older.flatMap((run) => run.get(file) ?? [])];
  return [file, median(samples)] as const;
});
NodeFS.writeFileSync(
  NodePath.join(repoRoot, suite.weights),
  `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`,
);
console.log(`Recorded ${sorted.length} files in ${suite.weights}.`);

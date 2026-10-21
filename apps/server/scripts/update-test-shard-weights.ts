// @effect-diagnostics nodeBuiltinImport:off - a maintenance script with no Effect
// runtime; it shells out to gh and reads and writes files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Rewrites `test-shard-weights.json` from the server shard timings of a green
 * CI run on main: the newest one, or the run id given as the first argument.
 * Each shard runs its files one at a time, so the gap between consecutive file
 * results is that file's wall time on a CI runner, imports and setup included.
 * Local runs make poor weights: git-heavy files run several times slower on a
 * Mac than on CI's Linux runners. Needs a signed-in `gh`.
 *
 * Run with `node --run test:shard-weights [-- <run-id>]` from apps/server.
 */

interface VitestJsonReport {
  readonly startTime: number;
  readonly testResults: ReadonlyArray<{ readonly name: string; readonly endTime: number }>;
}

const TIMINGS_FILE = "server-test-timings.json";
const SERVER_PATH_MARKER = "/apps/server/";

const serverDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const weightsPath = NodePath.join(serverDir, "scripts/test-shard-weights.json");

const gh = (args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("gh", args, { cwd: serverDir, encoding: "utf8" }).trim();

const runId =
  process.argv[2] ??
  gh([
    "run",
    "list",
    "--workflow=ci.yml",
    "--branch=main",
    "--event=push",
    "--status=success",
    "--limit=1",
    "--json=databaseId",
    "--jq=.[0].databaseId",
  ]);
if (!runId) {
  throw new Error("Found no green CI run on main to read server test timings from.");
}

const downloadDir = NodeFS.mkdtempSync(
  NodePath.join(NodeOS.tmpdir(), "threadlines-shard-weights-"),
);
const weights = new Map<string, number>();
const shardLoads: Array<number> = [];
try {
  gh(["run", "download", runId, "--pattern=server-test-timings-*", `--dir=${downloadDir}`]);
  const reports = NodeFS.readdirSync(downloadDir, { recursive: true, encoding: "utf8" })
    .filter((entry) => NodePath.basename(entry) === TIMINGS_FILE)
    .toSorted();
  if (reports.length === 0) {
    throw new Error(`CI run ${runId} has no server test timings.`);
  }
  for (const entry of reports) {
    const report: VitestJsonReport = JSON.parse(
      NodeFS.readFileSync(NodePath.join(downloadDir, entry), "utf8"),
    );
    let previousEnd = report.startTime;
    for (const file of report.testResults.toSorted((a, b) => a.endTime - b.endTime)) {
      const name = file.name.replaceAll("\\", "/");
      const key = name.slice(name.lastIndexOf(SERVER_PATH_MARKER) + SERVER_PATH_MARKER.length);
      weights.set(key, Math.max(0.1, Math.round((file.endTime - previousEnd) / 100) / 10));
      previousEnd = file.endTime;
    }
    shardLoads.push(Math.round((previousEnd - report.startTime) / 1000));
  }
} finally {
  NodeFS.rmSync(downloadDir, { recursive: true, force: true });
}

const sorted = [...weights].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
NodeFS.writeFileSync(weightsPath, `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`);
console.log(
  `Recorded ${sorted.length} files from CI run ${runId}. Shard times were ${shardLoads.map((s) => `${s}s`).join(", ")}.`,
);

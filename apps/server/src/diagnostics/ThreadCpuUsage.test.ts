import { describe, expect, it } from "vitest";

import type { ProcessRow } from "./ProcessDiagnostics.ts";
import {
  groupProcessRead,
  makeIntervalCpu,
  summarizeGroupedReads,
  type ProcessGroupRead,
  type ProcessOwners,
} from "./ThreadCpuUsage.ts";

const SERVER = 100;
const APP = 50;

const row = (
  pid: number,
  ppid: number,
  cpuPercent: number,
  command: string,
  pgid: number | null = pid,
): ProcessRow => ({
  pid,
  ppid,
  pgid,
  status: "S",
  cpuPercent,
  rssBytes: 1_000 * pid,
  elapsed: "01:00",
  command,
});

const owners = (overrides: Partial<ProcessOwners> = {}): ProcessOwners => ({
  agents: [],
  shared: [],
  shells: [],
  ...overrides,
});

const byKey = (groups: ReadonlyArray<ProcessGroupRead>) =>
  Object.fromEntries(
    groups.map((group) => [
      group.key.kind === "thread"
        ? group.key.threadId
        : group.key.kind === "shared"
          ? `shared:${group.key.provider}`
          : "threadlines",
      {
        cpu: group.cpuPercent,
        pids: group.topProcesses.map((process) => process.pid).toSorted((a, b) => a - b),
      },
    ]),
  );

describe("groupProcessRead", () => {
  const rows = [
    row(1, 0, 0, "launchd"),
    row(APP, 1, 12, "Threadlines"),
    row(51, APP, 20, "Threadlines Helper (Renderer)"),
    row(SERVER, APP, 5, "node server.mjs", APP),
    row(101, SERVER, 1, "git status", SERVER),
    // Thread A: two agents in one room.
    row(200, SERVER, 10, "claude --resume a1"),
    row(201, 200, 300, "npm test", 200),
    row(210, SERVER, 4, "codex app-server"),
    // Agent B, started by a command of agent A's: the nearest tracked agent wins.
    row(220, 201, 7, "claude --resume b1"),
    row(221, 220, 50, "vitest", 220),
    // A browser left behind by agent A's tests, handed to pid 1.
    row(230, 1, 400, "chrome-headless-shell", 200),
    // Agent C exited; what it left in its group still runs, reparented.
    row(240, 1, 90, "playwright worker", 300),
    // OpenCode's one server, for every thread of it.
    row(250, SERVER, 30, "opencode serve"),
    row(251, 250, 15, "bash -c make", 250),
    // A terminal of thread D.
    row(260, SERVER, 0, "/bin/zsh -l"),
    row(261, 260, 80, "cargo build", 260),
    // Not ours.
    row(900, 1, 500, "Spotlight"),
    // The diagnostics query itself.
    row(102, SERVER, 3, "ps -axo pid=,ppid=,pgid=,stat=,pcpu=,rss=,etime=,time=,command="),
  ];
  const tracked = owners({
    agents: [
      { threadId: "thread-a", pid: 200, ownGroup: true, alive: true },
      { threadId: "thread-a", pid: 210, ownGroup: true, alive: true },
      { threadId: "thread-b", pid: 220, ownGroup: true, alive: true },
      { threadId: "thread-c", pid: 300, ownGroup: true, alive: false },
    ],
    shared: [{ provider: "opencode" as never, pid: 250 }],
    shells: [{ threadId: "thread-d", pid: 260 }],
  });

  it("puts every process in one group by who started it", () => {
    const groups = byKey(
      groupProcessRead({ rows, serverPid: SERVER, owners: tracked, includeAppProcesses: true }),
    );
    expect(groups).toEqual({
      threadlines: { cpu: 12 + 20 + 5 + 1, pids: [APP, 51, SERVER, 101] },
      "thread-a": { cpu: 10 + 300 + 4 + 400, pids: [200, 201, 210, 230] },
      "thread-b": { cpu: 7 + 50, pids: [220, 221] },
      "thread-c": { cpu: 90, pids: [240] },
      "shared:opencode": { cpu: 30 + 15, pids: [250, 251] },
      "thread-d": { cpu: 80, pids: [260, 261] },
    });
  });

  it("keeps a tracked agent that left the server's tree, and drops a reused group id", () => {
    const groups = byKey(
      groupProcessRead({
        rows: [
          row(SERVER, APP, 5, "node server.mjs", APP),
          row(200, SERVER, 10, "claude --resume a1"),
          // Agent B, in A's group, reparented when the shell between them ended.
          row(220, 1, 7, "claude --resume b1", 200),
          row(221, 220, 50, "vitest", 200),
          // Agent C exited and its group emptied; the number now leads a stranger's group.
          row(300, 1, 70, "Xcode build", 300),
          row(301, 300, 30, "clang", 300),
        ],
        serverPid: SERVER,
        owners: owners({
          agents: [
            { threadId: "thread-a", pid: 200, ownGroup: true, alive: true },
            { threadId: "thread-b", pid: 220, ownGroup: true, alive: true },
            { threadId: "thread-c", pid: 300, ownGroup: true, alive: false },
          ],
        }),
        includeAppProcesses: false,
      }),
    );
    expect(groups["thread-b"]).toEqual({ cpu: 57, pids: [220, 221] });
    expect(groups["thread-a"]).toEqual({ cpu: 10, pids: [200] });
    expect(groups["thread-c"]).toBeUndefined();
  });

  it("leaves the app's own processes out unless the desktop app started the server", () => {
    const groups = byKey(
      groupProcessRead({ rows, serverPid: SERVER, owners: tracked, includeAppProcesses: false }),
    );
    expect(groups.threadlines).toEqual({ cpu: 5 + 1, pids: [SERVER, 101] });
  });

  it("finds only the tree where processes carry no group (Windows)", () => {
    const windowsRows = rows.map((entry) => ({ ...entry, pgid: null }));
    const groups = byKey(
      groupProcessRead({
        rows: windowsRows,
        serverPid: SERVER,
        owners: tracked,
        includeAppProcesses: false,
      }),
    );
    expect(groups["thread-a"]?.pids).toEqual([200, 201, 210]);
    expect(groups["thread-c"]).toBeUndefined();
  });
});

describe("summarizeGroupedReads", () => {
  const group = (threadId: string, cpuPercent: number): ProcessGroupRead => ({
    key: { kind: "thread", threadId },
    cpuPercent,
    rssBytes: 1_000,
    processCount: 1,
    topProcesses: [{ pid: 1, command: "work", cpuPercent, rssBytes: 1_000 }],
  });

  it("averages over every read and keeps a group whose processes ended since", () => {
    const summary = summarizeGroupedReads([
      { sampledAtMs: 0, groups: [group("busy-earlier", 400), group("steady", 100)] },
      { sampledAtMs: 5_000, groups: [group("steady", 100), group("spike", 600)] },
    ]);
    expect(
      summary.map((entry) => ({
        threadId: entry.kind === "thread" ? entry.threadId : null,
        cpu: entry.cpuPercent,
        avg: entry.avgCpuPercent,
        processes: entry.processCount,
        shown: entry.topProcesses.length,
      })),
    ).toEqual([
      { threadId: "spike", cpu: 600, avg: 300, processes: 1, shown: 1 },
      { threadId: "busy-earlier", cpu: 0, avg: 200, processes: 0, shown: 0 },
      { threadId: "steady", cpu: 100, avg: 100, processes: 1, shown: 1 },
    ]);
  });
});

describe("makeIntervalCpu", () => {
  const timed = (pid: number, cpuPercent: number, cpuTimeMs?: number): ProcessRow => ({
    ...row(pid, SERVER, cpuPercent, `process ${pid}`),
    cpuTimeMs,
  });
  const cpu = (rows: ReadonlyArray<ProcessRow>) => rows.map((entry) => entry.cpuPercent);

  it("reads what each process used since the read before, not its lifetime average", () => {
    const intervalCpu = makeIntervalCpu();
    // An hour-old agent that just filled a core: `ps` on Linux still says 2%.
    expect(cpu(intervalCpu([timed(1, 2, 72_000), timed(2, 40, 500)], 10_000))).toEqual([2, 40]);
    expect(cpu(intervalCpu([timed(1, 2, 77_000), timed(2, 40, 500)], 15_000))).toEqual([100, 0]);
    // Two reads at almost the same moment: the earlier figure stands.
    expect(cpu(intervalCpu([timed(1, 2, 77_400), timed(2, 40, 500)], 15_400))).toEqual([100, 0]);
    expect(cpu(intervalCpu([timed(1, 2, 79_500), timed(2, 40, 1_500)], 20_000))).toEqual([50, 20]);
  });

  it("keeps the figure it was given when there is nothing to compare with", () => {
    const intervalCpu = makeIntervalCpu();
    intervalCpu([timed(1, 9, 50_000), timed(2, 9, 50_000), timed(3, 9)], 10_000);
    expect(
      cpu(
        intervalCpu(
          [
            // Its number was reused: the total went backwards.
            timed(1, 30, 200),
            timed(2, 9, 55_000),
            // Windows gives no total.
            timed(3, 7),
            // New since the last read.
            timed(4, 60, 3_000),
          ],
          15_000,
        ),
      ),
    ).toEqual([30, 100, 7, 60]);
    // The sampler stopped and started again: the old totals say nothing about now.
    expect(cpu(intervalCpu([timed(2, 9, 999_000)], 500_000))).toEqual([9]);
  });
});

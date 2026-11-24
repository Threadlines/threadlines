// @effect-diagnostics nodeBuiltinImport:off
/**
 * CPU by thread (Settings > Diagnostics): which thread's agents and terminals
 * use the machine, next to Threadlines itself and provider processes that
 * serve several threads.
 *
 * Ownership comes from what the server already tracks, never from command
 * lines or folders: each driver's agent processes (ProviderService
 * `listAgentProcesses`, from the ledger it keeps to confirm a thread stopped)
 * and each terminal's shell (TerminalManager `listShells`). Every read the
 * process monitor takes is grouped as it arrives, so a process that ran
 * between two looks still counts where it ran. Nothing here reads on its own:
 * reads happen only while someone keeps the monitor's sampler going.
 */
import * as OS from "node:os";

import type {
  ProviderDriverKind,
  ServerThreadCpuUsageGroup,
  ServerThreadCpuUsageProcess,
  ServerThreadCpuUsageResult,
  ThreadId,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Services/Manager.ts";
import { isDiagnosticsQueryProcess, type ProcessRow } from "./ProcessDiagnostics.ts";
import { ProcessResourceMonitor, type ProcessTableRead } from "./ProcessResourceMonitor.ts";

/** How far back the average reaches. */
export const THREAD_CPU_WINDOW_MS = 60_000;
const TOP_PROCESSES = 5;
const MAX_COMMAND_LENGTH = 300;
/** Reads further apart than this say too little about now to compare. */
const MACHINE_CPU_MAX_GAP_MS = 15_000;

/** What the server knows about who started which process. */
export interface ProcessOwners {
  readonly agents: ReadonlyArray<{
    readonly threadId: string;
    readonly pid: number;
    /** It leads a process group of its own (POSIX), so the whole group is its. */
    readonly ownGroup: boolean;
    /** False once the process exited; its group may still run. */
    readonly alive: boolean;
  }>;
  /** Provider processes serving every thread of their provider (OpenCode's server). */
  readonly shared: ReadonlyArray<{ readonly provider: ProviderDriverKind; readonly pid: number }>;
  readonly shells: ReadonlyArray<{ readonly threadId: string; readonly pid: number }>;
}

export type ProcessGroupKey =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "threadlines" }
  | { readonly kind: "shared"; readonly provider: ProviderDriverKind };

export interface ProcessGroupRead {
  readonly key: ProcessGroupKey;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly processCount: number;
  readonly topProcesses: ReadonlyArray<ServerThreadCpuUsageProcess>;
}

const keyId = (key: ProcessGroupKey) =>
  key.kind === "thread"
    ? `thread:${key.threadId}`
    : key.kind === "shared"
      ? `shared:${key.provider}`
      : "threadlines";

const THREADLINES: ProcessGroupKey = { kind: "threadlines" };

/**
 * Puts each process of one read in exactly one group.
 *
 * - A thread: the tree under each of its agents and terminal shells, also
 *   where one left the server's tree (its parent died). When tracked
 *   processes nest, the nearest one wins. An agent that leads its own process
 *   group also gets the group's processes that left the tree (handed to pid 1
 *   when their parent died), and keeps them after it exits itself, until
 *   another process holds its number. Rows carry no group on Windows, so
 *   there only the tree counts.
 * - Shared: the tree under a provider process that serves several threads.
 * - Threadlines: the server and the rest of its tree, plus, with
 *   `includeAppProcesses` (the desktop app started the server), the server's
 *   parent and that parent's other children.
 *
 * Processes that are none of these are left out.
 */
export function groupProcessRead(input: {
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly serverPid: number;
  readonly owners: ProcessOwners;
  readonly includeAppProcesses: boolean;
}): ReadonlyArray<ProcessGroupRead> {
  const rowsByPid = new Map<number, ProcessRow>();
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of input.rows) {
    if (isDiagnosticsQueryProcess(row, input.serverPid)) continue;
    rowsByPid.set(row.pid, row);
    const siblings = childrenByParent.get(row.ppid);
    if (siblings) siblings.push(row);
    else childrenByParent.set(row.ppid, [row]);
  }

  const anchors = new Map<number, ProcessGroupKey>();
  for (const shell of input.owners.shells) {
    anchors.set(shell.pid, { kind: "thread", threadId: shell.threadId });
  }
  for (const shared of input.owners.shared) {
    anchors.set(shared.pid, { kind: "shared", provider: shared.provider });
  }
  const groupOwners = new Map<number, ProcessGroupKey>();
  for (const agent of input.owners.agents) {
    const key: ProcessGroupKey = { kind: "thread", threadId: agent.threadId };
    // A pid whose process exited may already be someone else's.
    if (agent.alive) anchors.set(agent.pid, key);
    // Its group id can't be reused while any member lives, but once they are
    // all gone a new process may take the number and lead a group of its
    // own: a group whose leader's number is in use again is someone else's.
    if (agent.ownGroup && (agent.alive || !rowsByPid.has(agent.pid))) {
      groupOwners.set(agent.pid, key);
    }
  }

  const owner = new Map<number, ProcessGroupKey>();
  /** Claims `root` and its unclaimed tree for `key`, nearest anchor first. */
  const claimTree = (root: ProcessRow, key: ProcessGroupKey) => {
    const stack: Array<{ readonly row: ProcessRow; readonly key: ProcessGroupKey }> = [
      { row: root, key },
    ];
    while (stack.length > 0) {
      const item = stack.pop()!;
      if (owner.has(item.row.pid)) continue;
      owner.set(item.row.pid, item.key);
      for (const child of childrenByParent.get(item.row.pid) ?? []) {
        stack.push({ row: child, key: anchors.get(child.pid) ?? item.key });
      }
    }
  };

  const server = rowsByPid.get(input.serverPid);
  if (server) claimTree(server, THREADLINES);
  else {
    // Windows reads only the server's tree; its own row may be missing.
    for (const child of childrenByParent.get(input.serverPid) ?? []) {
      claimTree(child, anchors.get(child.pid) ?? THREADLINES);
    }
  }
  for (const [pid, key] of anchors) {
    const row = rowsByPid.get(pid);
    if (row && !owner.has(pid)) claimTree(row, key);
  }
  for (const row of rowsByPid.values()) {
    if (owner.has(row.pid) || row.pgid === null) continue;
    const key = groupOwners.get(row.pgid);
    if (key) claimTree(row, key);
  }
  if (input.includeAppProcesses && server && server.ppid > 1) {
    const app = rowsByPid.get(server.ppid);
    if (app) claimTree(app, THREADLINES);
  }

  const groups = new Map<string, { key: ProcessGroupKey; rows: ProcessRow[] }>();
  for (const [pid, key] of owner) {
    const row = rowsByPid.get(pid)!;
    const id = keyId(key);
    const group = groups.get(id);
    if (group) group.rows.push(row);
    else groups.set(id, { key, rows: [row] });
  }
  return [...groups.values()].map(({ key, rows }) => ({
    key,
    cpuPercent: rows.reduce((total, row) => total + row.cpuPercent, 0),
    rssBytes: rows.reduce((total, row) => total + row.rssBytes, 0),
    processCount: rows.length,
    topProcesses: rows
      .toSorted(
        (left, right) => right.cpuPercent - left.cpuPercent || right.rssBytes - left.rssBytes,
      )
      .slice(0, TOP_PROCESSES)
      .map((row) => ({
        pid: row.pid,
        command: row.command.trim().slice(0, MAX_COMMAND_LENGTH) || `pid ${row.pid}`,
        cpuPercent: row.cpuPercent,
        rssBytes: row.rssBytes,
      })),
  }));
}

/** Two reads closer than this give an unsteady figure. */
const INTERVAL_CPU_MIN_GAP_MS = 1_000;

/**
 * Turns each row's `cpuPercent` into what the process used since the read
 * before, from its running total of CPU time (`cpuTimeMs`). That is the same
 * measure on every system: left alone, `ps` reports a recent average on
 * macOS and an average over the process's whole life on Linux, where an
 * agent that sat idle for an hour and then filled a core would read 2%.
 *
 * A row keeps the figure `ps` gave it when there is nothing to compare with:
 * a process seen for the first time, one whose total went backwards (its
 * number was reused), a read after a gap, or a row without a total
 * (Windows, where the figure is already made this way). Linux counts CPU
 * time in whole seconds, so there one process's figure moves in steps of
 * 100% divided by the seconds between reads; a group's sum and its average
 * over the minute even that out.
 */
export function makeIntervalCpu(): (
  rows: ReadonlyArray<ProcessRow>,
  atMs: number,
) => ReadonlyArray<ProcessRow> {
  let previous = new Map<
    number,
    { readonly cpuTimeMs: number; readonly atMs: number; readonly cpuPercent: number | null }
  >();
  return (rows, atMs) => {
    const next: typeof previous = new Map();
    const result = rows.map((row) => {
      if (row.cpuTimeMs === undefined) return row;
      const last = previous.get(row.pid);
      const gapMs = last ? atMs - last.atMs : 0;
      if (!last || row.cpuTimeMs < last.cpuTimeMs || gapMs > MACHINE_CPU_MAX_GAP_MS) {
        next.set(row.pid, { cpuTimeMs: row.cpuTimeMs, atMs, cpuPercent: null });
        return row;
      }
      if (gapMs < INTERVAL_CPU_MIN_GAP_MS) {
        // Too soon after the last read to compare: its total and figure stand.
        next.set(row.pid, last);
        return last.cpuPercent === null ? row : { ...row, cpuPercent: last.cpuPercent };
      }
      const cpuPercent = Math.round(((row.cpuTimeMs - last.cpuTimeMs) / gapMs) * 1000) / 10;
      next.set(row.pid, { cpuTimeMs: row.cpuTimeMs, atMs, cpuPercent });
      return { ...row, cpuPercent };
    });
    previous = next;
    return result;
  };
}

export interface GroupedRead {
  readonly sampledAtMs: number;
  readonly groups: ReadonlyArray<ProcessGroupRead>;
}

/**
 * Each group seen in the window, with its latest numbers and its average over
 * every read in the window (a read it was absent from counts as 0), busiest
 * on average first.
 */
export function summarizeGroupedReads(
  reads: ReadonlyArray<GroupedRead>,
): ReadonlyArray<ServerThreadCpuUsageGroup> {
  const latestRead = reads.at(-1);
  if (!latestRead) return [];
  const summaries = new Map<
    string,
    { latestSeen: ProcessGroupRead; cpuTotal: number; inLatest: boolean }
  >();
  for (const read of reads) {
    for (const group of read.groups) {
      const id = keyId(group.key);
      const summary = summaries.get(id);
      if (summary) {
        summary.latestSeen = group;
        summary.cpuTotal += group.cpuPercent;
      } else {
        summaries.set(id, { latestSeen: group, cpuTotal: group.cpuPercent, inLatest: false });
      }
    }
  }
  for (const group of latestRead.groups) summaries.get(keyId(group.key))!.inLatest = true;

  return [...summaries.values()]
    .map(({ latestSeen, cpuTotal, inLatest }): ServerThreadCpuUsageGroup => {
      const numbers = {
        cpuPercent: inLatest ? latestSeen.cpuPercent : 0,
        avgCpuPercent: cpuTotal / reads.length,
        rssBytes: inLatest ? Math.round(latestSeen.rssBytes) : 0,
        processCount: inLatest ? latestSeen.processCount : 0,
        topProcesses: inLatest ? latestSeen.topProcesses : [],
      };
      const key = latestSeen.key;
      return key.kind === "thread"
        ? { kind: "thread", threadId: key.threadId as ThreadId, ...numbers }
        : key.kind === "shared"
          ? { kind: "shared", provider: key.provider, ...numbers }
          : { kind: "threadlines", ...numbers };
    })
    .toSorted((left, right) => right.avgCpuPercent - left.avgCpuPercent);
}

/**
 * Busy time across all cores since the last read, in percent of one core.
 * Null for the first read, and after a gap (the sampler stopped), whose
 * average would say little about now.
 */
function makeMachineCpuMeter() {
  let previous: { busy: number; total: number; atMs: number } | null = null;
  return (atMs: number) => {
    let busy = 0;
    let total = 0;
    for (const cpu of OS.cpus()) {
      const { user, nice, sys, idle, irq } = cpu.times;
      busy += user + nice + sys + irq;
      total += user + nice + sys + idle + irq;
    }
    const last = previous;
    previous = { busy, total, atMs };
    if (!last || atMs - last.atMs > MACHINE_CPU_MAX_GAP_MS || total <= last.total) return null;
    const cores = Math.max(1, OS.cpus().length);
    return ((busy - last.busy) / (total - last.total)) * cores * 100;
  };
}

export interface ThreadCpuUsageShape {
  /** Keeps the sampler going for another two minutes and answers what it has. */
  readonly read: Effect.Effect<ServerThreadCpuUsageResult>;
}

export class ThreadCpuUsage extends Context.Service<ThreadCpuUsage, ThreadCpuUsageShape>()(
  "threadlines/diagnostics/ThreadCpuUsage",
) {}

export const make = Effect.fn("makeThreadCpuUsage")(function* () {
  const monitor = yield* ProcessResourceMonitor;
  const providers = yield* ProviderService;
  const terminals = yield* TerminalManager;
  const config = yield* ServerConfig;
  const includeAppProcesses = config.mode === "desktop";
  const machineCpu = makeMachineCpuMeter();
  const intervalCpu = makeIntervalCpu();
  let reads: ReadonlyArray<GroupedRead> = [];
  let lastRows: ReadonlyArray<ProcessRow> | null = null;
  let machineCpuPercent: number | null = null;

  const readOwners = Effect.gen(function* () {
    const [listed, shells] = yield* Effect.all([
      providers.listAgentProcesses,
      terminals.listShells,
    ]);
    return {
      agents: listed.flatMap((owner) => (owner.kind === "thread" ? [owner] : [])),
      shared: listed.flatMap((owner) =>
        owner.kind === "shared" ? [{ provider: owner.provider, pid: owner.pid }] : [],
      ),
      shells,
    } satisfies ProcessOwners;
  });

  const observe = (read: ProcessTableRead) =>
    Effect.gen(function* () {
      // Two requests at once can take one cached snapshot twice; counting it
      // twice would weigh that moment double in the average.
      if (read.rows === lastRows) return;
      lastRows = read.rows;
      const owners = yield* readOwners;
      const groups = groupProcessRead({
        rows: intervalCpu(read.rows, read.sampledAtMs),
        serverPid: read.serverPid,
        owners,
        includeAppProcesses,
      });
      machineCpuPercent = machineCpu(read.sampledAtMs);
      reads = [
        ...reads.filter((kept) => kept.sampledAtMs > read.sampledAtMs - THREAD_CPU_WINDOW_MS),
        { sampledAtMs: read.sampledAtMs, groups },
      ];
    });
  yield* monitor.observeReads(observe);

  const read: ThreadCpuUsageShape["read"] = Effect.gen(function* () {
    const error = yield* monitor.requestSamples.pipe(
      Effect.as(Option.none<{ readonly message: string }>()),
      Effect.catch((message) => Effect.succeed(Option.some({ message }))),
    );
    const readAt = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(readAt);
    // Reads older than the window are dropped here too, for a sampler that
    // stopped and started again.
    const recent = reads.filter((kept) => kept.sampledAtMs > nowMs - THREAD_CPU_WINDOW_MS);
    return {
      readAt,
      windowMs: THREAD_CPU_WINDOW_MS,
      // The same cores the machine figure counts.
      coreCount: Math.max(1, OS.cpus().length),
      machineCpuPercent: recent.length > 0 ? machineCpuPercent : null,
      groups: summarizeGroupedReads(recent),
      error,
    } satisfies ServerThreadCpuUsageResult;
  });

  return ThreadCpuUsage.of({ read });
});

export const layer = Layer.effect(ThreadCpuUsage, make());

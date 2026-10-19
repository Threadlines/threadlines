// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";

/**
 * Live descendant pids of a process (children, grandchildren, …) from a
 * single `ps` snapshot. Capture BEFORE signaling the root: once it dies,
 * surviving descendants reparent to pid 1 and can no longer be attributed.
 * POSIX only — on Windows a signal-less pty kill already terminates the
 * whole console tree, so this returns an empty list there.
 */
export function listDescendantProcessIds(rootPid: number): number[] {
  if (process.platform === "win32") return [];
  let table: string;
  try {
    table = execFileSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }

  const childrenByParent = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const siblings = childrenByParent.get(parent);
    if (siblings) {
      siblings.push(pid);
    } else {
      childrenByParent.set(parent, [pid]);
    }
  }

  const descendants: number[] = [];
  const queue: number[] = [rootPid];
  // Array iterators observe entries appended mid-iteration, so this walks
  // the whole tree breadth-first.
  for (const parent of queue) {
    for (const child of childrenByParent.get(parent) ?? []) {
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

/** `ps` prints these for a process with no controlling terminal. */
const NO_TERMINAL = new Set(["?", "??", "-"]);

/**
 * The processes in a `ps -A -o pid=,ppid=,tty=` table that stopping the shell
 * `shellPid` would touch: its descendants, and anything else on its terminal
 * (a background job its parent left behind keeps the terminal after
 * reparenting to pid 1). Null when the shell isn't in the table.
 */
export function terminalProcessIdsFromTable(table: string, shellPid: number): number[] | null {
  const rows: Array<{ pid: number; ppid: number; tty: string }> = [];
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), tty: match[3]! });
  }
  const shell = rows.find((row) => row.pid === shellPid);
  if (shell === undefined) return null;

  const touched = new Set<number>();
  const queue = [shellPid];
  for (const parent of queue) {
    for (const row of rows) {
      if (row.ppid !== parent || touched.has(row.pid)) continue;
      touched.add(row.pid);
      queue.push(row.pid);
    }
  }
  if (!NO_TERMINAL.has(shell.tty)) {
    for (const row of rows) {
      if (row.tty === shell.tty && row.pid !== shellPid) touched.add(row.pid);
    }
  }
  return [...touched];
}

/**
 * Other processes that live and die with a terminal's shell (see
 * terminalProcessIdsFromTable), from a single `ps` snapshot. Null when that
 * can't be known: on Windows, or when the process table can't be read.
 */
export function listTerminalProcessIds(shellPid: number): number[] | null {
  if (process.platform === "win32") return null;
  try {
    const table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,tty="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return terminalProcessIdsFromTable(table, shellPid);
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort signal delivery; a process that already exited is not an error. */
export function signalProcessSilently(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Exited or inaccessible.
  }
}

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

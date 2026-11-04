// @effect-diagnostics nodeBuiltinImport:off
/**
 * Which folders each running demo agent works in, so a fixtures reset can
 * wait for the agents of deleted threads to exit before it deletes their
 * folders. Threadlines stops a deleted thread's agent on its own schedule
 * (ThreadDeletionReactor), after the thread has already left the shell.
 *
 * One file per agent process in DEMO_AGENT_RUN_DIR (default: a folder in the
 * system temp folder), written by demo-agent.ts and removed when it exits. An
 * entry whose process is gone counts as gone, and is cleaned up when read.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const runDir = () =>
  process.env.DEMO_AGENT_RUN_DIR?.trim() ||
  NodePath.join(NodeOS.tmpdir(), "threadlines-demo-agents");

const recordPath = (pid: number) => NodePath.join(runDir(), `${pid}.json`);

const realOr = (path: string) => {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
};

/** This process works in `folders` (written whole each time). */
export function recordAgentFolders(folders: ReadonlyArray<string>): void {
  NodeFS.mkdirSync(runDir(), { recursive: true });
  // Renamed into place, so a reader never sees half a record.
  const partial = `${recordPath(process.pid)}.partial`;
  NodeFS.writeFileSync(
    partial,
    JSON.stringify({ pid: process.pid, folders: [...new Set(folders.map(realOr))] }),
  );
  NodeFS.renameSync(partial, recordPath(process.pid));
}

export function forgetThisAgent(): void {
  NodeFS.rmSync(recordPath(process.pid), { force: true });
}

/** Every record, at container start: no agent outlives the server that started it. */
export function clearAgentRecords(): void {
  NodeFS.rmSync(runDir(), { recursive: true, force: true });
}

/** Whether process `pid` is running. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: it exists, it just isn't ours to signal.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether `path` is `root` or under it, by their names (no symlinks followed). */
export const isWithin = (path: string, root: string) => {
  const relative = NodePath.relative(NodePath.resolve(root), NodePath.resolve(path));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
};

/** The live agents working in or under any of `roots`. */
export function agentsWorkingIn(roots: ReadonlyArray<string>): ReadonlyArray<number> {
  let names: ReadonlyArray<string>;
  try {
    names = NodeFS.readdirSync(runDir());
  } catch {
    return [];
  }
  const realRoots = roots.map(realOr);
  const pids: Array<number> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = NodePath.join(runDir(), name);
    let record: { readonly pid: number; readonly folders: ReadonlyArray<string> };
    try {
      record = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!isAlive(record.pid)) {
      NodeFS.rmSync(file, { force: true });
      continue;
    }
    if (record.folders.some((folder) => realRoots.some((root) => isWithin(folder, root)))) {
      pids.push(record.pid);
    }
  }
  return pids;
}

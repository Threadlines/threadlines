// @effect-diagnostics nodeBuiltinImport:off - lock files on disk
/**
 * InstallLock — one Threadlines process at a time installs, updates or
 * removes an agent, and writes its trust record.
 *
 * A contender publishes a lock file of its own in the agent's folder,
 * `install.lock.<token>`, holding its pid and when that process started. The
 * file is written beside and renamed in, so a lock that can be seen is
 * complete. The contender then looks at the folder: if someone else's live
 * lock is there it takes its own away and reports `busy`; if not, the lock
 * is its. Of two contenders the later to publish always sees the earlier,
 * so two never hold the lock at once. Two that publish at the same moment
 * may both step back; callers try again a moment later, not in step.
 *
 * Nobody moves or rewrites another's lock. A lock is deleted by its owner,
 * or by anyone once it is stale, which it is only when its owner is gone:
 * - another process's lock, when that pid is no longer alive, or when the
 *   lock was written before this computer last started (the pid belongs to
 *   something else now). A pid reused since the last start keeps a lock
 *   longer; it never lets two owners in;
 * - a lock in this process's pid, when it was started at another time (the
 *   pid was reused) or no caller here holds its token;
 * - a file that isn't a lock record, once it is older than any writer.
 *
 * @module provider/acpRegistry/InstallLock
 */
import { randomBytes } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const LOCK_PREFIX = "install.lock.";
const TEMP_PREFIX = "install.lock-tmp.";
const TOKEN_PATTERN = /^[0-9a-f]{16}$/u;
/** A file that isn't a lock record was never renamed in by a writer here: damage. */
const UNREADABLE_GRACE_MS = 10_000;
/** Publishing takes milliseconds; a temp file this old was abandoned. */
const LEFTOVER_AGE_MS = 60_000;
/** Slack for the clock moving a little, and for uptime that is reported in whole seconds. */
const BOOT_MARGIN_MS = 60_000;
const IN_USE_ATTEMPTS = 10;
const IN_USE_RETRY_MS = 100;
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

const LockRecord = Schema.Struct({
  pid: Schema.Int,
  /** When the owning process started, in milliseconds since the epoch. */
  startedAt: Schema.Number,
  /** When the lock was published, in milliseconds since the epoch. */
  createdAt: Schema.Number,
  token: Schema.String,
});
const LockRecordJson = Schema.fromJsonString(LockRecord);
const decodeLockRecord = Schema.decodeUnknownOption(LockRecordJson);
const encodeLockRecord = Schema.encodeSync(LockRecordJson);

/**
 * Tokens of the locks this process holds or is publishing. A lock file in
 * this process's name whose token isn't here is a leftover.
 */
const heldTokens = new Set<string>();

const errnoCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const isGone = (cause: unknown) => {
  const code = errnoCode(cause);
  return code === "ENOENT" || code === "ENOTDIR";
};

/** Windows: a reader or a virus scanner has the file open for a moment. */
const isBrieflyInUse = (cause: unknown) => {
  const code = errnoCode(cause);
  return (
    process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY")
  );
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: it exists but belongs to someone else.
    return errnoCode(cause) === "EPERM";
  }
}

/** When this computer last started, in milliseconds since the epoch. */
const bootedAt = () => Date.now() - NodeOS.uptime() * 1000;

/** Deletes a file, waiting out a Windows reader. Missing is fine. Throws when it is still there. */
async function deleteFile(path: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await NodeFS.unlink(path);
      return;
    } catch (cause) {
      if (isGone(cause)) return;
      if (!isBrieflyInUse(cause) || attempt >= IN_USE_ATTEMPTS) throw cause;
      await new Promise((resolve) => setTimeout(resolve, IN_USE_RETRY_MS));
    }
  }
}

export type InstallLockAttempt =
  | { readonly outcome: "acquired"; readonly token: string }
  /** Someone else holds it, or is taking it right now. */
  | { readonly outcome: "busy" }
  /** The agent's folder doesn't exist, so there is nothing to lock. */
  | { readonly outcome: "noFolder" };

/** Whether the lock file at `path` still has a living owner. Gone counts as not. */
async function isLive(path: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await NodeFS.readFile(path, "utf8");
  } catch (cause) {
    // Unreadable for another reason (Windows, while it is renamed in or deleted): live.
    return !isGone(cause);
  }
  const record = Option.getOrUndefined(decodeLockRecord(raw));
  if (!record) {
    const stats = await NodeFS.stat(path).catch(() => undefined);
    return stats !== undefined && Date.now() - stats.mtimeMs <= UNREADABLE_GRACE_MS;
  }
  if (record.pid === process.pid) {
    return record.startedAt === PROCESS_STARTED_AT && heldTokens.has(record.token);
  }
  return isProcessAlive(record.pid) && record.createdAt >= bootedAt() - BOOT_MARGIN_MS;
}

/**
 * Looks at every lock in `root` but `ownName`: deletes the stale ones and
 * says whether a live one is there.
 */
async function othersHoldIt(root: string, ownName: string): Promise<boolean> {
  let live = false;
  for (const name of await NodeFS.readdir(root)) {
    if (!name.startsWith(LOCK_PREFIX) || name === ownName) continue;
    const path = NodePath.join(root, name);
    if (await isLive(path)) live = true;
    else await deleteFile(path).catch(() => undefined);
  }
  return live;
}

/**
 * Deletes what a cut-off attempt left in `root`: stale locks, and lock files
 * that were never renamed in. Only old ones of the latter: another process
 * may be publishing a fresh one right now.
 */
export async function deleteInstallLockLeftovers(root: string): Promise<void> {
  const names = await NodeFS.readdir(root).catch(() => [] as Array<string>);
  for (const name of names) {
    const path = NodePath.join(root, name);
    if (name.startsWith(TEMP_PREFIX)) {
      const stats = await NodeFS.stat(path).catch(() => undefined);
      if (stats && Date.now() - stats.mtimeMs > LEFTOVER_AGE_MS) {
        await deleteFile(path).catch(() => undefined);
      }
    } else if (name.startsWith(LOCK_PREFIX) && !(await isLive(path))) {
      await deleteFile(path).catch(() => undefined);
    }
  }
}

/**
 * One attempt at the lock of the agent folder `root`. Never waits: `busy`
 * means try again later. Throws only what the filesystem does.
 */
export async function tryAcquireInstallLock(root: string): Promise<InstallLockAttempt> {
  const token = randomBytes(8).toString("hex");
  const name = `${LOCK_PREFIX}${token}`;
  const lockPath = NodePath.join(root, name);
  const tempPath = NodePath.join(root, `${TEMP_PREFIX}${token}`);
  // Held from before the file exists, so nothing here takes it for a leftover.
  heldTokens.add(token);
  let acquired = false;
  try {
    await NodeFS.writeFile(
      tempPath,
      encodeLockRecord({
        pid: process.pid,
        startedAt: PROCESS_STARTED_AT,
        createdAt: Date.now(),
        token,
      }),
      { flag: "wx", mode: 0o600 },
    );
    await NodeFS.rename(tempPath, lockPath);
    if (await othersHoldIt(root, name)) return { outcome: "busy" };
    acquired = true;
    return { outcome: "acquired", token };
  } catch (cause) {
    // No folder, or it was removed under this attempt: nothing to lock.
    if (isGone(cause)) return { outcome: "noFolder" };
    throw cause;
  } finally {
    // Everything but success takes back what it put there.
    if (!acquired) {
      await deleteFile(tempPath).catch(() => undefined);
      await deleteFile(lockPath).catch(() => undefined);
      heldTokens.delete(token);
    }
  }
}

/** Whether the lock `token` names is still in `root`. */
export async function holdsInstallLock(root: string, token: string): Promise<boolean> {
  if (!TOKEN_PATTERN.test(token)) return false;
  try {
    await NodeFS.stat(NodePath.join(root, `${LOCK_PREFIX}${token}`));
    return true;
  } catch (cause) {
    // Gone means someone took it for stale. Unreadable for a moment (a
    // Windows virus scanner has it open) does not.
    return !isGone(cause);
  }
}

/** Gives the lock up. Never throws. */
export async function releaseInstallLock(root: string, token: string): Promise<void> {
  try {
    if (TOKEN_PATTERN.test(token)) {
      await deleteFile(NodePath.join(root, `${LOCK_PREFIX}${token}`));
    }
  } catch {
    // Still there: with the token forgotten below, it is a leftover, and
    // the next attempt in this process deletes it.
  } finally {
    heldTokens.delete(token);
  }
}

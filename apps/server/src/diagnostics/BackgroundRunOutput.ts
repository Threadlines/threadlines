/**
 * Reads the newest output of a command an agent left running in the
 * background. Claude sends such a command's output to a file
 * (`…/tasks/<id>.output`) and never streams it, so the run list asks for the
 * end of that file while it is open.
 *
 * Only a file shaped like Claude's, named word for word by the thread's own
 * activity, and not reached through a symlink is ever read: the client says
 * which file, but cannot point this at anything the agent did not announce.
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import type {
  OrchestrationThreadActivity,
  ServerReadBackgroundRunOutputInput,
  ServerReadBackgroundRunOutputResult,
  ThreadId,
} from "@threadlines/contracts";
import {
  backgroundOutputFilesInText,
  isBackgroundRunOutputPath,
} from "@threadlines/shared/backgroundRunOutput";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/** Enough for the last few lines of a chatty dev server or test run. */
const OUTPUT_TAIL_BYTES = 8_192;
/** How long a file stays matched to its thread before the thread is asked
 *  again. Polling every few seconds then costs one lookup per half minute,
 *  and a file whose announcement was reverted or deleted stops being read
 *  soon after. */
const ANNOUNCEMENT_TTL_MS = 30_000;
const MAX_ANNOUNCED_FILES = 256;
/** How deep into an activity payload announcements are looked for. */
const MAX_PAYLOAD_DEPTH = 6;

const UNREADABLE: ServerReadBackgroundRunOutputResult = { tail: null };

function collectAnnouncedFiles(value: unknown, depth: number, into: Set<string>): void {
  if (typeof value === "string") {
    for (const file of backgroundOutputFilesInText(value)) into.add(file);
    return;
  }
  if (depth >= MAX_PAYLOAD_DEPTH || !value || typeof value !== "object") return;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectAnnouncedFiles(child, depth + 1, into);
  }
}

/** The output files a thread's activity names, exactly as named. */
export function announcedOutputFiles(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "payload">>,
): ReadonlySet<string> {
  const files = new Set<string>();
  for (const activity of activities) {
    collectAnnouncedFiles(activity.payload, 0, files);
  }
  return files;
}

/** Refuses to follow a symlink at the last step of the path, where the
 *  platform supports it (not Windows). */
const OPEN_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** The end of a regular file as text, from a whole line on. Null for a
 *  symlink, or a path whose real location is not a `tasks/<id>.output` file. */
async function readFileTail(file: string): Promise<string | null> {
  const linkStats = await lstat(file);
  if (!linkStats.isFile()) return null;
  // A symlinked parent directory could still move the read elsewhere; the
  // real path has to keep the same shape and name.
  const resolved = await realpath(file);
  if (path.basename(resolved) !== path.basename(file) || !isBackgroundRunOutputPath(resolved)) {
    return null;
  }
  const handle = await open(resolved, OPEN_NO_FOLLOW);
  try {
    const stats = await handle.stat();
    // The file opened has to be the one checked above, not something swapped
    // in between the check and the open.
    if (!stats.isFile() || stats.ino !== linkStats.ino || stats.dev !== linkStats.dev) {
      return null;
    }
    const length = Math.min(stats.size, OUTPUT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, stats.size - length);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // A read that starts mid-file starts mid-line; drop the partial line.
    return length < stats.size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

export function makeBackgroundRunOutputReader(
  projectionSnapshotQuery: Pick<ProjectionSnapshotQueryShape, "getThreadDetailById">,
  now: () => number = Date.now,
) {
  /** When each file was last confirmed, per thread. */
  const confirmedAt = new Map<ThreadId, Map<string, number>>();
  let confirmedCount = 0;

  const isAnnouncedInThread = Effect.fn("backgroundRunOutput.isAnnouncedInThread")(function* (
    threadId: ThreadId,
    file: string,
  ) {
    const threadConfirmations = confirmedAt.get(threadId);
    const confirmed = threadConfirmations?.get(file);
    if (confirmed !== undefined && now() - confirmed < ANNOUNCEMENT_TTL_MS) return true;
    const thread = yield* projectionSnapshotQuery.getThreadDetailById(threadId);
    if (Option.isNone(thread)) return false;
    if (!announcedOutputFiles(thread.value.activities).has(file)) return false;
    if (confirmedCount >= MAX_ANNOUNCED_FILES) {
      confirmedAt.clear();
      confirmedCount = 0;
    }
    const confirmations = confirmedAt.get(threadId) ?? new Map<string, number>();
    if (!confirmations.has(file)) confirmedCount += 1;
    confirmations.set(file, now());
    confirmedAt.set(threadId, confirmations);
    return true;
  });

  return Effect.fn("backgroundRunOutput.read")(function* (
    input: ServerReadBackgroundRunOutputInput,
  ) {
    const file = input.outputFile;
    if (!isBackgroundRunOutputPath(file)) return UNREADABLE;
    const announced = yield* isAnnouncedInThread(input.threadId, file).pipe(
      Effect.orElseSucceed(() => false),
    );
    if (!announced) return UNREADABLE;
    const tail = yield* Effect.tryPromise(() => readFileTail(file)).pipe(
      Effect.orElseSucceed(() => null),
    );
    return { tail } satisfies ServerReadBackgroundRunOutputResult;
  });
}

/**
 * When the open app plays its alert sound (Settings › General › Alerts › Play
 * a sound). Pure: two readings of every thread in, the sound they call for
 * out. The runtime (components/AlertSoundRuntime.tsx) reads the threads, holds a sound
 * for a moment and asks {@link dueAlertSound} again before it plays, and the
 * player (alertSoundPlayer.ts) makes the sound and keeps other tabs quiet.
 *
 * A sound marks a change seen happen: nothing plays for the threads an app
 * finds when it opens, when a computer connects, or when one reconnects with
 * a fresh snapshot, since that work moved out of sight.
 */
import { resolveThreadStatusPill, type ThreadStatusPill } from "../components/Sidebar.logic";
import type { SidebarThreadSummary } from "../types";

/** "done" when a turn finishes or fails, "attention" when a thread starts needing the user. */
export type AlertSound = "done" | "attention";

/** What a thread is doing, as far as the sound cares. */
export type AlertSoundPhase = "working" | "needs-you" | "finished" | "failed" | "quiet";

export interface AlertSoundThread {
  readonly phase: AlertSoundPhase;
  /** Its newest turn, so a second finished turn reads as new. */
  readonly turnId: string | null;
  /**
   * Filed under Wrapped (a child whose answer went back to its parent, say).
   * The inbox and the Dock let it go, so the sound does too.
   */
  readonly filed: boolean;
  /** Its computer's count of applied shell snapshots when this was read. */
  readonly snapshot: number;
}

/** Every thread the app shows, by scoped thread key. */
export type AlertSoundSnapshot = ReadonlyMap<string, AlertSoundThread>;

const PHASE_BY_STATUS: Record<ThreadStatusPill["label"], AlertSoundPhase> = {
  Working: "working",
  Starting: "working",
  Answering: "working",
  Waiting: "working",
  "Pending Approval": "needs-you",
  "Awaiting Input": "needs-you",
  "Plan Ready": "needs-you",
  Failed: "failed",
  Completed: "finished",
  "Checking back": "quiet",
  "Continues at reset": "quiet",
};

/**
 * A thread's phase from the status its row would show, read as if never
 * seen: the sound follows the work, and a thread open in a window nobody is
 * looking at still deserves one. A turn the user stopped is quiet.
 */
export function alertSoundPhaseOf(thread: SidebarThreadSummary): AlertSoundPhase {
  const status = resolveThreadStatusPill({ thread });
  if (status === null) return "quiet";
  if (status.label === "Completed") {
    switch (thread.latestTurn?.state) {
      case "interrupted":
        return "quiet";
      case "error":
        return "failed";
      default:
        return "finished";
    }
  }
  return PHASE_BY_STATUS[status.label];
}

/** The louder of two sounds: needing the user wins over finishing. */
export function strongerAlertSound(left: AlertSound | undefined, right: AlertSound): AlertSound {
  return left === "attention" || right === "attention" ? "attention" : "done";
}

/**
 * The sounds the change from `prev` to `next` calls for, by thread key. The
 * first reading (`prev` null), a thread not in `prev`, and a thread whose
 * computer applied a new snapshot in between are only remembered.
 *
 * - attention: the thread now needs the user and didn't before.
 * - done: it failed, or finished a turn it was seen working on (or a newer
 *   turn than the one it last showed). A plan or approval clearing on the same
 *   turn is no news.
 */
export function alertSoundChanges(
  prev: AlertSoundSnapshot | null,
  next: AlertSoundSnapshot,
): Map<string, AlertSound> {
  const sounds = new Map<string, AlertSound>();
  if (prev === null) return sounds;
  for (const [threadKey, thread] of next) {
    const before = prev.get(threadKey);
    if (before === undefined || before.snapshot !== thread.snapshot) continue;
    if (thread.phase === "needs-you") {
      if (before.phase !== "needs-you") sounds.set(threadKey, "attention");
      continue;
    }
    if (thread.filed) continue;
    if (thread.phase === "failed" && before.phase !== "failed") {
      sounds.set(threadKey, "done");
    } else if (
      thread.phase === "finished" &&
      (before.phase === "working" || before.turnId !== thread.turnId)
    ) {
      sounds.set(threadKey, "done");
    }
  }
  return sounds;
}

/**
 * Of the sounds held since they were noticed, the one to play now, from the
 * threads as they are now: a thread that went back to work, got filed away,
 * no longer needs the user, or is being watched (open on an attended
 * screen) has nothing left to say. Needing the user wins.
 */
export function dueAlertSound(
  pending: ReadonlyMap<string, AlertSound>,
  latest: AlertSoundSnapshot,
  isWatched: (threadKey: string) => boolean,
): AlertSound | null {
  let due: AlertSound | null = null;
  for (const [threadKey, sound] of pending) {
    const thread = latest.get(threadKey);
    if (thread === undefined || isWatched(threadKey)) continue;
    if (sound === "attention") {
      if (thread.phase === "needs-you") return "attention";
    } else if (!thread.filed && (thread.phase === "finished" || thread.phase === "failed")) {
      due = "done";
    }
  }
  return due;
}

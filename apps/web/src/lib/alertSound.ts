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
 * A sound one thread's change calls for, with what it was about: the turn it
 * saw and its computer's snapshot count. A cue whose thread moved on to
 * another turn, or whose computer sent a new snapshot, by the time it is due
 * says nothing.
 */
export interface AlertSoundCue {
  readonly sound: AlertSound;
  readonly turnId: string | null;
  readonly snapshot: number;
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
): Map<string, AlertSoundCue> {
  const cues = new Map<string, AlertSoundCue>();
  if (prev === null) return cues;
  const cue = (threadKey: string, thread: AlertSoundThread, sound: AlertSound) =>
    cues.set(threadKey, { sound, turnId: thread.turnId, snapshot: thread.snapshot });
  for (const [threadKey, thread] of next) {
    const before = prev.get(threadKey);
    if (before === undefined || before.snapshot !== thread.snapshot) continue;
    if (thread.phase === "needs-you") {
      if (before.phase !== "needs-you") cue(threadKey, thread, "attention");
      continue;
    }
    if (thread.filed) continue;
    if (thread.phase === "failed" && before.phase !== "failed") {
      cue(threadKey, thread, "done");
    } else if (
      thread.phase === "finished" &&
      (before.phase === "working" || before.turnId !== thread.turnId)
    ) {
      cue(threadKey, thread, "done");
    }
  }
  return cues;
}

/** A thread that starts needing the user waits only for its neighbors in the same burst. */
export const ATTENTION_HOLD_MS = 250;
/**
 * A finished turn waits this long first: work often hands straight on (a
 * queued message, a child's answer going back), and a sound for the gap
 * would be a false alarm. The Dock waits the same.
 */
export const DONE_HOLD_MS = 1_500;

/** A cue waiting until `dueAt` (ms since the epoch). */
export interface QueuedAlertSoundCue extends AlertSoundCue {
  readonly dueAt: number;
}

/**
 * Adds new cues to the waiting ones. A thread cued again keeps the louder
 * sound and the sooner time, and takes the newer cue's turn and snapshot.
 */
export function queueAlertSoundCues(
  queued: ReadonlyMap<string, QueuedAlertSoundCue>,
  cues: ReadonlyMap<string, AlertSoundCue>,
  now: number,
): Map<string, QueuedAlertSoundCue> {
  const next = new Map(queued);
  for (const [threadKey, cue] of cues) {
    const held = queued.get(threadKey);
    const dueAt = now + (cue.sound === "attention" ? ATTENTION_HOLD_MS : DONE_HOLD_MS);
    next.set(threadKey, {
      ...cue,
      sound: strongerAlertSound(held?.sound, cue.sound),
      dueAt: Math.min(held?.dueAt ?? dueAt, dueAt),
    });
  }
  return next;
}

/**
 * Splits the waiting cues into those due at `now` and the rest, and says when
 * to look again (null: nothing waits). A "done" cue also waits for every
 * attention cue still held, so a thread that needs the user a moment after
 * another finished plays the attention sound instead of losing it to the gap
 * after "done".
 */
export function takeDueAlertSoundCues(
  queued: ReadonlyMap<string, QueuedAlertSoundCue>,
  now: number,
): {
  readonly due: Map<string, AlertSoundCue>;
  readonly waiting: Map<string, QueuedAlertSoundCue>;
  readonly nextAt: number | null;
} {
  let lastAttentionAt = Number.NEGATIVE_INFINITY;
  for (const cue of queued.values()) {
    if (cue.sound === "attention") lastAttentionAt = Math.max(lastAttentionAt, cue.dueAt);
  }
  const due = new Map<string, AlertSoundCue>();
  const waiting = new Map<string, QueuedAlertSoundCue>();
  let nextAt: number | null = null;
  for (const [threadKey, cue] of queued) {
    const at = cue.sound === "done" ? Math.max(cue.dueAt, lastAttentionAt) : cue.dueAt;
    if (at <= now) {
      due.set(threadKey, { sound: cue.sound, turnId: cue.turnId, snapshot: cue.snapshot });
    } else {
      waiting.set(threadKey, cue);
      nextAt = nextAt === null ? at : Math.min(nextAt, at);
    }
  }
  return { due, waiting, nextAt };
}

/**
 * Of the cues due, the sound to play now, from the threads as they are now:
 * a thread that went back to work, moved on to another turn, got filed away,
 * no longer needs the user, or is being watched (open on an attended screen),
 * or whose computer sent a new snapshot since, has nothing left to say.
 * Needing the user wins.
 */
export function dueAlertSound(
  due: ReadonlyMap<string, AlertSoundCue>,
  latest: AlertSoundSnapshot,
  isWatched: (threadKey: string) => boolean,
): AlertSound | null {
  let sound: AlertSound | null = null;
  for (const [threadKey, cue] of due) {
    const thread = latest.get(threadKey);
    if (thread === undefined || isWatched(threadKey)) continue;
    if (thread.snapshot !== cue.snapshot || thread.turnId !== cue.turnId) continue;
    if (cue.sound === "attention") {
      if (thread.phase === "needs-you") return "attention";
    } else if (!thread.filed && (thread.phase === "finished" || thread.phase === "failed")) {
      sound = "done";
    }
  }
  return sound;
}

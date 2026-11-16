/**
 * Mounted once at the root. While Play a sound is on (Settings › General ›
 * Alerts), plays a short sound when a thread on any connected computer
 * finishes, fails or starts needing the user. Which change calls for which
 * sound is lib/alertSound.ts; making it, and keeping other tabs quiet, is
 * lib/alertSoundPlayer.ts. The threads are the inbox's, filed the same way
 * the sidebar and the Dock file them.
 */
import { scopedThreadKey } from "@threadlines/client-runtime";
import { useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { useInboxThreads } from "../hooks/useInboxThreads";
import { useSettings } from "../hooks/useSettings";
import {
  type AlertSound,
  type AlertSoundSnapshot,
  type AlertSoundThread,
  alertSoundChanges,
  alertSoundPhaseOf,
  dueAlertSound,
  strongerAlertSound,
} from "../lib/alertSound";
import {
  holdWatchedThread,
  playAlertSound,
  primeAlertSound,
  watchedThreadKeys,
} from "../lib/alertSoundPlayer";
import { isPageAttended, usePageAttended } from "../lib/pageAttention";
import { selectShellSnapshotCounts, useStore } from "../store";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";

/** A thread that starts needing the user waits only for its neighbors in the same burst. */
const ATTENTION_HOLD_MS = 250;
/**
 * A finished turn waits this long first: work often hands straight on (a
 * queued message, a child's answer going back), and a sound for the gap
 * would be a false alarm. The Dock waits the same.
 */
const DONE_HOLD_MS = 1_500;

/**
 * Holds each noticed sound until it is due, then hands over everything due
 * at once. A thread noticed again keeps the louder sound and the sooner time.
 */
function createAlertSoundQueue(onDue: (due: ReadonlyMap<string, AlertSound>) => void) {
  const pending = new Map<string, { sound: AlertSound; dueAt: number }>();
  let timer: { readonly at: number; readonly id: number } | null = null;

  function schedule() {
    let at = Number.POSITIVE_INFINITY;
    for (const { dueAt } of pending.values()) at = Math.min(at, dueAt);
    if (timer !== null) {
      if (timer.at === at) return;
      window.clearTimeout(timer.id);
      timer = null;
    }
    if (at === Number.POSITIVE_INFINITY) return;
    timer = { at, id: window.setTimeout(flush, Math.max(0, at - Date.now())) };
  }

  function flush() {
    timer = null;
    const now = Date.now();
    const due = new Map<string, AlertSound>();
    for (const [threadKey, { sound, dueAt }] of pending) {
      if (dueAt > now) continue;
      due.set(threadKey, sound);
      pending.delete(threadKey);
    }
    schedule();
    if (due.size > 0) onDue(due);
  }

  return {
    add(sounds: ReadonlyMap<string, AlertSound>) {
      const now = Date.now();
      for (const [threadKey, sound] of sounds) {
        const held = pending.get(threadKey);
        const dueAt = now + (sound === "attention" ? ATTENTION_HOLD_MS : DONE_HOLD_MS);
        pending.set(threadKey, {
          sound: strongerAlertSound(held?.sound, sound),
          dueAt: Math.min(held?.dueAt ?? dueAt, dueAt),
        });
      }
      schedule();
    },
    dispose() {
      if (timer !== null) window.clearTimeout(timer.id);
      timer = null;
      pending.clear();
    },
  };
}

export function AlertSoundRuntime() {
  const on = useSettings((settings) => settings.alertSound);
  return on ? <AlertSoundWatcher /> : null;
}

function AlertSoundWatcher() {
  const { entries, generalChatEntries } = useInboxThreads();
  const snapshotCounts = useStore(useShallow(selectShellSnapshotCounts));
  const openThreadKey = useParams({
    strict: false,
    select: (params) => {
      const target = resolveThreadRouteTarget(params);
      return target?.kind === "server" ? scopedThreadKey(target.threadRef) : null;
    },
  });
  const attended = usePageAttended();
  const watching = attended ? openThreadKey : null;

  const latestRef = useRef<AlertSoundSnapshot | null>(null);
  const queueRef = useRef<ReturnType<typeof createAlertSoundQueue> | null>(null);

  useEffect(() => primeAlertSound(), []);
  // Every tab learns which thread this one shows on an attended screen.
  useEffect(() => holdWatchedThread(watching), [watching]);

  /** Plays what is due, from the threads as they are now, unless someone is watching them. */
  const playDue = useEffectEvent(async (due: ReadonlyMap<string, AlertSound>) => {
    const latest = latestRef.current;
    if (latest === null) return;
    const watchedElsewhere = await watchedThreadKeys();
    const sound = dueAlertSound(
      due,
      latest,
      (threadKey) =>
        watchedElsewhere.has(threadKey) || (threadKey === openThreadKey && isPageAttended()),
    );
    if (sound !== null) playAlertSound(sound);
  });

  useEffect(() => {
    const queue = createAlertSoundQueue((due) => void playDue(due));
    queueRef.current = queue;
    return () => {
      queue.dispose();
      queueRef.current = null;
    };
  }, []);

  useEffect(() => {
    const next = new Map<string, AlertSoundThread>();
    const read = (threadKey: string, thread: SidebarThreadSummary, filed: boolean) => {
      next.set(threadKey, {
        phase: alertSoundPhaseOf(thread),
        turnId: thread.latestTurn?.turnId ?? null,
        filed,
        snapshot: snapshotCounts[thread.environmentId] ?? 0,
      });
    };
    for (const entry of entries) read(entry.threadKey, entry.thread, entry.isDone);
    for (const entry of generalChatEntries) read(entry.threadKey, entry.thread, false);
    const changes = alertSoundChanges(latestRef.current, next);
    latestRef.current = next;
    if (changes.size > 0) queueRef.current?.add(changes);
  }, [entries, generalChatEntries, snapshotCounts]);

  return null;
}

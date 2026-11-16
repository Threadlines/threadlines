/**
 * Mounted once at the root. While Play a sound is on (Settings › General ›
 * Alerts), plays a short sound when a thread on any connected computer
 * finishes, fails or starts needing the user. Which change calls for which
 * sound, and when it is due, is lib/alertSound.ts; making it, and keeping
 * other tabs quiet, is lib/alertSoundPlayer.ts. The threads are the inbox's,
 * filed the same way the sidebar and the Dock file them.
 */
import { scopedThreadKey } from "@threadlines/client-runtime";
import { useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { useInboxThreads } from "../hooks/useInboxThreads";
import { useSettings } from "../hooks/useSettings";
import {
  type AlertSoundCue,
  type AlertSoundSnapshot,
  type AlertSoundThread,
  type QueuedAlertSoundCue,
  alertSoundChanges,
  alertSoundPhaseOf,
  dueAlertSound,
  queueAlertSoundCues,
  takeDueAlertSoundCues,
} from "../lib/alertSound";
import {
  holdWatchedThread,
  joinAlertSoundTabs,
  playAlertSound,
  primeAlertSound,
  watchedThreadKeys,
} from "../lib/alertSoundPlayer";
import { isPageAttended, usePageAttended } from "../lib/pageAttention";
import { selectShellSnapshotCounts, useStore } from "../store";
import { resolveThreadRouteTarget } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";

/**
 * Holds cues until they are due (takeDueAlertSoundCues), then hands over
 * everything due at once.
 */
function createAlertSoundQueue(onDue: (due: ReadonlyMap<string, AlertSoundCue>) => void) {
  let queued = new Map<string, QueuedAlertSoundCue>();
  let timer: { readonly at: number; readonly id: number } | null = null;

  function schedule(at: number | null) {
    if (timer !== null) {
      if (timer.at === at) return;
      window.clearTimeout(timer.id);
      timer = null;
    }
    if (at === null) return;
    const id = window.setTimeout(
      () => {
        timer = null;
        flush();
      },
      Math.max(0, at - Date.now()),
    );
    timer = { at, id };
  }

  /** Hands over what is due and waits for the next one. */
  function flush() {
    const { due, waiting, nextAt } = takeDueAlertSoundCues(queued, Date.now());
    queued = waiting;
    schedule(nextAt);
    if (due.size > 0) onDue(due);
  }

  return {
    add(cues: ReadonlyMap<string, AlertSoundCue>) {
      queued = queueAlertSoundCues(queued, cues, Date.now());
      flush();
    },
    dispose() {
      schedule(null);
      queued = new Map();
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

  useEffect(() => {
    joinAlertSoundTabs();
    return primeAlertSound();
  }, []);
  // Every tab learns which thread this one shows on an attended screen.
  useEffect(() => holdWatchedThread(watching), [watching]);

  /** Plays what is due, from the threads as they are now, unless someone is watching them. */
  const playDue = useEffectEvent(async (due: ReadonlyMap<string, AlertSoundCue>) => {
    const latest = latestRef.current;
    if (latest === null) return;
    const watchedElsewhere = await watchedThreadKeys();
    const sound = dueAlertSound(
      due,
      latest,
      (threadKey) =>
        watchedElsewhere.has(threadKey) || (threadKey === openThreadKey && isPageAttended()),
    );
    if (sound !== null) await playAlertSound(sound);
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
    const cues = alertSoundChanges(latestRef.current, next);
    latestRef.current = next;
    if (cues.size > 0) queueRef.current?.add(cues);
  }, [entries, generalChatEntries, snapshotCounts]);

  return null;
}

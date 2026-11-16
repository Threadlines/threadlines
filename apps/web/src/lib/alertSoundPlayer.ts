/**
 * Makes the alert sounds (alertSound.ts) and keeps the app's other tabs and
 * windows on this device from making them too.
 *
 * The sounds are synthesized with Web Audio, so there are no audio files:
 * "done" is two soft rising notes, "attention" two taps on one higher note.
 * The audio context is suspended between sounds, so an idle app runs no
 * audio thread. Before any click or key press a browser may refuse to start
 * it; then the sound is skipped, quietly.
 *
 * Tabs coordinate through Web Locks, which every tab of this origin shares
 * and which a closed or crashed tab gives back by itself:
 * - one lock is held while a sound plays and for the gap after it, so of the
 *   tabs that all saw the same change only the first plays, and nothing
 *   plays more often than once a gap;
 * - a tab whose thread is on an attended screen holds a lock named for that
 *   thread, so every tab knows it is being watched.
 */
import type { AlertSound } from "./alertSound";

/** At most one sound this often, across every tab. */
export const ALERT_SOUND_GAP_MS = 1_500;

const PLAY_LOCK = "threadlines:alert-sound";
const WATCHING_LOCK_PREFIX = "threadlines:alert-sound:watching:";
/** How long a suspended audio context gets to start before the sound is skipped. */
const RESUME_WAIT_MS = 300;
/** Loudness of the whole sound, out of 1. */
const MASTER_GAIN = 0.12;

interface Note {
  readonly frequency: number;
  /** Seconds after the sound starts. */
  readonly at: number;
  /** Seconds until it has faded out. */
  readonly length: number;
}

interface Voice {
  readonly notes: ReadonlyArray<Note>;
  /** How much of the octave above each note sounds, for a little shimmer. */
  readonly overtone: number;
}

const VOICES: Record<AlertSound, Voice> = {
  // G5 then C6: a rising fourth, about 0.4 s.
  done: {
    notes: [
      { frequency: 783.99, at: 0, length: 0.18 },
      { frequency: 1046.5, at: 0.11, length: 0.3 },
    ],
    overtone: 0.12,
  },
  // A5 twice: a tap-tap that reads as "look".
  attention: {
    notes: [
      { frequency: 880, at: 0, length: 0.13 },
      { frequency: 880, at: 0.15, length: 0.27 },
    ],
    overtone: 0.25,
  },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (context !== null) return context;
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return null;
  try {
    context = new window.AudioContext();
  } catch {
    return null;
  }
  return context;
}

// A function, so a check after an await reads the context afresh.
const isRunning = (audio: AudioContext) => audio.state === "running";

/** The audio context, started; null when the browser won't start it now. */
async function startedContext(): Promise<AudioContext | null> {
  const audio = audioContext();
  if (audio === null) return null;
  if (isRunning(audio)) return audio;
  try {
    await Promise.race([audio.resume(), sleep(RESUME_WAIT_MS)]);
  } catch {
    return null;
  }
  return isRunning(audio) ? audio : null;
}

/** Plays `sound` in this tab, then lets the audio context rest. */
async function playHere(sound: AlertSound): Promise<void> {
  const audio = await startedContext();
  if (audio === null) return;
  const voice = VOICES[sound];
  const start = audio.currentTime + 0.02;
  const master = audio.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(audio.destination);
  let end = start;
  for (const note of voice.notes) {
    const at = start + note.at;
    const fadedAt = at + note.length;
    end = Math.max(end, fadedAt);
    const envelope = audio.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(1, at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, fadedAt);
    envelope.connect(master);
    for (const [multiple, level] of [
      [1, 1],
      [2, voice.overtone],
    ] as const) {
      const oscillator = audio.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = note.frequency * multiple;
      const partial = audio.createGain();
      partial.gain.value = level;
      oscillator.connect(partial).connect(envelope);
      oscillator.start(at);
      oscillator.stop(fadedAt + 0.02);
    }
  }
  await sleep(Math.ceil((end - audio.currentTime) * 1000) + 60);
  master.disconnect();
  // Another sound may have started meanwhile; it starts the context again.
  void audio.suspend().catch(() => undefined);
}

let lastPlayedAt = 0;

/**
 * Plays `sound` unless another tab of the app (or this one) played one within
 * the gap: the first tab to ask plays, the rest skip.
 */
export function playAlertSound(sound: AlertSound): void {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) {
    // No Web Locks: this tab keeps its own gap.
    if (Date.now() - lastPlayedAt < ALERT_SOUND_GAP_MS) return;
    lastPlayedAt = Date.now();
    void playHere(sound);
    return;
  }
  void locks
    .request(PLAY_LOCK, { ifAvailable: true }, async (lock) => {
      if (lock === null) return;
      await Promise.all([playHere(sound), sleep(ALERT_SOUND_GAP_MS)]);
    })
    .catch(() => undefined);
}

/** Plays `sound` now, in this tab: the Settings switch's preview, from the user's own click. */
export function previewAlertSound(sound: AlertSound): void {
  void playHere(sound);
}

/**
 * Starts the audio context on the first click or key press, the moment a
 * browser allows it, then lets it rest. Some browsers (Safari) only start
 * one later if it was first started that way. Returns a cleanup.
 */
export function primeAlertSound(): () => void {
  const events = ["pointerdown", "keydown"] as const;
  const prime = () => {
    stop();
    const audio = audioContext();
    if (audio === null) return;
    void audio
      .resume()
      .then(() => audio.suspend())
      .catch(() => undefined);
  };
  const stop = () => {
    for (const event of events) window.removeEventListener(event, prime, true);
  };
  for (const event of events) window.addEventListener(event, prime, true);
  return stop;
}

/**
 * Marks `threadKey` as watched (open on an attended screen) for every tab,
 * until the returned release is called. Null marks nothing.
 */
export function holdWatchedThread(threadKey: string | null): () => void {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (threadKey === null || locks === undefined) return () => undefined;
  // Abort takes back a request still waiting; resolving lets go of a held lock.
  const controller = new AbortController();
  const held: { release: (() => void) | null } = { release: null };
  void locks
    .request(
      `${WATCHING_LOCK_PREFIX}${threadKey}`,
      { signal: controller.signal },
      () =>
        new Promise<void>((resolve) => {
          held.release = resolve;
        }),
    )
    .catch(() => undefined);
  return () => {
    controller.abort();
    held.release?.();
  };
}

/** The threads some tab of the app holds as watched ({@link holdWatchedThread}). */
export async function watchedThreadKeys(): Promise<ReadonlySet<string>> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (locks === undefined) return new Set();
  try {
    const { held } = await locks.query();
    return new Set(
      (held ?? [])
        .map((lock) => lock.name)
        .filter((name): name is string => name?.startsWith(WATCHING_LOCK_PREFIX) === true)
        .map((name) => name.slice(WATCHING_LOCK_PREFIX.length)),
    );
  } catch {
    return new Set();
  }
}

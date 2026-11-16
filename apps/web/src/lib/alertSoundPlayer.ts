/**
 * Makes the alert sounds (alertSound.ts) and keeps the app's other tabs and
 * windows on this device from making them too.
 *
 * The sounds are synthesized with Web Audio, so there are no audio files:
 * "done" is two soft rising notes, "attention" two taps on one higher note.
 * The audio context is suspended between sounds, so an idle app runs no
 * audio thread. Until a click, tap or key press a browser may refuse to start
 * it; then the sound is skipped, quietly.
 *
 * Only a tab whose audio has started claims a sound, so a tab that can't play
 * never silences one that can. Tabs coordinate through Web Locks, which every
 * tab of this origin shares and which a closed or crashed tab gives back by
 * itself:
 * - one lock is held while a sound plays and for the gap after it, so of the
 *   tabs that all saw the same change only the first plays, and nothing
 *   plays more often than once a gap;
 * - a tab whose thread is on an attended screen holds a lock named for that
 *   thread, so every tab knows it is being watched.
 * Web Locks need a secure context, so an app opened over plain HTTP (a
 * computer's address on the local network) uses a BroadcastChannel instead:
 * tabs say which thread they are watching, and a tab about to play says so,
 * the earliest-named tab winning a tie.
 */
import type { AlertSound } from "./alertSound";

/** At most one sound this often, across every tab. */
export const ALERT_SOUND_GAP_MS = 1_500;

const PLAY_LOCK = "threadlines:alert-sound";
const WATCHING_LOCK_PREFIX = "threadlines:alert-sound:watching:";
const CHANNEL_NAME = "threadlines:alert-sound";
/** How long a suspended audio context gets to start before the sound is skipped. */
const RESUME_WAIT_MS = 300;
/** Loudness of the whole sound, out of 1. */
const MASTER_GAIN = 0.12;
/** Without Web Locks: how long a tab about to play listens for another that is too. */
const CLAIM_WAIT_MS = 60;
/** Without Web Locks: how often a watching tab says so again, and how long that holds. */
const WATCHING_RENEW_MS = 30_000;
const WATCHING_STALE_MS = 90_000;

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

// ----- audio -----------------------------------------------------------------------

let context: AudioContext | null = null;
/** The audio context has run once: the browser lets this page make sound. */
let primed = false;
/** Sounds playing in this tab; the context rests once none are. */
let playing = 0;

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

/** Whether it runs now (read afresh after an await), noting that it has run once. */
function isRunning(audio: AudioContext): boolean {
  const running = audio.state === "running";
  if (running) primed = true;
  return running;
}

/** Suspends the context unless a sound is playing. */
function rest(audio: AudioContext) {
  if (playing === 0) void audio.suspend().catch(() => undefined);
}

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

/** Plays `sound` on a started context, then lets it rest. */
async function playOn(audio: AudioContext, sound: AlertSound): Promise<void> {
  playing += 1;
  try {
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
  } finally {
    playing -= 1;
    rest(audio);
  }
}

// ----- tabs without Web Locks ------------------------------------------------------

type ChannelMessage =
  | { readonly type: "hello" }
  | { readonly type: "watching"; readonly tab: string; readonly threadKey: string | null }
  | { readonly type: "claim"; readonly tab: string };

// Not crypto.randomUUID: that needs a secure context too.
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let channel: BroadcastChannel | null | undefined;
/** What each other tab last said it watches, and when. */
const watchedByTab = new Map<string, { readonly threadKey: string; readonly at: number }>();
let watchingHere: string | null = null;
/** When this tab last played, or heard another tab claim a sound. */
let lastSoundAt = Number.NEGATIVE_INFINITY;
let claiming = false;
const rivals = new Set<string>();

const webLocks = (): LockManager | undefined =>
  typeof navigator === "undefined" ? undefined : navigator.locks;

function post(message: ChannelMessage) {
  tabChannel()?.postMessage(message);
}

function tabChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof BroadcastChannel !== "function") return (channel = null);
  const opened = new BroadcastChannel(CHANNEL_NAME);
  channel = opened;
  opened.addEventListener("message", (event: MessageEvent<ChannelMessage>) => {
    const message = event.data;
    switch (message.type) {
      case "hello":
        if (watchingHere !== null) post({ type: "watching", tab: TAB_ID, threadKey: watchingHere });
        return;
      case "watching":
        if (message.threadKey === null) watchedByTab.delete(message.tab);
        else watchedByTab.set(message.tab, { threadKey: message.threadKey, at: Date.now() });
        return;
      case "claim":
        lastSoundAt = Date.now();
        if (claiming) rivals.add(message.tab);
        return;
    }
  });
  window.addEventListener("pagehide", () => {
    if (watchingHere !== null) post({ type: "watching", tab: TAB_ID, threadKey: null });
  });
  // Tabs already open say what they watch.
  post({ type: "hello" });
  return channel;
}

/** Claims the next sound through the channel: false when another tab has or will. */
async function claimByChannel(): Promise<boolean> {
  if (claiming || Date.now() - lastSoundAt < ALERT_SOUND_GAP_MS) return false;
  claiming = true;
  rivals.clear();
  post({ type: "claim", tab: TAB_ID });
  await sleep(CLAIM_WAIT_MS);
  claiming = false;
  if ([...rivals].some((tab) => tab < TAB_ID)) return false;
  lastSoundAt = Date.now();
  return true;
}

/**
 * Starts listening to the app's other tabs when there are no Web Locks, so
 * what they say they watch is known before this tab first asks.
 */
export function joinAlertSoundTabs(): void {
  if (webLocks() === undefined) tabChannel();
}

// ----- playing ---------------------------------------------------------------------

/**
 * Plays `sound` unless this tab can't make sound right now, or another tab of
 * the app (or this one) played one within the gap.
 */
export async function playAlertSound(sound: AlertSound): Promise<void> {
  const audio = await startedContext();
  if (audio === null) return;
  const locks = webLocks();
  if (locks === undefined) {
    if (await claimByChannel()) await playOn(audio, sound);
    else rest(audio);
    return;
  }
  let played = false;
  await locks
    .request(PLAY_LOCK, { ifAvailable: true }, async (lock) => {
      if (lock === null) return;
      played = true;
      await Promise.all([playOn(audio, sound), sleep(ALERT_SOUND_GAP_MS)]);
    })
    .catch(() => undefined);
  if (!played) rest(audio);
}

/** Plays `sound` now, in this tab: the Settings switch's preview, from the user's own click. */
export function previewAlertSound(sound: AlertSound): void {
  void startedContext().then((audio) => (audio === null ? undefined : playOn(audio, sound)));
}

/**
 * Starts the audio context on a click, tap or key press, the moments a browser
 * allows it, then lets it rest. Some browsers (Safari) only start one later
 * if it was first started that way. Listens until the context has run once.
 * Returns a cleanup.
 */
export function primeAlertSound(): () => void {
  if (primed) return () => undefined;
  // Touch's pointerdown doesn't count as a user's go-ahead; these do.
  const events = ["pointerup", "touchend", "click", "keydown"] as const;
  const stop = () => {
    for (const event of events) window.removeEventListener(event, prime, true);
  };
  function prime() {
    const audio = audioContext();
    if (audio === null || primed) {
      stop();
      return;
    }
    void audio
      .resume()
      .then(() => {
        if (!isRunning(audio)) return;
        stop();
        rest(audio);
      })
      .catch(() => undefined);
  }
  for (const event of events) window.addEventListener(event, prime, true);
  return stop;
}

// ----- watching --------------------------------------------------------------------

/**
 * Marks `threadKey` as watched (open on an attended screen) for every tab,
 * until the returned release is called. Null marks nothing.
 */
export function holdWatchedThread(threadKey: string | null): () => void {
  if (threadKey === null) return () => undefined;
  const locks = webLocks();
  if (locks === undefined) {
    if (tabChannel() === null) return () => undefined;
    watchingHere = threadKey;
    const say = () => post({ type: "watching", tab: TAB_ID, threadKey });
    say();
    const renew = window.setInterval(say, WATCHING_RENEW_MS);
    return () => {
      window.clearInterval(renew);
      if (watchingHere !== threadKey) return;
      watchingHere = null;
      post({ type: "watching", tab: TAB_ID, threadKey: null });
    };
  }
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

/** The threads some tab of the app marks as watched ({@link holdWatchedThread}). */
export async function watchedThreadKeys(): Promise<ReadonlySet<string>> {
  const locks = webLocks();
  if (locks === undefined) {
    const now = Date.now();
    return new Set(
      [...watchedByTab.values()]
        .filter((watched) => now - watched.at < WATCHING_STALE_MS)
        .map((watched) => watched.threadKey),
    );
  }
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

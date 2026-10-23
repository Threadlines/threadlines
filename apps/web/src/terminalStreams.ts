/**
 * The terminal event streams of each environment (docs/terminal.md).
 *
 * A connection subscribes once to every thread's tab lists and activity (the
 * `metadata` stream, see connectTerminalStreams). A thread's output comes on
 * its own stream, open while something shows that thread's terminals (its
 * drawer, a row in the running list): acquireTerminalThreadStream. Output is
 * kept here, a few hundred events per tab, never in a React store.
 *
 * Servers from before tab lists ignore the mode and send everything on the
 * first stream; output is then taken from there and the per-thread streams
 * are closed. A server says which kind it is (`terminalTabLists` among its
 * capabilities, see noteTerminalServerCapabilities), and a new one always
 * starts the stream with `catalog`, so the first event tells too. Both are
 * asked again whenever the stream comes back: the server may have changed.
 */
import type {
  EnvironmentId,
  ExecutionEnvironmentCapabilities,
  TerminalEvent,
  TerminalStreamEvent,
  TerminalSubscribeInput,
} from "@threadlines/contracts";
import { useEffect, useSyncExternalStore } from "react";

export type TerminalProtocol = "unknown" | "catalog" | "legacy";

export interface TerminalEventEntry {
  readonly id: number;
  readonly event: TerminalEvent;
}

/** The part of the RPC client this module needs. */
export interface TerminalStreamClient {
  readonly terminal: {
    readonly onEvent: (
      input: TerminalSubscribeInput,
      listener: (event: TerminalStreamEvent) => void,
      options?: { readonly onResubscribe?: () => void },
    ) => () => void;
  };
}

const MAX_BUFFERED_EVENTS_PER_TERMINAL = 500;

interface DroppedThrough {
  readonly id: number;
  readonly createdAt: string;
}

interface TerminalBuffer {
  entries: TerminalEventEntry[];
  /** The newest event dropped for room: a viewer that never applied it redraws instead. */
  droppedThrough: DroppedThrough | null;
  listeners: Set<() => void>;
}

interface ThreadStream {
  refs: number;
  unsubscribe: (() => void) | null;
  /** The server said nothing printed from here on can be missed (`subscribed`). */
  live: boolean;
  /**
   * Bumped whenever this thread's tabs must be drawn again from the server:
   * a new subscription (a reconnect, a restarted server) or a `resync`.
   */
  epoch: number;
  buffers: Map<string, TerminalBuffer>;
  /** The tabs the server lists for the thread (null until it has said). */
  listed: ReadonlySet<string> | null;
  listeners: Set<() => void>;
}

interface EnvironmentStreams {
  client: TerminalStreamClient | null;
  protocol: TerminalProtocol;
  /** What the server says about itself: it keeps tab lists (null until it has said). */
  tabLists: boolean | null;
  threads: Map<string, ThreadStream>;
  unsubscribeMetadata: () => void;
}

const environments = new Map<EnvironmentId, EnvironmentStreams>();
let nextEntryId = 1;

function environmentStreams(environmentId: EnvironmentId): EnvironmentStreams {
  const existing = environments.get(environmentId);
  if (existing) return existing;
  const created: EnvironmentStreams = {
    client: null,
    protocol: "unknown",
    tabLists: null,
    threads: new Map(),
    unsubscribeMetadata: () => undefined,
  };
  environments.set(environmentId, created);
  return created;
}

/**
 * A thread's entry, made on first use by whichever comes first: the holder
 * of its stream or a tab listening for output (a drawer's tabs mount before
 * the drawer's own effect takes the stream).
 */
function threadStream(env: EnvironmentStreams, threadId: string): ThreadStream {
  const existing = env.threads.get(threadId);
  if (existing) return existing;
  const created: ThreadStream = {
    refs: 0,
    unsubscribe: null,
    live: false,
    epoch: 0,
    buffers: new Map(),
    listed: null,
    listeners: new Set(),
  };
  env.threads.set(threadId, created);
  return created;
}

function notifyThread(stream: ThreadStream): void {
  for (const listener of stream.listeners) listener();
}

function pushEntry(stream: ThreadStream, event: TerminalEvent): void {
  let buffer = stream.buffers.get(event.terminalId);
  if (!buffer) {
    // The last words of a tab closed elsewhere, after the list said so:
    // nothing will show them.
    if (stream.listed !== null && !stream.listed.has(event.terminalId)) return;
    buffer = { entries: [], droppedThrough: null, listeners: new Set() };
    stream.buffers.set(event.terminalId, buffer);
  }
  buffer.entries.push({ id: nextEntryId++, event });
  if (buffer.entries.length > MAX_BUFFERED_EVENTS_PER_TERMINAL) {
    const dropped = buffer.entries.shift();
    if (dropped) buffer.droppedThrough = { id: dropped.id, createdAt: dropped.event.createdAt };
  }
  for (const listener of buffer.listeners) listener();
}

function closeThreadStream(stream: ThreadStream): void {
  stream.unsubscribe?.();
  stream.unsubscribe = null;
  stream.live = false;
}

function openThreadStream(env: EnvironmentStreams, threadId: string, stream: ThreadStream): void {
  if (env.client === null || env.protocol === "legacy" || stream.unsubscribe !== null) return;
  stream.live = false;
  stream.unsubscribe = env.client.terminal.onEvent(
    { mode: "thread", threadId },
    (event) => {
      if (event.type === "subscribed") {
        if (event.threadId !== threadId) return;
        stream.live = true;
        stream.epoch += 1;
        notifyThread(stream);
        return;
      }
      // An older server ignores the mode and sends every thread, no marker.
      if (!stream.live) return;
      if (event.type === "resync") {
        stream.epoch += 1;
        notifyThread(stream);
        return;
      }
      if (!("terminalId" in event) || event.threadId !== threadId || stream.refs === 0) return;
      pushEntry(stream, event);
    },
    {
      onResubscribe: () => {
        stream.live = false;
        notifyThread(stream);
      },
    },
  );
}

/** Switches how output comes; the caller notifies once its event is applied. */
function setProtocol(env: EnvironmentStreams, protocol: TerminalProtocol): void {
  env.protocol = protocol;
  for (const [threadId, stream] of env.threads) {
    if (protocol === "legacy") {
      closeThreadStream(stream);
      // Output now comes on the connection's one stream: draw from here.
      stream.epoch += 1;
    } else if (protocol === "catalog" && stream.refs > 0) {
      openThreadStream(env, threadId, stream);
    }
  }
}

function notifyEnvironment(env: EnvironmentStreams): void {
  for (const stream of env.threads.values()) notifyThread(stream);
}

/** A server that says it keeps no tab lists sends everything on one stream. */
function settleProtocolFromServer(env: EnvironmentStreams): void {
  if (env.client === null || env.protocol !== "unknown" || env.tabLists !== false) return;
  setProtocol(env, "legacy");
  notifyEnvironment(env);
}

/** Forgets the events of tabs the server no longer lists that nothing shows. */
function noteListedTabs(stream: ThreadStream, terminalIds: ReadonlyArray<string>): void {
  const listed = new Set(terminalIds);
  stream.listed = listed;
  for (const [terminalId, buffer] of stream.buffers) {
    if (!listed.has(terminalId) && buffer.listeners.size === 0) stream.buffers.delete(terminalId);
  }
}

function noteTabsEvent(env: EnvironmentStreams, event: TerminalStreamEvent): void {
  if (event.type === "tabs") {
    const stream = env.threads.get(event.threadId);
    if (stream)
      noteListedTabs(
        stream,
        event.tabs.map((tab) => tab.terminalId),
      );
    return;
  }
  if (event.type !== "catalog") return;
  const tabsByThread = new Map(event.threads.map((thread) => [thread.threadId, thread.tabs]));
  for (const [threadId, stream] of env.threads) {
    noteListedTabs(
      stream,
      (tabsByThread.get(threadId) ?? []).map((tab) => tab.terminalId),
    );
  }
}

/**
 * What the connected server says about itself (its descriptor): one without
 * tab lists sends everything on one stream, so output is taken from there
 * straight away rather than after its first event.
 */
export function noteTerminalServerCapabilities(
  environmentId: EnvironmentId,
  capabilities: ExecutionEnvironmentCapabilities,
): void {
  const env = environmentStreams(environmentId);
  const tabLists = capabilities.terminalTabLists === true;
  if (env.tabLists === tabLists) return;
  env.tabLists = tabLists;
  if (env.client !== null && env.protocol === "unknown" && !tabLists) {
    settleProtocolFromServer(env);
    return;
  }
  // Whether a tab may open before the server says more changed.
  notifyEnvironment(env);
}

/**
 * Subscribes an environment's connection to its terminals, returning the
 * unsubscribe. `onEvent` gets tab lists, activity and lifecycle events
 * (output stays here).
 */
export function connectTerminalStreams(
  environmentId: EnvironmentId,
  client: TerminalStreamClient,
  onEvent: (event: TerminalStreamEvent) => void,
): () => void {
  const env = environmentStreams(environmentId);
  env.unsubscribeMetadata();
  for (const stream of env.threads.values()) closeThreadStream(stream);
  env.client = client;
  env.protocol = "unknown";

  const unsubscribe = client.terminal.onEvent(
    { mode: "metadata" },
    (event) => {
      // Only a server with tab lists sends `catalog`, whatever was assumed.
      const detected =
        event.type === "catalog" ? "catalog" : env.protocol === "unknown" ? "legacy" : null;
      const switched = detected !== null && detected !== env.protocol;
      if (switched) setProtocol(env, detected);
      noteTabsEvent(env, event);
      if (env.protocol === "legacy" && "terminalId" in event) {
        const stream = env.threads.get(event.threadId);
        if (stream && stream.refs > 0) pushEntry(stream, event);
      }
      onEvent(event);
      // After the tab lists are in, so a tab opened now finds itself listed.
      if (switched) notifyEnvironment(env);
    },
    {
      onResubscribe: () => {
        // The server may have been replaced by an older or newer one: ask
        // again (its first event, or what it says about itself next).
        env.protocol = "unknown";
        env.tabLists = null;
        notifyEnvironment(env);
      },
    },
  );
  env.unsubscribeMetadata = unsubscribe;
  for (const [threadId, stream] of env.threads) openThreadStream(env, threadId, stream);
  settleProtocolFromServer(env);

  return () => {
    if (env.client !== client) return;
    unsubscribe();
    env.unsubscribeMetadata = () => undefined;
    for (const stream of env.threads.values()) closeThreadStream(stream);
    env.client = null;
    env.protocol = "unknown";
  };
}

/** Whether the environment's server keeps tab lists (null until it is known). */
export function readTerminalProtocol(environmentId: EnvironmentId): TerminalProtocol {
  return environments.get(environmentId)?.protocol ?? "unknown";
}

/** Keeps a thread's output coming while held; returns the release. */
export function acquireTerminalThreadStream(
  environmentId: EnvironmentId,
  threadId: string,
): () => void {
  const env = environmentStreams(environmentId);
  const held = threadStream(env, threadId);
  held.refs += 1;
  if (held.refs === 1) openThreadStream(env, threadId, held);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs -= 1;
    if (held.refs > 0) return;
    closeThreadStream(held);
    // Nothing shows the thread now: let its output go (listeners stay).
    for (const buffer of held.buffers.values()) {
      buffer.entries = [];
      buffer.droppedThrough = null;
    }
  };
}

export interface TerminalThreadStreamState {
  /** Opening a tab now can't miss its output, and finds the server's tab list in. */
  readonly ready: boolean;
  /**
   * Nothing says yet whether the server keeps tab lists: a tab opens after a
   * moment even if `ready` never comes (an older server never says so).
   */
  readonly unsure: boolean;
  /** Changes whenever the thread's tabs must be drawn again from the server. */
  readonly epoch: number;
}

const NOT_READY: TerminalThreadStreamState = { ready: false, unsure: true, epoch: 0 };
const threadStateCache = new WeakMap<ThreadStream, TerminalThreadStreamState>();

export function readTerminalThreadStreamState(
  environmentId: EnvironmentId,
  threadId: string,
): TerminalThreadStreamState {
  const env = environments.get(environmentId);
  const stream = env?.threads.get(threadId);
  if (!env || !stream) return NOT_READY;
  const ready = env.protocol === "legacy" || (env.protocol === "catalog" && stream.live);
  const unsure = env.protocol === "unknown" && env.tabLists !== true;
  const cached = threadStateCache.get(stream);
  if (
    cached &&
    cached.ready === ready &&
    cached.unsure === unsure &&
    cached.epoch === stream.epoch
  ) {
    return cached;
  }
  const next = { ready, unsure, epoch: stream.epoch };
  threadStateCache.set(stream, next);
  return next;
}

function subscribeThreadState(
  environmentId: EnvironmentId,
  threadId: string,
  listener: () => void,
): () => void {
  const stream = threadStream(environmentStreams(environmentId), threadId);
  stream.listeners.add(listener);
  return () => {
    stream.listeners.delete(listener);
  };
}

/**
 * Holds a thread's output stream while mounted (when `enabled`) and returns
 * whether opening its tabs is safe yet, and the epoch to redraw them on.
 */
export function useTerminalThreadStream(
  environmentId: EnvironmentId,
  threadId: string,
  enabled = true,
): TerminalThreadStreamState {
  useEffect(() => {
    if (!enabled) return;
    return acquireTerminalThreadStream(environmentId, threadId);
  }, [enabled, environmentId, threadId]);
  return useSyncExternalStore(
    (listener) => subscribeThreadState(environmentId, threadId, listener),
    () => readTerminalThreadStreamState(environmentId, threadId),
  );
}

export interface TerminalBufferView {
  readonly entries: ReadonlyArray<TerminalEventEntry>;
  readonly droppedThrough: DroppedThrough | null;
}

const EMPTY_BUFFER: TerminalBufferView = { entries: [], droppedThrough: null };

/** What a tab printed recently, while its thread's stream is held. */
export function readTerminalBuffer(
  environmentId: EnvironmentId,
  threadId: string,
  terminalId: string,
): TerminalBufferView {
  return (
    environments.get(environmentId)?.threads.get(threadId)?.buffers.get(terminalId) ?? EMPTY_BUFFER
  );
}

/** Calls `listener` for each new event of a tab; returns the unsubscribe. */
export function subscribeTerminalBuffer(
  environmentId: EnvironmentId,
  threadId: string,
  terminalId: string,
  listener: () => void,
): () => void {
  const stream = threadStream(environmentStreams(environmentId), threadId);
  let buffer = stream.buffers.get(terminalId);
  if (!buffer) {
    buffer = { entries: [], droppedThrough: null, listeners: new Set() };
    stream.buffers.set(terminalId, buffer);
  }
  const held = buffer;
  held.listeners.add(listener);
  return () => {
    held.listeners.delete(listener);
    // A tab closed elsewhere: nothing will show its events again.
    if (
      held.listeners.size === 0 &&
      stream.listed !== null &&
      !stream.listed.has(terminalId) &&
      stream.buffers.get(terminalId) === held
    ) {
      stream.buffers.delete(terminalId);
    }
  };
}

/** Forgets a closed tab's events. */
export function dropTerminalBuffer(
  environmentId: EnvironmentId,
  threadId: string,
  terminalId: string,
): void {
  environments.get(environmentId)?.threads.get(threadId)?.buffers.delete(terminalId);
}

/** Test seam: forget every environment. */
export function resetTerminalStreamsForTests(): void {
  for (const env of environments.values()) {
    env.unsubscribeMetadata();
    for (const stream of env.threads.values()) closeThreadStream(stream);
  }
  environments.clear();
}

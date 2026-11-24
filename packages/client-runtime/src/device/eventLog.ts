// @effect-diagnostics globalTimers:off - Browser transport code, run without an Effect runtime.
/**
 * An iOS Simulator's recent events, as serve-sim logs them
 * (`/vendor/serve-sim/api/event-log/events?device=<udid>`, a server-sent
 * event stream). Read through the device channel like every other hub route:
 * the response body is read as it arrives and parsed here, never with
 * `EventSource`, which cannot ride the channel. Ported from T3 Code's
 * `subscribeDeviceEventLog`.
 */
import type { DeviceHubTransport } from "./hubTransport.ts";

export interface DeviceEventLogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly kind: string;
  readonly summary: string;
}

/** How many entries the log keeps: the newest ones. */
export const DEVICE_EVENT_LOG_LIMIT = 100;
/** Wait before reading again after the stream ends or fails. */
const RETRY_MS = 3_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function toEntry(raw: unknown): DeviceEventLogEntry | null {
  if (!isRecord(raw) || typeof raw.id !== "number") return null;
  return {
    id: raw.id,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : "",
    kind: typeof raw.kind === "string" ? raw.kind : "",
    summary:
      typeof raw.summary === "string" ? raw.summary : typeof raw.msg === "string" ? raw.msg : "",
  };
}

/**
 * One SSE message's data, read as serve-sim sends it: `{events: [...]}`
 * replaces the log (the backlog when the stream opens), `{event}` adds one.
 * Null for anything else.
 */
export function parseDeviceEventLogMessage(
  data: string,
): { readonly entries: ReadonlyArray<DeviceEventLogEntry>; readonly reset: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (Array.isArray(parsed.events)) {
    return { entries: parsed.events.flatMap((raw) => toEntry(raw) ?? []), reset: true };
  }
  const entry = toEntry(parsed.event);
  return entry ? { entries: [entry], reset: false } : null;
}

/** The log after a batch: a reset replaces it, and only the newest LIMIT stay. */
export function appendDeviceEventLog(
  current: ReadonlyArray<DeviceEventLogEntry>,
  incoming: ReadonlyArray<DeviceEventLogEntry>,
  reset: boolean,
): ReadonlyArray<DeviceEventLogEntry> {
  const merged = reset ? [...incoming] : [...current, ...incoming];
  return merged.length > DEVICE_EVENT_LOG_LIMIT ? merged.slice(-DEVICE_EVENT_LOG_LIMIT) : merged;
}

/** Max buffered characters in one unfinished SSE message/line before resetting. */
const MAX_SSE_BUFFER_CHARS = 1024 * 1024;

/**
 * Splits a server-sent event stream into the data of each message. Feed it
 * text as it arrives; it calls `onData` once per complete message.
 */
export function createSseParser(onData: (data: string) => void) {
  let buffer = "";
  let data: string[] = [];
  let dataChars = 0;
  let sawTrailingCr = false;
  const line = (text: string) => {
    if (text === "") {
      if (data.length > 0) onData(data.join("\n"));
      data = [];
      dataChars = 0;
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    if (field !== "data") return;
    const value = colon < 0 ? "" : text.slice(colon + 1);
    const trimmed = value.startsWith(" ") ? value.slice(1) : value;
    dataChars += trimmed.length;
    if (dataChars > MAX_SSE_BUFFER_CHARS) {
      data = [];
      dataChars = 0;
      return;
    }
    data.push(trimmed);
  };
  return (chunk: string) => {
    let incoming = chunk;
    if (sawTrailingCr) {
      sawTrailingCr = false;
      if (incoming.startsWith("\n")) incoming = incoming.slice(1);
    }
    buffer += incoming;
    if (buffer.length > MAX_SSE_BUFFER_CHARS) {
      buffer = "";
      data = [];
      dataChars = 0;
      return;
    }
    let end = buffer.search(/\r\n|\r|\n/);
    while (end >= 0) {
      const isCrAtEnd = buffer[end] === "\r" && end === buffer.length - 1;
      const breakLength = buffer.startsWith("\r\n", end) ? 2 : 1;
      line(buffer.slice(0, end));
      buffer = buffer.slice(end + breakLength);
      if (isCrAtEnd) sawTrailingCr = true;
      end = buffer.search(/\r\n|\r|\n/);
    }
  };
}

/**
 * Follows a simulator's event log until the returned stop, which cancels the
 * request. `onEvents` gets each batch; `reset` means it replaces what came
 * before. A stream that ends or fails is read again after a short wait, and
 * that read starts with a fresh backlog (a reset).
 */
export function subscribeDeviceEventLog(
  transport: DeviceHubTransport,
  deviceId: string,
  onEvents: (entries: ReadonlyArray<DeviceEventLogEntry>, reset: boolean) => void,
  onError?: (failed: boolean) => void,
): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const read = async () => {
    controller = new AbortController();
    const { signal } = controller;
    try {
      const response = await transport.fetch(
        `/vendor/serve-sim/api/event-log/events?device=${encodeURIComponent(deviceId)}&limit=${DEVICE_EVENT_LOG_LIMIT}`,
        { signal },
      );
      if (stopped) {
        await response.body?.cancel().catch(() => {});
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`The event log answered with status ${response.status}.`);
      }
      onError?.(false);
      const decoder = new TextDecoder();
      const feed = createSseParser((data) => {
        const message = parseDeviceEventLogMessage(data);
        if (message && !stopped) onEvents(message.entries, message.reset);
      });
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        feed(decoder.decode(value, { stream: true }));
      }
      if (stopped) await reader.cancel().catch(() => {});
    } catch {
      if (!stopped) onError?.(true);
    }
    if (!stopped) timer = setTimeout(() => void read(), RETRY_MS);
  };

  void read();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    controller?.abort();
  };
}

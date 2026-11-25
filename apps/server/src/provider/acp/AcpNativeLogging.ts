import type { ProviderDriverKind, ThreadId } from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Effect from "effect/Effect";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { AcpSessionRequestLogEvent, AcpSessionRuntimeOptions } from "./AcpSessionRuntime.ts";

const ACP_STREAM_FRAGMENT_SESSION_UPDATES = new Set<string>([
  "agent_message_chunk",
  "agent_thought_chunk",
]);

function isAcpStreamFragmentRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as {
    readonly _tag?: unknown;
    readonly tag?: unknown;
    readonly method?: unknown;
    readonly params?: { readonly update?: { readonly sessionUpdate?: unknown } };
    readonly payload?: { readonly update?: { readonly sessionUpdate?: unknown } };
  };
  let sessionUpdate: unknown;
  if (record.method === "session/update") {
    sessionUpdate = record.params?.update?.sessionUpdate;
  } else if (record._tag === "Request" && record.tag === "session/update") {
    sessionUpdate = record.payload?.update?.sessionUpdate;
  } else {
    return false;
  }
  return (
    typeof sessionUpdate === "string" && ACP_STREAM_FRAGMENT_SESSION_UPDATES.has(sessionUpdate)
  );
}

const MAX_BUFFERED_RAW_LINE_CHARS = 2 * 1024 * 1024;

function isRawStreamFragmentLine(line: string): boolean {
  if (!line.includes('"agent_message_chunk"') && !line.includes('"agent_thought_chunk"')) {
    return false;
  }
  try {
    return isAcpStreamFragmentRecord(JSON.parse(line) as unknown);
  } catch {
    return false;
  }
}

function isAcpProtocolStreamFragment(event: EffectAcpProtocol.AcpProtocolLogEvent): boolean {
  if (event.direction !== "incoming") return false;
  const payload = event.payload;
  if (event.stage === "raw" && typeof payload === "string") {
    const lines = payload.split("\n");
    let sawLine = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      sawLine = true;
      if (!isRawStreamFragmentLine(line)) {
        return false;
      }
    }
    return sawLine;
  }
  if (event.stage === "decoded") {
    if (Array.isArray(payload)) {
      return payload.length > 0 && payload.every(isAcpStreamFragmentRecord);
    }
    return isAcpStreamFragmentRecord(payload);
  }
  return false;
}

function writeNativeAcpLog(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly kind: "request" | "protocol";
  readonly payload: unknown;
  readonly streamFragment?: boolean;
}): Effect.Effect<void, never> {
  if (
    !input.nativeEventLogger ||
    (input.streamFragment === true && input.nativeEventLogger.keepsStreamFragments === false)
  ) {
    return Effect.void;
  }
  const logger = input.nativeEventLogger;
  return Effect.gen(function* () {
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    yield* logger.write(
      {
        observedAt,
        event: {
          id: yield* randomUUIDv4,
          kind: input.kind,
          provider: input.provider,
          createdAt: observedAt,
          threadId: input.threadId,
          payload: input.payload,
        },
      },
      input.threadId,
      input.streamFragment === true ? { streamFragment: true } : undefined,
    );
  });
}

import { ACP_MCP_BRIDGE_AUTH_ENV } from "./acpMcpStdioBridge.ts";

const BEARER_TOKEN = /Bearer\s+[^\s"\\]+/gu;

/**
 * session/new and session/load carry Threadlines' MCP servers with a bearer
 * credential for the thread (in HTTP headers or stdio-bridge env). Provider
 * logs keep the header/env name, never the token: whoever holds it can drive
 * that thread's tools.
 */
export function redactAcpLogCredentials(value: unknown): unknown {
  if (typeof value === "string") {
    return value.includes("Bearer") ? value.replace(BEARER_TOKEN, "Bearer [redacted]") : value;
  }
  if (Array.isArray(value)) {
    let next: Array<unknown> | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      const redacted = redactAcpLogCredentials(entry);
      if (redacted !== entry) {
        next ??= value.slice(0, index);
      }
      if (next !== undefined) {
        next.push(redacted);
      }
    }
    return next ?? value;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (
      typeof record.name === "string" &&
      record.name === ACP_MCP_BRIDGE_AUTH_ENV &&
      typeof record.value === "string"
    ) {
      return { ...record, value: "[redacted]" };
    }
    const keys = Object.keys(record);
    let result: Record<string, unknown> | undefined;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      const entry = record[key];
      const redacted = redactAcpLogCredentials(entry);
      if (redacted !== entry) {
        if (result === undefined) {
          result = {};
          for (let prev = 0; prev < index; prev += 1) {
            const prevKey = keys[prev]!;
            result[prevKey] = record[prevKey];
          }
        }
      }
      if (result !== undefined) {
        result[key] = redacted;
      }
    }
    return result ?? value;
  }
  return value;
}

function formatRequestLogPayload(event: AcpSessionRequestLogEvent) {
  return {
    method: event.method,
    status: event.status,
    request: redactAcpLogCredentials(event.payload),
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.cause !== undefined ? { cause: Cause.pretty(event.cause) } : {}),
  };
}

export function makeAcpNativeLoggers(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
}): Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> {
  if (!input.nativeEventLogger) {
    return {};
  }
  const nativeEventLogger = input.nativeEventLogger;
  const dropFragments = nativeEventLogger.keepsStreamFragments === false;
  let rawIncomingRemainder = "";
  return {
    requestLogger: (event) =>
      writeNativeAcpLog({
        nativeEventLogger,
        provider: input.provider,
        threadId: input.threadId,
        kind: "request",
        payload: formatRequestLogPayload(event),
      }),
    protocolLogging: {
      logIncoming: true,
      logOutgoing: true,
      logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) => {
        if (dropFragments && event.direction === "incoming") {
          if (event.stage === "raw" && typeof event.payload === "string") {
            const combined = rawIncomingRemainder + event.payload;
            const newlineIndex = combined.lastIndexOf("\n");
            if (newlineIndex === -1) {
              if (combined.length > MAX_BUFFERED_RAW_LINE_CHARS) {
                rawIncomingRemainder = "";
                return writeNativeAcpLog({
                  nativeEventLogger,
                  provider: input.provider,
                  threadId: input.threadId,
                  kind: "protocol",
                  payload: { ...event, payload: combined },
                });
              }
              rawIncomingRemainder = combined;
              return Effect.void;
            }
            const complete = combined.slice(0, newlineIndex + 1);
            rawIncomingRemainder = combined.slice(newlineIndex + 1);
            const keptLines: Array<string> = [];
            for (const rawLine of complete.split("\n")) {
              const line = rawLine.trim();
              if (line.length === 0) continue;
              if (!isRawStreamFragmentLine(line)) {
                keptLines.push(rawLine);
              }
            }
            if (keptLines.length === 0) {
              return Effect.void;
            }
            return writeNativeAcpLog({
              nativeEventLogger,
              provider: input.provider,
              threadId: input.threadId,
              kind: "protocol",
              payload: { ...event, payload: `${keptLines.join("\n")}\n` },
            });
          }
          if (event.stage === "decoded") {
            if (Array.isArray(event.payload)) {
              const kept = event.payload.filter((item) => !isAcpStreamFragmentRecord(item));
              if (kept.length === 0) {
                return Effect.void;
              }
              return writeNativeAcpLog({
                nativeEventLogger,
                provider: input.provider,
                threadId: input.threadId,
                kind: "protocol",
                payload: kept.length === event.payload.length ? event : { ...event, payload: kept },
              });
            }
            if (isAcpStreamFragmentRecord(event.payload)) {
              return Effect.void;
            }
          }
        }
        const streamFragment = isAcpProtocolStreamFragment(event);
        if (streamFragment && dropFragments) {
          return Effect.void;
        }
        return writeNativeAcpLog({
          nativeEventLogger,
          provider: input.provider,
          threadId: input.threadId,
          kind: "protocol",
          // Only what Threadlines sends can carry its credential.
          payload:
            event.direction === "outgoing"
              ? { ...event, payload: redactAcpLogCredentials(event.payload) }
              : event,
          streamFragment,
        });
      },
    } satisfies NonNullable<AcpSessionRuntimeOptions["protocolLogging"]>,
  };
}

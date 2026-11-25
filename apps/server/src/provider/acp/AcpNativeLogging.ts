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
    readonly method?: unknown;
    readonly params?: { readonly update?: { readonly sessionUpdate?: unknown } };
  };
  if (record.method !== "session/update") return false;
  const sessionUpdate = record.params?.update?.sessionUpdate;
  return (
    typeof sessionUpdate === "string" && ACP_STREAM_FRAGMENT_SESSION_UPDATES.has(sessionUpdate)
  );
}

function isAcpProtocolStreamFragment(event: EffectAcpProtocol.AcpProtocolLogEvent): boolean {
  if (event.direction !== "incoming") return false;
  const payload = event.payload;
  if (event.stage === "raw" && typeof payload === "string") {
    if (!payload.includes('"agent_message_chunk"') && !payload.includes('"agent_thought_chunk"')) {
      return false;
    }
    const lines = payload.split("\n");
    let sawLine = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      sawLine = true;
      try {
        if (!isAcpStreamFragmentRecord(JSON.parse(line) as unknown)) {
          return false;
        }
      } catch {
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
  return Effect.gen(function* () {
    if (!input.nativeEventLogger) return;
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    yield* input.nativeEventLogger.write(
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
    return value.replace(BEARER_TOKEN, "Bearer [redacted]");
  }
  if (Array.isArray(value)) {
    return value.map(redactAcpLogCredentials);
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
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, redactAcpLogCredentials(entry)]),
    );
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
  return {
    requestLogger: (event) =>
      writeNativeAcpLog({
        nativeEventLogger: input.nativeEventLogger,
        provider: input.provider,
        threadId: input.threadId,
        kind: "request",
        payload: formatRequestLogPayload(event),
      }),
    ...(input.nativeEventLogger
      ? {
          protocolLogging: {
            logIncoming: true,
            logOutgoing: true,
            logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
              writeNativeAcpLog({
                nativeEventLogger: input.nativeEventLogger,
                provider: input.provider,
                threadId: input.threadId,
                kind: "protocol",
                // Only what Threadlines sends can carry its credential.
                payload:
                  event.direction === "outgoing"
                    ? { ...event, payload: redactAcpLogCredentials(event.payload) }
                    : event,
                streamFragment: isAcpProtocolStreamFragment(event),
              }),
          } satisfies NonNullable<AcpSessionRuntimeOptions["protocolLogging"]>,
        }
      : {}),
  };
}

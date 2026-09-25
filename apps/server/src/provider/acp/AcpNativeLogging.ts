import type { ProviderDriverKind, ThreadId } from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Effect from "effect/Effect";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { AcpSessionRequestLogEvent, AcpSessionRuntimeOptions } from "./AcpSessionRuntime.ts";

function writeNativeAcpLog(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly kind: "request" | "protocol";
  readonly payload: unknown;
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
    );
  });
}

const BEARER_TOKEN = /Bearer\s+[^\s"\\]+/gu;

/**
 * session/new and session/load carry the browser MCP server with a bearer
 * credential for the thread. Provider logs keep the header, never the token:
 * whoever holds it can drive that thread's browser.
 */
export function redactAcpLogCredentials(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(BEARER_TOKEN, "Bearer [redacted]");
  }
  if (Array.isArray(value)) {
    return value.map(redactAcpLogCredentials);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactAcpLogCredentials(entry)]),
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
              }),
          } satisfies NonNullable<AcpSessionRuntimeOptions["protocolLogging"]>,
        }
      : {}),
  };
}

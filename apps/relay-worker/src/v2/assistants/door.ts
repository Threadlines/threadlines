// @effect-diagnostics cryptoRandomUUID:off globalTimers:off
import {
  RELAY_ASSISTANT_FRAME_MAX_BYTES,
  RELAY_ASSISTANT_MAX_IN_FLIGHT,
  RELAY_ASSISTANT_REQUEST_TIMEOUT_MS,
  RelayAssistantHostFrame,
  type RelayAssistantRelayFrame,
  type RelayAssistantResponseFrame,
} from "@threadlines/contracts/relayAssistants";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type AssistantAnswer,
  badGateway,
  invalidGrant,
  jsonAnswer,
  mcpBusy,
  mcpDailyLimit,
  mcpDropped,
  mcpOffline,
  mcpRelayBusy,
  mcpTimedOut,
  mcpUnauthorized,
  passedResponseHeaders,
  tokenUnavailable,
} from "./answers.ts";
import { type AssistantHostCore, secondsUntilUtcMidnight } from "./hostAssistants.ts";

/** The computer's end of the assistant socket, as the door uses it. */
export interface AssistantDoorSocket {
  /** Stable for the socket's life (kept on its attachment), so answers match the socket asked. */
  readonly socketId: string;
  /** Throws when the socket can't take it. */
  send(text: string): void;
}

/** An assistant's request whose credential the edge already parsed and whose route tag it checked. */
export interface AssistantDoorRequest {
  readonly route: "mcp" | "token";
  readonly connectionId: string;
  readonly credential: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** What the host's object knows at the moment of a request. */
export interface AssistantDoorState {
  readonly now: number;
  readonly origin: string;
  readonly resource: string;
  readonly dailyRequests: number;
  /** The assistant socket, when the computer is there; null: offline. */
  readonly socket: AssistantDoorSocket | null;
  readonly relayBusy: boolean;
  /** Requests forwarded today that aren't committed to storage yet. */
  readonly uncommittedRequests: number;
  /** Called once per request that went out to the computer. */
  readonly onForwarded: () => void;
}

type Settled =
  | { readonly kind: "response"; readonly frame: RelayAssistantResponseFrame }
  | { readonly kind: "timeout" }
  | { readonly kind: "dropped" };

interface PendingRequest {
  readonly socketId: string;
  readonly settle: (outcome: Settled) => void;
}

/**
 * The relay's half of the assistant socket inside a host's object: refuses
 * what it must (removed connection, offline, allowance, in flight), forwards
 * the rest as `request` frames and matches each `response` frame to its
 * request by id. Pending requests live in memory only: an object with a
 * request in flight is busy, so it doesn't hibernate; a dropped socket fails
 * its requests at once (502), and a computer that never answers times out (504).
 */
export class AssistantDoor {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly core: AssistantHostCore;
  private readonly timeoutMs: number;
  private readonly maxInFlight: number;
  private readonly newId: () => string;

  constructor(
    core: AssistantHostCore,
    options: {
      readonly timeoutMs?: number;
      readonly maxInFlight?: number;
      readonly newId?: () => string;
    } = {},
  ) {
    this.core = core;
    this.timeoutMs = options.timeoutMs ?? RELAY_ASSISTANT_REQUEST_TIMEOUT_MS;
    this.maxInFlight = options.maxInFlight ?? RELAY_ASSISTANT_MAX_IN_FLIGHT;
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  inFlight(): number {
    return this.pending.size;
  }

  async request(input: AssistantDoorRequest, state: AssistantDoorState): Promise<AssistantAnswer> {
    const mcp = input.route === "mcp";
    // Removed connections are refused first, so Remove holds while the computer sleeps.
    if (this.core.isRevoked(input.connectionId)) {
      return mcp ? mcpUnauthorized(state.origin, true) : invalidGrant();
    }
    const socket = state.socket;
    if (!socket) return mcp ? mcpOffline(input.body) : tokenUnavailable();
    if (
      mcp &&
      this.core.requestsToday(state.now) + state.uncommittedRequests >= state.dailyRequests
    ) {
      return mcpDailyLimit(input.body, secondsUntilUtcMidnight(state.now));
    }
    if (state.relayBusy) return mcp ? mcpRelayBusy(input.body) : tokenUnavailable(900);
    if (this.pending.size >= this.maxInFlight) {
      return mcp ? mcpBusy(input.body) : tokenUnavailable(5);
    }

    const id = this.newId();
    const frame = JSON.stringify({
      type: "request",
      id,
      route: input.route,
      credential: input.credential,
      resource: state.resource,
      headers: input.headers,
      body: input.body,
    } satisfies RelayAssistantRelayFrame);
    if (exceedsFrameLimit(frame)) {
      return jsonAnswer(413, { error: "This request is too large for the relay." });
    }

    const settled = await new Promise<Settled>((resolve) => {
      const timer = setTimeout(() => settle({ kind: "timeout" }), this.timeoutMs);
      const settle = (outcome: Settled) => {
        if (this.pending.get(id)?.settle === settle) this.pending.delete(id);
        clearTimeout(timer);
        resolve(outcome);
      };
      this.pending.set(id, { socketId: socket.socketId, settle });
      try {
        socket.send(frame);
      } catch {
        settle({ kind: "dropped" });
        return;
      }
      state.onForwarded();
    });

    switch (settled.kind) {
      case "timeout":
        return mcp ? mcpTimedOut(input.body) : tokenUnavailable();
      case "dropped":
        return mcp ? mcpDropped(input.body) : tokenUnavailable();
      case "response":
        return computerAnswer(input.route, settled.frame);
    }
  }

  /** A `response` frame from the socket `socketId`; false when nothing there was waiting for it. */
  resolve(socketId: string, frame: RelayAssistantResponseFrame): boolean {
    const entry = this.pending.get(frame.id);
    if (!entry || entry.socketId !== socketId) return false;
    entry.settle({ kind: "response", frame });
    return true;
  }

  /** The socket closed or was replaced: every request still waiting on it fails now. */
  dropSocket(socketId: string): void {
    // Settling deletes the entry; a Map iterator carries on past deletions.
    for (const entry of this.pending.values()) {
      if (entry.socketId === socketId) entry.settle({ kind: "dropped" });
    }
  }
}

/** The computer's answer as the assistant gets it: its status, allowed headers and body. */
function computerAnswer(
  route: "mcp" | "token",
  frame: RelayAssistantResponseFrame,
): AssistantAnswer {
  if (frame.status < 200 || frame.status > 599) return badGateway();
  return {
    status: frame.status,
    headers: { "content-type": "application/json", ...passedResponseHeaders(route, frame.headers) },
    body: frame.body,
  };
}

const decodeHostFrame = Schema.decodeUnknownOption(RelayAssistantHostFrame);

export type HostFrameParse =
  | { readonly ok: true; readonly frame: RelayAssistantHostFrame }
  | { readonly ok: false; readonly reason: "binary" | "too-large" | "invalid" };

/** A frame from the computer on the assistant socket: JSON text, at most 768 KiB, one of the contract's shapes. */
export function parseHostFrame(message: string | ArrayBuffer): HostFrameParse {
  if (typeof message !== "string") return { ok: false, reason: "binary" };
  if (exceedsFrameLimit(message)) return { ok: false, reason: "too-large" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const frame = decodeHostFrame(parsed);
  return Option.isSome(frame) ? { ok: true, frame: frame.value } : { ok: false, reason: "invalid" };
}

/** Whether serialized text is over the frame limit, in UTF-8 bytes (encoded only when it could matter). */
export function exceedsFrameLimit(text: string): boolean {
  if (text.length > RELAY_ASSISTANT_FRAME_MAX_BYTES) return true;
  if (text.length * 3 <= RELAY_ASSISTANT_FRAME_MAX_BYTES) return false;
  return new TextEncoder().encode(text).byteLength > RELAY_ASSISTANT_FRAME_MAX_BYTES;
}

/**
 * Who a tool call is allowed to be.
 *
 * The tools take no thread argument, on purpose: an agent that names its own
 * thread is an agent that can name someone else's, and a model has no
 * business deciding whose page it drives or on whose behalf it asks another
 * agent. So the caller comes from the credential the request arrived with,
 * and the credential is minted here, by the code that already knows which
 * runtime it is starting.
 *
 * The endpoints are on loopback, but that is not the reason this exists.
 * Anything running on the machine can reach a loopback port, including the
 * very agents these tools are for -- and one of them wandering into another
 * thread's browser, or a read-only side runtime calling a tool that starts
 * work, is exactly the failure worth ruling out.
 *
 * Each credential also says what it may reach: the browser tools (`/mcp`)
 * and which room tools (`/mcp/room`). A side runtime's credential never
 * reaches the browser; the endpoint checks, so hiding the server from the
 * runtime is not the only guard.
 *
 * Credentials die with their runtime: `revoke(sessionKey, generation)` ends
 * exactly one runtime's credentials, so the late stop of a replaced runtime
 * never takes its successor's.
 */
import type { SideTurnId, ThreadId, ThreadParticipantId } from "@threadlines/contracts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as Effect from "effect/Effect";
import { parseSessionKey } from "@threadlines/shared/threadParticipants";

import { type RoomSideKind, type RoomToolName, roomToolsFor } from "./roomToolAccess.ts";

export interface McpInvocationScope {
  /** The real thread, whatever runtime of it called. */
  readonly threadId: ThreadId;
  /** The runtime's provider session key (main, added agent, or side). */
  readonly sessionKey: ThreadId;
  /** The calling agent. Null: the thread's own agent. */
  readonly participantId: ThreadParticipantId | null;
  /** Which runtime of `sessionKey` minted this. */
  readonly generation: number;
  /** Set for a side runtime: the side turn it answers, and its kind. */
  readonly side?: { readonly sideTurnId: SideTurnId; readonly kind: RoomSideKind } | undefined;
  /** Opaque provider-runtime identity; safe to send to the renderer. */
  readonly agentId: string;
  /** May call the browser tools at `/mcp`. */
  readonly browser: boolean;
  /** May show agent pages at `/mcp/pages` (McpPagesServer). */
  readonly pages: boolean;
  /** Room tools this credential may call at `/mcp/room`. Empty: none. */
  readonly roomTools: ReadonlySet<RoomToolName>;
}

export interface McpCredentialRequest {
  /** The runtime's provider session key. */
  readonly sessionKey: ThreadId;
  /** The browser tools. Never granted to a side runtime, whatever is asked. */
  readonly browser: boolean;
  /** The room tools this runtime's kind allows (see roomToolAccess). */
  readonly room: boolean;
  /** The page tools. Never granted to a side runtime, whatever is asked. */
  readonly pages?: boolean | undefined;
  /**
   * A side runtime's kind. A side key without one is treated as a review,
   * the narrowest.
   */
  readonly sideKind?: RoomSideKind | undefined;
}

export interface McpCredential {
  readonly token: string;
  /** Pass to `revoke` when this runtime stops. */
  readonly generation: number;
}

export interface McpSessionRegistryShape {
  /**
   * Mint the credential for one provider runtime. A room agent's key maps
   * back to its thread, so its browser tools drive the browser the user has
   * open for that thread.
   */
  readonly credentialFor: (request: McpCredentialRequest) => Effect.Effect<McpCredential>;
  readonly resolve: (token: string) => Effect.Effect<McpInvocationScope | null>;
  /**
   * The runtime `generation` of `sessionKey` stopped: its credential stops
   * working. Another runtime of the same key keeps its own.
   */
  readonly revoke: (sessionKey: ThreadId, generation: number) => Effect.Effect<void>;
}

/**
 * One registry for the process, in the shape RealtimeAudioHub already uses.
 *
 * Not a layered service, because threading it through the environment would put
 * it in the requirements of every provider driver -- and a driver does not
 * depend on this, it just needs to ask one question of something the process
 * has exactly one of. The credentials are secrets held in memory; there is no
 * second instance to want.
 */
export const makeMcpSessionRegistry = (): McpSessionRegistryShape => {
  const byToken = new Map<string, McpInvocationScope>();
  let nextGeneration = 1;

  return {
    credentialFor: (request) =>
      Effect.sync(() => {
        // 32 bytes because this is the only thing standing between one agent
        // and another agent's browser, and it costs nothing to make guessing
        // hopeless rather than merely hard.
        const token = randomBytes(32).toString("base64url");
        const generation = nextGeneration++;
        const target = parseSessionKey(request.sessionKey);
        const side =
          target.kind === "side"
            ? { sideTurnId: target.sideTurnId, kind: request.sideKind ?? ("review" as const) }
            : undefined;
        // Locked down if either the key or the caller says so.
        const sideKind = side?.kind ?? request.sideKind;
        byToken.set(token, {
          threadId: target.threadId,
          sessionKey: request.sessionKey,
          participantId: target.participantId,
          generation,
          ...(side !== undefined ? { side } : {}),
          agentId: `agent-${randomBytes(12).toString("base64url")}`,
          browser: request.browser && sideKind === undefined,
          pages: request.pages === true && sideKind === undefined,
          roomTools: new Set(request.room ? roomToolsFor(sideKind) : []),
        });
        return { token, generation };
      }),
    resolve: (token) =>
      Effect.sync(() => {
        if (token === "") {
          return null;
        }
        // Compared against every credential in constant time rather than looked
        // up: a map lookup leaks how much of a guess was right through how long
        // it took, and there are only ever a handful of these.
        const candidate = Buffer.from(token);
        for (const [known, scope] of byToken) {
          const knownBuffer = Buffer.from(known);
          if (knownBuffer.length !== candidate.length) {
            continue;
          }
          if (timingSafeEqual(knownBuffer, candidate)) {
            return scope;
          }
        }
        return null;
      }),
    revoke: (sessionKey, generation) =>
      Effect.sync(() => {
        for (const [token, scope] of byToken) {
          if (scope.sessionKey === sessionKey && scope.generation === generation) {
            byToken.delete(token);
          }
        }
      }),
  };
};

export const mcpSessionRegistry: McpSessionRegistryShape = makeMcpSessionRegistry();

/**
 * Who a tool call is allowed to be.
 *
 * The browser tools take no thread argument, on purpose: an agent that names
 * its own thread is an agent that can name someone else's, and a model has no
 * business deciding whose page it drives. So the thread comes from the
 * credential the request arrived with, and the credential is minted here, by
 * the code that already knows which session it is starting.
 *
 * The endpoint is on loopback, but that is not the reason this exists. Anything
 * running on the machine can reach a loopback port, including the very agents
 * these tools are for -- and one of them wandering into another thread's
 * browser is exactly the failure worth ruling out.
 */
import type { ThreadId } from "@threadlines/contracts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as Effect from "effect/Effect";

export interface McpInvocationScope {
  readonly threadId: ThreadId;
  /** Opaque provider-runtime identity; safe to send to the renderer. */
  readonly agentId: string;
}

export interface McpSessionRegistryShape {
  /** Mint a credential for one provider runtime within a thread. */
  readonly credentialFor: (threadId: ThreadId) => Effect.Effect<string>;
  readonly resolve: (token: string) => Effect.Effect<McpInvocationScope | null>;
  /** Called when a thread's session ends; the credential stops working. */
  readonly revoke: (threadId: ThreadId) => Effect.Effect<void>;
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
  const byThread = new Map<ThreadId, Set<string>>();

  return {
    credentialFor: (threadId) =>
      Effect.sync(() => {
        // 32 bytes because this is the only thing standing between one agent
        // and another agent's browser, and it costs nothing to make guessing
        // hopeless rather than merely hard.
        const token = randomBytes(32).toString("base64url");
        const tokens = byThread.get(threadId) ?? new Set<string>();
        tokens.add(token);
        byThread.set(threadId, tokens);
        byToken.set(token, {
          threadId,
          agentId: `agent-${randomBytes(12).toString("base64url")}`,
        });
        return token;
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
    revoke: (threadId) =>
      Effect.sync(() => {
        const tokens = byThread.get(threadId);
        if (tokens === undefined) {
          return;
        }
        byThread.delete(threadId);
        for (const token of tokens) {
          byToken.delete(token);
        }
      }),
  };
};

export const mcpSessionRegistry: McpSessionRegistryShape = makeMcpSessionRegistry();

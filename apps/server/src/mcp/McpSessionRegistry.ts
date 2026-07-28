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
}

export interface McpSessionRegistryShape {
  /** The credential for a thread, minted on first ask and stable after. */
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
const makeRegistry = (): McpSessionRegistryShape => {
  const byToken = new Map<string, McpInvocationScope>();
  const byThread = new Map<ThreadId, string>();

  return {
    credentialFor: (threadId) =>
      Effect.sync(() => {
        const existing = byThread.get(threadId);
        if (existing !== undefined) {
          return existing;
        }
        // 32 bytes because this is the only thing standing between one agent
        // and another agent's browser, and it costs nothing to make guessing
        // hopeless rather than merely hard.
        const token = randomBytes(32).toString("base64url");
        byThread.set(threadId, token);
        byToken.set(token, { threadId });
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
        const token = byThread.get(threadId);
        if (token === undefined) {
          return;
        }
        byThread.delete(threadId);
        byToken.delete(token);
      }),
  };
};

export const mcpSessionRegistry: McpSessionRegistryShape = makeRegistry();

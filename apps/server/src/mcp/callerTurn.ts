/**
 * The turn an MCP tool call belongs to: its thread's running turn, while the
 * calling agent holds the thread. Tools that put something in a turn (a page,
 * a command request) latch it first, before anything slow.
 */
import type { OrchestrationThread, ThreadId, TurnId } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import type { McpInvocationScope } from "./McpSessionRegistry.ts";

export type LatchedCallerTurn =
  | { readonly gone: true }
  | { readonly notYours: true }
  | { readonly thread: OrchestrationThread; readonly turnId: TurnId };

/** How long a call waits for its own turn to be recorded (a provider can report a call first). */
const TURN_WAIT = Duration.seconds(3);

export function latchCallerTurn(
  readThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>,
  scope: Pick<McpInvocationScope, "threadId" | "participantId">,
): Effect.Effect<LatchedCallerTurn> {
  const attempt: Effect.Effect<LatchedCallerTurn, "no-turn"> = Effect.gen(function* () {
    const thread = yield* readThread(scope.threadId);
    if (thread === undefined || thread.deletedAt !== null) {
      return { gone: true as const };
    }
    const holder = thread.session?.participantId ?? null;
    const turnId = thread.session?.activeTurnId ?? null;
    if (holder !== scope.participantId || turnId === null) {
      return yield* Effect.fail("no-turn" as const);
    }
    return { thread, turnId };
  });
  return attempt.pipe(
    Effect.retry(Schedule.spaced(Duration.millis(250))),
    Effect.timeoutOption(TURN_WAIT),
    Effect.map(Option.getOrElse((): LatchedCallerTurn => ({ notYours: true as const }))),
    Effect.orElseSucceed((): LatchedCallerTurn => ({ notYours: true as const })),
  );
}

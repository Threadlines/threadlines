import {
  CommandId,
  type OrchestrationThreadGoal,
  type RuntimeThreadGoalSnapshot,
  type ThreadId,
} from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

export function toOrchestrationThreadGoal(
  threadId: ThreadId,
  goal: RuntimeThreadGoalSnapshot,
): OrchestrationThreadGoal {
  return {
    threadId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

/**
 * Pauses a provider-owned active goal before its live session is stopped.
 *
 * The provider call deliberately does not recover cold sessions. Persisting
 * the authoritative response here also makes shutdown ordering independent of
 * the asynchronous provider-event ingestion reactor.
 */
export const pauseActiveThreadGoalForStop = Effect.fn("pauseActiveThreadGoalForStop")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
    readonly providerService: ProviderServiceShape;
    readonly orchestrationEngine: OrchestrationEngineShape;
  }) {
    const thread = Option.getOrUndefined(
      yield* input.projectionSnapshotQuery.getThreadShellById(input.threadId),
    );
    if (thread?.goal?.status !== "active" || thread.session?.status === "stopped") {
      return false;
    }

    const goal = yield* input.providerService.pauseThreadGoalForStop({ threadId: input.threadId });
    if (goal === null) {
      return false;
    }

    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* input.orchestrationEngine.dispatch({
      type: "thread.goal.state.set",
      commandId: CommandId.make(`provider-goal-stop:${input.threadId}:${crypto.randomUUID()}`),
      threadId: input.threadId,
      goal: toOrchestrationThreadGoal(input.threadId, goal),
      createdAt,
    });
    return goal.status === "paused";
  },
);

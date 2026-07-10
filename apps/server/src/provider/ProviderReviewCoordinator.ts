import {
  CommandId,
  MessageId,
  ProviderStartReviewError,
  type ProviderStartReviewInput,
  type ProviderReviewTarget,
} from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderServiceShape } from "./Services/ProviderService.ts";

interface ProviderReviewCoordinatorServices {
  readonly providerService: Pick<
    ProviderServiceShape,
    "getCapabilities" | "getInstanceInfo" | "startReview"
  >;
  readonly projectionSnapshotQuery: Pick<ProjectionSnapshotQueryShape, "getThreadShellById">;
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
}

export function formatProviderReviewRequest(target: ProviderReviewTarget): string {
  switch (target.type) {
    case "uncommittedChanges":
      return "Review the current working tree changes";
    case "baseBranch":
      return `Review changes against ${target.branch}`;
    case "commit": {
      const commit = target.sha.slice(0, 12);
      return target.title ? `Review commit ${commit}: ${target.title}` : `Review commit ${commit}`;
    }
    case "custom":
      return target.instructions;
  }
}

export function startProviderReviewForThread(
  input: ProviderStartReviewInput,
  services: ProviderReviewCoordinatorServices,
) {
  return Effect.gen(function* () {
    const loadThreadShell = () =>
      services.projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
    let threadShell = yield* loadThreadShell();

    const requestedModelSelection =
      input.modelSelection ?? input.bootstrap?.modelSelection ?? threadShell?.modelSelection;
    const requestedInstanceId =
      threadShell?.session?.providerInstanceId ?? requestedModelSelection?.instanceId;

    if (requestedInstanceId === undefined) {
      return yield* new ProviderStartReviewError({
        message: `Cannot start a code review for thread '${input.threadId}' because its provider is unknown.`,
      });
    }

    const [reviewCapabilities, reviewInstance] = yield* Effect.all([
      services.providerService.getCapabilities(requestedInstanceId),
      services.providerService.getInstanceInfo(requestedInstanceId),
    ]);
    if (reviewCapabilities.reviewStart !== "supported") {
      return yield* new ProviderStartReviewError({
        message: `Provider '${reviewInstance.driverKind}' does not support native code reviews. Start a thread with a Codex model to run this review.`,
      });
    }

    if (threadShell === undefined) {
      const bootstrap = input.bootstrap;
      if (bootstrap === undefined) {
        return yield* new ProviderStartReviewError({
          message: `Cannot start a code review for thread '${input.threadId}' because the thread has not been created yet.`,
        });
      }
      yield* services.orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`server:provider-review:thread-create:${crypto.randomUUID()}`),
        threadId: input.threadId,
        ...bootstrap,
      });
      threadShell = yield* loadThreadShell();
    }

    if (threadShell === undefined) {
      return yield* new ProviderStartReviewError({
        message: `Cannot start a code review for thread '${input.threadId}' because its thread state is unavailable.`,
      });
    }
    if (
      threadShell.session !== null &&
      (threadShell.session.status === "starting" ||
        threadShell.session.status === "running" ||
        threadShell.session.activeTurnId !== null)
    ) {
      return yield* new ProviderStartReviewError({
        message: "Wait for the current provider turn to finish before starting a review.",
      });
    }
    if ((threadShell.session?.pendingBackgroundTaskCount ?? 0) > 0) {
      return yield* new ProviderStartReviewError({
        message: "Wait for provider background tasks to finish before starting a review.",
      });
    }

    const effectiveModelSelection = requestedModelSelection ?? threadShell.modelSelection;
    const effectiveRuntimeMode =
      threadShell.session?.runtimeMode ?? input.runtimeMode ?? threadShell.runtimeMode;
    const reviewRequestedAt = DateTime.formatIso(yield* DateTime.now);
    const previousSession = threadShell.session;
    const reviewSessionBase = {
      threadId: input.threadId,
      providerName: reviewInstance.driverKind,
      providerInstanceId: requestedInstanceId,
      providerSessionId: previousSession?.providerSessionId ?? null,
      providerThreadId: previousSession?.providerThreadId ?? null,
      runtimeMode: effectiveRuntimeMode,
      pendingBackgroundTaskCount: previousSession?.pendingBackgroundTaskCount ?? 0,
    } as const;
    const refreshReviewSessionBase = () =>
      loadThreadShell().pipe(
        Effect.map((latestThreadShell) => ({
          ...reviewSessionBase,
          providerSessionId:
            latestThreadShell?.session?.providerSessionId ?? reviewSessionBase.providerSessionId,
          providerThreadId:
            latestThreadShell?.session?.providerThreadId ?? reviewSessionBase.providerThreadId,
          pendingBackgroundTaskCount:
            latestThreadShell?.session?.pendingBackgroundTaskCount ??
            reviewSessionBase.pendingBackgroundTaskCount,
        })),
        Effect.catch(() => Effect.succeed(reviewSessionBase)),
      );

    yield* services.orchestrationEngine.dispatch({
      type: "thread.message.user.record",
      commandId: CommandId.make(`server:provider-review:user-message:${crypto.randomUUID()}`),
      threadId: input.threadId,
      messageId: MessageId.make(`review-request:${crypto.randomUUID()}`),
      text: formatProviderReviewRequest(input.target),
      createdAt: reviewRequestedAt,
    });

    yield* services.orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`server:provider-review:session-starting:${crypto.randomUUID()}`),
      threadId: input.threadId,
      session: {
        ...reviewSessionBase,
        status: "starting",
        activeTurnId: null,
        lastError: null,
        updatedAt: reviewRequestedAt,
      },
      createdAt: reviewRequestedAt,
    });

    const review = yield* services.providerService
      .startReview({
        threadId: input.threadId,
        target: input.target,
        delivery: input.delivery,
        cwd: input.cwd,
        modelSelection: effectiveModelSelection,
        runtimeMode: effectiveRuntimeMode,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.gen(function* () {
            const [failedAt, latestSessionBase] = yield* Effect.all([
              DateTime.now.pipe(Effect.map(DateTime.formatIso)),
              refreshReviewSessionBase(),
            ]);
            yield* services.orchestrationEngine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(
                `server:provider-review:session-error:${crypto.randomUUID()}`,
              ),
              threadId: input.threadId,
              session: {
                ...latestSessionBase,
                status: "error",
                activeTurnId: null,
                lastError: cause.message || "Failed to start provider review.",
                updatedAt: failedAt,
              },
              createdAt: failedAt,
            });
          }).pipe(
            Effect.catchCause((dispatchCause) =>
              Effect.logWarning("failed to persist provider review startup failure", {
                threadId: input.threadId,
                cause: dispatchCause,
              }),
            ),
          ),
        ),
      );

    const [reviewStartedAt, latestSessionBase] = yield* Effect.all([
      DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      refreshReviewSessionBase(),
    ]);

    yield* services.orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`server:provider-review:session-running:${crypto.randomUUID()}`),
      threadId: input.threadId,
      session: {
        ...latestSessionBase,
        status: "running",
        activeTurnId: review.turnId,
        lastError: null,
        updatedAt: reviewStartedAt,
      },
      createdAt: reviewStartedAt,
    });

    if (
      previousSession === null &&
      !Equal.equals(threadShell.modelSelection, effectiveModelSelection)
    ) {
      yield* services.orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`server:provider-review:model-selection:${crypto.randomUUID()}`),
        threadId: input.threadId,
        modelSelection: effectiveModelSelection,
      });
    }
    if (threadShell.runtimeMode !== effectiveRuntimeMode) {
      yield* services.orchestrationEngine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make(`server:provider-review:runtime-mode:${crypto.randomUUID()}`),
        threadId: input.threadId,
        runtimeMode: effectiveRuntimeMode,
        createdAt: reviewStartedAt,
      });
    }

    return review;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderStartReviewError({
          message: cause.message || "Failed to start provider review.",
          cause,
        }),
    ),
  );
}

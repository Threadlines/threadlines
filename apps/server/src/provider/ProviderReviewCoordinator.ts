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
import { sessionSlotParticipantId } from "@threadlines/shared/threadParticipants";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderServiceShape } from "./Services/ProviderService.ts";

interface ProviderReviewCoordinatorServices {
  readonly providerService: Pick<
    ProviderServiceShape,
    "getCapabilities" | "getInstanceInfo" | "startReview" | "listSessions" | "stopSession"
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
    // A native review runs on the thread's own agent. In a room the session
    // slot may hold another agent, whose runtime says nothing about this one.
    const ownSession =
      sessionSlotParticipantId(threadShell?.session ?? null) === null
        ? (threadShell?.session ?? null)
        : null;
    const requestedInstanceId =
      ownSession?.providerInstanceId ?? requestedModelSelection?.instanceId;

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
      ownSession?.runtimeMode ?? input.runtimeMode ?? threadShell.runtimeMode;
    const reviewRequestedAt = DateTime.formatIso(yield* DateTime.now);
    const previousSession = ownSession;
    const reviewSessionBase = {
      threadId: input.threadId,
      // Hands the slot to the thread's own agent for the review.
      participantId: null,
      providerName: reviewInstance.driverKind,
      providerInstanceId: requestedInstanceId,
      providerSessionId: previousSession?.providerSessionId ?? null,
      providerThreadId: previousSession?.providerThreadId ?? null,
      runtimeMode: effectiveRuntimeMode,
      checkoutCwd: previousSession?.checkoutCwd ?? input.cwd,
      pendingBackgroundTaskCount: previousSession?.pendingBackgroundTaskCount ?? 0,
    } as const;
    const refreshReviewSessionBase = () =>
      loadThreadShell().pipe(
        Effect.map((latestThreadShell) => ({
          ...reviewSessionBase,
          providerSessionId:
            (sessionSlotParticipantId(latestThreadShell?.session ?? null) === null
              ? latestThreadShell?.session?.providerSessionId
              : undefined) ?? reviewSessionBase.providerSessionId,
          providerThreadId:
            latestThreadShell?.session?.providerThreadId ?? reviewSessionBase.providerThreadId,
          pendingBackgroundTaskCount:
            latestThreadShell?.session?.pendingBackgroundTaskCount ??
            reviewSessionBase.pendingBackgroundTaskCount,
        })),
        Effect.catch(() => Effect.succeed(reviewSessionBase)),
      );

    // In a room the thread's own agent may be parked in an earlier checkout or
    // access mode while another agent worked. A review must run where the
    // thread is now, so a mismatched runtime is stopped and started fresh.
    if ((threadShell.participants?.length ?? 0) > 0) {
      const parked = (yield* services.providerService.listSessions()).find(
        (session) => session.threadId === input.threadId,
      );
      const normalize = (value: string | undefined) => value?.replace(/[/\\]+$/, "");
      if (
        parked !== undefined &&
        (normalize(parked.cwd) !== normalize(input.cwd) ||
          parked.runtimeMode !== effectiveRuntimeMode)
      ) {
        yield* services.providerService
          .stopSession({ threadId: input.threadId })
          .pipe(Effect.catch(() => Effect.void));
      }
    }

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

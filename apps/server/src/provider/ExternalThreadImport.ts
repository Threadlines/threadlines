import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProviderDriverKind,
  ProviderExternalThreadError,
  type ProviderExternalThreadImportInput,
  type ProviderExternalThreadImportResult,
  TurnId,
} from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderServiceShape } from "./Services/ProviderService.ts";

interface ExternalThreadImportServices {
  readonly providerService: Pick<
    ProviderServiceShape,
    "readExternalThread" | "startSession" | "stopSession"
  >;
  readonly projectionSnapshotQuery: Pick<ProjectionSnapshotQueryShape, "getProjectShellById">;
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
}

const isProviderExternalThreadError = Schema.is(ProviderExternalThreadError);

function importedThreadTitle(name: string | null, preview: string): string {
  const source = name?.trim() || preview.trim().split(/\r?\n/, 1)[0] || "Imported Codex session";
  return source.slice(0, 120).trim() || "Imported Codex session";
}

function importCommandId(input: ProviderExternalThreadImportInput, suffix: string): CommandId {
  return CommandId.make(`server:external-thread-import:${input.threadId}:${suffix}`);
}

/**
 * Attach a provider-native conversation to a new Threadlines thread.
 *
 * Compatibility and project ownership are re-checked immediately before any
 * orchestration state is written. Transcript commands are deterministic so a
 * transport retry cannot duplicate imported messages.
 */
export function importExternalProviderThread(
  input: ProviderExternalThreadImportInput,
  services: ExternalThreadImportServices,
): Effect.Effect<ProviderExternalThreadImportResult, ProviderExternalThreadError> {
  return Effect.gen(function* () {
    if (input.modelSelection.instanceId !== input.providerInstanceId) {
      return yield* new ProviderExternalThreadError({
        message: "The selected model belongs to a different Codex account.",
      });
    }

    const project = Option.getOrUndefined(
      yield* services.projectionSnapshotQuery.getProjectShellById(input.projectId),
    );
    if (!project || project.kind !== "workspace") {
      return yield* new ProviderExternalThreadError({
        message: "Codex sessions can only be imported into an existing workspace project.",
      });
    }

    const snapshot = yield* services.providerService.readExternalThread({
      providerInstanceId: input.providerInstanceId,
      providerThreadId: input.providerThreadId,
      expectedCwd: project.workspaceRoot,
    });

    yield* services.orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: importCommandId(input, "thread-create"),
      threadId: input.threadId,
      projectId: input.projectId,
      title: importedThreadTitle(snapshot.candidate.name, snapshot.candidate.preview),
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: snapshot.candidate.createdAt,
    });

    yield* Effect.forEach(
      snapshot.messages,
      (message, index) => {
        const messageId = MessageId.make(`external:${input.threadId}:${index}`);
        const turnId = TurnId.make(message.providerTurnId);
        if (message.role === "user") {
          return services.orchestrationEngine.dispatch({
            type: "thread.message.user.record",
            commandId: importCommandId(input, `message:${index}:user`),
            threadId: input.threadId,
            messageId,
            text: message.text,
            turnId,
            createdAt: message.createdAt,
          });
        }
        return services.orchestrationEngine
          .dispatch({
            type: "thread.message.assistant.delta",
            commandId: importCommandId(input, `message:${index}:assistant-delta`),
            threadId: input.threadId,
            messageId,
            delta: message.text,
            turnId,
            createdAt: message.createdAt,
          })
          .pipe(
            Effect.andThen(
              services.orchestrationEngine.dispatch({
                type: "thread.message.assistant.complete",
                commandId: importCommandId(input, `message:${index}:assistant-complete`),
                threadId: input.threadId,
                messageId,
                turnId,
                createdAt: message.createdAt,
              }),
            ),
          );
      },
      { concurrency: 1, discard: true },
    );

    const projectImportedSession = (status: "stopped" | "error", lastError: string | null) =>
      Effect.gen(function* () {
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* services.orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: importCommandId(input, `session-${status}`),
          threadId: input.threadId,
          session: {
            threadId: input.threadId,
            status,
            providerName: ProviderDriverKind.make("codex"),
            providerInstanceId: input.providerInstanceId,
            providerSessionId: null,
            providerThreadId: snapshot.candidate.providerThreadId,
            runtimeMode: input.runtimeMode,
            activeTurnId: null,
            pendingBackgroundTaskCount: 0,
            lastError,
            updatedAt,
          },
          createdAt: updatedAt,
        });
      });

    const projectImportFailure = (cause: { readonly message: string }) =>
      projectImportedSession(
        "error",
        cause.message.trim() || "Failed to attach the imported Codex session.",
      ).pipe(Effect.ignoreCause({ log: true }));

    yield* services.providerService
      .startSession(input.threadId, {
        threadId: input.threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: input.providerInstanceId,
        cwd: project.workspaceRoot,
        modelSelection: input.modelSelection,
        resumeCursor: { threadId: input.providerThreadId },
        resumePolicy: "required",
        runtimeMode: input.runtimeMode,
      })
      .pipe(Effect.tapError(projectImportFailure));

    // Importing attaches history; it does not start a model turn. Close the
    // temporary validation runtime and leave the persisted native cursor cold
    // so the first user message resumes it through the normal turn lifecycle.
    yield* services.providerService
      .stopSession({ threadId: input.threadId })
      .pipe(Effect.tapError(projectImportFailure));
    yield* projectImportedSession("stopped", null);

    return {
      threadId: input.threadId,
      importedMessageCount: snapshot.messages.length,
    };
  }).pipe(
    Effect.mapError((cause) =>
      isProviderExternalThreadError(cause)
        ? cause
        : new ProviderExternalThreadError({
            message:
              cause instanceof Error && cause.message.trim().length > 0
                ? cause.message
                : "Failed to import the Codex session.",
            cause,
          }),
    ),
  );
}

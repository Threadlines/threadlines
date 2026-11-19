/**
 * Undoing a turn discards the note suggestions it wrote (docs/design/
 * project-brief-notes.md, "In a thread"). Watches `thread.reverted`, and at
 * startup drops suggestions whose turn is gone (a revert a restart cut off),
 * as the scheduler reconciles what the last process left.
 */
import type { OrchestrationEvent, ThreadId, TurnId } from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProjectContext } from "./ProjectContext.ts";

export interface ProjectNotesUndoShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ProjectNotesUndo extends Context.Service<ProjectNotesUndo, ProjectNotesUndoShape>()(
  "threadlines/projectContext/ProjectNotesUndo",
) {}

type ThreadReverted = Extract<OrchestrationEvent, { type: "thread.reverted" }>;

export const makeProjectNotesUndo = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const turns = yield* ProjectionTurnRepository;
  const context = yield* ProjectContext;

  /**
   * The thread's turns that survive a revert to `turnCount`: the same set
   * whether or not the turn projection has applied the revert yet.
   */
  const keptTurns = (threadId: ThreadId, turnCount: number | undefined) =>
    turns
      .listByThreadId({ threadId })
      .pipe(
        Effect.map(
          (rows) =>
            new Set(
              rows.flatMap((row): ReadonlyArray<TurnId> =>
                row.turnId !== null &&
                (turnCount === undefined ||
                  (row.checkpointTurnCount !== null && row.checkpointTurnCount <= turnCount))
                  ? [row.turnId]
                  : [],
              ),
            ),
        ),
      );

  const onReverted = (event: ThreadReverted) =>
    keptTurns(event.payload.threadId, event.payload.turnCount).pipe(
      Effect.flatMap((kept) => context.dropUndoneSuggestions(event.payload.threadId, kept)),
      Effect.catchCause((cause) =>
        Effect.logWarning("project notes: an undone turn's suggestions weren't checked", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /** Suggestions whose turn no longer exists go: a revert the last process didn't finish. */
  const reconcile = Effect.gen(function* () {
    const snapshot = yield* context.changes.pipe(Stream.runHead);
    if (snapshot._tag === "None") return;
    const threads = new Set(
      snapshot.value.suggestions
        .filter((suggestion) => suggestion.turnId !== null)
        .map((suggestion) => suggestion.author.threadId),
    );
    for (const threadId of threads) {
      const kept = yield* keptTurns(threadId, undefined);
      yield* context.dropUndoneSuggestions(threadId, kept);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("project notes: suggestions weren't reconciled at startup", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const start: ProjectNotesUndoShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(engine.streamDomainEvents, (event) =>
          event.type === "thread.reverted" ? onReverted(event) : Effect.void,
        ),
      );
      yield* reconcile;
    });

  return { start } satisfies ProjectNotesUndoShape;
});

export const ProjectNotesUndoLive = Layer.effect(ProjectNotesUndo, makeProjectNotesUndo);

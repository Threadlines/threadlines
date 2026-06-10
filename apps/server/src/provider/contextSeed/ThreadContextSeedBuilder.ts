/**
 * ThreadContextSeedBuilder - assembles a provider-agnostic `ThreadContextSeed`
 * from the orchestration transcript for a cross-driver handoff.
 *
 * The seed is built deterministically: verbatim recent messages + tool-action
 * summaries (the `summary` line of tool activities, never raw payloads) +
 * a working-tree pointer. Older history beyond the recency/char budget is
 * either compacted by an injected summarizer (the cheap text-generation model,
 * wired separately) or, failing that, replaced with a deterministic truncation
 * marker — so a switch never hard-depends on a model call.
 *
 * Read failures degrade to "no seed" (working-tree-only handoff) rather than
 * failing the turn, keeping the switch resilient.
 *
 * See `.plans/18-cross-provider-switching.md`.
 *
 * @module ThreadContextSeedBuilder
 */
import type {
  ProviderDriverKind,
  TextGenerationError,
  ThreadContextSeed,
  ThreadContextSeedEntry,
  ThreadId,
} from "@t3tools/contracts";
import {
  DEFAULT_SEED_BUDGET,
  renderSeedEntries,
  type SeedBudget,
  splitSeedEntriesByBudget,
} from "@t3tools/shared/contextSeed";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

export interface ThreadContextSeedBuildInput {
  readonly threadId: ThreadId;
  readonly fromProvider: ProviderDriverKind;
  readonly toProvider: ProviderDriverKind;
  readonly excludeMessageId?: string | undefined;
  readonly cwd?: string | undefined;
  readonly budget?: SeedBudget;
}

/**
 * Optional compaction hook. Returns a compact summary of older history. May
 * fail; the builder falls back to a deterministic truncation marker on failure
 * or empty output. Wired to the cheap text-generation model separately.
 */
export type ThreadHandoffSummarize = (input: {
  readonly text: string;
  readonly fromProvider: ProviderDriverKind;
}) => Effect.Effect<string, TextGenerationError>;

export interface ThreadContextSeedBuilderShape {
  /**
   * Build a seed for handing `threadId` from `fromProvider` to `toProvider`.
   * Returns `None` when the thread has no usable transcript (the new session
   * then starts on the shared working tree alone).
   */
  readonly build: (
    input: ThreadContextSeedBuildInput,
  ) => Effect.Effect<Option.Option<ThreadContextSeed>>;
}

export class ThreadContextSeedBuilder extends Context.Service<
  ThreadContextSeedBuilder,
  ThreadContextSeedBuilderShape
>()("t3/provider/contextSeed/ThreadContextSeedBuilder") {}

function truncationMarker(count: number): string {
  return `[${count} earlier message${count === 1 ? "" : "s"} omitted to fit the handoff budget.]`;
}

function workspacePointer(cwd: string | undefined): string | undefined {
  if (!cwd || cwd.trim().length === 0) {
    return undefined;
  }
  return (
    `The repository at ${cwd.trim()} reflects in-progress work from this thread; ` +
    "run `git diff` to see uncommitted changes."
  );
}

function compareIso(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Flatten messages + tool activities into one oldest-first entry list. Only
 * `tone === "tool"` activities are included (concrete actions); thinking/info/
 * warning/error tones are noise for a handoff and are skipped. Empty text is
 * dropped.
 */
function buildEntries(input: {
  readonly messages: ReadonlyArray<{
    readonly id?: string | undefined;
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly createdAt: string;
  }>;
  readonly activities: ReadonlyArray<{
    readonly tone: string;
    readonly summary: string;
    readonly createdAt: string;
  }>;
  readonly excludeMessageId?: string | undefined;
}): ReadonlyArray<ThreadContextSeedEntry> {
  const items: Array<{ readonly createdAt: string; readonly entry: ThreadContextSeedEntry }> = [];

  for (const message of input.messages) {
    if (message.id !== undefined && message.id === input.excludeMessageId) {
      continue;
    }
    const text = message.text.trim();
    if (text.length === 0) {
      continue;
    }
    items.push({
      createdAt: message.createdAt,
      entry: { kind: "message", role: message.role, text },
    });
  }

  for (const activity of input.activities) {
    if (activity.tone !== "tool") {
      continue;
    }
    const text = activity.summary.trim();
    if (text.length === 0) {
      continue;
    }
    items.push({ createdAt: activity.createdAt, entry: { kind: "tool", text } });
  }

  return items.toSorted((a, b) => compareIso(a.createdAt, b.createdAt)).map((item) => item.entry);
}

export const makeThreadContextSeedBuilder = (deps: {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly summarize?: ThreadHandoffSummarize;
}): ThreadContextSeedBuilderShape => ({
  build: (input) =>
    Effect.gen(function* () {
      const pointer = workspacePointer(input.cwd);
      const threadOption = yield* deps.snapshotQuery.getThreadDetailById(input.threadId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("thread context seed builder failed to read thread", {
            threadId: input.threadId,
            detail: error.message,
          }).pipe(Effect.as(Option.none())),
        ),
      );

      if (Option.isNone(threadOption)) {
        if (pointer === undefined) {
          return Option.none();
        }
        return Option.some({
          version: 1,
          fromProvider: input.fromProvider,
          entries: [],
          workspacePointer: pointer,
        });
      }
      const thread = threadOption.value;

      const entries = buildEntries({
        messages: thread.messages,
        activities: thread.activities,
        excludeMessageId: input.excludeMessageId,
      });

      if (entries.length === 0 && pointer === undefined) {
        return Option.none();
      }

      const { older, recent } = splitSeedEntriesByBudget(
        entries,
        input.budget ?? DEFAULT_SEED_BUDGET,
      );

      let olderSummary: string | undefined;
      if (older.length > 0) {
        const olderText = renderSeedEntries(older);
        if (olderText.length > 0) {
          olderSummary = deps.summarize
            ? yield* deps.summarize({ text: olderText, fromProvider: input.fromProvider }).pipe(
                Effect.map((summary) => summary.trim()),
                Effect.flatMap((summary) =>
                  summary.length > 0
                    ? Effect.succeed(summary)
                    : Effect.succeed(truncationMarker(older.length)),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("thread context seed builder summarization failed", {
                    threadId: input.threadId,
                    cause,
                  }).pipe(Effect.as(truncationMarker(older.length))),
                ),
              )
            : truncationMarker(older.length);
        }
      }

      const seed: ThreadContextSeed = {
        version: 1,
        fromProvider: input.fromProvider,
        ...(olderSummary !== undefined ? { olderSummary } : {}),
        entries: recent,
        ...(pointer !== undefined ? { workspacePointer: pointer } : {}),
      };
      return Option.some(seed);
    }),
});

export const ThreadContextSeedBuilderLive = Layer.effect(
  ThreadContextSeedBuilder,
  Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    return makeThreadContextSeedBuilder({ snapshotQuery });
  }),
);

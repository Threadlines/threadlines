import type { CommandId, OrchestrationEvent, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";

/**
 * The threads an archive took along with the thread it named (a parent's
 * settled children), read back from the events that command wrote between
 * the two sequences. Whoever archived cleans these up as it does the named
 * thread; a child the archive separated instead keeps running, so it is not
 * here. A retried command that wrote nothing finds none.
 */
export const threadsArchivedWith = (
  engine: Pick<OrchestrationEngineShape, "readEvents">,
  input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly fromSequenceExclusive: number;
    readonly throughSequence: number;
  },
) =>
  engine.readEvents(input.fromSequenceExclusive).pipe(
    Stream.takeWhile((event) => event.sequence <= input.throughSequence),
    Stream.filter(
      (event): event is Extract<OrchestrationEvent, { type: "thread.archived" }> =>
        event.type === "thread.archived" &&
        event.commandId === input.commandId &&
        event.payload.threadId !== input.threadId,
    ),
    Stream.map((event) => event.payload.threadId),
    Stream.runCollect,
    Effect.map((threadIds): ReadonlyArray<ThreadId> => Array.from(threadIds)),
  );

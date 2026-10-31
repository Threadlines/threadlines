/**
 * Whether outside text reached an agent's runtime and it hasn't started
 * fresh since (OrchestrationOutsideWork; docs/design/assistants.md, step 3),
 * for an adapter's own checks on the provider's built-in tools. Claude asks
 * before `CronCreate`, `ScheduleWakeup` and `ProposeGoal`: outside work must
 * leave nothing that runs after its mark clears.
 *
 * Process-wide, in the shape McpSessionRegistry uses: a driver asks one
 * question of something the process has exactly one of, and the drivers are
 * built before the projections that answer it. The server provides the
 * answer once its projections are up (OutsideWorkLookupLive); until then,
 * and in tests, nothing is marked. A read that fails counts as marked.
 */
import type { ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";

/** Reads as marked when it can't tell (the provider's own job, see OutsideWorkLookupLive). */
type Lookup = (sessionKey: ThreadId) => Effect.Effect<boolean>;

let current: Lookup | undefined;

export const outsideWorkLookup = {
  /** Answer for the process from now on; the release puts the old answer back. */
  provide: (lookup: Lookup) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const previous = current;
        current = lookup;
        return previous;
      }),
      (previous) =>
        Effect.sync(() => {
          current = previous;
        }),
    ),
  /** Whether the runtime of `sessionKey` belongs to an agent outside work marked. */
  isMarked: (sessionKey: ThreadId): Effect.Effect<boolean> =>
    current === undefined ? Effect.succeed(false) : current(sessionKey),
};

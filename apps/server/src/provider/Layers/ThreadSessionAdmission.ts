/**
 * The session fence as the projection has it (ThreadSessionAdmission): read
 * from the thread's row at every start, so it holds across restarts and
 * needs no cache to keep in step.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import {
  ThreadSessionAdmission,
  type ThreadSessionAdmissionShape,
} from "../Services/ThreadSessionAdmission.ts";

const make = Effect.gen(function* () {
  const threads = yield* ProjectionThreadRepository;
  const refusal: ThreadSessionAdmissionShape["refusal"] = (threadId) =>
    threads.getById({ threadId }).pipe(
      Effect.map((row) => {
        if (Option.isNone(row)) return null;
        const move = row.value.move ?? null;
        if (move !== null) {
          return move.movedAway !== undefined
            ? `This thread moved to ${move.target.label}, so its agent can't start here.`
            : `This thread is moving to ${move.target.label}, so its agent can't start here.`;
        }
        const pending = row.value.pendingMove ?? null;
        return pending !== null && pending.stage === "quiescing"
          ? `This thread's agent is being stopped to move it to ${pending.target.label}.`
          : null;
      }),
      // A thread that can't be read is never started on a guess.
      Effect.orElseSucceed(() => "This thread couldn't be read, so its agent wasn't started."),
    );
  return ThreadSessionAdmission.of({ refusal });
});

export const ThreadSessionAdmissionLive = Layer.effect(ThreadSessionAdmission, make);

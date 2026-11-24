/**
 * ThreadSessionAdmission - whether a thread's agent sessions may start.
 *
 * ProviderService asks it before it starts or recovers any session, whatever
 * its key (the thread's own agent, a room agent, a side answer, an early
 * start) and whoever asked (a turn, a transcript read, compaction, startup).
 * A command guard can't stop a session that reopens without a command; this
 * can. It refuses while a thread's queued move is ending its sessions
 * (`pendingMove.stage: "quiescing"`) and once the thread moves or moved
 * (docs/design/fleet.md, Part 3b, "The session fence").
 *
 * @module ThreadSessionAdmission
 */
import type { ThreadId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface ThreadSessionAdmissionShape {
  /** Why no session of `threadId` (a thread id, not a session key) may start now, or null. */
  readonly refusal: (threadId: ThreadId) => Effect.Effect<string | null>;
}

export class ThreadSessionAdmission extends Context.Service<
  ThreadSessionAdmission,
  ThreadSessionAdmissionShape
>()("threadlines/provider/Services/ThreadSessionAdmission") {}

/** Admits every session: for tests of code that never moves a thread. */
export const ThreadSessionAdmissionPermissive = Layer.succeed(
  ThreadSessionAdmission,
  ThreadSessionAdmission.of({ refusal: () => Effect.succeed(null) }),
);

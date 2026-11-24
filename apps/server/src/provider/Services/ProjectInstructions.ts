/**
 * ProjectInstructions: the project's text a provider session starts with
 * (docs/design/project-brief-notes.md, "Delivery"). `ProviderService` asks
 * it at every adapter start, recovery included, so a session gets the
 * project as it is when it starts, whoever started it.
 */
import type { RuntimeMode, ThreadId } from "@threadlines/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProjectInstructionsShape {
  /**
   * The text for the session `sessionKey` (a thread's, a room agent's, or a
   * side answer's) about to start with `runtimeMode`. Undefined when there is
   * nothing to add: no brief, a General Chat, a side answer, or a thread an
   * agent outside this computer's trust answers to (the link fence, an outside
   * agent's thread). Never fails: a lookup that can't be read adds nothing.
   */
  readonly forSession: (input: {
    readonly sessionKey: ThreadId;
    readonly runtimeMode: RuntimeMode;
    /** False when the session is starting without the room/app MCP server. */
    readonly canUseNoteTools?: boolean | undefined;
  }) => Effect.Effect<string | undefined>;
}

export class ProjectInstructions extends Context.Service<
  ProjectInstructions,
  ProjectInstructionsShape
>()("threadlines/provider/Services/ProjectInstructions") {}

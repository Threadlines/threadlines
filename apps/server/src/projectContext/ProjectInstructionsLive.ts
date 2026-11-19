import { GENERAL_CHATS_PROJECT_ID } from "@threadlines/contracts";
import { parseSessionKey } from "@threadlines/shared/threadParticipants";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { isLinkFenced } from "../orchestration/linkFence.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import {
  ProjectInstructions,
  type ProjectInstructionsShape,
} from "../provider/Services/ProjectInstructions.ts";
import { ProjectBriefRepository } from "./ProjectBriefRepository.ts";
import { projectInstructionsText } from "./projectInstructionsText.ts";

/**
 * Reads the thread, its project and the project's brief from the stored
 * projections each time a session starts: no copy to keep in step.
 */
export const makeProjectInstructions = Effect.gen(function* () {
  const threads = yield* ProjectionThreadRepository;
  const projects = yield* ProjectionProjectRepository;
  const briefs = yield* ProjectBriefRepository;

  const forSession: ProjectInstructionsShape["forSession"] = ({ sessionKey }) =>
    Effect.gen(function* () {
      const target = parseSessionKey(sessionKey);
      // A side answer is short, read-only and locked down.
      if (target.kind === "side") return undefined;
      const thread = Option.getOrUndefined(yield* threads.getById({ threadId: target.threadId }));
      if (thread === undefined || thread.deletedAt !== null) return undefined;
      if (thread.projectId === GENERAL_CHATS_PROJECT_ID) return undefined;
      // An agent outside this computer's trust answers for it: it could just
      // ask the thread to repeat the brief.
      if (isLinkFenced(thread) || (thread.outsideOrigin ?? null) !== null) return undefined;
      const project = Option.getOrUndefined(
        yield* projects.getById({ projectId: thread.projectId }),
      );
      if (project === undefined || project.deletedAt !== null) return undefined;
      const brief = Option.getOrUndefined(yield* briefs.get(thread.projectId));
      return projectInstructionsText({ projectTitle: project.title, brief: brief?.text ?? "" });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project instructions could not be read", {
          sessionKey,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );

  return { forSession } satisfies ProjectInstructionsShape;
});

export const ProjectInstructionsLive = Layer.effect(ProjectInstructions, makeProjectInstructions);

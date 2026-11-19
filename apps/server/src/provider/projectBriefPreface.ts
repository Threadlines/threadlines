/**
 * For providers whose project brief sits in the conversation rather than in
 * standing instructions (Muse and the ACP agents; docs/design/
 * project-brief-notes.md, "Per provider"): what the first turn after a
 * runtime start sends ahead of the user's words. The hash of the brief the
 * conversation last got is kept in the session's resume cursor, so a thread
 * that restarts often gets a copy only when the brief changed. A wrong hash
 * costs one extra or one missing copy until the next change.
 */
import { createHash } from "node:crypto";

/** Sent when the brief the conversation holds was cleared. */
export const PROJECT_BRIEF_CLEARED_NOTE =
  "The user removed this project's brief. The project brief given earlier in this conversation no longer applies.";

export const projectBriefHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

export interface ProjectBriefPreface {
  /** Text to send ahead of the next prompt; undefined: nothing to send. */
  readonly text: string | undefined;
  /** The hash the conversation holds once it is sent; undefined: no brief. */
  readonly hash: string | undefined;
}

/**
 * `projectInstructions` is the session's start input
 * (ProviderSessionStartInput.projectInstructions); `sentHash` the hash a
 * resumed conversation already holds, undefined for a new or forked one.
 */
export function projectBriefPreface(input: {
  readonly projectInstructions: string | undefined;
  readonly sentHash: string | undefined;
}): ProjectBriefPreface {
  if (input.projectInstructions === undefined || input.projectInstructions.length === 0) {
    return {
      text: input.sentHash !== undefined ? PROJECT_BRIEF_CLEARED_NOTE : undefined,
      hash: undefined,
    };
  }
  const hash = projectBriefHash(input.projectInstructions);
  return { text: hash === input.sentHash ? undefined : input.projectInstructions, hash };
}

/** The hash a resume cursor keeps under `projectBriefHash`, if any. */
export const readProjectBriefHash = (cursor: unknown): string | undefined => {
  if (typeof cursor !== "object" || cursor === null) return undefined;
  const value = (cursor as { readonly projectBriefHash?: unknown }).projectBriefHash;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

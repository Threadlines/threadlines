import { randomUUID } from "node:crypto";

/**
 * Private index files Threadlines stages into, by way of `GIT_INDEX_FILE`.
 *
 * Checkpoints, commit previews and working-tree diffs build their trees in a
 * scratch index inside the git common dir so they never touch the user's
 * staging area. The files are our own bookkeeping rather than repository
 * activity, so the status watcher has to recognize and ignore them; both sides
 * go through this module so the names cannot drift apart.
 */
const SCRATCH_INDEX_PURPOSES = ["checkpoint", "preview", "working-tree-diff"] as const;

export type ScratchIndexPurpose = (typeof SCRATCH_INDEX_PURPOSES)[number];

/** A fresh, unique file name for one scratch index. */
export const scratchIndexFileName = (purpose: ScratchIndexPurpose): string =>
  `t3-${purpose}-index-${randomUUID()}`;

/** True for a file name `scratchIndexFileName` produced, or its `.lock`. */
export const isScratchIndexFileName = (fileName: string): boolean =>
  SCRATCH_INDEX_PURPOSES.some((purpose) => fileName.startsWith(`t3-${purpose}-index-`));

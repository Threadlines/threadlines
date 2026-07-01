/**
 * Git ref namespaces for Threadlines checkpoint snapshots.
 *
 * Checkpoint refs live outside refs/heads and refs/tags so they never appear
 * as branches or tags, and commit-graph queries exclude them explicitly.
 */
export const CHECKPOINT_REFS_PREFIX = "refs/threadlines/checkpoints";

/**
 * Namespace used before the t3 -> threadlines rename. Repos that captured
 * checkpoints with older builds still carry refs here; the git driver migrates
 * them to CHECKPOINT_REFS_PREFIX on first checkpoint use per repository.
 */
export const LEGACY_CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

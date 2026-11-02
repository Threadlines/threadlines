/**
 * Names for the in-app browser's sessions.
 *
 * Two shapes, chosen by the "Browser sign-ins" setting. Shared: every project
 * on one environment runs in that environment's partition, so signing in to a
 * site once is enough. Separate: each project gets its own, so a sign-in, a
 * cookie or a localhost port's site data in one project never shows up in
 * another. The main process owns the naming: the renderer asks for its
 * project's partition and sets it on the <webview>, and `will-attach-webview`
 * refuses any partition that does not have one of these shapes.
 *
 * Either way a page also carries its project's own partition name as its
 * scope (see `PreviewScopes.ts`): the sites it may visit belong to the
 * project, not to the partition it happens to share.
 */

import { createHash } from "node:crypto";

/**
 * The single shared partition every tab used before profiles were per project.
 *
 * Still accepted so its data can be cleared, but nothing hands it out any more.
 */
export const LEGACY_PREVIEW_PARTITION = "persist:threadlines-preview";

const PROJECT_PARTITION_PREFIX = "persist:threadlines-preview-";
const PROJECT_PARTITION_PATTERN = /^persist:threadlines-preview-[0-9a-f]{32}$/;
const SHARED_PARTITION_PREFIX = "persist:threadlines-preview-shared-";
const SHARED_PARTITION_PATTERN = /^persist:threadlines-preview-shared-[0-9a-f]{32}$/;

/** A fixed-length, filesystem-safe name out of ids of any shape. */
function digestOf(parts: ReadonlyArray<string>): string {
  // JSON rather than a separator: ids may contain any character, and two
  // different lists must never read the same.
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

/**
 * The partition for one project on one environment.
 *
 * A hash only to get a fixed-length, filesystem-safe name out of ids of any
 * shape. It is not a secret and not a credential: anyone who knows the ids can
 * compute it, and nothing relies on them not being able to.
 */
export function previewProfilePartition(environmentId: string, projectId: string): string {
  return `${PROJECT_PARTITION_PREFIX}${digestOf([environmentId, projectId])}`;
}

/**
 * The partition every project on one environment shares when sign-ins are
 * shared.
 *
 * One per environment rather than one for everything: a session sends its
 * `localhost` to a single computer (`PreviewLoopbackProxy.ts`), and another
 * computer's projects need theirs to reach that computer.
 */
export function previewSharedPartition(environmentId: string): string {
  // The leading tag keeps the digest apart from any project's.
  return `${SHARED_PARTITION_PREFIX}${digestOf(["shared", environmentId])}`;
}

/** Whether a partition is one project's own. */
export function isProjectPreviewPartition(partition: unknown): partition is string {
  return typeof partition === "string" && PROJECT_PARTITION_PATTERN.test(partition);
}

/** Whether a partition is one that several projects share. */
export function isSharedPreviewPartition(partition: unknown): partition is string {
  return typeof partition === "string" && SHARED_PARTITION_PATTERN.test(partition);
}

/** Whether a partition is one the in-app browser may run in. */
export function isPreviewPartition(partition: unknown): partition is string {
  return (
    partition === LEGACY_PREVIEW_PARTITION ||
    isProjectPreviewPartition(partition) ||
    isSharedPreviewPartition(partition)
  );
}

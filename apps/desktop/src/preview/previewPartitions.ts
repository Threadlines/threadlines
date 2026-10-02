/**
 * Names for the in-app browser's sessions.
 *
 * Each project gets its own persistent partition, so a sign-in, a cookie or a
 * localhost port's site data in one project never shows up in another. The
 * main process owns the naming: the renderer asks for its project's partition
 * and sets it on the <webview>, and `will-attach-webview` refuses any partition
 * that does not have this shape.
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

/**
 * The partition for one project on one environment.
 *
 * A hash only to get a fixed-length, filesystem-safe name out of ids of any
 * shape. It is not a secret and not a credential: anyone who knows the ids can
 * compute it, and nothing relies on them not being able to.
 */
export function previewProfilePartition(environmentId: string, projectId: string): string {
  // JSON rather than a separator: ids may contain any character, and two
  // different pairs must never read the same.
  const digest = createHash("sha256")
    .update(JSON.stringify([environmentId, projectId]))
    .digest("hex");
  return `${PROJECT_PARTITION_PREFIX}${digest.slice(0, 32)}`;
}

/** Whether a partition is one the in-app browser may run in. */
export function isPreviewPartition(partition: unknown): partition is string {
  return (
    typeof partition === "string" &&
    (partition === LEGACY_PREVIEW_PARTITION || PROJECT_PARTITION_PATTERN.test(partition))
  );
}

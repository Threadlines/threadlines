// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import NodePath from "node:path";

import type { ChatAttachment } from "@threadlines/contracts";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import {
  CANONICAL_FILE_ATTACHMENT_EXTENSIONS,
  fileAttachmentExtension,
} from "@threadlines/shared/fileAttachments";
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

/** Extensions a stored attachment is served back under with its own content
 *  type: pictures and the canonical file types. Any other file (a Word
 *  document, but also an HTML page or a script) is served only as a
 *  download, so nothing a user attached can run as a page of the app. */
const SERVED_AS_OWN_TYPE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...SAFE_IMAGE_FILE_EXTENSIONS,
  ...CANONICAL_FILE_ATTACHMENT_EXTENSIONS,
]);

/** Extensions tried first when looking an attachment up by id alone. */
const ATTACHMENT_FILENAME_EXTENSIONS = [...SERVED_AS_OWN_TYPE_EXTENSIONS, ".bin"];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})$`,
  "i",
);

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment;
}

export function createAttachmentId(threadId: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${randomUUID()}`;
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

export function attachmentRelativePath(attachment: ChatAttachment): string {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
    case "file": {
      const extension = fileAttachmentExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: attachmentRelativePath(input.attachment),
  });
}

export function resolveAttachmentPathById(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}): string | null {
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  for (const extension of ATTACHMENT_FILENAME_EXTENSIONS) {
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}${extension}`,
    });
    if (maybePath && existsSync(maybePath)) {
      return maybePath;
    }
  }
  // Any other file keeps its own extension (`.docx`, `.xlsx`): find it by id.
  // Only those files reach this listing.
  let entries: ReadonlyArray<string>;
  try {
    entries = readdirSync(input.attachmentsDir);
  } catch {
    return null;
  }
  const entry = entries.find(
    (name) =>
      name.startsWith(`${normalizedId}.`) &&
      parseAttachmentIdFromRelativePath(name) === normalizedId,
  );
  return entry === undefined
    ? null
    : resolveAttachmentRelativePath({ attachmentsDir: input.attachmentsDir, relativePath: entry });
}

/** The spelling staged attachment paths are compared by: resolved, and on
 *  Windows, whose paths ignore letter case, lowercased. */
export function stagedAttachmentPathKey(filePath: string): string {
  const resolved = NodePath.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Whether a path is a plain file as it stands: not a link, not a folder. */
export function isPlainFile(filePath: string): boolean {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Whether a stored attachment may be served under its own content type
 *  (see SERVED_AS_OWN_TYPE_EXTENSIONS); otherwise only as a download. */
export function isAttachmentServedAsOwnType(filePath: string): boolean {
  return SERVED_AS_OWN_TYPE_EXTENSIONS.has(NodePath.extname(filePath).toLowerCase());
}

export function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return null;
  }
  const id = normalized.slice(0, extensionIndex);
  return id.length > 0 && !id.includes(".") ? id : null;
}

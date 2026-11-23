/**
 * How each attachment reaches Antigravity (`AcpProviderDescriptor.attachmentDelivery`).
 *
 * `agy acp` reads images and audio inline, PDFs through a link to the file,
 * and text files embedded as text (1.5.13 honors attached file contents).
 * Everything else, and anything the agent's `initialize` answer doesn't
 * offer, goes as a note naming the staged file for the agent to open, as for
 * every ACP agent. MIME parameters (`; charset=utf-8`) are dropped before
 * deciding. The lists follow T3 Code's (AntigravityAcpSupport.ts, commits
 * 29a33f8827 and ff8a831067).
 *
 * @module provider/antigravity/AntigravityAttachments
 */
import type { ChatAttachment } from "@threadlines/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import { type AcpAttachmentDelivery, bareMimeType } from "../acp/AcpPromptAttachments.ts";

const IMAGE_MIME_TYPES = new Set(["image/bmp", "image/jpeg", "image/png", "image/webp"]);
const AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
]);
/** Application types that hold text, beyond `text/*`. */
const TEXT_APPLICATION_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/x-sh",
]);

/**
 * Text the server stored as some other kind: a UTF-16 file reads as binary
 * to the server's UTF-8 check, so it arrives as `other` with its text type.
 * The core decodes it (with its byte order mark) or falls back to the note.
 */
const isTextType = (mimeType: string) =>
  mimeType.startsWith("text/") || TEXT_APPLICATION_MIME_TYPES.has(mimeType);

export function antigravityAttachmentDelivery(
  attachment: ChatAttachment,
  capabilities: EffectAcpSchema.PromptCapabilities | null | undefined,
): AcpAttachmentDelivery {
  const mimeType = bareMimeType(attachment.mimeType);
  if (attachment.type === "image") {
    return IMAGE_MIME_TYPES.has(mimeType) && capabilities?.image === true ? "inline" : "note";
  }
  if (AUDIO_MIME_TYPES.has(mimeType)) return capabilities?.audio === true ? "inline" : "note";
  // Every ACP agent reads a `resource_link`; `embeddedContext` is only for embedded text.
  if (attachment.kind === "pdf" || mimeType === "application/pdf") return "link";
  if (capabilities?.embeddedContext !== true) return "note";
  if (attachment.kind === "text" || isTextType(mimeType)) return "text";
  return "note";
}

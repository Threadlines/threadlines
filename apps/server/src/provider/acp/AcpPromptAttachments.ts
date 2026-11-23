// @effect-diagnostics nodeBuiltinImport:off -- node:url makes a staged file's file:// link.
/**
 * How an attachment reaches an ACP agent as prompt content. By default an
 * image goes inline and any other file goes as a note naming its staged path
 * (`buildFileAttachmentNote`), which works for every agent. An agent that
 * reads more natively says so per attachment (`AcpProviderDescriptor.
 * attachmentDelivery`), and the ways here are plain ACP content blocks:
 *
 * - `inline`: an image or audio block with the bytes.
 * - `link`: a `resource_link` to the staged file (ACP's baseline block).
 * - `text`: an embedded text `resource`, decoded as UTF-8, or UTF-16 when the
 *   file starts with its byte order mark.
 *
 * Anything that doesn't fit its way (too big, not text after all) falls back
 * to the note, so a file always reaches the agent one way or another.
 *
 * @module provider/acp/AcpPromptAttachments
 */
import type { ChatAttachment } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as EffectAcpSchema from "effect-acp/schema";
import { pathToFileURL } from "node:url";

import {
  buildFileAttachmentNote,
  INLINE_TEXT_ATTACHMENT_MAX_BYTES,
} from "../fileAttachmentPrompt.ts";

/** How one attachment travels (see the module comment). */
export type AcpAttachmentDelivery = "inline" | "link" | "text" | "note";

/** The most audio one file may send inline. */
const INLINE_AUDIO_MAX_BYTES = 20 * 1024 * 1024;
/** The most bytes one message sends inline, images and audio together. */
const INLINE_MESSAGE_MAX_BYTES = 50 * 1024 * 1024;

/** A MIME type without its parameters (`text/plain; charset=utf-8` is `text/plain`). */
export function bareMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** What one message has sent inline so far. */
export interface AcpAttachmentBudget {
  inlineBytes: number;
}

/**
 * Text as the file holds it: UTF-16 with its byte order mark, else UTF-8.
 * `undefined` for bytes that aren't valid text in that encoding, or hold a NUL.
 */
export function decodeAttachmentText(bytes: Uint8Array): string | undefined {
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}

const note = (attachment: ChatAttachment, path: string): EffectAcpSchema.ContentBlock => ({
  type: "text",
  text: buildFileAttachmentNote(attachment, path),
});

/**
 * The content blocks for one attachment, sent the way `delivery` says, or
 * as its note when it doesn't fit that way. Fails only when the staged file
 * can't be read.
 */
export const acpAttachmentContent = (input: {
  readonly attachment: ChatAttachment;
  readonly path: string;
  readonly delivery: AcpAttachmentDelivery;
  readonly budget: AcpAttachmentBudget;
  readonly fileSystem: FileSystem.FileSystem;
}) =>
  Effect.gen(function* () {
    const { attachment, path, delivery, budget, fileSystem } = input;
    const mimeType = bareMimeType(attachment.mimeType);
    if (delivery === "note") return [note(attachment, path)];
    if (delivery === "link") {
      return [
        {
          type: "resource_link",
          uri: pathToFileURL(path).href,
          name: attachment.name,
          mimeType,
          size: attachment.sizeBytes,
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.ContentBlock>;
    }
    const audio = mimeType.startsWith("audio/");
    const limit =
      delivery === "text"
        ? INLINE_TEXT_ATTACHMENT_MAX_BYTES
        : audio
          ? INLINE_AUDIO_MAX_BYTES
          : Number.POSITIVE_INFINITY;
    // Sizes are checked before reading, so a large file is never read whole.
    if (attachment.sizeBytes > limit) return [note(attachment, path)];
    if (
      delivery === "inline" &&
      budget.inlineBytes + attachment.sizeBytes > INLINE_MESSAGE_MAX_BYTES
    )
      return [note(attachment, path)];
    const bytes = yield* fileSystem.readFile(path);
    if (bytes.byteLength > limit) return [note(attachment, path)];
    if (delivery === "text") {
      const text = decodeAttachmentText(bytes);
      if (text === undefined) return [note(attachment, path)];
      return [
        {
          type: "resource",
          resource: { uri: pathToFileURL(path).href, mimeType, text },
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.ContentBlock>;
    }
    budget.inlineBytes += bytes.byteLength;
    const data = Buffer.from(bytes).toString("base64");
    return [
      audio
        ? { type: "audio", data, mimeType }
        : { type: "image", data, mimeType: mimeType || attachment.mimeType },
    ] satisfies ReadonlyArray<EffectAcpSchema.ContentBlock>;
  });

// @effect-diagnostics nodeBuiltinImport:off -- node:url links a staged file; node:fs reads it without following a link.
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
import { type ChatAttachment, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
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

/** A staged attachment that couldn't be read, or isn't a regular file. */
export class AcpAttachmentReadError extends Schema.TaggedError<AcpAttachmentReadError>()(
  "AcpAttachmentReadError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const isAttachmentReadError = Schema.is(AcpAttachmentReadError);

const notAFile = (name: string) =>
  new AcpAttachmentReadError({ message: `Attachment '${name}' is not a regular file.` });

/** The limit one attachment sent this way may reach, before the message's own. */
function deliveryLimit(delivery: "inline" | "text", mimeType: string): number {
  if (delivery === "text") return INLINE_TEXT_ATTACHMENT_MAX_BYTES;
  return mimeType.startsWith("audio/")
    ? INLINE_AUDIO_MAX_BYTES
    : PROVIDER_SEND_TURN_MAX_IMAGE_BYTES;
}

/**
 * The staged file's bytes, read through one handle: never through a link,
 * only a regular file, and no more than `maxBytes` whatever its record or
 * its size says (it may have grown). `too-big` past the cap. Fails when the
 * staged file isn't a regular file or can't be read.
 */
const readStaged = (path: string, name: string, maxBytes: number) =>
  Effect.tryPromise({
    try: async (): Promise<Uint8Array | "too-big"> => {
      const handle = await NodeFSP.open(
        path,
        NodeFS.constants.O_RDONLY |
          (NodeFS.constants.O_NOFOLLOW ?? 0) |
          (NodeFS.constants.O_NONBLOCK ?? 0),
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw notAFile(name);
        if (stat.size > maxBytes) return "too-big";
        // Size the buffer from stat.size + 1 so small attachments don't allocate
        // maxBytes + 1 (10-20 MiB), while still growing up to maxBytes + 1 to
        // catch a file that grew past maxBytes since stat.
        const limit = maxBytes + 1;
        let buffer = Buffer.allocUnsafe(Math.min(limit, Math.max(1, stat.size + 1)));
        let total = 0;
        while (total < limit) {
          if (total === buffer.length) {
            const nextCapacity = Math.min(limit, Math.max(buffer.length * 2, total + 4096));
            const next = Buffer.allocUnsafe(nextCapacity);
            buffer.copy(next, 0, 0, total);
            buffer = next;
          }
          const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
          if (bytesRead === 0) break;
          total += bytesRead;
        }
        return total > maxBytes ? "too-big" : buffer.subarray(0, total);
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      isAttachmentReadError(cause)
        ? cause
        : new AcpAttachmentReadError({ message: `Could not read attachment '${name}'.`, cause }),
  });

/** Whether the staged file is a regular file, not a link, for a link to it. */
const isStagedFile = (path: string) =>
  Effect.promise(() =>
    NodeFSP.lstat(path).then(
      (info) => info.isFile(),
      () => false,
    ),
  );

/**
 * The content blocks for one attachment, sent the way `delivery` says, or
 * as its note when it doesn't fit that way. Bytes sent inline are charged to
 * the message's budget as read, not as recorded. Fails only when the staged
 * file can't be read, or isn't a regular file.
 */
export const acpAttachmentContent = (input: {
  readonly attachment: ChatAttachment;
  readonly path: string;
  readonly delivery: AcpAttachmentDelivery;
  readonly budget: AcpAttachmentBudget;
}) =>
  Effect.gen(function* () {
    const { attachment, path, delivery, budget } = input;
    const mimeType = bareMimeType(attachment.mimeType);
    if (delivery === "note") return [note(attachment, path)];
    if (delivery === "link") {
      if (!(yield* isStagedFile(path))) {
        return yield* notAFile(attachment.name);
      }
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
    // Embedded text counts toward the message's allowance like inline bytes.
    const cap = Math.min(
      deliveryLimit(delivery, mimeType),
      INLINE_MESSAGE_MAX_BYTES - budget.inlineBytes,
    );
    // A record already past the cap is never read.
    if (cap <= 0 || attachment.sizeBytes > cap) return [note(attachment, path)];
    const bytes = yield* readStaged(path, attachment.name, cap);
    if (bytes === "too-big") return [note(attachment, path)];
    if (delivery === "text") {
      const text = decodeAttachmentText(bytes);
      if (text === undefined) return [note(attachment, path)];
      budget.inlineBytes += bytes.byteLength;
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
      mimeType.startsWith("audio/")
        ? { type: "audio", data, mimeType }
        : { type: "image", data, mimeType: mimeType || attachment.mimeType },
    ] satisfies ReadonlyArray<EffectAcpSchema.ContentBlock>;
  });

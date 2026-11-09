import type { ChatAttachment } from "@threadlines/contracts";

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Text bigger than this reaches an agent as a staged file, never inline:
 * about 25,000 tokens. More would crowd the conversation out of the model's
 * context (a 5 MB log is over a million tokens), and a file that size is
 * better searched or read in parts than read whole.
 */
export const INLINE_TEXT_ATTACHMENT_MAX_BYTES = 100 * 1024;

/** A text attachment too big to go inline (INLINE_TEXT_ATTACHMENT_MAX_BYTES). */
export function isLargeTextAttachment(attachment: ChatAttachment): boolean {
  return (
    attachment.type === "file" &&
    attachment.kind === "text" &&
    attachment.sizeBytes > INLINE_TEXT_ATTACHMENT_MAX_BYTES
  );
}

function readingGuidance(attachment: ChatAttachment): string {
  if (isLargeTextAttachment(attachment)) {
    return "It is too large to read whole: search it, or read the parts you need from that path.";
  }
  if (attachment.type === "image") {
    return "It is a picture in a format that could not be shown to you directly: open it from that path with a tool that reads or converts it.";
  }
  switch (attachment.kind) {
    case "pdf":
      return "Read it from that path. It is a binary PDF: use an installed PDF-reading skill or tool to inspect it rather than reading raw bytes.";
    case "text":
      return "Read it from that path to use its contents.";
    case "other":
      return "It is not plain text: open it from that path with a skill or tool that reads this kind of file (its name gives the format), rather than reading its raw bytes.";
  }
}

/** An attachment a provider cannot take as input (or one too big to, see
 *  isLargeTextAttachment) reaches it as a staged local path plus this
 *  instruction note, and the agent reads the file with its own tools. Codex
 *  app-server input has only text and images, ACP providers vary, and no
 *  provider takes every file type natively. */
export function buildFileAttachmentNote(attachment: ChatAttachment, stagedPath: string): string {
  const header = `Attached ${attachment.type === "image" ? "picture" : "file"} "${attachment.name}" (${attachment.mimeType}, ${formatAttachmentSize(attachment.sizeBytes)}) is staged at: ${stagedPath}`;
  return `[${header}\n${readingGuidance(attachment)}]`;
}

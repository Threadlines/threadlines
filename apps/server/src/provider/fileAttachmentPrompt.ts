import type { ChatFileAttachment } from "@threadlines/contracts";

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Providers without native document input (Codex app-server exposes only
 *  text/image input items; ACP providers vary) receive file attachments as
 *  a staged local path plus this instruction note. The agent reads the
 *  file with its own tools. */
export function buildFileAttachmentNote(
  attachment: ChatFileAttachment,
  stagedPath: string,
): string {
  const header = `Attached file "${attachment.name}" (${attachment.mimeType}, ${formatAttachmentSize(attachment.sizeBytes)}) is staged at: ${stagedPath}`;
  const guidance =
    attachment.kind === "pdf"
      ? "Read it from that path. It is a binary PDF: use an installed PDF-reading skill or tool to inspect it rather than reading raw bytes."
      : "Read it from that path to use its contents.";
  return `[${header}\n${guidance}]`;
}

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

function readingGuidance(attachment: ChatAttachment): string {
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

/** An attachment a provider cannot take as input reaches it as a staged
 *  local path plus this instruction note, and the agent reads the file with
 *  its own tools. Codex app-server input has only text and images, ACP
 *  providers vary, and no provider takes every file type natively. */
export function buildFileAttachmentNote(attachment: ChatAttachment, stagedPath: string): string {
  const header = `Attached ${attachment.type === "image" ? "picture" : "file"} "${attachment.name}" (${attachment.mimeType}, ${formatAttachmentSize(attachment.sizeBytes)}) is staged at: ${stagedPath}`;
  return `[${header}\n${readingGuidance(attachment)}]`;
}

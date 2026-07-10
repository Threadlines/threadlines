import type { ChatFileAttachmentKind } from "@threadlines/contracts";

/** Canonical MIME type, kind, and storage extension for a supported
 *  non-image attachment. The MVP allowlist covers PDF plus text-shaped
 *  files (plain text, markdown, CSV); everything else is rejected at
 *  upload normalization. */
export interface FileAttachmentType {
  readonly kind: ChatFileAttachmentKind;
  readonly mimeType: string;
  readonly extension: string;
}

const FILE_ATTACHMENT_TYPE_BY_MIME: Record<string, FileAttachmentType> = {
  "application/pdf": { kind: "pdf", mimeType: "application/pdf", extension: ".pdf" },
  "text/plain": { kind: "text", mimeType: "text/plain", extension: ".txt" },
  "text/markdown": { kind: "text", mimeType: "text/markdown", extension: ".md" },
  "text/csv": { kind: "text", mimeType: "text/csv", extension: ".csv" },
};

const FILE_ATTACHMENT_TYPE_BY_EXTENSION: Record<string, FileAttachmentType> = {
  ".pdf": FILE_ATTACHMENT_TYPE_BY_MIME["application/pdf"]!,
  ".txt": FILE_ATTACHMENT_TYPE_BY_MIME["text/plain"]!,
  ".md": FILE_ATTACHMENT_TYPE_BY_MIME["text/markdown"]!,
  ".markdown": FILE_ATTACHMENT_TYPE_BY_MIME["text/markdown"]!,
  ".csv": FILE_ATTACHMENT_TYPE_BY_MIME["text/csv"]!,
};

export const SAFE_FILE_ATTACHMENT_EXTENSIONS = new Set(
  Object.values(FILE_ATTACHMENT_TYPE_BY_MIME).map((type) => type.extension),
);

/** `accept` fragment for file pickers covering the supported non-image
 *  attachment types (extensions, since browsers report generic MIME types
 *  for several of them). */
export const FILE_ATTACHMENT_ACCEPT = Object.keys(FILE_ATTACHMENT_TYPE_BY_EXTENSION).join(",");

/** MIME types browsers commonly report for files they cannot classify.
 *  For these the file name extension is the only usable signal. */
const GENERIC_MIME_TYPES = new Set(["application/octet-stream", "application/x-unknown"]);

function extensionOf(fileName: string | undefined): string {
  const match = /\.([a-z0-9]{1,10})$/i.exec(fileName?.trim() ?? "");
  return match ? `.${match[1]!.toLowerCase()}` : "";
}

/** Resolves a supported file attachment type from the client-reported MIME
 *  type, falling back to the file name extension when the MIME type is
 *  missing or generic. Returns null for unsupported files. */
export function resolveFileAttachmentType(input: {
  readonly mimeType?: string | undefined;
  readonly fileName?: string | undefined;
}): FileAttachmentType | null {
  const mimeType = input.mimeType?.trim().toLowerCase().split(";")[0] ?? "";
  const byMime = Object.hasOwn(FILE_ATTACHMENT_TYPE_BY_MIME, mimeType)
    ? FILE_ATTACHMENT_TYPE_BY_MIME[mimeType]
    : undefined;
  if (byMime) {
    return byMime;
  }
  if (mimeType.length > 0 && !GENERIC_MIME_TYPES.has(mimeType)) {
    return null;
  }
  const extension = extensionOf(input.fileName);
  return Object.hasOwn(FILE_ATTACHMENT_TYPE_BY_EXTENSION, extension)
    ? (FILE_ATTACHMENT_TYPE_BY_EXTENSION[extension] ?? null)
    : null;
}

export function fileAttachmentExtension(input: {
  readonly mimeType: string;
  readonly fileName?: string | undefined;
}): string {
  return resolveFileAttachmentType(input)?.extension ?? ".bin";
}

export function fileAttachmentMimeTypeForExtension(extension: string): string | null {
  const normalized = extension.toLowerCase();
  return Object.hasOwn(FILE_ATTACHMENT_TYPE_BY_EXTENSION, normalized)
    ? (FILE_ATTACHMENT_TYPE_BY_EXTENSION[normalized]?.mimeType ?? null)
    : null;
}

// "%PDF-" — kept Buffer-free so browser bundles can use this module.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const TEXT_SNIFF_BYTES = 8_192;

/** Cheap content sniffing so mislabeled payloads are rejected at upload
 *  time: PDFs must carry the %PDF- magic, text files must not contain NUL
 *  bytes in their leading window. */
export function sniffFileAttachmentBytes(kind: ChatFileAttachmentKind, bytes: Uint8Array): boolean {
  switch (kind) {
    case "pdf":
      return (
        bytes.byteLength > PDF_MAGIC.length &&
        PDF_MAGIC.every((expected, index) => bytes[index] === expected)
      );
    case "text":
      return !bytes.subarray(0, TEXT_SNIFF_BYTES).includes(0);
  }
}

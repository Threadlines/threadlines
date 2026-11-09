import type { ChatFileAttachmentKind } from "@threadlines/contracts";

/** How a non-image attachment travels and where it is stored. Any file can
 *  be attached: `pdf` and `text` go to providers that read them natively,
 *  `other` (a Word document, a spreadsheet, an archive) is staged on disk
 *  for the agent to open with its own tools. */
export interface FileAttachmentType {
  readonly kind: ChatFileAttachmentKind;
  readonly mimeType: string;
  readonly extension: string;
}

/**
 * Types whose stored extension follows the MIME type alone. Attachments sent
 * before any file was allowed were stored under these extensions whatever
 * their names said (a `notes.log` sent as text/plain lives at `<id>.txt`),
 * and the stored path is derived from the record each time, so this mapping
 * must never change.
 */
const CANONICAL_FILE_TYPE_BY_MIME: Record<string, FileAttachmentType> = {
  "application/pdf": { kind: "pdf", mimeType: "application/pdf", extension: ".pdf" },
  "text/plain": { kind: "text", mimeType: "text/plain", extension: ".txt" },
  "text/markdown": { kind: "text", mimeType: "text/markdown", extension: ".md" },
  "text/csv": { kind: "text", mimeType: "text/csv", extension: ".csv" },
};

const CANONICAL_FILE_TYPE_BY_EXTENSION: Record<string, FileAttachmentType> = {
  ".pdf": CANONICAL_FILE_TYPE_BY_MIME["application/pdf"]!,
  ".txt": CANONICAL_FILE_TYPE_BY_MIME["text/plain"]!,
  ".md": CANONICAL_FILE_TYPE_BY_MIME["text/markdown"]!,
  ".markdown": CANONICAL_FILE_TYPE_BY_MIME["text/markdown"]!,
  ".csv": CANONICAL_FILE_TYPE_BY_MIME["text/csv"]!,
};

/** The extensions canonical types are stored under, the only file
 *  attachment extensions served back with their own content type. */
export const CANONICAL_FILE_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.values(CANONICAL_FILE_TYPE_BY_MIME).map((type) => type.extension),
);

const PLAIN_TEXT_TYPE = CANONICAL_FILE_TYPE_BY_MIME["text/plain"]!;
const UNKNOWN_BINARY_MIME_TYPE = "application/octet-stream";
const UNKNOWN_BINARY_EXTENSION = ".bin";

/** Text-shaped types browsers report outside `text/*`. */
const TEXT_APPLICATION_MIME_TYPES = new Set([
  "application/graphql",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/sql",
  "application/toml",
  "application/typescript",
  "application/x-httpd-php",
  "application/x-javascript",
  "application/x-ndjson",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-sql",
  "application/x-subrip",
  "application/x-tex",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
]);

/** Extensions of text files that browsers often label wrongly or not at all
 *  (`.ts` comes in as an MPEG video, most code with no type). */
const TEXT_FILE_EXTENSIONS = new Set([
  ".adoc",
  ".astro",
  ".bash",
  ".bat",
  ".bib",
  ".c",
  ".cc",
  ".cfg",
  ".cjs",
  ".clj",
  ".cmd",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".cts",
  ".cxx",
  ".dart",
  ".diff",
  ".env",
  ".erl",
  ".ex",
  ".exs",
  ".fish",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".hpp",
  ".hs",
  ".htm",
  ".html",
  ".ini",
  ".ipynb",
  ".java",
  ".js",
  ".json",
  ".json5",
  ".jsonl",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".log",
  ".lua",
  ".m",
  ".mjs",
  ".mm",
  ".mts",
  ".ndjson",
  ".org",
  ".patch",
  ".php",
  ".pl",
  ".properties",
  ".proto",
  ".ps1",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".rst",
  ".sass",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".srt",
  ".svelte",
  ".swift",
  ".tex",
  ".toml",
  ".ts",
  ".tsv",
  ".tsx",
  ".vtt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

/** MIME types browsers commonly report for files they cannot classify.
 *  For these the file name extension is the only usable signal. */
const GENERIC_MIME_TYPES = new Set(["application/octet-stream", "application/x-unknown"]);

/** A MIME type as the record keeps it: a plain `type/subtype` that fits the
 *  contract's 100 characters, or nothing. */
const RECORDABLE_MIME_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const RECORDABLE_MIME_TYPE_MAX_CHARS = 100;

function extensionOf(fileName: string | undefined): string {
  const match = /\.([a-z0-9]{1,10})$/i.exec(fileName?.trim() ?? "");
  return match ? `.${match[1]!.toLowerCase()}` : "";
}

function normalizeMimeType(mimeType: string | undefined): string {
  const normalized = mimeType?.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  return normalized.length <= RECORDABLE_MIME_TYPE_MAX_CHARS &&
    RECORDABLE_MIME_TYPE_PATTERN.test(normalized)
    ? normalized
    : "";
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith("text/") || TEXT_APPLICATION_MIME_TYPES.has(mimeType);
}

/**
 * The extension a file attachment is stored under. Canonical types keep
 * their fixed extension (see CANONICAL_FILE_TYPE_BY_MIME); every other file
 * keeps its own name's extension, so tools that go by it (a spreadsheet
 * reader wants `.xlsx`) can open the staged copy; `.bin` when it has none.
 */
export function fileAttachmentExtension(input: {
  readonly mimeType: string;
  readonly fileName?: string | undefined;
}): string {
  const canonical = Object.hasOwn(CANONICAL_FILE_TYPE_BY_MIME, input.mimeType)
    ? CANONICAL_FILE_TYPE_BY_MIME[input.mimeType]
    : undefined;
  if (canonical) {
    return canonical.extension;
  }
  return extensionOf(input.fileName) || UNKNOWN_BINARY_EXTENSION;
}

function typeOf(
  kind: ChatFileAttachmentKind,
  mimeType: string,
  fileName: string | undefined,
): FileAttachmentType {
  return { kind, mimeType, extension: fileAttachmentExtension({ mimeType, fileName }) };
}

function canonicalTypeByExtension(extension: string): FileAttachmentType | undefined {
  return Object.hasOwn(CANONICAL_FILE_TYPE_BY_EXTENSION, extension)
    ? CANONICAL_FILE_TYPE_BY_EXTENSION[extension]
    : undefined;
}

function isTextExtension(extension: string): boolean {
  return (
    TEXT_FILE_EXTENSIONS.has(extension) || canonicalTypeByExtension(extension)?.kind === "text"
  );
}

/**
 * Text is always recorded as one of the canonical text types, whatever the
 * browser called it (a .json file is text/plain): those are the only text
 * types older builds know, so one that receives a moved thread stores the
 * file where this build looks for it. The name keeps the real format.
 */
function textTypeFor(extension: string): FileAttachmentType {
  const canonical = canonicalTypeByExtension(extension);
  return canonical?.kind === "text" ? canonical : PLAIN_TEXT_TYPE;
}

/**
 * Resolves how a file travels from the client-reported MIME type and its
 * name, before its bytes are read. A concrete MIME type wins over the name,
 * except that a text file's own extension marks it as text whatever type the
 * browser guessed (`.ts` comes in as an MPEG video, a .csv on Windows as an
 * Excel file). Never fails: a file that is neither a PDF nor text is `other`.
 * The server settles the kind from the bytes (`classifyFileAttachmentBytes`).
 */
export function resolveFileAttachmentType(input: {
  readonly mimeType?: string | undefined;
  readonly fileName?: string | undefined;
}): FileAttachmentType {
  const mimeType = normalizeMimeType(input.mimeType);
  const extension = extensionOf(input.fileName);
  const canonicalByMime = Object.hasOwn(CANONICAL_FILE_TYPE_BY_MIME, mimeType)
    ? CANONICAL_FILE_TYPE_BY_MIME[mimeType]
    : undefined;
  if (canonicalByMime) {
    return canonicalByMime;
  }
  const genericMimeType = mimeType.length === 0 || GENERIC_MIME_TYPES.has(mimeType);
  if (genericMimeType && canonicalTypeByExtension(extension)?.kind === "pdf") {
    return CANONICAL_FILE_TYPE_BY_MIME["application/pdf"]!;
  }
  if (isTextExtension(extension) || (!genericMimeType && isTextMimeType(mimeType))) {
    return textTypeFor(extension);
  }
  return typeOf("other", genericMimeType ? UNKNOWN_BINARY_MIME_TYPE : mimeType, input.fileName);
}

/**
 * Settles a file's kind from its bytes, for the server to store. Text has to
 * read as text (no NUL bytes and valid UTF-8 in its leading window), or the
 * agent gets it as a file to open instead of inline. A file that reads as
 * text is text whatever its name said. A file that claims to be a PDF must
 * carry the PDF signature: null means it does not.
 */
export function classifyFileAttachmentBytes(
  type: FileAttachmentType,
  fileName: string | undefined,
  bytes: Uint8Array,
): FileAttachmentType | null {
  switch (type.kind) {
    case "pdf":
      return hasPdfSignature(bytes) ? type : null;
    case "text":
      return looksLikeText(bytes) ? type : typeOf("other", type.mimeType, fileName);
    case "other":
      return looksLikeText(bytes) ? textTypeFor(extensionOf(fileName)) : type;
  }
}

/** The MIME type to label a stored attachment's bytes with, from its stored
 *  extension: canonical types only, null for everything else. */
export function fileAttachmentMimeTypeForExtension(extension: string): string | null {
  const normalized = extension.toLowerCase();
  return Object.hasOwn(CANONICAL_FILE_TYPE_BY_EXTENSION, normalized)
    ? (CANONICAL_FILE_TYPE_BY_EXTENSION[normalized]?.mimeType ?? null)
    : null;
}

// "%PDF-" — kept Buffer-free so browser bundles can use this module.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const TEXT_SNIFF_BYTES = 8_192;

function hasPdfSignature(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength > PDF_MAGIC.length &&
    PDF_MAGIC.every((expected, index) => bytes[index] === expected)
  );
}

function looksLikeText(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, TEXT_SNIFF_BYTES);
  if (window.byteLength === 0 || window.includes(0)) {
    return false;
  }
  try {
    // `stream` leaves a character cut off at the window's end undecoded
    // rather than calling it invalid.
    new TextDecoder("utf-8", { fatal: true }).decode(window, { stream: true });
    return true;
  } catch {
    return false;
  }
}

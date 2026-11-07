/**
 * Which files the Media tab lists, and under which group.
 *
 * The server filters a project's turn summaries by these extensions in SQL,
 * and the web groups what comes back by `classifyMediaPath`, so the two can
 * never disagree about what counts as media. Text formats (Markdown, CSV,
 * JSON) are deliberately absent: they read as code and live in the Diff tab.
 */

export type MediaKind = "picture" | "video" | "audio" | "document";

/** Extensions per group, lowercase and without the dot. */
export const MEDIA_EXTENSIONS: Readonly<Record<MediaKind, ReadonlyArray<string>>> = {
  picture: [
    "avif",
    "bmp",
    "gif",
    "heic",
    "heif",
    "ico",
    "jpeg",
    "jpg",
    "png",
    "svg",
    "tif",
    "tiff",
    "webp",
  ],
  video: ["avi", "m4v", "mkv", "mov", "mp4", "webm"],
  audio: ["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav"],
  document: [
    "doc",
    "docx",
    "epub",
    "key",
    "numbers",
    "odp",
    "ods",
    "odt",
    "pages",
    "pdf",
    "ppt",
    "pptx",
    "rtf",
    "xls",
    "xlsx",
  ],
};

/** Display order of the groups. */
export const MEDIA_KIND_ORDER: ReadonlyArray<MediaKind> = ["picture", "video", "audio", "document"];

const KIND_BY_EXTENSION: ReadonlyMap<string, MediaKind> = new Map(
  MEDIA_KIND_ORDER.flatMap((kind) =>
    MEDIA_EXTENSIONS[kind].map((extension) => [extension, kind] as const),
  ),
);

/** Every media extension, for callers that filter before classifying. */
export const ALL_MEDIA_EXTENSIONS: ReadonlyArray<string> = [...KIND_BY_EXTENSION.keys()];

/** The lowercase extension of a path's last segment, or null when it has none. */
export function mediaPathExtension(path: string): string | null {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  // A leading dot is a hidden file's name, not an extension.
  if (dot <= 0 || dot === name.length - 1) {
    return null;
  }
  return name.slice(dot + 1).toLowerCase();
}

/** The Media tab group a path belongs to, or null when it is not media. */
export function classifyMediaPath(path: string): MediaKind | null {
  const extension = mediaPathExtension(path);
  return extension === null ? null : (KIND_BY_EXTENSION.get(extension) ?? null);
}

/**
 * Which paths the chat treats as pictures.
 *
 * One list, shared by every surface that can show an inline preview (markdown
 * links, inline-code references, bare paths in prose, tool rows), so a
 * screenshot referenced any of those ways is recognised the same way. The
 * server keeps its own set for what it is willing to serve; these are only
 * about what the client bothers to ask for.
 */
export const IMAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  "avif",
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

const IMAGE_FILE_EXTENSION_PATTERN = /\.([A-Za-z0-9]+)$/u;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/u;

/** Whether a path (optionally carrying a `:line[:column]` suffix) names an image. */
export function isImageFilePath(value: string): boolean {
  const withoutPosition = value.trim().replace(POSITION_SUFFIX_PATTERN, "");
  const withoutQuery = withoutPosition.split(/[?#]/u)[0] ?? withoutPosition;
  const extension = IMAGE_FILE_EXTENSION_PATTERN.exec(withoutQuery)?.[1];
  return extension !== undefined && IMAGE_FILE_EXTENSIONS.has(extension.toLowerCase());
}

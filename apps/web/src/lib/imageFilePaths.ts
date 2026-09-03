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

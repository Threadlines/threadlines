/**
 * How the chat reads file references in an agent's reply: which link
 * destinations, inline code spans and bare paths name a file, where a relative
 * one resolves against the thread's folder, and which of them are pictures.
 *
 * Shared so the chat (which draws them) and the server (which lists the
 * pictures the chat showed in the Media tab) apply one rule.
 *
 * @module chatLinks
 */
import type { ProjectEntry } from "@threadlines/contracts";

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
const IMAGE_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/u;

/** Whether a path (optionally carrying a `:line[:column]` suffix) names an image. */
export function isImageFilePath(value: string): boolean {
  const withoutPosition = value.trim().replace(IMAGE_POSITION_SUFFIX_PATTERN, "");
  const withoutQuery = withoutPosition.split(/[?#]/u)[0] ?? withoutPosition;
  const extension = IMAGE_FILE_EXTENSION_PATTERN.exec(withoutQuery)?.[1];
  return extension !== undefined && IMAGE_FILE_EXTENSIONS.has(extension.toLowerCase());
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

function isWindowsPathStyle(value: string): boolean {
  return isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value);
}

/** `value` without the slashes it ends in. A loop, not `/[\\/]+$/`: that
 *  pattern retries from every slash and slows to a crawl on a long run of them. */
function trimTrailingSeparators(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) {
    end -= 1;
  }
  return value.slice(0, end);
}

function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = trimTrailingSeparators(base);
  if (separator === "\\") {
    return `${cleanBase}\\${next.replaceAll("/", "\\")}`;
  }
  return `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

export function inferHomeFromCwd(cwd: string): string | undefined {
  const posixUser = cwd.match(/^\/Users\/([^/]+)/);
  if (posixUser?.[1]) {
    return `/Users/${posixUser[1]}`;
  }

  const posixHome = cwd.match(/^\/home\/([^/]+)/);
  if (posixHome?.[1]) {
    return `/home/${posixHome[1]}`;
  }

  const windowsUser = cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/);
  if (windowsUser?.[1]) {
    return windowsUser[1];
  }

  return undefined;
}

export function splitPathAndPosition(value: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} {
  let path = value;
  let column: string | undefined;
  let line: string | undefined;

  const columnMatch = path.match(/:(\d+)$/);
  if (!columnMatch?.[1]) {
    return { path, line: undefined, column: undefined };
  }

  column = columnMatch[1];
  path = path.slice(0, -columnMatch[0].length);

  const lineMatch = path.match(/:(\d+)$/);
  if (lineMatch?.[1]) {
    line = lineMatch[1];
    path = path.slice(0, -lineMatch[0].length);
  } else {
    line = column;
    column = undefined;
  }

  return { path, line, column };
}

export function resolvePathLinkTarget(rawPath: string, cwd: string): string {
  const { path, line, column } = splitPathAndPosition(rawPath);

  let resolvedPath = path;
  if (path.startsWith("~/")) {
    const home = inferHomeFromCwd(cwd);
    if (home) {
      const separator: "/" | "\\" = isWindowsPathStyle(home) ? "\\" : "/";
      resolvedPath = joinPath(home, path.slice(2), separator);
    }
  } else if (!isAbsolutePath(path)) {
    const separator: "/" | "\\" = isWindowsPathStyle(cwd) ? "\\" : "/";
    resolvedPath = joinPath(cwd, path, separator);
  }

  if (!line) return resolvedPath;
  return `${resolvedPath}:${line}${column ? `:${column}` : ""}`;
}

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
] as const;

/**
 * Local dev servers, written the way people actually write them.
 *
 * `localhost:5173` is not a link to any markdown parser -- it has no scheme --
 * but in a coding transcript it is always an address, and being told to copy it
 * into a browser by hand is the wrong end of the tool. The port is required:
 * "localhost" on its own is a word in a sentence far more often than it is a
 * place to go.
 */
const LOCALHOST_HOST_SOURCE = "(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0)";
const BARE_LOCALHOST_URL_REGEX = new RegExp(
  `${LOCALHOST_HOST_SOURCE}:\\d{1,5}(?:[/?#][^\\s]*)?`,
  "gi",
);
const WHOLE_LOCALHOST_URL_REGEX = new RegExp(
  `^(https?://)?${LOCALHOST_HOST_SOURCE}(:\\d{1,5})?(?:[/?#][^\\s]*)?$`,
  "i",
);
/** Characters that make a `localhost:` run part of something longer. */
const LOCALHOST_BOUNDARY_BLOCKERS = /[A-Za-z0-9._\-/:@]/;
const URL_TRAILING_PUNCTUATION = ".,;:!?'\"";

export interface BareLocalhostUrlMatch {
  readonly start: number;
  readonly end: number;
  /** The run as written, so the transcript still reads the way it was sent. */
  readonly text: string;
  /** The same address made loadable. */
  readonly url: string;
}

function trimUrlTrailingPunctuation(value: string): string {
  // Counted once and kept in step, not recounted per character: a run of
  // closing parentheses would otherwise cost its length squared.
  let opened = 0;
  let closed = 0;
  for (const char of value) {
    if (char === "(") opened += 1;
    else if (char === ")") closed += 1;
  }
  let end = value.length;
  while (end > 0) {
    const char = value[end - 1]!;
    if (URL_TRAILING_PUNCTUATION.includes(char)) {
      end -= 1;
      continue;
    }
    if (char === ")" && closed > opened) {
      end -= 1;
      closed -= 1;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

/**
 * Every bare `host:port` run in a stretch of plain text, in order.
 *
 * Scheme-less by design: text that already carries `http://` is turned into a
 * link by the markdown autolinker before this ever sees it.
 */
export function findBareLocalhostUrls(text: string): BareLocalhostUrlMatch[] {
  const matches: BareLocalhostUrlMatch[] = [];
  for (const match of text.matchAll(BARE_LOCALHOST_URL_REGEX)) {
    const start = match.index ?? 0;
    const previous = start === 0 ? "" : text[start - 1]!;
    if (previous !== "" && LOCALHOST_BOUNDARY_BLOCKERS.test(previous)) {
      continue;
    }
    const followingIndex = start + match[0].length;
    const following = text[followingIndex] ?? "";
    const afterFollowing = text[followingIndex + 1] ?? "";
    if (
      following !== "" &&
      LOCALHOST_BOUNDARY_BLOCKERS.test(following) &&
      // A full stop ending a sentence is punctuation, while `.example` means
      // the apparent port was only the start of a longer token.
      !(following === "." && !/[A-Za-z0-9_/-]/.test(afterFollowing))
    ) {
      continue;
    }
    const raw = trimUrlTrailingPunctuation(match[0]);
    if (!WHOLE_LOCALHOST_URL_REGEX.test(raw)) {
      continue;
    }
    matches.push({ start, end: start + raw.length, text: raw, url: `http://${raw}` });
  }
  return matches;
}

/**
 * The loadable address for a string that is entirely a localhost url, else null.
 *
 * Used for inline code spans, where the backticks already say "this is one
 * thing", so a scheme is optional and a bare host with a scheme but no port
 * (`http://localhost/health`) still counts.
 */
export function localhostUrlFromText(text: string): string | null {
  const trimmed = text.trim();
  const match = WHOLE_LOCALHOST_URL_REGEX.exec(trimmed);
  if (!match) {
    return null;
  }
  const scheme = match[1];
  const port = match[2];
  if (!scheme && !port) {
    return null;
  }
  return scheme ? trimmed : `http://${trimmed}`;
}

/**
 * A path shaped like nothing else, so it can be picked out of running prose.
 *
 * Only the four forms that cannot be mistaken for an English word: a Windows
 * drive (`C:\`, `C:/`), a POSIX absolute (`/`), a home path (`~/`), and an
 * explicit relative (`./`, `../`). A bare `screenshot.png` is deliberately not
 * here — it is as likely to be the name of a file being discussed as a file to
 * go and fetch, and guessing wrong means an unexpected picture in the middle of
 * a sentence.
 */
const BARE_IMAGE_PATH_REGEX = /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|\/)[^\s"'`<>|*?]+/g;
/** Characters that make a path run part of something longer. */
const BARE_PATH_BOUNDARY_BLOCKERS = /[A-Za-z0-9._\-/\\:@]/;

export interface BareImagePathMatch {
  readonly start: number;
  readonly end: number;
  /** The path as written, so the transcript still reads the way it was sent. */
  readonly text: string;
}

/**
 * Every bare image path in a stretch of plain text, in order.
 *
 * Scoped to plain text on purpose: paths inside links and backticks are already
 * recognised by the markdown pre-pass, and this only has to cover the case
 * where an agent simply typed where it put the screenshot.
 */
export function findBareImagePaths(text: string): BareImagePathMatch[] {
  const matches: BareImagePathMatch[] = [];
  for (const match of text.matchAll(BARE_IMAGE_PATH_REGEX)) {
    const start = match.index ?? 0;
    const previous = start === 0 ? "" : text[start - 1]!;
    if (previous !== "" && BARE_PATH_BOUNDARY_BLOCKERS.test(previous)) {
      continue;
    }
    const raw = trimUrlTrailingPunctuation(match[0]);
    if (raw.length === 0 || !isImageFilePath(raw) || !isLikelyPathCandidate(raw)) {
      continue;
    }
    matches.push({ start, end: start + raw.length, text: raw });
  }
  return matches;
}

/**
 * A Windows drive path, a home path, or a POSIX absolute path, ending in a file
 * name with a letter-led extension and an optional `:line[:column]`. Spaces are
 * allowed: this only ever sees the whole of an inline code span, whose
 * backticks already mark where the path starts and ends.
 */
const INLINE_ABSOLUTE_FILE_PATH_PATTERN =
  /^(?:[A-Za-z]:[\\/]|~?\/)[^"*<>?|#`\t]*\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+){0,2}$/;

/**
 * Whether inline code is, in its entirety, the absolute path of a file
 * (`C:\Users\me\Desktop\Threadlines X posts\home.png`). Such a path already
 * says where the file is, so it needs no workspace search to open. A POSIX path
 * must start at a root files live under, so a route like `/api/users.json`
 * stays code.
 */
export function isAbsoluteInlineFilePath(text: string): boolean {
  const trimmed = text.trim();
  if (!INLINE_ABSOLUTE_FILE_PATH_PATTERN.test(trimmed)) return false;
  return (
    !trimmed.startsWith("/") || POSIX_FILE_ROOT_PREFIXES.some((root) => trimmed.startsWith(root))
  );
}
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unwrapMarkdownLinkDestination(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

export function normalizeMarkdownLinkDestination(value: string): string {
  return unwrapMarkdownLinkDestination(value.trim());
}

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

function normalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

function encodeFileUrlPath(path: string): string {
  return path
    .split("/")
    .map((segment, index) =>
      index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment),
    )
    .join("/");
}

export function toMarkdownFileUrlHref(
  filePath: string,
  position?: { readonly line?: number | undefined; readonly column?: number | undefined },
): string {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const fileUrlPath = WINDOWS_DRIVE_PATH_PATTERN.test(normalizedPath)
    ? `/${encodeFileUrlPath(normalizedPath)}`
    : encodeFileUrlPath(normalizedPath);
  const line = position?.line;
  const column = position?.column;
  const hash = line ? `#L${line}${column ? `C${column}` : ""}` : "";
  return `file://${fileUrlPath}${hash}`;
}

function parseFileUrlHref(
  href: string,
  options?: { readonly decodePath?: boolean },
): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const rawPath = parsed.pathname;
    if (rawPath.length === 0) return null;

    // Browser URL parser encodes "C:/foo" as "/C:/foo" for file URLs.
    const normalizedPath = normalizeWindowsDrivePath(rawPath);

    return {
      path: options?.decodePath === false ? normalizedPath : safeDecode(normalizedPath),
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const target = parseFileUrlHref(normalizedHref, { decodePath: false });
  if (!target) return null;
  return `${target.path}${target.hash}`;
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  const line = match[1];
  const column = match[2];
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function isLikelyPathCandidate(path: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function isRelativePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") &&
      !WINDOWS_DRIVE_PATH_PATTERN.test(path) &&
      !WINDOWS_UNC_PATH_PATTERN.test(path))
  );
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
): string | null {
  if (!href) return null;
  const rawHref = normalizeMarkdownLinkDestination(href);
  if (rawHref.length === 0 || rawHref.startsWith("#")) return null;
  if (localhostUrlFromText(rawHref) !== null) return null;

  const fileUrlTarget = rawHref.toLowerCase().startsWith("file:")
    ? parseFileUrlHref(rawHref)
    : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawHref);
  const decodedPath = normalizeWindowsDrivePath(
    fileUrlTarget ? source.path.trim() : safeDecode(source.path.trim()),
  );
  const decodedHash = safeDecode(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null;
  }

  if (!isLikelyPathCandidate(decodedPath)) return null;

  const pathWithPosition = appendLineColumnFromHash(decodedPath, decodedHash);
  if (!isRelativePath(pathWithPosition)) {
    return pathWithPosition;
  }

  if (!cwd) return null;
  return resolvePathLinkTarget(pathWithPosition, cwd);
}

/**
 * Inline-code text that reads as a file reference: an optionally-pathed file
 * name with a letter-led extension and an optional `:line[:column]` suffix.
 * (`v0.1.0` and package names like `effect/Schema` deliberately do not match.)
 */
const CHAT_FILE_REFERENCE_PATTERN =
  /^(?<path>[\w.@~-]+(?:\/[\w.@~-]+)*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(?<line>\d+)(?::\d+)?)?$/;

/** Bare dotted identifiers (`telemetry.step`, `tool.started`) are common in
 * technical prose and look exactly like extensionless file names to a regex.
 * A path makes intent explicit; a bare name needs a familiar file extension
 * before the chat turns it into a file chip. */
const CHAT_BARE_FILE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "bat",
  "c",
  "cc",
  "cjs",
  "cpp",
  "cs",
  "css",
  "csv",
  "cxx",
  "env",
  "fish",
  "fs",
  "fsx",
  "gif",
  "go",
  "gql",
  "graphql",
  "h",
  "hpp",
  "htm",
  "html",
  "hxx",
  "ico",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "less",
  "lock",
  "md",
  "mdx",
  "mjs",
  "pdf",
  "php",
  "png",
  "proto",
  "ps1",
  "psm1",
  "py",
  "pyi",
  "rb",
  "rs",
  "sass",
  "scss",
  "sh",
  "sql",
  "svelte",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "vue",
  "webp",
  "xml",
  "yaml",
  "yml",
  "zsh",
]);

export function parseChatFileReference(
  text: string,
): { path: string; line: number | undefined } | null {
  const match = CHAT_FILE_REFERENCE_PATTERN.exec(text.trim());
  if (!match?.groups?.path) {
    return null;
  }
  const path = match.groups.path;
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!path.includes("/") && !CHAT_BARE_FILE_EXTENSIONS.has(extension)) {
    return null;
  }
  const line = match.groups.line ? Number.parseInt(match.groups.line, 10) : undefined;
  return { path, line };
}

/**
 * Files asked for per lookup. A current server returns only files the
 * reference can name, so two settle whether a path names one; an older one
 * ranks fuzzy hits, and the rest of the page gives the real ones room.
 */
export const FILE_REFERENCE_SEARCH_LIMIT = 32;

/** Which workspace search hit an inline-code reference names. */
export type ReferencedFileMatch =
  | { readonly status: "found"; readonly path: string }
  | { readonly status: "ambiguous" }
  | { readonly status: "none" };

/**
 * The workspace search hit an inline-code reference names. The search is
 * fuzzy, so its best hit can be some other file entirely: a reference only
 * ever resolves to a file whose path is it or ends with it. The file at the
 * path as written wins. Otherwise a bare name (`README.txt`) is the best-ranked
 * file with exactly that name, in whatever folder. A path is the one file whose
 * path ends with it, since agents often cite a path from inside a subfolder
 * (`Model/ReturnForm.php` for `shop/app/code/Buyfire/ReturnForm/Model/ReturnForm.php`);
 * when several do, nothing says which one is meant.
 */
export function findReferencedFile(
  entries: ReadonlyArray<ProjectEntry>,
  reference: string,
): ReferencedFileMatch {
  const wanted = reference.toLowerCase();
  const ending = `/${wanted}`;
  const matches = entries.filter((entry) => {
    if (entry.kind !== "file") return false;
    const path = entry.path.toLowerCase();
    return path === wanted || path.endsWith(ending);
  });
  // Exact spelling first: on a case-sensitive disk `src/Index.ts` and
  // `src/index.ts` are two files.
  const asWritten =
    matches.find((entry) => entry.path === reference) ??
    matches.find((entry) => entry.path.toLowerCase() === wanted);
  const best = asWritten ?? (wanted.includes("/") && matches.length > 1 ? undefined : matches[0]);
  if (best) {
    return { status: "found", path: best.path };
  }
  return matches.length > 1 ? { status: "ambiguous" } : { status: "none" };
}

/**
 * What one folder's path-ending search says an inline-code reference names
 * (`ProjectSearchEntriesInput.match: "path-ending"`). The file at the path as
 * written wins; past the index's size cap, one file found ending in a path is
 * not proof it is the only one, so that reads as ambiguous.
 */
export function placeReferenceInSearch(
  result: { readonly entries: ReadonlyArray<ProjectEntry>; readonly truncated: boolean },
  reference: string,
): ReferencedFileMatch {
  const match = findReferencedFile(result.entries, reference);
  const foundAsWritten = match.status === "found" && match.path === reference;
  if (result.truncated && reference.includes("/") && !foundAsWritten) {
    return match.status === "none" ? match : { status: "ambiguous" };
  }
  return match;
}

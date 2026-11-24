/**
 * What a chat markdown document is before React draws it: the blocks it renders
 * as, the streaming-tail repair, the file references it turns into chips and the
 * labels those chips wear. Pure, so the renderer (ChatMarkdown) and anything
 * that must know what the renderer shows (find in chat) read the same answers.
 */
import type { Options as ReactMarkdownOptions } from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { type PlaceId, placePathLabel } from "@threadlines/shared/appPlaces";

import { isPlaceLinkHref } from "@threadlines/shared/placeHref";
import { parseChatFileReference } from "../fileViewerStore";
import {
  fileLinkMetaForPath,
  findBareImagePaths,
  isAbsoluteInlineFilePath,
  localhostUrlFromText,
  type MarkdownFileLinkMeta,
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "../markdown-links";
import { createFenceTracker, laterMathClosers } from "./markdownFences";

export { splitMarkdownBlocks } from "@threadlines/shared/markdownBlocks";

/**
 * The markdown dialect chat speaks: GitHub-flavored, plus math. Only `$$`
 * delimits math here; normalizeChatMath (chatMarkdownMath.ts) rewrites the
 * other ways models write it into that form first, so a lone `$` stays a dollar.
 */
export const CHAT_MARKDOWN_REMARK_PLUGINS: NonNullable<ReactMarkdownOptions["remarkPlugins"]> = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: false }],
];

/**
 * GitHub's own allowlist, which is what the host already applied to the text
 * before it reached us. Anything outside it is unwrapped to its children, so a
 * `<relative-time>` still reads as its date and a `<picture>` as its image.
 */
export const GITHUB_HTML_REHYPE_PLUGINS: NonNullable<ReactMarkdownOptions["rehypePlugins"]> = [
  rehypeRaw,
  [rehypeSanitize, defaultSchema],
];

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

export function buildFileLinkParentSuffixByPath(
  filePaths: ReadonlyArray<string>,
): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const pathSegments = filePath
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(filePath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join("/") === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }

  return suffixByPath;
}

export function extractMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = match[1]?.trim();
    if (!href) continue;
    hrefs.push(href);
  }
  return hrefs;
}

export function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  return rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
}

/**
 * The one label a clickable file wears: name, then only as much of its parent
 * path as it takes to tell it from its namesakes in the same document, then the
 * position. Shared by markdown links and inline-code references so an
 * `AgentsPanel.tsx:300` written either way reads identically.
 */
export function buildFileLinkLabel(
  meta: MarkdownFileLinkMeta,
  parentSuffix: string | undefined,
): string {
  const labelParts = [meta.basename];
  if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
    labelParts.push(parentSuffix);
  }
  if (meta.line) {
    labelParts.push(`L${meta.line}${meta.column ? `:C${meta.column}` : ""}`);
  }
  return labelParts.join(" · ");
}

const INLINE_CODE_RUN_PATTERN = /(`+)([^`\n]+)\1/g;

/**
 * Every inline code span in a markdown document, skipping fenced blocks.
 *
 * Deliberately approximate: it exists so the file-link pre-pass sees the same
 * references the `code` renderer will, and anything it misses falls through to
 * plain inline code rather than to a wrong label.
 */
function extractInlineCodeSpans(text: string): string[] {
  const spans: string[] = [];
  const fence = createFenceTracker();

  for (const line of text.split("\n")) {
    if (fence.feed(line) !== "text") continue;

    for (const match of line.matchAll(INLINE_CODE_RUN_PATTERN)) {
      const span = match[2]?.trim();
      if (span) spans.push(span);
    }
  }

  return spans;
}

/**
 * Resolved metadata for every inline-code file reference in a document, keyed by
 * the span as written: a project-style reference (which is also what
 * {@link openChatFileReference} takes) or an absolute path.
 */
export function buildInlineCodeFileLinkMeta(
  text: string,
  cwd: string | undefined,
): ReadonlyMap<string, MarkdownFileLinkMeta> {
  let metaBySpan: Map<string, MarkdownFileLinkMeta> | null = null;
  for (const span of extractInlineCodeSpans(text)) {
    if (metaBySpan?.has(span)) continue;
    // A dev-server address reads as a file reference too (`127.0.0.1:8080`); it
    // is handled as an address by the renderer and must not become a chip.
    if (localhostUrlFromText(span)) continue;
    if (!parseChatFileReference(span) && !isAbsoluteInlineFilePath(span)) continue;
    const meta = resolveMarkdownFileLinkMeta(span, cwd);
    if (meta) {
      metaBySpan ??= new Map();
      metaBySpan.set(span, meta);
    }
  }
  return metaBySpan ?? EMPTY_FILE_LINK_META_MAP;
}

const TAIL_CONTAINER_PREFIX_REGEX = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])(?= ))?[ \t]*/;

function isTailMarkerBoundary(char: string): boolean {
  return char === "" || char === " " || char === "\t";
}

function isTailWordCharacter(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char);
}

/** Closers for the inline markers still open at the end of one line, innermost first. */
function unclosedInlineMarkerClosers(line: string): string {
  const scanned = line.replace(TAIL_CONTAINER_PREFIX_REGEX, "");
  const openMarkers: string[] = [];
  const toggleMarker = (marker: string) => {
    const openIndex = openMarkers.lastIndexOf(marker);
    if (openIndex >= 0) openMarkers.splice(openIndex, 1);
    else openMarkers.push(marker);
  };

  let openBacktickRun = 0;
  let index = 0;
  while (index < scanned.length) {
    const char = scanned[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") {
      let runLength = 1;
      while (scanned[index + runLength] === "`") runLength += 1;
      if (openBacktickRun === 0) openBacktickRun = runLength;
      else if (openBacktickRun === runLength) openBacktickRun = 0;
      index += runLength;
      continue;
    }
    if (openBacktickRun > 0) {
      index += 1;
      continue;
    }
    if (char === "$" && scanned[index + 1] === "$") {
      // Math is not markup: `$$x_{i}$$` has no emphasis to close, and an
      // unfinished formula holds everything after it.
      const close = scanned.indexOf("$$", index + 2);
      if (close === -1) break;
      index = close + 2;
      continue;
    }
    if (char !== "*" && char !== "_" && char !== "~") {
      index += 1;
      continue;
    }

    let runLength = 1;
    while (scanned[index + runLength] === char) runLength += 1;
    const before = index === 0 ? "" : scanned[index - 1]!;
    const after = scanned[index + runLength] ?? "";
    index += runLength;

    // Whitespace on both sides opens nothing (`2 * 3`), and that includes the
    // freshly typed `**` at the end of a line: closing it would only render
    // `****`.
    if (isTailMarkerBoundary(before) && isTailMarkerBoundary(after)) continue;
    if (char === "~") {
      if (runLength === 2) toggleMarker("~~");
      continue;
    }
    // `snake_case` is a word, not emphasis.
    if (char === "_" && isTailWordCharacter(before) && isTailWordCharacter(after)) continue;
    if (runLength === 1) {
      toggleMarker(char);
    } else if (runLength === 2) {
      toggleMarker(char + char);
    } else if (runLength === 3) {
      toggleMarker(char + char);
      toggleMarker(char);
    }
    // Longer runs are ambiguous; leave them to the parser.
  }

  let closers = openBacktickRun > 0 ? "`".repeat(openBacktickRun) : "";
  for (let openIndex = openMarkers.length - 1; openIndex >= 0; openIndex -= 1) {
    closers += openMarkers[openIndex];
  }
  return closers;
}

/**
 * Closes the inline markers left hanging at the end of a streaming tail, so a
 * reader watching a reply arrive never sees a raw `**`, `_`, `~~`, or backtick
 * waiting for its partner. Render-only: the stored message text keeps exactly
 * what the model sent.
 *
 * Deliberately narrow. It reads the last line only, stays out of fenced code,
 * leaves link and image syntax alone, and skips runs CommonMark could not open
 * emphasis with anyway, because a wrong closer is more visible than the flicker
 * it would have prevented.
 */
export function repairStreamingMarkdownTail(text: string): string {
  if (text.length === 0) return text;

  const lines = text.split("\n");
  const fence = createFenceTracker();
  let lastLineIsFenceMarker = false;
  for (const line of lines) {
    const fenceLine = fence.feed(line);
    lastLineIsFenceMarker = fenceLine === "open" || fenceLine === "close";
  }
  if (fence.isOpen() || lastLineIsFenceMarker) return text;

  const lastLine = lines[lines.length - 1] ?? "";
  if (lastLine.trim() === "") return text;

  return text + unclosedInlineMarkerClosers(lastLine);
}

/** A link whose words only repeat the number the chip already prints. */
const REDUNDANT_PULL_REQUEST_LINK_TEXT = /^(?:pr\s*)?#?\d+$/i;

/**
 * The words a pull request chip keeps after its `#number`: the link's own
 * text, unless it is only the address or only repeats the number.
 */
export function pullRequestLinkLabel(linkText: string, href: string): string {
  const text = linkText.trim();
  return text === href.trim() || REDUNDANT_PULL_REQUEST_LINK_TEXT.test(text) ? "" : text;
}

/**
 * The words a place chip wears: the link's own text, or the place's path when
 * the link has none.
 */
export function placeLinkLabel(linkText: string, placeId: PlaceId): string {
  return linkText.trim() || placePathLabel(placeId);
}

/**
 * Where a link or image in a chat document points once the renderer has read
 * it: place links kept as written (the anchor decides what an id is worth),
 * file URIs and dev-server addresses rewritten, file references resolved
 * against the working directory, everything else through react-markdown's own
 * safety filter, which would drop the place scheme.
 */
export function chatMarkdownUrlTransform(href: string, cwd: string | undefined): string {
  if (isPlaceLinkHref(href)) return href;

  const rewrittenFileHref = rewriteMarkdownFileUriHref(href);
  if (rewrittenFileHref) return rewrittenFileHref;

  const localhostHref = localhostUrlFromText(href);
  if (localhostHref) return localhostHref;

  const fileLinkMeta = resolveMarkdownFileLinkMeta(href, cwd);
  return fileLinkMeta?.href ?? defaultUrlTransform(href);
}

const EMPTY_FILE_LINK_META_MAP: ReadonlyMap<string, MarkdownFileLinkMeta> = new Map();
const EMPTY_SUFFIX_MAP: ReadonlyMap<string, string> = new Map();
const EMPTY_SPAN_SET: ReadonlySet<string> = new Set();
const EMPTY_PATHS: readonly string[] = [];

/** Per-block file-path summary used to avoid rescanning settled blocks while streaming. */
export interface MarkdownBlockFileLinkScan {
  readonly writtenPaths: readonly string[];
  /** Bare file names referenced in inline code (`home.png`, `math.ts:12`), without line/column. */
  readonly bareFileNames: readonly string[];
}

const EMPTY_BLOCK_FILE_LINK_SCAN: MarkdownBlockFileLinkScan = {
  writtenPaths: EMPTY_PATHS,
  bareFileNames: EMPTY_PATHS,
};

const MAX_BLOCK_FILE_LINK_SCAN_CACHE_ENTRIES = 512;
const blockFileLinkScanCache = new Map<string, MarkdownBlockFileLinkScan>();

function scanMarkdownBlockFileLinksUncached(
  text: string,
  cwd: string | undefined,
): MarkdownBlockFileLinkScan {
  let writtenPaths: Set<string> | null = null;
  let bareFileNames: Set<string> | null = null;
  const addWritten = (written: string) => {
    const meta = resolveMarkdownFileLinkMeta(written, cwd);
    if (meta) {
      writtenPaths ??= new Set();
      writtenPaths.add(meta.filePath);
    }
  };
  const lines = text.split("\n");
  const fence = createFenceTracker({ closesLater: laterMathClosers(lines) });
  for (const line of lines) {
    if (fence.feed(line) !== "text") continue;
    for (const href of extractMarkdownLinkHrefs(line)) {
      if (href.includes("/") || href.includes("\\")) addWritten(normalizeMarkdownLinkHrefKey(href));
    }
    for (const match of line.matchAll(INLINE_CODE_RUN_PATTERN)) {
      const span = match[2]?.trim();
      if (!span) continue;
      if (isAbsoluteInlineFilePath(span)) {
        addWritten(span);
        continue;
      }
      if (localhostUrlFromText(span)) continue;
      const reference = parseChatFileReference(span);
      if (reference && !reference.path.includes("/")) {
        bareFileNames ??= new Set();
        bareFileNames.add(reference.path);
      }
    }
    const prose = line.replace(INLINE_CODE_RUN_PATTERN, (run) => " ".repeat(run.length));
    for (const match of findBareImagePaths(prose)) addWritten(match.text);
  }
  if (!writtenPaths && !bareFileNames) {
    return EMPTY_BLOCK_FILE_LINK_SCAN;
  }
  return {
    writtenPaths: writtenPaths ? [...writtenPaths].toSorted() : EMPTY_PATHS,
    bareFileNames: bareFileNames ? [...bareFileNames].toSorted() : EMPTY_PATHS,
  };
}

/**
 * Scans one markdown block for written file paths and bare inline-code file
 * names. Settled blocks hit a bounded LRU cache so streaming deltas only scan
 * the growing tail block.
 */
export function scanMarkdownBlockFileLinks(
  text: string,
  cwd: string | undefined,
  options?: { readonly cache?: boolean },
): MarkdownBlockFileLinkScan {
  if (options?.cache === false) {
    return scanMarkdownBlockFileLinksUncached(text, cwd);
  }
  const cacheKey = `${cwd ?? ""}\u0000${text}`;
  const cached = blockFileLinkScanCache.get(cacheKey);
  if (cached !== undefined) {
    blockFileLinkScanCache.delete(cacheKey);
    blockFileLinkScanCache.set(cacheKey, cached);
    return cached;
  }
  const computed = scanMarkdownBlockFileLinksUncached(text, cwd);
  if (blockFileLinkScanCache.size >= MAX_BLOCK_FILE_LINK_SCAN_CACHE_ENTRIES) {
    const oldestKey = blockFileLinkScanCache.keys().next().value;
    if (oldestKey !== undefined) {
      blockFileLinkScanCache.delete(oldestKey);
    }
  }
  blockFileLinkScanCache.set(cacheKey, computed);
  return computed;
}

/** Groups written file paths by trailing basename segment for O(1) bare-name lookup. */
export function indexWrittenFilePathsByBasename(
  writtenPaths: Iterable<string>,
): ReadonlyMap<string, readonly string[]> {
  const byBasename = new Map<string, Set<string>>();
  for (const filePath of writtenPaths) {
    const slashed = filePath.replaceAll("\\", "/");
    const lastSlash = slashed.lastIndexOf("/");
    if (lastSlash < 0) continue;
    const basename = slashed.slice(lastSlash + 1);
    if (!basename) continue;
    let group = byBasename.get(basename);
    if (!group) {
      group = new Set();
      byBasename.set(basename, group);
    }
    group.add(filePath);
  }
  const sorted = new Map<string, readonly string[]>();
  for (const [basename, group] of byBasename) {
    sorted.set(basename, [...group].toSorted());
  }
  return sorted;
}

/** Returns only the written paths that could match one of `bareFileNames`, as a newline-joined key. */
export function selectWrittenFilePathsKeyForBareNames(
  bareFileNames: readonly string[],
  writtenPathsByBasename: ReadonlyMap<string, readonly string[]>,
): string {
  if (bareFileNames.length === 0 || writtenPathsByBasename.size === 0) {
    return "";
  }
  if (bareFileNames.length === 1) {
    const matches = writtenPathsByBasename.get(bareFileNames[0]!);
    return matches ? matches.join("\n") : "";
  }
  let matched: Set<string> | null = null;
  for (const name of bareFileNames) {
    const group = writtenPathsByBasename.get(name);
    if (!group) continue;
    matched ??= new Set();
    for (const filePath of group) {
      matched.add(filePath);
    }
  }
  return matched ? [...matched].toSorted().join("\n") : "";
}

/**
 * Every file a message names by a written-out path: a link with a folder in
 * it, an inline code span that is an absolute path, an image path typed in
 * prose. Fenced blocks are skipped, and so is a path inside a longer code span:
 * a path in a command is not a citation. Read over the whole message, since
 * chat draws each block on its own and a name often sits blocks below the path
 * that placed it. Sorted, so equal answers compare equal.
 */
export function collectWrittenFilePaths(text: string, cwd: string | undefined): readonly string[] {
  return scanMarkdownBlockFileLinksUncached(text, cwd).writtenPaths;
}

/**
 * Agents often write a file's full path once and then call it by name. A bare
 * name in inline code (`home.png`, `math.ts:12`) that exactly one written-out
 * path ends in is that file, at the line the name cites. Searching the
 * workspace for the name instead would miss any file outside the project. A
 * name two written paths end in is left to the search, and so is a partial
 * path (`Model/Form.php`): agents are told to cite project files that way, so
 * it means the project's copy even when another copy's full path is nearby.
 */
function placeShortReferencesByWrittenPaths(
  inlineMetaBySpan: ReadonlyMap<string, MarkdownFileLinkMeta>,
  writtenFilePaths: readonly string[],
  cwd: string | undefined,
): {
  readonly metaBySpan: ReadonlyMap<string, MarkdownFileLinkMeta>;
  readonly placedSpans: ReadonlySet<string>;
} {
  if (writtenFilePaths.length === 0) {
    return { metaBySpan: inlineMetaBySpan, placedSpans: EMPTY_SPAN_SET };
  }
  const written = writtenFilePaths.map((filePath) => ({
    filePath,
    slashed: filePath.replaceAll("\\", "/"),
  }));
  let metaBySpan: Map<string, MarkdownFileLinkMeta> | null = null;
  const placedSpans = new Set<string>();
  for (const span of inlineMetaBySpan.keys()) {
    if (isAbsoluteInlineFilePath(span)) continue;
    const reference = parseChatFileReference(span);
    if (!reference || reference.path.includes("/")) continue;
    const suffix = `/${reference.path}`;
    const matches = written.filter((path) => path.slashed.endsWith(suffix));
    if (matches.length !== 1) continue;
    const { filePath } = matches[0]!;
    metaBySpan ??= new Map(inlineMetaBySpan);
    metaBySpan.set(
      span,
      fileLinkMetaForPath(
        reference.line !== undefined ? `${filePath}:${reference.line}` : filePath,
        cwd,
      ),
    );
    placedSpans.add(span);
  }
  return metaBySpan === null
    ? { metaBySpan: inlineMetaBySpan, placedSpans: EMPTY_SPAN_SET }
    : { metaBySpan, placedSpans };
}

/**
 * Whether inline code names a file by its name alone (`math.ts:12`): no folder,
 * and no full path for it anywhere in the message. Such a name is drawn as the
 * code the agent wrote, not as a chip, since nothing says where the file is.
 */
export function isFileNameMention(span: string, placedByDocument: ReadonlySet<string>): boolean {
  if (placedByDocument.has(span) || isAbsoluteInlineFilePath(span)) return false;
  const reference = parseChatFileReference(span);
  return reference !== null && !reference.path.includes("/");
}

/** Every file reference one document turns into a chip, and how each is labelled. */
export interface MarkdownDocumentFileLinks {
  /** Markdown links that point at a file, keyed by normalized href. */
  readonly markdownFileLinkMetaByHref: ReadonlyMap<string, MarkdownFileLinkMeta>;
  /** Inline-code file references, keyed by the span as written. */
  readonly inlineCodeFileLinkMetaBySpan: ReadonlyMap<string, MarkdownFileLinkMeta>;
  /**
   * Bare file names in inline code (`home.png`, `math.ts:12`) the same
   * message already placed by writing the file's full path. Their entry in
   * {@link inlineCodeFileLinkMetaBySpan} is that file, so they open it directly
   * instead of searching the workspace for the name.
   */
  readonly inlineCodeSpansPlacedByDocument: ReadonlySet<string>;
  /** Both of the above in one map (links win), for the file-kind lookup. */
  readonly fileLinkMetaByKey: ReadonlyMap<string, MarkdownFileLinkMeta>;
  /** The parent-folder suffix that tells a file from its namesakes. */
  readonly fileLinkParentSuffixByPath: ReadonlyMap<string, string>;
}

/**
 * The file-link pre-pass one document runs before rendering. Links and inline
 * references share it, so the same file cited both ways gets the same
 * parent-suffix disambiguation. `inlineCodeChips` off keeps inline code as
 * written (a highlighted search hit must not shorten into a chip).
 * `writtenFilePaths` is {@link collectWrittenFilePaths} of the whole message
 * this document is a block of; without it, only this document's own paths
 * place its short references.
 */
export function resolveMarkdownDocumentFileLinks(
  text: string,
  cwd: string | undefined,
  options: {
    readonly inlineCodeChips: boolean;
    readonly writtenFilePaths?: readonly string[] | undefined;
  },
): MarkdownDocumentFileLinks {
  let markdownFileLinkMetaByHrefMap: Map<string, MarkdownFileLinkMeta> | null = null;
  for (const href of extractMarkdownLinkHrefs(text)) {
    const normalizedHref = normalizeMarkdownLinkHrefKey(href);
    if (markdownFileLinkMetaByHrefMap?.has(normalizedHref)) continue;
    const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd);
    if (meta) {
      markdownFileLinkMetaByHrefMap ??= new Map();
      markdownFileLinkMetaByHrefMap.set(normalizedHref, meta);
    }
  }
  const markdownFileLinkMetaByHref: ReadonlyMap<string, MarkdownFileLinkMeta> =
    markdownFileLinkMetaByHrefMap ?? EMPTY_FILE_LINK_META_MAP;
  const { metaBySpan: inlineCodeFileLinkMetaBySpan, placedSpans: inlineCodeSpansPlacedByDocument } =
    options.inlineCodeChips
      ? placeShortReferencesByWrittenPaths(
          buildInlineCodeFileLinkMeta(text, cwd),
          options.writtenFilePaths ?? collectWrittenFilePaths(text, cwd),
          cwd,
        )
      : { metaBySpan: EMPTY_FILE_LINK_META_MAP, placedSpans: EMPTY_SPAN_SET };
  let fileLinkMetaByKey: ReadonlyMap<string, MarkdownFileLinkMeta> = markdownFileLinkMetaByHref;
  if (inlineCodeFileLinkMetaBySpan.size > 0) {
    if (markdownFileLinkMetaByHref.size === 0) {
      fileLinkMetaByKey = inlineCodeFileLinkMetaBySpan;
    } else {
      const merged = new Map(markdownFileLinkMetaByHref);
      for (const [span, meta] of inlineCodeFileLinkMetaBySpan) {
        if (!merged.has(span)) merged.set(span, meta);
      }
      fileLinkMetaByKey = merged;
    }
  }
  const fileLinkParentSuffixByPath: ReadonlyMap<string, string> =
    fileLinkMetaByKey.size < 2
      ? EMPTY_SUFFIX_MAP
      : buildFileLinkParentSuffixByPath(
          [...fileLinkMetaByKey.values()].map((meta) => meta.filePath),
        );
  return {
    markdownFileLinkMetaByHref,
    inlineCodeFileLinkMetaBySpan,
    inlineCodeSpansPlacedByDocument,
    fileLinkMetaByKey,
    fileLinkParentSuffixByPath,
  };
}

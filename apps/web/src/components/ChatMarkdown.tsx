import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import type {
  EnvironmentId,
  ScopedThreadRef,
  ServerProviderSkill,
  ThreadId,
} from "@threadlines/contracts";
import React, {
  Children,
  Suspense,
  type MouseEvent as ReactMouseEvent,
  isValidElement,
  use,
  useCallback,
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { MessageCopyButton } from "./chat/MessageCopyButton";
import {
  renderSkillInlineMarkdownChildren,
  SearchHighlightedInlineText,
} from "./chat/SkillInlineText";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { openInPreferredEditor } from "../editorPreferences";
import {
  isPathWithinCwd,
  openChatFileReference,
  openDirectoryInActiveViewer,
  openFileInActiveViewer,
  parseChatFileReference,
} from "../fileViewerStore";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import { useTheme } from "../hooks/useTheme";
import {
  localhostUrlFromText,
  type MarkdownFileLinkMeta,
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "../markdown-links";
import { readLocalApi } from "../localApi";
import { ChatWebLink } from "./chat/ChatWebLink";
import { copyTextWithToast } from "./chat/copyTextWithToast";
import { isBrowserPanelHref } from "./browser/openInBrowserPanel";
import {
  type MarkdownFileLinkKind,
  useMarkdownFileLinkKinds,
} from "../hooks/useMarkdownFileLinkKinds";
import { cn } from "../lib/utils";
import { parseCodexInlineVisualizations } from "../lib/codexInlineVisualization";
import { CodexInlineVisualization } from "./chat/CodexInlineVisualization";

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  environmentId?: EnvironmentId | undefined;
  threadId?: ThreadId | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  searchHighlightQuery?: string | undefined;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  // react-markdown passes the configured code renderer element here rather
  // than a literal `code` host element, so inspecting `type` drops every
  // fenced block whenever a custom code renderer is installed.
  if (!isValidElement<{ className?: string; children?: ReactNode }>(onlyChild)) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

function MarkdownCodeBlock({ code, children }: { code: string; children: ReactNode }) {
  return (
    <div className="chat-markdown-codeblock leading-snug">
      <MessageCopyButton
        text={code}
        ariaLabel="Copy code block"
        size="icon-xs"
        variant="outline"
        className="chat-markdown-copy-button"
      />
      {children}
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
}

function SuspenseShikiCodeBlock({ className, code, themeName }: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = highlightedCodeCache.get(cacheKey);

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="chat-markdown-shiki"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    highlightedCodeCache.set(
      cacheKey,
      highlightedHtml,
      estimateHighlightedSize(highlightedHtml, code),
    );
  }, [cacheKey, code, highlightedHtml]);

  return (
    <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
  );
}

interface MarkdownFileLinkProps {
  href: string;
  targetPath: string;
  displayPath: string;
  filePath: string;
  kind: MarkdownFileLinkKind;
  isInWorkspace: boolean;
  line?: number | undefined;
  label: string;
  theme: "light" | "dark";
  className?: string | undefined;
  /**
   * Set when the chip was built from an inline-code reference rather than a
   * link. Such a reference is often a bare file name (`AgentsPanel.tsx:300`)
   * whose real location is only known after a workspace search, so it opens
   * through {@link openChatFileReference} and the affordances that need a
   * settled path (copy path, reveal, open in editor) stay off.
   */
  chatReference?: string | undefined;
}

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
const MARKDOWN_FILE_LINK_CLASS_NAME =
  "chat-markdown-file-link relative top-[2px] max-w-full no-underline";
const MARKDOWN_FILE_LINK_ICON_CLASS_NAME = "chat-markdown-file-link-icon size-3.5 shrink-0";
const MARKDOWN_FILE_LINK_LABEL_CLASS_NAME = "chat-markdown-file-link-label truncate";
/** Inline code that does something when clicked, whether a file or an address. */
const CLICKABLE_INLINE_CODE_CLASS_NAME =
  "cursor-pointer transition-colors hover:text-foreground hover:underline hover:decoration-dotted hover:underline-offset-2";
function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

function buildFileLinkParentSuffixByPath(filePaths: ReadonlyArray<string>): Map<string, string> {
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

function extractMarkdownLinkHrefs(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = match[1]?.trim();
    if (!href) continue;
    hrefs.push(href);
  }
  return hrefs;
}

function normalizeMarkdownLinkHrefKey(href: string): string {
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  return rewriteMarkdownFileUriHref(normalizedHref) ?? normalizedHref;
}

/**
 * The one label a clickable file wears: name, then only as much of its parent
 * path as it takes to tell it from its namesakes in the same document, then the
 * position. Shared by markdown links and inline-code references so an
 * `AgentsPanel.tsx:300` written either way reads identically.
 */
function buildFileLinkLabel(meta: MarkdownFileLinkMeta, parentSuffix: string | undefined): string {
  const labelParts = [meta.basename];
  if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
    labelParts.push(parentSuffix);
  }
  if (meta.line) {
    labelParts.push(`L${meta.line}${meta.column ? `:C${meta.column}` : ""}`);
  }
  return labelParts.join(" · ");
}

const BLOCK_FENCE_MARKER_REGEX = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RUN_PATTERN = /(`+)([^`\n]+)\1/g;
const EMPTY_FILE_LINK_META_MAP: ReadonlyMap<string, MarkdownFileLinkMeta> = new Map();

/**
 * Every inline code span in a markdown document, skipping fenced blocks.
 *
 * Deliberately approximate: it exists so the file-link pre-pass sees the same
 * references the `code` renderer will, and anything it misses falls through to
 * plain inline code rather than to a wrong label.
 */
function extractInlineCodeSpans(text: string): string[] {
  const spans: string[] = [];
  let openFence: { char: string; length: number } | null = null;

  for (const line of text.split("\n")) {
    const fenceMatch = BLOCK_FENCE_MARKER_REGEX.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (openFence === null) {
        openFence = { char: marker[0]!, length: marker.length };
      } else if (
        marker[0] === openFence.char &&
        marker.length >= openFence.length &&
        (fenceMatch[2] ?? "").trim() === ""
      ) {
        openFence = null;
      }
      continue;
    }
    if (openFence !== null) continue;

    for (const match of line.matchAll(INLINE_CODE_RUN_PATTERN)) {
      const span = match[2]?.trim();
      if (span) spans.push(span);
    }
  }

  return spans;
}

/**
 * Resolved metadata for every inline-code file reference in a document, keyed by
 * the span as written (which is also what {@link openChatFileReference} takes).
 */
function buildInlineCodeFileLinkMeta(
  text: string,
  cwd: string | undefined,
): ReadonlyMap<string, MarkdownFileLinkMeta> {
  const metaBySpan = new Map<string, MarkdownFileLinkMeta>();
  for (const span of extractInlineCodeSpans(text)) {
    if (metaBySpan.has(span)) continue;
    // A dev-server address reads as a file reference too (`127.0.0.1:8080`); it
    // is handled as an address by the renderer and must not become a chip.
    if (localhostUrlFromText(span)) continue;
    if (!parseChatFileReference(span)) continue;
    const meta = resolveMarkdownFileLinkMeta(span, cwd);
    if (meta) metaBySpan.set(span, meta);
  }
  return metaBySpan;
}

const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  targetPath,
  displayPath,
  filePath,
  kind,
  isInWorkspace,
  line,
  label,
  theme,
  className,
  chatReference,
}: MarkdownFileLinkProps) {
  const entryLabel = kind === "directory" ? "folder" : "file";

  /** Opens an inline-code reference, resolving bare names through workspace
   *  search. Returns false when this chip did not come from one. */
  const openReference = useCallback(() => {
    if (chatReference === undefined) {
      return false;
    }
    void openChatFileReference(chatReference).then((opened) => {
      if (!opened) {
        toastManager.add({
          type: "error",
          title: "File not found in workspace",
          description: chatReference,
        });
      }
    });
    return true;
  }, [chatReference]);

  const handleOpenExternally = useCallback(() => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Open in editor is unavailable",
      });
      return;
    }

    void openInPreferredEditor(api, targetPath).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Unable to open ${entryLabel}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, [entryLabel, targetPath]);

  const handleRevealInFileManager = useCallback(() => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Open in file manager is unavailable",
      });
      return;
    }

    void api.shell.openInEditor(targetPath, "file-manager").catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: kind === "directory" ? "Unable to open folder" : "Unable to reveal file",
          description: error instanceof Error ? error.message : displayPath,
        }),
      );
    });
  }, [displayPath, kind, targetPath]);

  const openInInternalViewer = useCallback(
    () =>
      kind === "directory"
        ? openDirectoryInActiveViewer({ path: targetPath })
        : openFileInActiveViewer({ path: targetPath, line }),
    [kind, line, targetPath],
  );

  const handleOpen = useCallback(() => {
    if (openReference()) {
      return;
    }
    if (openInInternalViewer()) {
      return;
    }
    if (kind === "directory") {
      handleRevealInFileManager();
      return;
    }
    handleOpenExternally();
  }, [handleOpenExternally, handleRevealInFileManager, kind, openInInternalViewer, openReference]);

  const handleOpenInViewer = useCallback(() => {
    if (openReference() || openInInternalViewer()) {
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open in file viewer",
        description: `${displayPath} is not available in the active project workspace.`,
      }),
    );
  }, [displayPath, openInInternalViewer, openReference]);

  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      const clicked = await api.contextMenu.show(
        isInWorkspace
          ? ([
              {
                id: "open",
                label: kind === "directory" ? "Browse folder" : "Open in file viewer",
              },
              {
                id: "open-external",
                label: kind === "directory" ? "Open folder in editor" : "Open in editor",
              },
              { id: "copy-relative", label: "Copy relative path" },
              { id: "copy-full", label: "Copy full path" },
            ] as const)
          : ([
              {
                id: "open-external",
                label: kind === "directory" ? "Open folder in editor" : "Open in editor",
              },
              {
                id: "reveal",
                label: kind === "directory" ? "Open in file manager" : "Reveal in file manager",
              },
              { id: "copy-full", label: "Copy full path" },
            ] as const),
        { x: event.clientX, y: event.clientY },
      );

      if (clicked === "open") {
        handleOpenInViewer();
        return;
      }
      if (clicked === "open-external") {
        handleOpenExternally();
        return;
      }
      if (clicked === "reveal") {
        handleRevealInFileManager();
        return;
      }
      if (clicked === "copy-relative") {
        copyTextWithToast(displayPath, "Relative path");
        return;
      }
      if (clicked === "copy-full") {
        copyTextWithToast(targetPath, "Full path");
      }
    },
    [
      displayPath,
      handleOpenExternally,
      handleOpenInViewer,
      handleRevealInFileManager,
      isInWorkspace,
      kind,
      targetPath,
    ],
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            className={cn(MARKDOWN_FILE_LINK_CLASS_NAME, className)}
            data-entry-kind={kind}
            data-workspace-scope={isInWorkspace ? "internal" : "external"}
            data-chat-file-reference={chatReference}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleOpen();
            }}
            // Enter already activates a link; Space does not, and the chip is a
            // single tab stop that reads as a button, so it fires on both.
            onKeyDown={(event) => {
              if (event.key === " ") {
                event.preventDefault();
                handleOpen();
              }
            }}
            // An inline reference may be a bare name resolved by search, so the
            // menu's path actions would copy or reveal a guess.
            onContextMenu={chatReference === undefined ? handleContextMenu : undefined}
          >
            <VscodeEntryIcon
              pathValue={filePath}
              kind={kind}
              theme={theme}
              className={cn(MARKDOWN_FILE_LINK_ICON_CLASS_NAME, "text-current")}
            />
            <span className={MARKDOWN_FILE_LINK_LABEL_CLASS_NAME}>{label}</span>
          </a>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight"
      >
        <div className="markdown-file-link-tooltip-scroll overflow-x-auto whitespace-nowrap">
          {displayPath}
        </div>
        {!isInWorkspace ? (
          <div className="mt-1 font-sans text-muted-foreground">Outside active project</div>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.href === next.href &&
    previous.targetPath === next.targetPath &&
    previous.displayPath === next.displayPath &&
    previous.filePath === next.filePath &&
    previous.kind === next.kind &&
    previous.isInWorkspace === next.isInWorkspace &&
    previous.line === next.line &&
    previous.label === next.label &&
    previous.theme === next.theme &&
    previous.className === next.className &&
    previous.chatReference === next.chatReference
  );
}

/**
 * Splits markdown into top-level blocks at blank lines outside fenced code
 * blocks, so a streaming message can memoize settled blocks and re-parse
 * only the growing tail. Fidelity note: constructs that reference across
 * blank lines (reference-style link definitions, footnotes) degrade while
 * streaming; the final non-streaming render parses the full document again.
 */
export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let openFence: { char: string; length: number } | null = null;

  for (const line of lines) {
    const fenceMatch = BLOCK_FENCE_MARKER_REGEX.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const rest = fenceMatch[2] ?? "";
      if (openFence === null) {
        openFence = { char: marker[0]!, length: marker.length };
      } else if (
        marker[0] === openFence.char &&
        marker.length >= openFence.length &&
        rest.trim() === ""
      ) {
        openFence = null;
      }
      current.push(line);
      continue;
    }

    if (openFence === null && line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }

    current.push(line);
  }

  if (current.length > 0) {
    blocks.push(current.join("\n"));
  }
  return blocks;
}

function ChatMarkdownDocument({
  text,
  cwd,
  environmentId,
  threadId,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  searchHighlightQuery,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  // Null unless both halves of the identity are here: a transcript rendered
  // outside a thread (a plan preview, a subagent excerpt without context) has
  // no browser to open anything in, and its links stay ordinary links.
  const threadRef = useMemo<ScopedThreadRef | null>(
    () => (environmentId && threadId ? { environmentId, threadId } : null),
    [environmentId, threadId],
  );
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const href of extractMarkdownLinkHrefs(text)) {
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [cwd, text]);
  // While a search hit is being highlighted in this document the reader is
  // hunting for literal text, and a chip both drops the highlight and shortens
  // the path -- the matched characters could leave the page entirely. So the
  // one document being highlighted keeps its references as written.
  const inlineCodeFileLinkMetaBySpan = useMemo(
    () =>
      searchHighlightQuery?.trim()
        ? EMPTY_FILE_LINK_META_MAP
        : buildInlineCodeFileLinkMeta(text, cwd),
    [cwd, searchHighlightQuery, text],
  );
  // Links and inline references share one pre-pass, so the same file cited both
  // ways gets the same parent-suffix disambiguation and the same resolved kind.
  const fileLinkMetaByKey = useMemo(() => {
    if (inlineCodeFileLinkMetaBySpan.size === 0) {
      return markdownFileLinkMetaByHref;
    }
    const merged = new Map(markdownFileLinkMetaByHref);
    for (const [span, meta] of inlineCodeFileLinkMetaBySpan) {
      if (!merged.has(span)) merged.set(span, meta);
    }
    return merged;
  }, [inlineCodeFileLinkMetaBySpan, markdownFileLinkMetaByHref]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [...fileLinkMetaByKey.values()].map((meta) => meta.filePath);
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [fileLinkMetaByKey]);
  const fileLinkKindByPath = useMarkdownFileLinkKinds(fileLinkMetaByKey, environmentId, cwd);
  const markdownUrlTransform = useCallback(
    (href: string) => {
      const rewrittenFileHref = rewriteMarkdownFileUriHref(href);
      if (rewrittenFileHref) return rewrittenFileHref;

      const localhostHref = localhostUrlFromText(href);
      if (localhostHref) return localhostHref;

      const fileLinkMeta = resolveMarkdownFileLinkMeta(href, cwd);
      return fileLinkMeta?.href ?? defaultUrlTransform(href);
    },
    [cwd],
  );
  const inlineContext = useMemo(
    () => ({ skills, searchHighlightQuery, threadRef }),
    [searchHighlightQuery, skills, threadRef],
  );
  const markdownComponents = useMemo<Components>(
    () => ({
      p({ node: _node, children, ...props }) {
        return <p {...props}>{renderSkillInlineMarkdownChildren(children, inlineContext)}</p>;
      },
      li({ node: _node, children, ...props }) {
        return <li {...props}>{renderSkillInlineMarkdownChildren(children, inlineContext)}</li>;
      },
      a({ node: _node, href, children, ...props }) {
        const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
        const fileLinkMeta = normalizedHref
          ? (markdownFileLinkMetaByHref.get(normalizedHref) ??
            resolveMarkdownFileLinkMeta(normalizedHref, cwd))
          : null;
        if (!fileLinkMeta) {
          if (href && isBrowserPanelHref(href)) {
            return (
              <ChatWebLink
                href={href}
                threadRef={threadRef}
                className={props.className}
                title={props.title}
              >
                {children}
              </ChatWebLink>
            );
          }
          return (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          );
        }

        return (
          <MarkdownFileLink
            href={fileLinkMeta.href}
            targetPath={fileLinkMeta.targetPath}
            displayPath={fileLinkMeta.displayPath}
            filePath={fileLinkMeta.filePath}
            kind={fileLinkKindByPath.get(fileLinkMeta.filePath) ?? "file"}
            isInWorkspace={Boolean(cwd && isPathWithinCwd(fileLinkMeta.filePath, cwd))}
            line={fileLinkMeta.line}
            label={buildFileLinkLabel(
              fileLinkMeta,
              fileLinkParentSuffixByPath.get(fileLinkMeta.filePath),
            )}
            theme={resolvedTheme}
            className={props.className}
          />
        );
      },
      code({ node: _node, className, children, ...props }) {
        // Inline code that reads as a file reference (`ChatComposer.tsx:1010`)
        // opens the internal file viewer; bare names resolve via workspace
        // search. Fenced blocks carry a language class and are skipped.
        const text = typeof children === "string" ? children : null;
        const renderedChildren = text ? (
          <SearchHighlightedInlineText text={text} query={searchHighlightQuery} />
        ) : (
          children
        );
        // A dev-server address in backticks is an address first: it would also
        // read as a file reference (`127.0.0.1:8080`), and searching the
        // workspace for it would find nothing.
        const localhostUrl = className || !text ? null : localhostUrlFromText(text);
        if (localhostUrl) {
          return (
            <code {...props} className={className}>
              <ChatWebLink
                href={localhostUrl}
                threadRef={threadRef}
                className={CLICKABLE_INLINE_CODE_CLASS_NAME}
              >
                {renderedChildren}
              </ChatWebLink>
            </code>
          );
        }
        // Opted in, this reference wears the same chip a markdown file link
        // does: in a narrow column the raw path wraps mid-token and reads as a
        // broken button, and one clickable-file style beats two.
        const inlineFileReference = className || !text ? null : text.trim();
        const inlineFileLinkMeta = inlineFileReference
          ? inlineCodeFileLinkMetaBySpan.get(inlineFileReference)
          : undefined;
        if (inlineFileReference && inlineFileLinkMeta) {
          return (
            <MarkdownFileLink
              href={inlineFileLinkMeta.href}
              targetPath={inlineFileLinkMeta.targetPath}
              displayPath={inlineFileLinkMeta.displayPath}
              filePath={inlineFileLinkMeta.filePath}
              kind={fileLinkKindByPath.get(inlineFileLinkMeta.filePath) ?? "file"}
              isInWorkspace={Boolean(cwd && isPathWithinCwd(inlineFileLinkMeta.filePath, cwd))}
              line={inlineFileLinkMeta.line}
              label={buildFileLinkLabel(
                inlineFileLinkMeta,
                fileLinkParentSuffixByPath.get(inlineFileLinkMeta.filePath),
              )}
              theme={resolvedTheme}
              chatReference={inlineFileReference}
            />
          );
        }
        if (className || !text || !parseChatFileReference(text)) {
          return (
            <code {...props} className={className}>
              {renderedChildren}
            </code>
          );
        }
        const openReference = () => {
          void openChatFileReference(text).then((opened) => {
            if (!opened) {
              toastManager.add({
                type: "error",
                title: "File not found in workspace",
                description: text,
              });
            }
          });
        };
        return (
          <code
            {...props}
            role="button"
            tabIndex={0}
            title={`Open ${text}`}
            className={CLICKABLE_INLINE_CODE_CLASS_NAME}
            onClick={openReference}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openReference();
              }
            }}
          >
            {renderedChildren}
          </code>
        );
      },
      pre({ node: _node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        // While this document is an actively growing streaming tail, skip
        // Shiki entirely: re-highlighting the open fence on every delta is
        // O(n²) in block size. The block gets highlighted (and cached) once
        // it settles or the message finishes streaming.
        if (isStreaming) {
          return (
            <MarkdownCodeBlock code={codeBlock.code}>
              <pre {...props}>{children}</pre>
            </MarkdownCodeBlock>
          );
        }

        return (
          <MarkdownCodeBlock code={codeBlock.code}>
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={diffThemeName}
                />
              </Suspense>
            </CodeHighlightErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
    }),
    [
      cwd,
      diffThemeName,
      fileLinkKindByPath,
      fileLinkParentSuffixByPath,
      inlineCodeFileLinkMetaBySpan,
      inlineContext,
      isStreaming,
      markdownFileLinkMetaByHref,
      resolvedTheme,
      searchHighlightQuery,
      threadRef,
    ],
  );

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={markdownComponents}
      urlTransform={markdownUrlTransform}
    >
      {text}
    </ReactMarkdown>
  );
}

const MemoChatMarkdownDocument = memo(ChatMarkdownDocument);

function StreamingTailBlock({
  text,
  cwd,
  environmentId,
  threadId,
  skills = EMPTY_MARKDOWN_SKILLS,
  searchHighlightQuery,
}: Omit<ChatMarkdownProps, "isStreaming">) {
  // Lets React drop intermediate parses when deltas outpace rendering
  // (older CPUs) instead of parsing every 50ms server flush.
  const deferredText = useDeferredValue(text);
  return (
    <MemoChatMarkdownDocument
      text={deferredText}
      cwd={cwd}
      environmentId={environmentId}
      threadId={threadId}
      isStreaming
      skills={skills}
      searchHighlightQuery={searchHighlightQuery}
    />
  );
}

function ChatMarkdownBody({
  text,
  cwd,
  environmentId,
  threadId,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  searchHighlightQuery,
}: ChatMarkdownProps) {
  let body: ReactNode;
  if (isStreaming) {
    // Streaming: parse settled blocks once and re-parse only the growing
    // tail. Index keys are the correct identity here: streaming only appends
    // blocks, and keying by content would remount the tail on every delta.
    const blocks = splitMarkdownBlocks(text);
    const tailIndex = blocks.length - 1;
    /* oxlint-disable react/no-array-index-key -- streaming only appends blocks; index is the stable identity */
    body = blocks.map((block, index) =>
      index === tailIndex ? (
        <StreamingTailBlock
          key={index}
          text={block}
          cwd={cwd}
          environmentId={environmentId}
          threadId={threadId}
          skills={skills}
          searchHighlightQuery={searchHighlightQuery}
        />
      ) : (
        <MemoChatMarkdownDocument
          key={index}
          text={block}
          cwd={cwd}
          environmentId={environmentId}
          threadId={threadId}
          isStreaming={false}
          skills={skills}
          searchHighlightQuery={searchHighlightQuery}
        />
      ),
    );
    /* oxlint-enable react/no-array-index-key */
  } else {
    body = (
      <MemoChatMarkdownDocument
        text={text}
        cwd={cwd}
        environmentId={environmentId}
        threadId={threadId}
        isStreaming={false}
        skills={skills}
        searchHighlightQuery={searchHighlightQuery}
      />
    );
  }

  return body;
}

function ChatMarkdown({
  text,
  cwd,
  environmentId,
  threadId,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  searchHighlightQuery,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const canRenderVisualizations = environmentId !== undefined && threadId !== undefined;
  const segments = canRenderVisualizations
    ? parseCodexInlineVisualizations(text, { isStreaming })
    : [{ type: "markdown" as const, key: "markdown:0", text }];

  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80">
      {segments.map((segment, index) => {
        if (segment.type === "visualization") {
          return environmentId && threadId ? (
            <CodexInlineVisualization
              key={segment.key}
              environmentId={environmentId}
              threadId={threadId}
              file={segment.file}
              theme={resolvedTheme}
            />
          ) : null;
        }
        return (
          <ChatMarkdownBody
            key={segment.key}
            text={segment.text}
            cwd={cwd}
            environmentId={environmentId}
            threadId={threadId}
            isStreaming={isStreaming && index === segments.length - 1}
            skills={skills}
            searchHighlightQuery={searchHighlightQuery}
          />
        );
      })}
    </div>
  );
}

export default memo(ChatMarkdown);

import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import type { EnvironmentId, ServerProviderSkill } from "@threadlines/contracts";
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
  normalizeMarkdownLinkDestination,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "../markdown-links";
import { readLocalApi } from "../localApi";
import {
  type MarkdownFileLinkKind,
  useMarkdownFileLinkKinds,
} from "../hooks/useMarkdownFileLinkKinds";
import { cn } from "../lib/utils";

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
}

const MARKDOWN_LINK_HREF_PATTERN = /\[[^\]]*]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
const MARKDOWN_FILE_LINK_CLASS_NAME =
  "chat-markdown-file-link relative top-[2px] max-w-full no-underline";
const MARKDOWN_FILE_LINK_ICON_CLASS_NAME = "chat-markdown-file-link-icon size-3.5 shrink-0";
const MARKDOWN_FILE_LINK_LABEL_CLASS_NAME = "chat-markdown-file-link-label truncate";
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
}: MarkdownFileLinkProps) {
  const entryLabel = kind === "directory" ? "folder" : "file";

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
    if (openInInternalViewer()) {
      return;
    }
    if (kind === "directory") {
      handleRevealInFileManager();
      return;
    }
    handleOpenExternally();
  }, [handleOpenExternally, handleRevealInFileManager, kind, openInInternalViewer]);

  const handleOpenInViewer = useCallback(() => {
    if (openInInternalViewer()) {
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Unable to open in file viewer",
        description: `${displayPath} is not available in the active project workspace.`,
      }),
    );
  }, [displayPath, openInInternalViewer]);

  const handleCopy = useCallback((value: string, title: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to copy ${title.toLowerCase()}`,
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(value).then(
      () => {
        toastManager.add({
          type: "success",
          title: `${title} copied`,
          description: value,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to copy ${title.toLowerCase()}`,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);

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
        handleCopy(displayPath, "Relative path");
        return;
      }
      if (clicked === "copy-full") {
        handleCopy(targetPath, "Full path");
      }
    },
    [
      displayPath,
      handleCopy,
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
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleOpen();
            }}
            onContextMenu={handleContextMenu}
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
    previous.className === next.className
  );
}

const BLOCK_FENCE_MARKER_REGEX = /^ {0,3}(`{3,}|~{3,})(.*)$/;

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
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  searchHighlightQuery,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
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
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath);
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [markdownFileLinkMetaByHref]);
  const fileLinkKindByPath = useMarkdownFileLinkKinds(
    markdownFileLinkMetaByHref,
    environmentId,
    cwd,
  );
  const markdownUrlTransform = useCallback((href: string) => {
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  }, []);
  const markdownComponents = useMemo<Components>(
    () => ({
      p({ node: _node, children, ...props }) {
        return (
          <p {...props}>
            {renderSkillInlineMarkdownChildren(children, skills, searchHighlightQuery)}
          </p>
        );
      },
      li({ node: _node, children, ...props }) {
        return (
          <li {...props}>
            {renderSkillInlineMarkdownChildren(children, skills, searchHighlightQuery)}
          </li>
        );
      },
      a({ node: _node, href, ...props }) {
        const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
        const fileLinkMeta = normalizedHref
          ? (markdownFileLinkMetaByHref.get(normalizedHref) ??
            resolveMarkdownFileLinkMeta(normalizedHref, cwd))
          : null;
        if (!fileLinkMeta) {
          return <a {...props} href={href} target="_blank" rel="noopener noreferrer" />;
        }

        const parentSuffix = fileLinkParentSuffixByPath.get(fileLinkMeta.filePath);
        const labelParts = [fileLinkMeta.basename];
        if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
          labelParts.push(parentSuffix);
        }
        if (fileLinkMeta.line) {
          labelParts.push(
            `L${fileLinkMeta.line}${fileLinkMeta.column ? `:C${fileLinkMeta.column}` : ""}`,
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
            label={labelParts.join(" · ")}
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
            className="cursor-pointer transition-colors hover:text-foreground hover:underline hover:decoration-dotted hover:underline-offset-2"
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
      isStreaming,
      markdownFileLinkMetaByHref,
      resolvedTheme,
      searchHighlightQuery,
      skills,
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
      isStreaming
      skills={skills}
      searchHighlightQuery={searchHighlightQuery}
    />
  );
}

function ChatMarkdown({
  text,
  cwd,
  environmentId,
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
          skills={skills}
          searchHighlightQuery={searchHighlightQuery}
        />
      ) : (
        <MemoChatMarkdownDocument
          key={index}
          text={block}
          cwd={cwd}
          environmentId={environmentId}
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
        isStreaming={false}
        skills={skills}
        searchHighlightQuery={searchHighlightQuery}
      />
    );
  }

  return (
    <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80">
      {body}
    </div>
  );
}

export default memo(ChatMarkdown);

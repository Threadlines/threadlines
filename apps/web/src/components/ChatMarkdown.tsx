import type {
  EnvironmentId,
  ScopedThreadRef,
  ServerProviderSkill,
  ThreadId,
} from "@threadlines/contracts";
import React, {
  Children,
  Fragment,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  createContext,
  isValidElement,
  useCallback,
  memo,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components, Options as ReactMarkdownOptions } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { MessageCopyButton } from "./chat/MessageCopyButton";
import {
  type InlineMarkdownContext,
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
import {
  highlightCode,
  openStreamingHighlight,
  warmCodeHighlighter,
  type StreamToken,
  type StreamingHighlight,
} from "../lib/codeHighlight";
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
  /**
   * Render the raw HTML GitHub allows in a pull request body or comment
   * (tables with markup in cells, images, details). Chat stays markdown-only,
   * where an agent's stray tag is safer shown than interpreted.
   */
  html?: "github" | undefined;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];

/**
 * GitHub's own allowlist, which is what the host already applied to the text
 * before it reached us. Anything outside it is unwrapped to its children, so a
 * `<relative-time>` still reads as its date and a `<picture>` as its image.
 */
const GITHUB_HTML_REHYPE_PLUGINS: NonNullable<ReactMarkdownOptions["rehypePlugins"]> = [
  rehypeRaw,
  [rehypeSanitize, defaultSchema],
];

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;
const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);

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

/** Everything a markdown renderer needs from the document around it. */
interface MarkdownDocumentContextValue {
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly resolvedTheme: "light" | "dark";
  readonly themeName: DiffThemeName;
  /** Whether this document is a still-growing streaming tail. */
  readonly isStreaming: boolean;
  readonly searchHighlightQuery: string | undefined;
  readonly inlineContext: InlineMarkdownContext;
  readonly markdownFileLinkMetaByHref: ReadonlyMap<string, MarkdownFileLinkMeta>;
  readonly inlineCodeFileLinkMetaBySpan: ReadonlyMap<string, MarkdownFileLinkMeta>;
  readonly fileLinkParentSuffixByPath: ReadonlyMap<string, string>;
  readonly fileLinkKindByPath: ReadonlyMap<string, MarkdownFileLinkKind>;
}

/**
 * The document's data reaches its renderers through context, never through a
 * closure. React reconciles by component identity, so a renderer rebuilt for
 * new data is a new component type: every element it made would unmount and
 * remount. On a streaming tail that is the whole message, on every delta -- the
 * DOM is thrown away, code blocks lose the color they streamed, and the reveal
 * mask re-collects from scratch. Context changes re-render the same components
 * instead, which is what {@link MARKDOWN_COMPONENTS} being a constant buys.
 */
const MarkdownDocumentContext = createContext<MarkdownDocumentContextValue>({
  cwd: undefined,
  threadRef: null,
  resolvedTheme: "dark",
  themeName: resolveDiffThemeName("dark"),
  isStreaming: false,
  searchHighlightQuery: undefined,
  inlineContext: { skills: EMPTY_MARKDOWN_SKILLS, threadRef: null },
  markdownFileLinkMetaByHref: new Map(),
  inlineCodeFileLinkMetaBySpan: new Map(),
  fileLinkParentSuffixByPath: new Map(),
  fileLinkKindByPath: new Map(),
});

/** Shiki's `FontStyle` flags, as they reach us on a themed token. */
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

function streamTokenStyle(token: StreamToken): CSSProperties | undefined {
  const fontStyle = token.fontStyle ?? 0;
  if (token.color === undefined && fontStyle <= 0) return undefined;
  const style: CSSProperties = {};
  if (token.color !== undefined) style.color = token.color;
  if (fontStyle & FONT_STYLE_ITALIC) style.fontStyle = "italic";
  if (fontStyle & FONT_STYLE_BOLD) style.fontWeight = "bold";
  const decorations: string[] = [];
  if (fontStyle & FONT_STYLE_UNDERLINE) decorations.push("underline");
  if (fontStyle & FONT_STYLE_STRIKETHROUGH) decorations.push("line-through");
  if (decorations.length > 0) style.textDecoration = decorations.join(" ");
  return style;
}

const EMPTY_STREAM_TOKENS: readonly StreamToken[] = [];
const EMPTY_STREAM_LINES: ReactNode[] = [];

/**
 * One line, shaped exactly like Shiki's `codeToHtml` output down to the newline
 * that separates lines, so the settled HTML can replace it without anything
 * moving.
 */
function renderStreamLine(tokens: readonly StreamToken[], index: number): ReactNode {
  return (
    <Fragment key={index}>
      {index > 0 ? "\n" : null}
      <span className="line">
        {tokens.map((token, tokenIndex) => (
          // oxlint-disable-next-line react/no-array-index-key -- position is the only identity a token has
          <span key={tokenIndex} style={streamTokenStyle(token)}>
            {token.content}
          </span>
        ))}
      </span>
    </Fragment>
  );
}

interface StreamLineBuild {
  /** Rendered lines. Every one but the last is final. */
  lines: ReactNode[];
  /** Where the last (still growing) line starts in the token array. */
  lineStart: number;
}

/**
 * Rebuilds only the last line and whatever followed it: a recall never reaches
 * past the newline before it, so every earlier line's element can be reused,
 * and React skips the ones it already rendered. That is what keeps a 500-line
 * block costing the same per flush as a five-line one.
 */
function buildStreamLines(build: StreamLineBuild, tokens: readonly StreamToken[]): ReactNode[] {
  if (build.lines.length > 0) build.lines.length -= 1;
  let lineTokens: StreamToken[] = [];
  for (let index = build.lineStart; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.content === "\n") {
      build.lines.push(renderStreamLine(lineTokens, build.lines.length));
      lineTokens = [];
      build.lineStart = index + 1;
      continue;
    }
    lineTokens.push(token);
  }
  build.lines.push(renderStreamLine(lineTokens, build.lines.length));
  return [...build.lines];
}

interface CodeBlockStream {
  readonly handle: StreamingHighlight;
  readonly language: string;
  readonly theme: DiffThemeName;
  readonly build: StreamLineBuild;
  /** Code already handed to the tokenizer, without the trailing newline. */
  sent: string;
}

interface ChatCodeBlockProps {
  className: string | undefined;
  code: string;
  /** The unhighlighted block, shown until (or unless) a highlight lands. */
  plain: ReactNode;
}

/**
 * One fenced block, from its first character to its settled HTML.
 *
 * While the fence is open the worker tokenizes each delta and this paints the
 * tokens, so the block is colored as it arrives instead of only once it closes.
 * When it settles the stream is flushed and the one-shot HTML requested, but
 * the streamed tokens stay on screen until that HTML lands: a block that has
 * color never drops back to plain. Blocks that mount already settled (history,
 * cache hits) skip the stream entirely.
 */
function ChatCodeBlock({ className, code, plain }: ChatCodeBlockProps) {
  const { isStreaming, themeName } = useContext(MarkdownDocumentContext);
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const [highlighted, setHighlighted] = useState<{ cacheKey: string; html: string } | null>(null);
  const [streamLines, setStreamLines] = useState<ReactNode[]>(EMPTY_STREAM_LINES);
  const streamRef = useRef<CodeBlockStream | null>(null);

  // The state copy keeps the block highlighted after the shared cache evicts it.
  const highlightedHtml = isStreaming
    ? null
    : (highlightedCodeCache.get(cacheKey) ??
      (highlighted?.cacheKey === cacheKey ? highlighted.html : null));

  useEffect(() => {
    if (!isStreaming) {
      // Flushes the last partial line. `close()` reclassifies the tail rather
      // than retokenizing it, so settling changes nothing on screen.
      streamRef.current?.handle.close();
      return;
    }

    // `code` carries the trailing newline react-markdown adds. The tokenizer
    // gets the text without it so every delta stays a pure append; the blank
    // last line it stands for is added back at render.
    const streamed = code.endsWith("\n") ? code.slice(0, -1) : code;
    let stream = streamRef.current;
    if (
      stream &&
      (stream.language !== language ||
        stream.theme !== themeName ||
        !streamed.startsWith(stream.sent))
    ) {
      // Not an append (a retry, an edit, a theme change): start the block over.
      stream.handle.dispose();
      streamRef.current = null;
      stream = null;
      setStreamLines(EMPTY_STREAM_LINES);
    }
    if (!stream) {
      const opened: CodeBlockStream = {
        handle: openStreamingHighlight(language, themeName),
        language,
        theme: themeName,
        build: { lines: [], lineStart: 0 },
        sent: "",
      };
      streamRef.current = opened;
      stream = opened;
      opened.handle.subscribe((tokens) => {
        setStreamLines(buildStreamLines(opened.build, tokens));
      });
    }
    if (streamed.length > stream.sent.length) {
      stream.handle.append(streamed.slice(stream.sent.length));
      stream.sent = streamed;
    }
  }, [code, isStreaming, language, themeName]);

  useEffect(() => {
    if (isStreaming) return;
    if (highlightedCodeCache.get(cacheKey) != null) return;

    let cancelled = false;
    void highlightCode(code, language, themeName).then((html) => {
      if (cancelled || html === null) return;
      highlightedCodeCache.set(cacheKey, html, estimateHighlightedSize(html, code));
      setHighlighted({ cacheKey, html });
    });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, code, isStreaming, language, themeName]);

  // Once the settled HTML is up, the streamed copy of the same block is only
  // holding memory.
  useEffect(() => {
    if (highlightedHtml === null) return;
    streamRef.current?.handle.dispose();
    streamRef.current = null;
    setStreamLines((previous) => (previous.length === 0 ? previous : EMPTY_STREAM_LINES));
  }, [highlightedHtml]);

  useEffect(
    () => () => {
      streamRef.current?.handle.dispose();
      streamRef.current = null;
    },
    [],
  );

  if (highlightedHtml !== null) {
    return (
      <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
    );
  }
  if (streamLines.length === 0) {
    return plain;
  }
  // Shiki keeps the trailing newline as one more empty line; matching it here
  // is what stops the block growing a row when the settled HTML swaps in.
  const lines = code.endsWith("\n")
    ? [...streamLines, renderStreamLine(EMPTY_STREAM_TOKENS, streamLines.length)]
    : streamLines;
  return (
    <div className="chat-markdown-shiki">
      <pre className={`shiki ${themeName}`} tabIndex={0}>
        <code>{lines}</code>
      </pre>
    </div>
  );
}

type MarkdownRendererProps<Tag extends keyof React.JSX.IntrinsicElements> =
  ComponentPropsWithoutRef<Tag> & { readonly node?: unknown };

function MarkdownParagraph({ node: _node, children, ...props }: MarkdownRendererProps<"p">) {
  const { inlineContext } = useContext(MarkdownDocumentContext);
  return <p {...props}>{renderSkillInlineMarkdownChildren(children, inlineContext)}</p>;
}

function MarkdownListItem({ node: _node, children, ...props }: MarkdownRendererProps<"li">) {
  const { inlineContext } = useContext(MarkdownDocumentContext);
  return <li {...props}>{renderSkillInlineMarkdownChildren(children, inlineContext)}</li>;
}

function MarkdownAnchor({ node: _node, href, children, ...props }: MarkdownRendererProps<"a">) {
  const {
    cwd,
    threadRef,
    resolvedTheme,
    markdownFileLinkMetaByHref,
    fileLinkKindByPath,
    fileLinkParentSuffixByPath,
  } = useContext(MarkdownDocumentContext);
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
}

/**
 * Inline code that reads as a file reference (`ChatComposer.tsx:1010`) opens the
 * internal file viewer; bare names resolve via workspace search. Fenced blocks
 * carry a language class and are skipped.
 */
function MarkdownCode({
  node: _node,
  className,
  children,
  ...props
}: MarkdownRendererProps<"code">) {
  const {
    cwd,
    threadRef,
    resolvedTheme,
    searchHighlightQuery,
    inlineCodeFileLinkMetaBySpan,
    fileLinkKindByPath,
    fileLinkParentSuffixByPath,
  } = useContext(MarkdownDocumentContext);
  const text = typeof children === "string" ? children : null;
  const renderedChildren = text ? (
    <SearchHighlightedInlineText text={text} query={searchHighlightQuery} />
  ) : (
    children
  );
  // A dev-server address in backticks is an address first: it would also read
  // as a file reference (`127.0.0.1:8080`), and searching the workspace for it
  // would find nothing.
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
  // Opted in, this reference wears the same chip a markdown file link does: in
  // a narrow column the raw path wraps mid-token and reads as a broken button,
  // and one clickable-file style beats two.
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
}

/**
 * The `pre` renderer react-markdown gets. Module level on purpose: the renderer
 * map is rebuilt on every delta, so a `pre` defined inside it would be a new
 * component type each flush and every code block would remount mid-stream.
 */
function MarkdownPre({ node: _node, children, ...props }: MarkdownRendererProps<"pre">) {
  const codeBlock = extractCodeBlock(children);
  const plainBlock = <pre {...props}>{children}</pre>;
  if (!codeBlock) {
    return plainBlock;
  }
  return (
    <MarkdownCodeBlock code={codeBlock.code}>
      <CodeHighlightErrorBoundary fallback={plainBlock}>
        <ChatCodeBlock className={codeBlock.className} code={codeBlock.code} plain={plainBlock} />
      </CodeHighlightErrorBoundary>
    </MarkdownCodeBlock>
  );
}

/**
 * An image the text points at. A host bot links images that later go missing,
 * and a broken-image glyph says nothing; the alt text at least says what was
 * meant to be there.
 */
function MarkdownImage({ alt, src, ...rest }: React.ComponentProps<"img">) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return alt ? <span className="text-muted-foreground/70">{alt}</span> : null;
  }
  return <img alt={alt ?? ""} src={src} loading="lazy" onError={() => setFailed(true)} {...rest} />;
}

/**
 * The renderer map handed to react-markdown, built once. react-markdown uses
 * these functions as element types, so rebuilding the map would remount every
 * element in the document; the data they need comes from
 * {@link MarkdownDocumentContext} instead.
 */
const MARKDOWN_COMPONENTS: Components = {
  p: MarkdownParagraph,
  li: MarkdownListItem,
  a: MarkdownAnchor,
  img: MarkdownImage,
  code: MarkdownCode,
  pre: MarkdownPre,
};

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
 * Fenced-code state while walking a markdown document line by line. Every pass
 * over a document shares this bookkeeping: a fence marker line is never a block
 * boundary, and nothing between two markers is markup.
 */
function createFenceTracker() {
  let openFence: { char: string; length: number } | null = null;
  return {
    isOpen: () => openFence !== null,
    /** Feeds one line; true when the line was itself a fence marker. */
    feed(line: string): boolean {
      const fenceMatch = BLOCK_FENCE_MARKER_REGEX.exec(line);
      if (!fenceMatch) return false;
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
      return true;
    },
  };
}

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
    if (fence.feed(line) || fence.isOpen()) continue;

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

/** ATX headings and thematic breaks, recognized only at the left margin: one
 *  space of indent and they can be content inside a list item instead. */
const ATX_HEADING_LINE_REGEX = /^#{1,6}(?: |$)/;
const THEMATIC_BREAK_LINE_REGEX = /^(?:\*{3,}|_{3,}|-{3,})[ \t]*$/;

/**
 * Splits markdown into top-level blocks at blank lines outside fenced code
 * blocks, plus at headings and thematic breaks, which never continue the block
 * above them. Every render goes through this: a streaming message re-parses
 * only its growing tail, and a settled one keeps the same blocks so nothing
 * remounts when streaming stops.
 *
 * Fidelity note: because the final render no longer re-parses the whole
 * document, constructs that reference across blank lines (reference-style link
 * definitions, footnotes) and blank-line-separated indented code stay degraded
 * rather than healing at the end of the turn.
 */
export function splitMarkdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = createFenceTracker();
  let current: string[] = [];
  const flushCurrent = () => {
    if (current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
  };

  for (const line of text.split("\n")) {
    if (fence.feed(line) || fence.isOpen()) {
      current.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushCurrent();
      continue;
    }

    if (ATX_HEADING_LINE_REGEX.test(line)) {
      flushCurrent();
      current.push(line);
      continue;
    }

    // A `---` under a paragraph is that paragraph's setext heading underline,
    // so only a break that starts a block is safe to cut on. `***` and `___`
    // are never underlines and always break.
    if (THEMATIC_BREAK_LINE_REGEX.test(line) && !(line.startsWith("-") && current.length > 0)) {
      flushCurrent();
      blocks.push(line);
      continue;
    }

    current.push(line);
  }

  flushCurrent();
  return blocks;
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
    lastLineIsFenceMarker = fence.feed(line);
  }
  if (fence.isOpen() || lastLineIsFenceMarker) return text;

  const lastLine = lines[lines.length - 1] ?? "";
  if (lastLine.trim() === "") return text;

  return text + unclosedInlineMarkerClosers(lastLine);
}

function ChatMarkdownDocument({
  text,
  cwd,
  environmentId,
  threadId,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  searchHighlightQuery,
  html,
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
  const inlineContext = useMemo<InlineMarkdownContext>(
    () => ({ skills, searchHighlightQuery, threadRef }),
    [searchHighlightQuery, skills, threadRef],
  );
  // Rebuilt whenever the document's data changes, which on a streaming tail is
  // every delta. That is fine and is the point: the renderers re-render, they
  // do not change identity, so nothing remounts.
  const documentContext = useMemo<MarkdownDocumentContextValue>(
    () => ({
      cwd,
      threadRef,
      resolvedTheme,
      themeName: diffThemeName,
      isStreaming,
      searchHighlightQuery,
      inlineContext,
      markdownFileLinkMetaByHref,
      inlineCodeFileLinkMetaBySpan,
      fileLinkParentSuffixByPath,
      fileLinkKindByPath,
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
    <MarkdownDocumentContext value={documentContext}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={html === "github" ? GITHUB_HTML_REHYPE_PLUGINS : undefined}
        components={MARKDOWN_COMPONENTS}
        urlTransform={markdownUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </MarkdownDocumentContext>
  );
}

const MemoChatMarkdownDocument = memo(ChatMarkdownDocument);

/**
 * One top-level block of a message. Settled blocks and the growing tail are the
 * same component so that a block settling flips one prop instead of swapping
 * component types, which would unmount its DOM and re-highlight its code.
 */
const MarkdownBlock = memo(function MarkdownBlock({
  text,
  cwd,
  environmentId,
  threadId,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  searchHighlightQuery,
  html,
}: ChatMarkdownProps) {
  // Lets React drop intermediate parses when deltas outpace rendering
  // (older CPUs) instead of parsing every 50ms server flush. A settled block's
  // text never changes, so deferring it costs nothing.
  const deferredText = useDeferredValue(text);
  const renderedText = useMemo(
    () => (isStreaming ? repairStreamingMarkdownTail(deferredText) : deferredText),
    [deferredText, isStreaming],
  );
  return (
    <MemoChatMarkdownDocument
      text={renderedText}
      cwd={cwd}
      environmentId={environmentId}
      threadId={threadId}
      isStreaming={isStreaming}
      skills={skills}
      searchHighlightQuery={searchHighlightQuery}
      html={html}
    />
  );
});

function ChatMarkdownBody({
  text,
  cwd,
  environmentId,
  threadId,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  searchHighlightQuery,
  html,
}: ChatMarkdownProps) {
  // Blocks are the unit of rendering whether or not the message is streaming:
  // a streaming message re-parses only its growing tail, and when it stops
  // streaming nothing changes but the tail's `isStreaming` prop. Index keys are
  // the correct identity here: streaming only appends blocks, and keying by
  // content would remount the tail on every delta.
  // Raw HTML can span what the splitter takes for several blocks (a
  // `<details>` around paragraphs), so an HTML-bearing document parses whole.
  const blocks = html === "github" ? [text] : splitMarkdownBlocks(text);
  const tailIndex = blocks.length - 1;
  /* oxlint-disable react/no-array-index-key -- streaming only appends blocks; index is the stable identity */
  return (
    <>
      {blocks.map((block, index) => (
        <MarkdownBlock
          key={index}
          text={block}
          cwd={cwd}
          environmentId={environmentId}
          threadId={threadId}
          isStreaming={isStreaming && index === tailIndex}
          skills={skills}
          searchHighlightQuery={searchHighlightQuery}
          html={html}
        />
      ))}
    </>
  );
  /* oxlint-enable react/no-array-index-key */
}

function ChatMarkdown({
  text,
  cwd,
  environmentId,
  threadId,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  searchHighlightQuery,
  html,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  // Boots the highlighting worker and its theme while the page is idle, so the
  // first code block of a session is not also the one that loads Shiki.
  useEffect(() => {
    warmCodeHighlighter(resolveDiffThemeName(resolvedTheme));
  }, [resolvedTheme]);
  const canRenderVisualizations = environmentId !== undefined && threadId !== undefined;
  const segments = canRenderVisualizations
    ? parseCodexInlineVisualizations(text, { isStreaming })
    : [{ type: "markdown" as const, key: "markdown:0", text }];

  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80",
        // Host HTML brings wide tables and images sized for a wider page; give
        // them a scroll of their own rather than letting them widen the panel.
        html === "github" && "chat-markdown-html",
      )}
    >
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
            html={html}
          />
        );
      })}
    </div>
  );
}

export default memo(ChatMarkdown);

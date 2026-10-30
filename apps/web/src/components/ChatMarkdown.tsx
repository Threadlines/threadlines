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
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { MarkdownCodeBlock } from "./chat/MarkdownCodeBlock";
import {
  type InlineMarkdownContext,
  renderSkillInlineMarkdownChildren,
  SearchHighlightedInlineText,
} from "./chat/SkillInlineText";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { failureNotice, toastManager } from "./ui/toast";
import { copyWithNotice } from "./ui/copyWithNotice";
import { openInPreferredEditor } from "../editorPreferences";
import {
  isPathWithinCwd,
  openChatFileReference,
  openDirectoryInActiveViewer,
  openFileInActiveViewer,
  parseChatFileReference,
  relativePathWithinCwd,
  getActiveFileViewerContext,
  resolveChatFileReference,
  viewerPathFor,
} from "../fileViewerStore";
import {
  canLaunchFilesFor,
  type FileActionTarget,
  fileActionMenuItems,
  readFileActionLaunchers,
  runFileAction,
  useFileActionLaunchers,
} from "./fileActionsMenu";
import { editorLabel } from "./EditorOpenOptions";
import { useComputerLabel } from "./sidebar/linkedComputers";
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
  fileLinkMetaForPath,
  isAbsoluteInlineFilePath,
  localhostUrlFromText,
  type MarkdownFileLinkMeta,
  resolveMarkdownFileLinkMeta,
} from "../markdown-links";
import { resolvePathLinkTarget } from "../terminal-links";
import { readLocalApi } from "../localApi";
import { GitPullRequestIcon } from "lucide-react";

import { ChatWebLink } from "./chat/ChatWebLink";
import {
  PullRequestHoverCard,
  PullRequestLinkRead,
  usePullRequestChip,
} from "./pull-requests/PullRequestHoverCard";
import { pullRequestBadgeTone } from "./pull-requests/pullRequests.logic";
import { parsePullRequestUrl } from "@threadlines/shared/sourceControl";
import { isPlaceLinkHref } from "../appPlaceLinks";
import { isBrowserPanelHref } from "./browser/openInBrowserPanel";
import {
  type MarkdownFileLinkKind,
  useMarkdownFileLinkKinds,
} from "../hooks/useMarkdownFileLinkKinds";
import { cn } from "../lib/utils";
import { isImageFilePath } from "../lib/imageFilePaths";
import { useFileNamedInProject } from "../hooks/useFileNamedInProject";
import { useLocalImagePreview } from "../hooks/useLocalImagePreview";
import { LocalImageThumbnail } from "./chat/LocalImageThumbnail";
import { openExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { usePinchToExpand } from "./chat/usePinchToExpand";
import { parseCodexInlineVisualizations } from "../lib/codexInlineVisualization";
import {
  buildFileLinkLabel,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  chatMarkdownUrlTransform,
  GITHUB_HTML_REHYPE_PLUGINS,
  normalizeMarkdownLinkHrefKey,
  pullRequestLinkLabel,
  resolveMarkdownDocumentFileLinks,
  splitMarkdownBlocks,
  repairStreamingMarkdownTail,
} from "../lib/chatMarkdownDocument";
import { normalizeChatMath } from "../lib/chatMarkdownMath";
import { fencedBlockIsClosed } from "../lib/markdownFences";
import { DisplayMath, InlineMath } from "./chat/MarkdownMath";
import { MarkdownDiagram } from "./chat/MarkdownDiagram";
import { CodexInlineVisualization } from "./chat/CodexInlineVisualization";
import {
  MARKDOWN_FILE_LINK_CLASS_NAME,
  MARKDOWN_FILE_LINK_ICON_CLASS_NAME,
  MARKDOWN_FILE_LINK_LABEL_CLASS_NAME,
} from "./chat/markdownChipClasses";
import { PlaceLink } from "./chat/PlaceLink";

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
  /** Overrides the block's classes (its color, for a quieter message). */
  className?: string | undefined;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
/** remark-math's inline formulas (`language-math`; GitHub's sanitizer drops `math-inline`). */
const MATH_CODE_CLASS_REGEX = /(?:^|\s)language-math(?:\s|$)/;
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

/** Everything a markdown renderer needs from the document around it. */
interface MarkdownDocumentContextValue {
  readonly cwd: string | undefined;
  /** Environment whose `projects.readFile` RPC backs inline image previews. */
  readonly environmentId: EnvironmentId | undefined;
  readonly threadRef: ScopedThreadRef | null;
  readonly resolvedTheme: "light" | "dark";
  readonly themeName: DiffThemeName;
  /** Whether this document is a still-growing streaming tail. */
  readonly isStreaming: boolean;
  /**
   * While this document is a streaming tail, its text. A fenced block that
   * reaches its end without a closing marker is still being written, so a
   * diagram or formula there isn't drawn yet.
   */
  readonly streamingText: string | null;
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
  environmentId: undefined,
  threadRef: null,
  resolvedTheme: "dark",
  themeName: resolveDiffThemeName("dark"),
  isStreaming: false,
  streamingText: null,
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
  // The settled HTML keeps the trailing newline as one more empty line;
  // matching it here is what stops the block growing a row when it swaps in.
  // The pre mirrors that HTML's own (`class="diffs"`, no inline colors).
  const lines = code.endsWith("\n")
    ? [...streamLines, renderStreamLine(EMPTY_STREAM_TOKENS, streamLines.length)]
    : streamLines;
  return (
    <div className="chat-markdown-shiki">
      <pre className="diffs" tabIndex={0}>
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

/**
 * The chip a resolved file reference wears. Links, inline code, and image paths
 * all start here so the same file reads the same wherever it is cited; callers
 * adjust only what their syntax says differently.
 */
function fileLinkChip(
  meta: MarkdownFileLinkMeta,
  documentContext: MarkdownDocumentContextValue,
): MarkdownFileLinkProps {
  const { cwd } = documentContext;
  return {
    href: meta.href,
    targetPath: meta.targetPath,
    displayPath: meta.displayPath,
    filePath: meta.filePath,
    kind: documentContext.fileLinkKindByPath.get(meta.filePath) ?? "file",
    isInWorkspace: Boolean(cwd && isPathWithinCwd(meta.filePath, cwd)),
    workspaceRoot: cwd,
    environmentId: documentContext.environmentId,
    line: meta.line,
    column: meta.column,
    label: buildFileLinkLabel(meta, documentContext.fileLinkParentSuffixByPath.get(meta.filePath)),
    theme: documentContext.resolvedTheme,
  };
}

/** Lays a referenced image out as a figure: the picture, then its chip. */
const IMAGE_FIGURE_CLASS_NAME = "my-1 flex w-fit max-w-full flex-col items-start gap-1";

/**
 * A referenced image: the picture on a line of its own with the file chip
 * underneath, once the bytes are here.
 *
 * The chip is the constant: it is what an image reference has always looked
 * like and it still opens the file viewer. While the bytes are in flight, and
 * for good when they never arrive, the chip is all there is and it stays
 * inline, so a sentence naming three screenshots still reads as one sentence.
 * A file the server reports gone dims its chip.
 */
function MarkdownImageFigure({ name, chip }: { name: string; chip: MarkdownFileLinkProps }) {
  const { cwd, environmentId } = useContext(MarkdownDocumentContext);
  const preview = useLocalImagePreview({ environmentId, cwd, path: chip.filePath });
  const dataUrl = preview.status === "ready" ? preview.dataUrl : undefined;
  // The same span either way, so the chip keeps its place in the tree and is
  // not remounted when the picture arrives.
  return (
    <span className={dataUrl ? IMAGE_FIGURE_CLASS_NAME : undefined}>
      {dataUrl ? (
        <LocalImageThumbnail dataUrl={dataUrl} filePath={chip.filePath} name={name} />
      ) : null}
      <MarkdownFileLink {...chip} isMissing={preview.status === "missing"} />
    </span>
  );
}

/**
 * An image cited by bare name in inline code (`home.png`). The name says
 * nothing about the folder, so the picture is the file a click on the chip
 * would open: the project's file with exactly that name. With no such file,
 * the project root is the one place left to look, which is where the chip
 * already points.
 */
function MarkdownNamedImage({ name, chip }: { name: string; chip: MarkdownFileLinkProps }) {
  const { cwd, environmentId } = useContext(MarkdownDocumentContext);
  const match = useFileNamedInProject({ environmentId, cwd, name });
  if (match.status === "loading") {
    return <MarkdownFileLink {...chip} />;
  }
  const found =
    match.status === "found" && cwd
      ? fileLinkMetaForPath(resolvePathLinkTarget(match.relativePath, cwd), cwd)
      : null;
  if (!found) {
    return <MarkdownImageFigure name={name} chip={chip} />;
  }
  // Placed now, so it opens directly and offers the path actions a link does.
  const { chatReference: _placedBySearch, ...placedChip } = chip;
  return (
    <MarkdownImageFigure
      name={name}
      chip={{
        ...placedChip,
        // The guessed path may have been a folder; the search only finds files.
        kind: "file",
        href: found.href,
        targetPath: found.targetPath,
        displayPath: found.displayPath,
        filePath: found.filePath,
      }}
    />
  );
}

/**
 * A file cited by bare name in inline code (`math.ts:12`). Pointing at it runs
 * the search a click would, so the hover label can say where the file really
 * is, a name the project lacks dims before anyone clicks it, and the click or
 * right-click that follows opens the found file without searching again. One
 * look places every chip that cites the same name.
 */
function MarkdownNamedFileLink({
  name,
  chip,
  cwd,
  environmentId,
}: {
  name: string;
  chip: MarkdownFileLinkProps;
  cwd: string | undefined;
  environmentId: EnvironmentId | undefined;
}) {
  const [lookup, setLookup] = useState(false);
  const startLookup = useCallback(() => setLookup(true), []);
  const match = useFileNamedInProject({ environmentId, cwd, name, lookup });
  const position =
    chip.line !== undefined
      ? `:${chip.line}${chip.column !== undefined ? `:${chip.column}` : ""}`
      : "";
  const found =
    match.status === "found" && cwd
      ? fileLinkMetaForPath(resolvePathLinkTarget(`${match.relativePath}${position}`, cwd), cwd)
      : null;
  // Placed now, so it opens directly and offers the path actions a link does.
  const { chatReference: _placedBySearch, ...placedChip } = chip;
  return (
    <span onPointerEnter={startLookup} onFocus={startLookup}>
      {found ? (
        <MarkdownFileLink
          {...placedChip}
          // The guessed path may have been a folder; the search only finds files.
          kind="file"
          href={found.href}
          targetPath={found.targetPath}
          displayPath={found.displayPath}
          filePath={found.filePath}
        />
      ) : (
        <MarkdownFileLink {...chip} isMissing={match.status === "none"} />
      )}
    </span>
  );
}

/**
 * `![alt](path)` where the destination is a file on the agent's machine.
 * A plain `<img>` would ask the browser to load a `file://` url it will always
 * refuse; http(s) and data sources still render as ordinary images.
 */
function MarkdownImage({ node: _node, src, alt, ...props }: MarkdownRendererProps<"img">) {
  const documentContext = useContext(MarkdownDocumentContext);
  const { cwd, searchHighlightQuery } = documentContext;
  const source = typeof src === "string" ? src : undefined;
  const fileLinkMeta =
    source && !searchHighlightQuery?.trim() ? resolveMarkdownFileLinkMeta(source, cwd) : null;
  if (!fileLinkMeta || !isImageFilePath(fileLinkMeta.filePath)) {
    return <RemoteMarkdownImage {...props} src={source} alt={alt} />;
  }
  const name = alt && alt.length > 0 ? alt : fileLinkMeta.basename;
  return (
    <MarkdownImageFigure
      name={name}
      chip={{ ...fileLinkChip(fileLinkMeta, documentContext), label: name }}
    />
  );
}

/**
 * An image path written bare in prose (`C:\Users\me\AppData\Local\Temp\ui.png`).
 * Only reached for settled, unhighlighted text; see {@link findBareImagePaths}.
 */
function MarkdownBareImagePath({ rawPath }: { rawPath: string }) {
  const documentContext = useContext(MarkdownDocumentContext);
  const fileLinkMeta = resolveMarkdownFileLinkMeta(rawPath, documentContext.cwd);
  if (!fileLinkMeta) {
    return <>{rawPath}</>;
  }
  return (
    <MarkdownImageFigure
      name={fileLinkMeta.basename}
      chip={fileLinkChip(fileLinkMeta, documentContext)}
    />
  );
}

/** Module-level so the inline pass never changes component identity. */
const renderBareImagePath: NonNullable<InlineMarkdownContext["renderBareImagePath"]> = (input) => (
  <MarkdownBareImagePath key={input.key} rawPath={input.path} />
);

/** The visible words of a link, flattened out of whatever markdown made them. */
function markdownChildrenText(children: ReactNode): string {
  let text = "";
  Children.forEach(children, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      text += String(child);
      return;
    }
    if (isValidElement<{ children?: ReactNode }>(child)) {
      text += markdownChildrenText(child.props.children);
    }
  });
  return text;
}

/**
 * A pull request address in a transcript, as a chip rather than a URL: the
 * state glyph and `#number`, which is how the sidebar, the composer's row and
 * the pull requests page all name one. The words the author wrote are kept
 * after the number unless they only repeat it.
 *
 * The click behaviour is unchanged -- {@link ChatWebLink} still decides whether
 * this opens the thread's own Pull request tab or the browser panel.
 */
function MarkdownPullRequestChip({
  href,
  repository,
  number,
  label,
  threadRef,
  title,
}: {
  readonly href: string;
  readonly repository: string;
  readonly number: number;
  /** Empty when the link's own text said nothing the number does not. */
  readonly label: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly title?: string | undefined;
}) {
  const chip = usePullRequestChip(href, repository, number);
  const tone = chip.state
    ? pullRequestBadgeTone(chip.state.state, chip.state.isDraft, chip.state.autoMergeEnabled)
    : // Nothing here has listed this repository, so the glyph says "a pull
      // request" without claiming to know how it is going.
      { Icon: GitPullRequestIcon, className: "text-muted-foreground", label: "Pull request" };

  return (
    <>
      {chip.payload ? <PullRequestLinkRead payload={chip.payload} /> : null}
      <PullRequestHoverCard payload={chip.payload}>
        <ChatWebLink
          href={href}
          threadRef={threadRef}
          title={title}
          className="chat-markdown-pull-request-chip inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 align-middle font-mono text-[12px] transition-colors hover:bg-accent"
        >
          <tone.Icon aria-hidden className={cn("size-3 shrink-0", tone.className)} />
          <span>#{number}</span>
          {label ? <span className="font-sans">{label}</span> : null}
        </ChatWebLink>
      </PullRequestHoverCard>
    </>
  );
}

/** Whether a renderer sits inside a markdown link, whose click is the link's. */
const InsideMarkdownLinkContext = createContext(false);

function MarkdownAnchor({ node: _node, href, children, ...props }: MarkdownRendererProps<"a">) {
  const documentContext = useContext(MarkdownDocumentContext);
  const { cwd, threadRef, searchHighlightQuery, markdownFileLinkMetaByHref } = documentContext;
  if (href && isPlaceLinkHref(href)) {
    return (
      <PlaceLink
        href={href}
        linkText={markdownChildrenText(children)}
        threadEnvironmentId={threadRef?.environmentId ?? documentContext.environmentId ?? null}
        threadRef={threadRef}
        className={props.className}
      >
        <InsideMarkdownLinkContext value>{children}</InsideMarkdownLinkContext>
      </PlaceLink>
    );
  }
  const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
  const fileLinkMeta = normalizedHref
    ? (markdownFileLinkMetaByHref.get(normalizedHref) ??
      resolveMarkdownFileLinkMeta(normalizedHref, cwd))
    : null;
  if (!fileLinkMeta) {
    const pullRequest = href ? parsePullRequestUrl(href) : null;
    if (href && pullRequest) {
      const label = pullRequestLinkLabel(markdownChildrenText(children), href);
      return (
        <MarkdownPullRequestChip
          href={href}
          repository={pullRequest.repository}
          number={pullRequest.number}
          label={label}
          threadRef={threadRef}
          title={props.title}
        />
      );
    }
    if (href && isBrowserPanelHref(href)) {
      return (
        <ChatWebLink
          href={href}
          threadRef={threadRef}
          className={props.className}
          title={props.title}
        >
          <InsideMarkdownLinkContext value>{children}</InsideMarkdownLinkContext>
        </ChatWebLink>
      );
    }
    return (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer">
        <InsideMarkdownLinkContext value>{children}</InsideMarkdownLinkContext>
      </a>
    );
  }

  const chip = { ...fileLinkChip(fileLinkMeta, documentContext), className: props.className };
  if (!isImageFilePath(fileLinkMeta.filePath) || searchHighlightQuery?.trim()) {
    return <MarkdownFileLink {...chip} />;
  }
  return <MarkdownImageFigure name={fileLinkMeta.basename} chip={chip} />;
}

/**
 * Inline code that reads as a file reference (`ChatComposer.tsx:1010`, or an
 * absolute path) opens the internal file viewer; bare names resolve via
 * workspace search. Fenced blocks carry a language class and are skipped.
 */
function MarkdownCode({
  node: _node,
  className,
  children,
  ...props
}: MarkdownRendererProps<"code">) {
  const documentContext = useContext(MarkdownDocumentContext);
  const { threadRef, searchHighlightQuery, inlineCodeFileLinkMetaBySpan } = documentContext;
  const text = typeof children === "string" ? children : null;
  // Inline math (remark-math). Display math is a `pre`, which MarkdownPre draws.
  if (text !== null && className && MATH_CODE_CLASS_REGEX.test(className)) {
    return <InlineMath tex={text} />;
  }
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
    // An absolute path already says where the file is, so it opens like a
    // link. Anything else opens through the workspace search, and a bare
    // name's hover shows the name as written until a look places it: before
    // that, its folder is only a guess.
    const isAbsolute = isAbsoluteInlineFilePath(inlineFileReference);
    const searchReference = isAbsolute ? null : parseChatFileReference(inlineFileReference);
    const isBareName = searchReference !== null && !searchReference.path.includes("/");
    const chip: MarkdownFileLinkProps = {
      ...fileLinkChip(inlineFileLinkMeta, documentContext),
      ...(isBareName ? { displayPath: inlineFileReference } : {}),
      ...(isAbsolute ? {} : { chatReference: inlineFileReference }),
    };
    if (!isImageFilePath(inlineFileLinkMeta.filePath)) {
      return isBareName ? (
        <MarkdownNamedFileLink
          name={inlineFileLinkMeta.basename}
          chip={chip}
          cwd={documentContext.cwd}
          environmentId={documentContext.environmentId}
        />
      ) : (
        <MarkdownFileLink {...chip} />
      );
    }
    return isBareName ? (
      <MarkdownNamedImage name={inlineFileLinkMeta.basename} chip={chip} />
    ) : (
      <MarkdownImageFigure name={inlineFileLinkMeta.basename} chip={chip} />
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
        toastFileReferenceNotFound(text);
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
 * Whether a fenced block in a streaming tail is still being written: a fence
 * the reply hasn't closed runs to the end of the text and has no closing
 * marker. Unknown positions count as unfinished.
 */
function isUnfinishedFence(node: unknown, streamingText: string): boolean {
  const position = (
    node as { position?: { start?: { offset?: number }; end?: { offset?: number } } } | undefined
  )?.position;
  const start = position?.start?.offset;
  const end = position?.end?.offset;
  if (start === undefined || end === undefined) return true;
  if (end < streamingText.trimEnd().length) return false;
  return !fencedBlockIsClosed(streamingText.slice(start, end));
}

/**
 * The `pre` renderer react-markdown gets. Module level on purpose: the renderer
 * map is rebuilt on every delta, so a `pre` defined inside it would be a new
 * component type each flush and every code block would remount mid-stream.
 */
function MarkdownPre({ node, children, ...props }: MarkdownRendererProps<"pre">) {
  const { streamingText } = useContext(MarkdownDocumentContext);
  const pending = streamingText !== null && isUnfinishedFence(node, streamingText);
  const codeBlock = extractCodeBlock(children);
  const plainBlock = <pre {...props}>{children}</pre>;
  if (!codeBlock) {
    return plainBlock;
  }
  const language = CODE_FENCE_LANGUAGE_REGEX.exec(codeBlock.className ?? "")?.[1];
  // Display math (`$$` blocks and ```math fences, as on GitHub).
  if (language === "math") {
    return <DisplayMath tex={codeBlock.code.replace(/\n$/, "")} pending={pending} />;
  }
  const highlighted = (
    <CodeHighlightErrorBoundary fallback={plainBlock}>
      <ChatCodeBlock className={codeBlock.className} code={codeBlock.code} plain={plainBlock} />
    </CodeHighlightErrorBoundary>
  );
  if (language === "mermaid") {
    return <MarkdownDiagram code={codeBlock.code} pending={pending} codeView={highlighted} />;
  }
  return (
    <MarkdownCodeBlock code={codeBlock.code} language={language}>
      {highlighted}
    </MarkdownCodeBlock>
  );
}

/**
 * An image with an http(s) or data source, the case {@link MarkdownImage} does
 * not turn into a local thumbnail. A host bot links images that later go
 * missing, and a broken-image glyph says nothing; the alt text at least says
 * what was meant to be there. Clicking or pinching it opens the image viewer;
 * in a link, a click follows the link and only a pinch opens it.
 */
function RemoteMarkdownImage({ alt, src, ...rest }: React.ComponentProps<"img">) {
  const inLink = useContext(InsideMarkdownLinkContext);
  const [failed, setFailed] = useState(false);
  const expand = src
    ? () => {
        openExpandedImagePreview({ images: [{ src, name: alt || "Image" }], index: 0 });
      }
    : undefined;
  const pinchRef = usePinchToExpand(expand);
  if (failed || !src) {
    // Shown only once loading fails, which find in chat cannot know about an
    // image it has not drawn, so it reads past the words.
    return alt ? (
      <span className="text-muted-foreground/70" data-chat-find-ignore="">
        {alt}
      </span>
    ) : null;
  }
  const image = (
    <img
      ref={inLink ? pinchRef : undefined}
      alt={alt ?? ""}
      src={src}
      loading="lazy"
      onError={() => setFailed(true)}
      {...rest}
    />
  );
  if (inLink) return image;
  return (
    <button
      ref={pinchRef}
      type="button"
      className="inline-block max-w-full cursor-zoom-in align-bottom"
      aria-label={`Preview ${alt || "image"}`}
      onClick={expand}
    >
      {image}
    </button>
  );
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
  /** The thread's folder, so a file opened in an editor shows inside it. */
  workspaceRoot: string | undefined;
  /** The thread's environment, which decides whether editors can open it here. */
  environmentId: EnvironmentId | undefined;
  line?: number | undefined;
  column?: number | undefined;
  label: string;
  theme: "light" | "dark";
  className?: string | undefined;
  /**
   * Set when the chip was built from an inline-code reference rather than a
   * link. Such a reference is often a bare file name (`AgentsPanel.tsx:300`)
   * whose real location is only known after a workspace search, so it opens
   * through {@link openChatFileReference}, and its right-click menu waits for
   * {@link resolveChatFileReference} before offering anything that needs the
   * real path.
   */
  chatReference?: string | undefined;
  /**
   * The file was looked for and is not there. The chip still names what the
   * agent meant, but dims so it does not read as something that will open.
   */
  isMissing?: boolean | undefined;
}

/** Inline code that does something when clicked, whether a file or an address. */
const CLICKABLE_INLINE_CODE_CLASS_NAME =
  "cursor-pointer transition-colors hover:text-foreground hover:underline hover:decoration-dotted hover:underline-offset-2";

/**
 * Whether a click can show a chip's target in the file viewer: the viewer the
 * thread route registered, by the rule its open applies. A screen with no
 * viewer (a pull request page) sends every click to another app.
 */
function viewerShows(kind: MarkdownFileLinkKind, filePath: string): boolean {
  const viewerCwd = getActiveFileViewerContext()?.cwd;
  if (viewerCwd === undefined) return false;
  const path = viewerPathFor(filePath, viewerCwd, kind);
  // The project root opens as a folder, never as a file.
  return kind === "directory" ? path !== null : Boolean(path);
}

/**
 * The hover label's second line. Quiet when a click does the expected thing
 * (a project file opens in the viewer); otherwise it says where the click
 * goes, or why it can't open anything and what will help. It mounts only while
 * the label shows, so a transcript full of chips subscribes to nothing.
 */
function FileLinkHoverNote({
  kind,
  filePath,
  isInWorkspace,
  environmentId,
  chatReference,
  isMissing,
}: {
  kind: MarkdownFileLinkKind;
  filePath: string;
  isInWorkspace: boolean;
  environmentId: EnvironmentId | undefined;
  chatReference: string | undefined;
  isMissing: boolean | undefined;
}) {
  const launchers = useFileActionLaunchers(environmentId);
  const computerLabel = useComputerLabel();
  let note: ReactNode = null;
  if (isMissing) {
    note =
      chatReference !== undefined
        ? "Not in this project · right-click to copy the name"
        : "Not found";
  } else if (chatReference !== undefined) {
    // Searched for in the project when clicked, and shown in the viewer.
    note = null;
  } else if (viewerShows(kind, filePath)) {
    note = isInWorkspace ? null : clickNote(true, "the file viewer");
  } else if (!launchers.launchesHere) {
    const computer = environmentId
      ? computerLabel(environmentId, "another computer")
      : "another computer";
    note = `On ${computer} · right-click to copy the path`;
  } else {
    // What a click launches: a folder opens in the file manager, a file in the
    // preferred editor, which may be the file manager itself.
    const opener =
      kind === "file" && launchers.editor
        ? editorLabel(launchers.editor)
        : launchers.canReveal
          ? editorLabel("file-manager")
          : null;
    note = clickNote(!isInWorkspace, opener);
  }
  return note === null ? null : <div className="mt-1 font-sans text-muted-foreground">{note}</div>;
}

/** "Outside this project · opens in Cursor", or the half of it that applies. */
function clickNote(outside: boolean, opener: string | null): ReactNode {
  if (!opener) {
    return outside ? "Outside this project" : null;
  }
  if (!outside) {
    return <span className="text-popover-foreground">Opens in {opener}</span>;
  }
  return (
    <>
      {"Outside this project · "}
      <span className="text-popover-foreground">opens in {opener}</span>
    </>
  );
}

const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  targetPath,
  displayPath,
  filePath,
  kind,
  isInWorkspace,
  workspaceRoot,
  environmentId,
  line,
  column,
  label,
  theme,
  className,
  chatReference,
  isMissing,
}: MarkdownFileLinkProps) {
  const entryLabel = kind === "directory" ? "folder" : "file";

  /** The chip as the shared file actions see it, when its path is settled. */
  const settledTarget = useMemo<FileActionTarget>(
    () => ({
      path: filePath,
      kind,
      relativePath:
        isInWorkspace && workspaceRoot ? relativePathWithinCwd(filePath, workspaceRoot) : null,
      workspaceRoot,
      line,
      column,
    }),
    [column, filePath, isInWorkspace, kind, line, workspaceRoot],
  );

  /** Opens an inline-code reference, resolving bare names through workspace
   *  search. Returns false when this chip did not come from one. */
  const openReference = useCallback(() => {
    if (chatReference === undefined) {
      return false;
    }
    void openChatFileReference(chatReference).then((opened) => {
      if (!opened) {
        toastFileReferenceNotFound(chatReference);
      }
    });
    return true;
  }, [chatReference]);

  const handleOpenExternally = useCallback(() => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Can't open an editor here",
      });
      return;
    }

    void openInPreferredEditor(api, targetPath, workspaceRoot).catch((error) => {
      toastManager.add(
        failureNotice({
          title: `Couldn't open ${entryLabel}`,
          error,
        }),
      );
    });
  }, [entryLabel, targetPath, workspaceRoot]);

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
    // What the viewer can't take (a folder outside the project, or any file
    // on a screen with no viewer) goes to this computer's apps, which a thread
    // on another computer can't use: its paths name files over there.
    if (!canLaunchFilesFor(environmentId)) {
      toastManager.add(
        failureNotice({
          title: `Couldn't open this ${entryLabel} here`,
          reason:
            "It's outside the project, on the computer this thread runs on. Right-click it to copy its path.",
        }),
      );
      return;
    }
    if (kind === "directory") {
      runFileAction("reveal", settledTarget, readFileActionLaunchers(environmentId));
      return;
    }
    handleOpenExternally();
  }, [
    entryLabel,
    environmentId,
    handleOpenExternally,
    kind,
    openInInternalViewer,
    openReference,
    settledTarget,
  ]);

  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;
      const anchor = event.currentTarget;
      const position = { x: event.clientX, y: event.clientY };

      // An inline reference may be a bare name only a workspace search can
      // place. The menu waits for the same lookup a click runs, so it never
      // copies or reveals a guess.
      const resolved =
        chatReference !== undefined ? await resolveChatFileReference(chatReference) : null;
      // The reader moved on (another thread, a collapsed message) while the
      // search ran; a menu now would point at what is no longer on screen.
      if (!anchor.isConnected) return;
      if (chatReference !== undefined && !resolved) {
        const clicked = await api.contextMenu.show(
          [
            { id: "not-found", label: "Not found in this project", disabled: true },
            { id: "copy-name", label: "Copy name", separatorBefore: true },
          ] as const,
          position,
        );
        if (clicked === "copy-name") {
          void copyWithNotice(parseChatFileReference(chatReference)?.path ?? chatReference, "name");
        }
        return;
      }
      const target: FileActionTarget = resolved
        ? {
            ...settledTarget,
            path: resolvePathLinkTarget(resolved.relativePath, resolved.cwd),
            relativePath: resolved.relativePath,
            workspaceRoot: resolved.cwd,
          }
        : settledTarget;

      const launchers = readFileActionLaunchers(environmentId);
      const opensInViewer = resolved !== null || viewerShows(kind, filePath);
      const clicked = await api.contextMenu.show(
        fileActionMenuItems(
          target,
          launchers,
          opensInViewer
            ? [
                {
                  id: "open-viewer",
                  label: kind === "directory" ? "Browse folder" : "Open in file viewer",
                },
              ]
            : [],
        ),
        position,
      );
      if (clicked === "open-viewer") {
        // A placed reference opens where the menu found it, without a second search.
        const opened = resolved
          ? openFileInActiveViewer({ path: resolved.relativePath, line: resolved.line })
          : openInInternalViewer();
        if (!opened) {
          toastManager.add(
            failureNotice({
              title: "Couldn't open it in the file viewer",
              reason: `${displayPath} is not available in the active project workspace.`,
            }),
          );
        }
        return;
      }
      runFileAction(clicked, target, launchers);
    },
    [
      chatReference,
      displayPath,
      environmentId,
      filePath,
      kind,
      openInInternalViewer,
      settledTarget,
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
            data-missing={isMissing ? "" : undefined}
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
        <FileLinkHoverNote
          kind={kind}
          filePath={filePath}
          isInWorkspace={isInWorkspace}
          environmentId={environmentId}
          chatReference={chatReference}
          isMissing={isMissing}
        />
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
    previous.workspaceRoot === next.workspaceRoot &&
    previous.environmentId === next.environmentId &&
    previous.line === next.line &&
    previous.column === next.column &&
    previous.label === next.label &&
    previous.theme === next.theme &&
    previous.className === next.className &&
    previous.chatReference === next.chatReference &&
    previous.isMissing === next.isMissing
  );
}

/**
 * A bare name the workspace search could not place: says where the app looked,
 * and the one thing that would place it.
 */
function toastFileReferenceNotFound(reference: string): void {
  const name = parseChatFileReference(reference)?.path ?? reference;
  toastManager.add(
    failureNotice({
      title: `Couldn't find ${name} in this project`,
      reason: "If it's saved somewhere else, ask the agent for its full path.",
    }),
  );
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
  // While a search hit is being highlighted in this document the reader is
  // hunting for literal text, and a chip both drops the highlight and shortens
  // the path -- the matched characters could leave the page entirely. So the
  // one document being highlighted keeps its references as written.
  const inlineCodeChips = !searchHighlightQuery?.trim();
  const {
    markdownFileLinkMetaByHref,
    inlineCodeFileLinkMetaBySpan,
    fileLinkMetaByKey,
    fileLinkParentSuffixByPath,
  } = useMemo(
    () => resolveMarkdownDocumentFileLinks(text, cwd, { inlineCodeChips }),
    [cwd, inlineCodeChips, text],
  );
  const fileLinkKindByPath = useMarkdownFileLinkKinds(fileLinkMetaByKey, environmentId, cwd);
  const streamingText = isStreaming ? text : null;
  const markdownUrlTransform = useCallback(
    (href: string) => chatMarkdownUrlTransform(href, cwd),
    [cwd],
  );
  // A streaming tail is re-parsed on every delta, so a path halfway through
  // being typed would fetch a file that does not exist yet; bare paths only
  // become pictures once the block has settled.
  const inlineContext = useMemo<InlineMarkdownContext>(
    () => ({
      skills,
      searchHighlightQuery,
      threadRef,
      ...(isStreaming || searchHighlightQuery?.trim() ? {} : { renderBareImagePath }),
    }),
    [isStreaming, searchHighlightQuery, skills, threadRef],
  );
  // Rebuilt whenever the document's data changes, which on a streaming tail is
  // every delta. That is fine and is the point: the renderers re-render, they
  // do not change identity, so nothing remounts.
  const documentContext = useMemo<MarkdownDocumentContextValue>(
    () => ({
      cwd,
      environmentId,
      threadRef,
      resolvedTheme,
      themeName: diffThemeName,
      isStreaming,
      streamingText,
      searchHighlightQuery,
      inlineContext,
      markdownFileLinkMetaByHref,
      inlineCodeFileLinkMetaBySpan,
      fileLinkParentSuffixByPath,
      fileLinkKindByPath,
    }),
    [
      cwd,
      environmentId,
      diffThemeName,
      fileLinkKindByPath,
      fileLinkParentSuffixByPath,
      inlineCodeFileLinkMetaBySpan,
      inlineContext,
      isStreaming,
      markdownFileLinkMetaByHref,
      resolvedTheme,
      searchHighlightQuery,
      streamingText,
      threadRef,
    ],
  );

  return (
    <MarkdownDocumentContext value={documentContext}>
      <ReactMarkdown
        remarkPlugins={CHAT_MARKDOWN_REMARK_PLUGINS}
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
  // Math in any of the forms models write it becomes the `$$` the parser
  // reads (once per settled block); then a streaming tail's open markers close.
  const renderedText = useMemo(() => {
    const withMath = normalizeChatMath(deferredText, { streaming: isStreaming });
    return isStreaming ? repairStreamingMarkdownTail(withMath) : withMath;
  }, [deferredText, isStreaming]);
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
  className,
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
        className,
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

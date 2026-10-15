/**
 * The words find in chat searches: what the reader sees in a message, not the
 * source text behind it. A link reads as its words, a file chip as its label, a
 * skill as its display name; a link's address, an image's alt text and a
 * skill's `$token` are not there to find.
 *
 * Text comes out as blocks, in reading order, grouped exactly as the find DOM
 * walker (chatFindDom.ts) groups the drawn text: every text node belongs to its
 * nearest block element (FIND_BLOCK_TAGS), or else to the body it sits in. A
 * match never spans two blocks, and the n-th match of a block here is the n-th
 * match of the same block on screen. The markdown goes through the pipeline
 * react-markdown runs (unified, remark-gfm, remark-rehype) and the same
 * document pre-pass ChatMarkdown runs (chatMarkdownDocument.ts), so the two
 * agree by construction; the browser contract test keeps them agreeing.
 */
import type { ElementContent, Element as HastElement, Root as HastRoot, RootContent } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { parsePullRequestUrl } from "@threadlines/shared/sourceControl";

import {
  buildFileLinkLabel,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  chatMarkdownUrlTransform,
  GITHUB_HTML_REHYPE_PLUGINS,
  type MarkdownDocumentFileLinks,
  normalizeMarkdownLinkHrefKey,
  pullRequestLinkLabel,
  repairStreamingMarkdownTail,
  resolveMarkdownDocumentFileLinks,
  splitMarkdownBlocks,
} from "../../../lib/chatMarkdownDocument";
import { parseCodexInlineVisualizations } from "../../../lib/codexInlineVisualization";
import { isImageFilePath } from "../../../lib/imageFilePaths";
import { findInlineTokenSpans, type InlineSkill } from "../../../lib/inlineMarkdownTokens";
import { resolveMarkdownFileLinkMeta } from "../../../markdown-links";
import { formatProviderSkillDisplayName } from "../../../providerSkillPresentation";
import { splitUserMessageText } from "../userMessageTerminalContexts";

/** Elements whose text is one block: a match never runs out of one. */
export const FIND_BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p",
  "li",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
]);

/** Marks a region find reads past: drawn next to a message, not part of it. */
export const FIND_IGNORE_ATTRIBUTE = "data-chat-find-ignore";
/** Marks the element holding one findable body of a timeline row. */
export const FIND_BODY_ATTRIBUTE = "data-chat-find-body";
/**
 * Marks a findable body drawn folded (a long message behind its fade, a plan
 * showing its preview): what is drawn is not all of its text yet.
 */
export const FIND_FOLDED_ATTRIBUTE = "data-chat-find-folded";
/** Class of text drawn for screen readers only; nothing the reader can see. */
export const SCREEN_READER_ONLY_CLASS = "sr-only";

export interface FindableMarkdownInput {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly skills: ReadonlyArray<InlineSkill>;
  readonly isStreaming: boolean;
  /** Codex inline visualizations render (ChatMarkdown draws them in a thread). */
  readonly visualizations: boolean;
  readonly html?: "github" | undefined;
}

const chatProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true });
const githubHtmlProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(GITHUB_HTML_REHYPE_PLUGINS);

/** Collects text into blocks, ordered by where each block first has text. */
class BlockCollector {
  private readonly blocks = new Map<object, string[]>();

  add(block: object, text: string): void {
    if (text.length === 0) return;
    const parts = this.blocks.get(block);
    if (parts) parts.push(text);
    else this.blocks.set(block, [text]);
  }

  /** Every block with something besides whitespace in it. */
  result(): string[] {
    return [...this.blocks.values()]
      .map((parts) => parts.join(""))
      .filter((text) => text.trim().length > 0);
  }
}

interface WalkContext {
  readonly block: object;
  /** Under a paragraph or list item, where skills and bare paths become chips. */
  readonly inlinePass: boolean;
  readonly document: DocumentContext;
}

interface DocumentContext {
  readonly cwd: string | undefined;
  readonly skills: ReadonlyArray<InlineSkill>;
  /** A streaming tail draws no bare-path previews (a half-typed path would fetch). */
  readonly bareImagePaths: boolean;
  readonly fileLinks: MarkdownDocumentFileLinks;
  readonly collector: BlockCollector;
}

/**
 * Raw HTML remark-rehype keeps (allowDangerousHtml); hast's own types do not
 * list the node.
 */
interface HastRawNode {
  readonly type: "raw";
  readonly value: string;
}

/** What the walk meets in a hast tree from remark-rehype. */
type WalkNode = ElementContent | RootContent | HastRawNode;

function hastText(nodes: ReadonlyArray<ElementContent | RootContent>): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === "text") text += node.value;
    else if (node.type === "element") text += hastText(node.children);
  }
  return text;
}

function hasClass(element: HastElement, className: string): boolean {
  const value = element.properties["className"];
  return Array.isArray(value) ? value.includes(className) : value === className;
}

function fileChipLabel(
  meta: NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>,
  document: DocumentContext,
): string {
  return buildFileLinkLabel(meta, document.fileLinks.fileLinkParentSuffixByPath.get(meta.filePath));
}

/**
 * Prose as SkillInlineText draws it: skills by their names, dev-server
 * addresses as written, bare image paths (where previews are on) by their
 * chip's label.
 */
function inlineTokensText(
  value: string,
  options: {
    readonly skills: ReadonlyArray<InlineSkill>;
    readonly bareImageLabel: ((path: string) => string) | null;
  },
): string {
  const spans = findInlineTokenSpans(value, {
    skills: options.skills,
    bareImagePaths: options.bareImageLabel !== null,
  });
  let text = "";
  let cursor = 0;
  for (const span of spans) {
    text += value.slice(cursor, span.start);
    text +=
      span.kind === "skill"
        ? formatProviderSkillDisplayName(span.skill)
        : span.kind === "localhost"
          ? span.text
          : (options.bareImageLabel?.(span.path) ?? span.path);
    cursor = span.end;
  }
  return text + value.slice(cursor);
}

function inlineProseText(value: string, document: DocumentContext): string {
  return inlineTokensText(value, {
    skills: document.skills,
    bareImageLabel: document.bareImagePaths
      ? (path) => {
          // MarkdownBareImagePath: a path that resolves wears its file chip.
          const meta = resolveMarkdownFileLinkMeta(path, document.cwd);
          return meta ? fileChipLabel(meta, document) : path;
        }
      : null,
  });
}

function walkChildren(nodes: ReadonlyArray<WalkNode>, context: WalkContext) {
  for (const node of nodes) {
    if (node.type === "text") {
      context.document.collector.add(
        context.block,
        context.inlinePass ? inlineProseText(node.value, context.document) : node.value,
      );
    } else if (node.type === "raw") {
      // react-markdown shows raw HTML as text when no rehype-raw reads it, and
      // that text goes through the same inline pass as any other.
      context.document.collector.add(
        context.block,
        context.inlinePass ? inlineProseText(node.value, context.document) : node.value,
      );
    } else if (node.type === "element") {
      walkElement(node, context);
    }
  }
}

/** MarkdownAnchor: a file chip, a pull request chip, or the link's own words. */
function walkAnchor(element: HastElement, context: WalkContext) {
  const { document } = context;
  const rawHref = element.properties["href"];
  const href =
    rawHref === undefined || rawHref === null
      ? undefined
      : chatMarkdownUrlTransform(String(rawHref), document.cwd);
  const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
  const fileLinkMeta = normalizedHref
    ? (document.fileLinks.markdownFileLinkMetaByHref.get(normalizedHref) ??
      resolveMarkdownFileLinkMeta(normalizedHref, document.cwd))
    : null;
  if (fileLinkMeta) {
    document.collector.add(context.block, fileChipLabel(fileLinkMeta, document));
    return;
  }
  const pullRequest = href ? parsePullRequestUrl(href) : null;
  if (href && pullRequest) {
    document.collector.add(context.block, `#${pullRequest.number}`);
    document.collector.add(context.block, pullRequestLinkLabel(hastText(element.children), href));
    return;
  }
  walkChildren(element.children, { ...context, inlinePass: false });
}

/** MarkdownImage: a local picture wears a chip named for it; a remote one shows nothing to find. */
function walkImage(element: HastElement, context: WalkContext) {
  const { document } = context;
  const rawSrc = element.properties["src"];
  if (typeof rawSrc !== "string") return;
  const source = chatMarkdownUrlTransform(rawSrc, document.cwd);
  const fileLinkMeta = resolveMarkdownFileLinkMeta(source, document.cwd);
  if (!fileLinkMeta || !isImageFilePath(fileLinkMeta.filePath)) return;
  const alt = element.properties["alt"];
  const name = typeof alt === "string" && alt.length > 0 ? alt : fileLinkMeta.basename;
  document.collector.add(context.block, name);
}

/** MarkdownCode, inline: a file reference wears its chip's label. */
function walkInlineCode(element: HastElement, context: WalkContext) {
  const { document } = context;
  const only = element.children.length === 1 ? element.children[0] : undefined;
  if (only?.type !== "text") {
    walkChildren(element.children, { ...context, inlinePass: false });
    return;
  }
  const meta = document.fileLinks.inlineCodeFileLinkMetaBySpan.get(only.value.trim());
  document.collector.add(context.block, meta ? fileChipLabel(meta, document) : only.value);
}

function walkElement(element: HastElement, context: WalkContext) {
  if (hasClass(element, SCREEN_READER_ONLY_CLASS)) return;
  const tag = element.tagName;
  if (tag === "br") {
    context.document.collector.add(context.block, "\n");
    return;
  }
  if (tag === "a") {
    walkAnchor(element, context);
    return;
  }
  if (tag === "img") {
    walkImage(element, context);
    return;
  }
  if (tag === "code") {
    walkInlineCode(element, context);
    return;
  }
  if (tag === "pre") {
    // A fenced block draws its code as written (ChatCodeBlock), chips and all.
    context.document.collector.add(element, hastText(element.children));
    return;
  }
  const block = FIND_BLOCK_TAGS.has(tag) ? element : context.block;
  const inlinePass = context.inlinePass || tag === "p" || tag === "li";
  walkChildren(element.children, { block, inlinePass, document: context.document });
}

function collectMarkdownDocument(
  text: string,
  options: {
    readonly cwd: string | undefined;
    readonly skills: ReadonlyArray<InlineSkill>;
    readonly isStreaming: boolean;
    readonly html: "github" | undefined;
    readonly collector: BlockCollector;
    readonly root: object;
  },
) {
  // MarkdownBlock: a streaming tail is drawn with its open markers closed.
  const rendered = options.isStreaming ? repairStreamingMarkdownTail(text) : text;
  const processor = options.html === "github" ? githubHtmlProcessor : chatProcessor;
  const tree = processor.runSync(processor.parse(rendered)) as HastRoot;
  const document: DocumentContext = {
    cwd: options.cwd,
    skills: options.skills,
    bareImagePaths: !options.isStreaming,
    fileLinks: resolveMarkdownDocumentFileLinks(rendered, options.cwd, { inlineCodeChips: true }),
    collector: options.collector,
  };
  walkChildren(tree.children, { block: options.root, inlinePass: false, document });
}

/**
 * The blocks one ChatMarkdown body shows, in order: the same segments,
 * per-block documents and streaming tail ChatMarkdown and ChatMarkdownBody draw.
 */
export function findableMarkdownBlocks(input: FindableMarkdownInput): string[] {
  const collector = new BlockCollector();
  const root = {};
  const segments = input.visualizations
    ? parseCodexInlineVisualizations(input.text, { isStreaming: input.isStreaming })
    : [{ type: "markdown" as const, key: "markdown:0", text: input.text }];
  segments.forEach((segment, segmentIndex) => {
    if (segment.type !== "markdown") return;
    const segmentStreaming = input.isStreaming && segmentIndex === segments.length - 1;
    const documents = input.html === "github" ? [segment.text] : splitMarkdownBlocks(segment.text);
    documents.forEach((document, documentIndex) => {
      collectMarkdownDocument(document, {
        cwd: input.cwd,
        skills: input.skills,
        isStreaming: segmentStreaming && documentIndex === documents.length - 1,
        html: input.html,
        collector,
        root,
      });
    });
  });
  return collector.result();
}

/**
 * The blocks a sent message's body shows (UserMessageBody): its words, with
 * skills as their names and terminal-context chips left out. One block: the
 * body has no block elements in it.
 */
export function findableUserMessageBlocks(input: {
  readonly text: string;
  readonly terminalContexts: ReadonlyArray<{ readonly header: string }>;
  readonly skills: ReadonlyArray<InlineSkill>;
}): string[] {
  const text = splitUserMessageText(input.text, input.terminalContexts)
    .pieces.map((piece) =>
      piece.kind === "text"
        ? inlineTokensText(piece.text, { skills: input.skills, bareImageLabel: null })
        : "",
    )
    .join("");
  return text.trim().length > 0 ? [text] : [];
}

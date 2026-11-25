/**
 * Core plain-text extraction for chat markdown (shared between folded agent
 * message previews and Find in chat). Kept free of `rehype-raw`/`parse5` so
 * normal chat threads never load the GitHub HTML parser just to preview a
 * folded agent message.
 */
import type { ElementContent, Element as HastElement, Root as HastRoot, RootContent } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { placeIdFromHref } from "@threadlines/shared/appPlaces";
import { parsePullRequestUrl } from "@threadlines/shared/sourceControl";

import {
  buildFileLinkLabel,
  CHAT_MARKDOWN_REMARK_PLUGINS,
  chatMarkdownUrlTransform,
  collectWrittenFilePaths,
  isFileNameMention,
  type MarkdownDocumentFileLinks,
  normalizeMarkdownLinkHrefKey,
  placeLinkLabel,
  pullRequestLinkLabel,
  repairStreamingMarkdownTail,
  resolveMarkdownDocumentFileLinks,
  splitMarkdownBlocks,
} from "../../../lib/chatMarkdownDocument";
import { normalizeChatMath } from "../../../lib/chatMarkdownMath";
import { isImageFilePath } from "../../../lib/imageFilePaths";
import { findInlineTokenSpans, type InlineSkill } from "../../../lib/inlineMarkdownTokens";
import { resolveMarkdownFileLinkMeta } from "../../../markdown-links";
import { formatProviderSkillDisplayName } from "../../../providerSkillPresentation";

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

export const chatProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true });

export type MarkdownToHast = (rendered: string) => HastRoot;

export const parseChatMarkdownToHast: MarkdownToHast = (rendered) =>
  chatProcessor.runSync(chatProcessor.parse(rendered)) as HastRoot;

/**
 * How a piece of a block is drawn: prose (its whitespace wraps as spaces), a
 * chip (a file, a pull request), a line break, or code kept line for line.
 */
type BlockPartKind = "prose" | "chip" | "break" | "code";

interface BlockPart {
  readonly text: string;
  readonly kind: BlockPartKind;
}

/** Collects text into blocks, ordered by where each block first has text. */
export class BlockCollector {
  private readonly blocks = new Map<object, BlockPart[]>();

  add(block: object, text: string, kind: BlockPartKind = "prose"): void {
    if (text.length === 0) return;
    const parts = this.blocks.get(block);
    if (parts) parts.push({ text, kind });
    else this.blocks.set(block, [{ text, kind }]);
  }

  /** Every block with something besides whitespace in it, as the DOM holds its text. */
  result(): string[] {
    return this.joined((parts) => parts.map((part) => part.text).join(""));
  }

  /**
   * The same blocks as the reader sees the words: prose and chips wrapped onto
   * one line, a chip spaced from what it sits against, and a new line only
   * where the block draws one (a line break, a line of code).
   */
  readable(): string[] {
    return this.joined((parts) =>
      parts.reduce((text, part, index) => {
        const words =
          part.kind === "prose" || part.kind === "chip"
            ? part.text.replace(/\s+/g, " ")
            : part.text;
        const previous = parts[index - 1];
        const spaced =
          previous !== undefined &&
          (part.kind === "chip" || previous.kind === "chip") &&
          !/\s$/.test(previous.text) &&
          !/^[\s.,;:!?)\]]/.test(part.text);
        return spaced ? `${text} ${words}` : text + words;
      }, ""),
    );
  }

  private joined(join: (parts: ReadonlyArray<BlockPart>) => string): string[] {
    return [...this.blocks.values()].map(join).filter((text) => text.trim().length > 0);
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
export function inlineTokensText(
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

/** MarkdownAnchor: a file chip, a pull request chip, a place chip, or the link's own words. */
function walkAnchor(element: HastElement, context: WalkContext) {
  const { document } = context;
  const rawHref = element.properties["href"];
  const href =
    rawHref === undefined || rawHref === null
      ? undefined
      : chatMarkdownUrlTransform(String(rawHref), document.cwd);
  // A place this build no longer knows reads as the link's words.
  const placeId = href ? placeIdFromHref(href) : null;
  if (placeId !== null) {
    document.collector.add(
      context.block,
      placeLinkLabel(hastText(element.children), placeId),
      "chip",
    );
    return;
  }
  const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
  const fileLinkMeta = normalizedHref
    ? (document.fileLinks.markdownFileLinkMetaByHref.get(normalizedHref) ??
      resolveMarkdownFileLinkMeta(normalizedHref, document.cwd))
    : null;
  if (fileLinkMeta) {
    document.collector.add(context.block, fileChipLabel(fileLinkMeta, document), "chip");
    return;
  }
  const pullRequest = href ? parsePullRequestUrl(href) : null;
  if (href && pullRequest) {
    document.collector.add(context.block, `#${pullRequest.number}`, "chip");
    document.collector.add(
      context.block,
      pullRequestLinkLabel(hastText(element.children), href),
      "chip",
    );
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
  document.collector.add(context.block, name, "chip");
}

/** MarkdownCode, inline: a file reference wears its chip's label. */
function walkInlineCode(element: HastElement, context: WalkContext) {
  // A formula draws glyphs, not words (InlineMath reads past it too).
  if (hasClass(element, "language-math")) return;
  const { document } = context;
  const only = element.children.length === 1 ? element.children[0] : undefined;
  if (only?.type !== "text") {
    walkChildren(element.children, { ...context, inlinePass: false });
    return;
  }
  const span = only.value.trim();
  const meta = document.fileLinks.inlineCodeFileLinkMetaBySpan.get(span);
  // A bare file name draws as the code it is (ChatMarkdown's mention), unless
  // a lookup finds a picture for it, which no text pass can know.
  if (meta && !isFileNameMention(span, document.fileLinks.inlineCodeSpansPlacedByDocument)) {
    document.collector.add(context.block, fileChipLabel(meta, document), "chip");
  } else document.collector.add(context.block, only.value);
}

function walkElement(element: HastElement, context: WalkContext) {
  if (hasClass(element, SCREEN_READER_ONLY_CLASS)) return;
  const tag = element.tagName;
  if (tag === "br") {
    context.document.collector.add(context.block, "\n", "break");
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
    // Display math and diagrams draw pictures, which find reads past
    // (MarkdownMath, MarkdownDiagram); any other fenced block draws its code
    // as written (ChatCodeBlock), chips and all.
    // Only a `pre` holding just its `code` is drawn that way (MarkdownPre).
    const code = element.children.length === 1 ? element.children[0] : undefined;
    if (
      code?.type === "element" &&
      code.tagName === "code" &&
      (hasClass(code, "language-math") || hasClass(code, "language-mermaid"))
    ) {
      return;
    }
    context.document.collector.add(element, hastText(element.children), "code");
    return;
  }
  const block = FIND_BLOCK_TAGS.has(tag) ? element : context.block;
  const inlinePass = context.inlinePass || tag === "p" || tag === "li";
  walkChildren(element.children, { block, inlinePass, document: context.document });
}

export function collectMarkdownDocument(
  text: string,
  options: {
    readonly cwd: string | undefined;
    readonly skills: ReadonlyArray<InlineSkill>;
    readonly isStreaming: boolean;
    readonly toHast: MarkdownToHast;
    readonly collector: BlockCollector;
    readonly root: object;
    readonly writtenFilePaths: readonly string[];
  },
) {
  // MarkdownBlock: math normalized, and a streaming tail drawn with its open
  // markers closed.
  const withMath = normalizeChatMath(text, { streaming: options.isStreaming });
  const rendered = options.isStreaming ? repairStreamingMarkdownTail(withMath) : withMath;
  const tree = options.toHast(rendered);
  const document: DocumentContext = {
    cwd: options.cwd,
    skills: options.skills,
    bareImagePaths: !options.isStreaming,
    fileLinks: resolveMarkdownDocumentFileLinks(rendered, options.cwd, {
      inlineCodeChips: true,
      writtenFilePaths: options.writtenFilePaths,
    }),
    collector: options.collector,
  };
  walkChildren(tree.children, { block: options.root, inlinePass: false, document });
}

/**
 * The first line of text a finished ChatMarkdown body shows, read as words
 * (BlockCollector.readable): what a folded message shows of itself. Parses
 * only as far as it has to. Empty for a body with no text to show (only a
 * picture, a diagram or a formula).
 */
export function markdownFirstLine(input: {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly skills: ReadonlyArray<InlineSkill>;
}): string {
  const writtenFilePaths = collectWrittenFilePaths(input.text, input.cwd);
  for (const document of splitMarkdownBlocks(input.text)) {
    const collector = new BlockCollector();
    collectMarkdownDocument(document, {
      cwd: input.cwd,
      skills: input.skills,
      isStreaming: false,
      toHast: parseChatMarkdownToHast,
      collector,
      root: {},
      writtenFilePaths,
    });
    const [first] = collector.readable();
    const line = first
      ?.split("\n")
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0);
    if (line !== undefined) return line;
  }
  return "";
}

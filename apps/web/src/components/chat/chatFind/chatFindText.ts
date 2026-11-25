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
import type { Root as HastRoot } from "hast";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  collectWrittenFilePaths,
  splitMarkdownBlocks,
} from "../../../lib/chatMarkdownDocument";
import { parseCodexInlineVisualizations } from "../../../lib/codexInlineVisualization";
import { GITHUB_HTML_REHYPE_PLUGINS } from "../../../lib/githubMarkdownHtml";
import type { InlineSkill } from "../../../lib/inlineMarkdownTokens";
import { splitUserMessageText } from "../userMessageTerminalContexts";
import {
  BlockCollector,
  collectMarkdownDocument,
  inlineTokensText,
  type MarkdownToHast,
  parseChatMarkdownToHast,
} from "./chatMarkdownTextCore";

export {
  FIND_BLOCK_TAGS,
  FIND_BODY_ATTRIBUTE,
  FIND_FOLDED_ATTRIBUTE,
  FIND_IGNORE_ATTRIBUTE,
  markdownFirstLine,
  SCREEN_READER_ONLY_CLASS,
} from "./chatMarkdownTextCore";

export interface FindableMarkdownInput {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly skills: ReadonlyArray<InlineSkill>;
  readonly isStreaming: boolean;
  /** Codex inline visualizations render (ChatMarkdown draws them in a thread). */
  readonly visualizations: boolean;
  readonly html?: "github" | undefined;
}

const githubHtmlProcessor = unified()
  .use(remarkParse)
  .use(CHAT_MARKDOWN_REMARK_PLUGINS)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(GITHUB_HTML_REHYPE_PLUGINS);

const parseGithubHtmlMarkdownToHast: MarkdownToHast = (rendered) =>
  githubHtmlProcessor.runSync(githubHtmlProcessor.parse(rendered)) as HastRoot;

/**
 * The blocks one ChatMarkdown body shows, in order: the same segments,
 * per-block documents and streaming tail ChatMarkdown and ChatMarkdownBody draw.
 */
export function findableMarkdownBlocks(input: FindableMarkdownInput): string[] {
  const collector = new BlockCollector();
  const root = {};
  // ChatMarkdown: a short name is placed by a path written anywhere in the message.
  const writtenFilePaths = collectWrittenFilePaths(input.text, input.cwd);
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
        toHast: input.html === "github" ? parseGithubHtmlMarkdownToHast : parseChatMarkdownToHast,
        collector,
        root,
        writtenFilePaths,
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

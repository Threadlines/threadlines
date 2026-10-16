import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import type { ScopedThreadRef } from "@threadlines/contracts";

import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import {
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  SKILL_CHIP_ICON_SVG,
} from "../composerInlineChip";
import { splitSearchTextHighlightSegments } from "../../lib/searchTextHighlight";
import { findInlineTokenSpans, type InlineSkill } from "../../lib/inlineMarkdownTokens";
import { ChatWebLink } from "./ChatWebLink";

/**
 * What the inline pass needs to know beyond the text itself: which skills are
 * real, what is being searched for, and which thread a bare dev-server address
 * should open in.
 */
export interface InlineMarkdownContext {
  readonly skills: ReadonlyArray<InlineSkill>;
  readonly searchHighlightQuery?: string | undefined;
  readonly threadRef?: ScopedThreadRef | null;
  /**
   * Turns an image path written bare in prose into a preview. Supplied by the
   * markdown document, which owns the file chip; absent on a streaming tail (a
   * half-typed path would fetch) and while a search hit is highlighted.
   */
  readonly renderBareImagePath?:
    | ((input: { readonly path: string; readonly key: string }) => ReactNode)
    | undefined;
}

interface InlineToken {
  readonly start: number;
  readonly end: number;
  readonly node: ReactNode;
}

/** The nodes that replace each token span, in order. */
function collectInlineTokens(text: string, context: InlineMarkdownContext): InlineToken[] {
  const renderBareImagePath = context.renderBareImagePath;
  return findInlineTokenSpans(text, {
    skills: context.skills,
    bareImagePaths: renderBareImagePath !== undefined,
  }).map((span) => ({
    start: span.start,
    end: span.end,
    node:
      span.kind === "skill" ? (
        <SkillChip
          key={`${span.start}:${span.skill.name}`}
          skill={span.skill}
          rawText={span.rawText}
        />
      ) : span.kind === "localhost" ? (
        <ChatWebLink
          key={`link:${span.start}`}
          href={span.url}
          threadRef={context.threadRef ?? null}
        >
          {span.text}
        </ChatWebLink>
      ) : (
        renderBareImagePath?.({ path: span.path, key: `image:${span.start}` })
      ),
  }));
}

export function SearchHighlightedInlineText(props: { text: string; query?: string | undefined }) {
  if (!props.query) {
    return <>{props.text}</>;
  }
  return (
    <>
      {splitSearchTextHighlightSegments(props.text, props.query).map((segment) =>
        segment.highlighted ? (
          <mark
            key={`match:${segment.start}:${segment.end}`}
            className="thread-search-inline-match"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={`text:${segment.start}:${segment.end}`}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export function SkillInlineText(props: { text: string } & InlineMarkdownContext) {
  const tokens = collectInlineTokens(props.text, props);
  if (tokens.length === 0) {
    return <SearchHighlightedInlineText text={props.text} query={props.searchHighlightQuery} />;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) {
      nodes.push(
        <SearchHighlightedInlineText
          key={`text:${cursor}:${token.start}`}
          text={props.text.slice(cursor, token.start)}
          query={props.searchHighlightQuery}
        />,
      );
    }
    nodes.push(token.node);
    cursor = token.end;
  }

  if (cursor < props.text.length) {
    nodes.push(
      <SearchHighlightedInlineText
        key={`text:${cursor}:${props.text.length}`}
        text={props.text.slice(cursor)}
        query={props.searchHighlightQuery}
      />,
    );
  }
  return <>{nodes}</>;
}

interface InlineMarkdownChildProps {
  children?: ReactNode;
  href?: string;
  /** The hast node the markdown renderer built this element from. */
  node?: { tagName?: string } | undefined;
}

/** Inline markdown whose contents belong to the renderer, not to this walker. */
function isInlineMarkdownTag(type: unknown): boolean {
  return type === "code" || type === "a";
}

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  context: InlineMarkdownContext,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SkillInlineText text={child} {...context} />;
    }
    if (!isValidElement<InlineMarkdownChildProps>(child)) {
      return child;
    }
    // Code and links are left exactly as the markdown renderer built them.
    // A renderer that overrides these tags hands over an element typed by the
    // override component rather than by the tag, so the tag has to be read off
    // the source node too: rewriting the text child of an inline-code element
    // is what stopped `AgentsPanel.tsx:300` from being a file reference the
    // renderer could recognise and open.
    if (isInlineMarkdownTag(child.type) || isInlineMarkdownTag(child.props.node?.tagName)) {
      return child;
    }
    // Custom anchor components are elements like any other, so the tag check
    // above misses them: an href is what actually says "already a link", and
    // tokenizing inside one would nest an anchor in an anchor.
    if ("href" in child.props) {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderSkillInlineMarkdownChildren(child.props.children, context),
    );
  });
}

function SkillChip(props: { skill: InlineSkill; rawText: string }) {
  return (
    <span className="inline-flex align-middle leading-none">
      <span className="sr-only">{props.rawText}</span>
      <span aria-hidden="true" className={COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME}>
        <span
          aria-hidden="true"
          className={COMPOSER_INLINE_CHIP_ICON_CLASS_NAME}
          dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
        />
        <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>
          {formatProviderSkillDisplayName(props.skill)}
        </span>
      </span>
    </span>
  );
}

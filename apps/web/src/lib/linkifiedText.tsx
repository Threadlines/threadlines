/**
 * Plain text with its http(s) URLs rendered as links.
 *
 * Provider status details are written by the server as prose, and some of
 * them name an install page ("Install Claude Code from https://..."). Rendered
 * as a bare string that address is dead text the user has to retype, so the
 * surfaces that show provider detail run it through here instead.
 *
 * Deliberately not a Markdown renderer: this text is not authored as Markdown
 * and the only thing worth promoting in it is a URL.
 *
 * @module linkifiedText
 */
import { Fragment, type ReactNode } from "react";

import { cn } from "./utils";

/**
 * Stops at whitespace and at the characters that normally surround a URL in a
 * sentence rather than belonging to it, so "(see https://x.dev/install)"
 * does not swallow the closing bracket.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/gu;
/** Sentence punctuation that trails a URL far more often than it ends one. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;

export interface LinkifiedTextSegment {
  readonly kind: "text" | "link";
  readonly value: string;
  /** Offset in the source text. Unique per segment, so it doubles as a key. */
  readonly start: number;
}

/**
 * Splits text into alternating plain and link runs. Concatenating every
 * segment's value reproduces the input exactly, so nothing is dropped or
 * reordered by making a URL clickable.
 */
export function splitTextIntoLinkSegments(text: string): ReadonlyArray<LinkifiedTextSegment> {
  const segments: LinkifiedTextSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const matchIndex = match.index;
    const href = match[0].replace(TRAILING_PUNCTUATION, "");
    if (href.length === 0) {
      continue;
    }
    if (matchIndex > cursor) {
      segments.push({ kind: "text", value: text.slice(cursor, matchIndex), start: cursor });
    }
    segments.push({ kind: "link", value: href, start: matchIndex });
    cursor = matchIndex + href.length;
  }

  if (cursor < text.length) {
    segments.push({ kind: "text", value: text.slice(cursor), start: cursor });
  }
  return segments;
}

/**
 * Renders `text` with its URLs as new-tab anchors. Text without a URL renders
 * as a plain string, so callers can use this anywhere a string used to sit.
 */
export function LinkifiedText({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}): ReactNode {
  const segments = splitTextIntoLinkSegments(text);
  if (!segments.some((segment) => segment.kind === "link")) {
    return text;
  }

  return (
    <>
      {segments.map((segment) =>
        segment.kind === "link" ? (
          <a
            key={segment.start}
            href={segment.value}
            target="_blank"
            rel="noopener noreferrer"
            className={cn("underline underline-offset-2 hover:text-foreground", className)}
          >
            {segment.value}
          </a>
        ) : (
          <Fragment key={segment.start}>{segment.value}</Fragment>
        ),
      )}
    </>
  );
}

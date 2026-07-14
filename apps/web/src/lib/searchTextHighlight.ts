import { searchQueryHighlightValues } from "@threadlines/shared/searchRanking";

export interface SearchTextHighlightSegment {
  readonly text: string;
  readonly highlighted: boolean;
  readonly start: number;
  readonly end: number;
}

export interface SearchTextHighlightSpan {
  readonly start: number;
  readonly end: number;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function searchHighlightPattern(value: string): string {
  return value.split(/\s+/u).map(escapeRegularExpression).join("\\s+");
}

export function findSearchTextHighlightSpans(
  text: string,
  query: string,
): SearchTextHighlightSpan[] {
  const terms = searchQueryHighlightValues(query);
  if (text.length === 0 || terms.length === 0) {
    return [];
  }

  const pattern = new RegExp(terms.map(searchHighlightPattern).join("|"), "giu");
  return [...text.matchAll(pattern)].flatMap((match) => {
    const start = match.index;
    const matchedText = match[0];
    return start === undefined || matchedText.length === 0
      ? []
      : [{ start, end: start + matchedText.length }];
  });
}

export function splitSearchTextHighlightSegments(
  text: string,
  query: string,
): SearchTextHighlightSegment[] {
  const spans = findSearchTextHighlightSpans(text, query);
  if (spans.length === 0) {
    return text.length > 0 ? [{ text, highlighted: false, start: 0, end: text.length }] : [];
  }

  const segments: SearchTextHighlightSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      segments.push({
        text: text.slice(cursor, span.start),
        highlighted: false,
        start: cursor,
        end: span.start,
      });
    }
    segments.push({
      text: text.slice(span.start, span.end),
      highlighted: true,
      start: span.start,
      end: span.end,
    });
    cursor = span.end;
  }
  if (cursor < text.length) {
    segments.push({
      text: text.slice(cursor),
      highlighted: false,
      start: cursor,
      end: text.length,
    });
  }
  return segments;
}

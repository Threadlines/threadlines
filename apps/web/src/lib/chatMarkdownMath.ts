/**
 * Which `$`, `\(` and `\[` in an agent's reply are math. The renderer parses
 * math with `$$` as its only delimiter (remark-math, single-dollar math off), so
 * a stray `$` -- a price, a shell variable, a regex anchor -- is never math.
 * This pass rewrites the other ways models write math into that one form:
 *
 * - `\[ … \]`, `$$ … $$` alone on a line, and `$$` blocks whose first or last
 *   line carries content become a display block (`$$` alone on the lines
 *   around it), in a list item or a quote too;
 * - `\( … \)`, `\[ … \]` inside a sentence, and `$ … $` become inline `$$ … $$`.
 *
 * It only ever touches prose: the markdown parser says where code (fenced,
 * indented, in lists and quotes), inline code, HTML (and the words inside a
 * `<code>` pair), links, images and reference definitions are, and those are
 * copied as written. Table rows keep their math inline. Single dollars follow
 * pandoc's rule (the opener is not followed by a space, the closer is not
 * preceded by one and not followed by a digit), tightened for a coding chat:
 * the opener does not follow a letter, digit or backslash, the closer is not
 * followed by a letter, digit or `{`, `${name}` is a shell variable, and the
 * inside has to look like math (a TeX command, an operator, a digit, or a one-
 * or two-letter name).
 *
 * Runs per block (splitMarkdownBlocks keeps a display block in one), so a
 * settled block is rewritten once, and every scan is linear in the block.
 * Render-only: the stored message keeps what the model sent.
 */
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import {
  BRACKET_MATH_CLOSE_REGEX,
  BRACKET_MATH_OPEN_REGEX,
  DOLLAR_MATH_CLOSE_REGEX,
  DOLLAR_MATH_OPEN_REGEX,
  OPENER_PREFIX,
} from "./markdownFences";

export interface NormalizeChatMathOptions {
  /**
   * The text is the tail of a reply still arriving. A `$` that ends it may be
   * the start of `$5` rather than the close of `$x$`, so it waits for the next
   * character, and a `$$` block still being written stays open.
   */
  readonly streaming?: boolean | undefined;
}

const MATH_CANDIDATE_REGEX = /\$|\\\(|\\\[/;
const WHOLE_LINE_DOLLAR_DISPLAY_REGEX = new RegExp(
  String.raw`^${OPENER_PREFIX}\$\$(?!\$)((?:(?!\$)[^\r])+?)\$\$[ \t]*$`,
);
const WHOLE_LINE_BRACKET_DISPLAY_REGEX = new RegExp(
  String.raw`^${OPENER_PREFIX}\\\[((?:(?!\\\]|\$)[^\r])+?)\\\][ \t]*$`,
);
const LIST_MARKER_REGEX = /(?:[-*+]|\d{1,9}[.)])(?=[ \t])/g;
const SHELL_VARIABLE_BRACES_REGEX = /^\{[A-Za-z_][A-Za-z0-9_]*\}/;
const URL_START_REGEX = /^(?:https?|ftp|file):\/\//i;
const MATH_SIGNAL_REGEX = /\\[A-Za-z]|[\^_=+\-*/<>(){}[\]|,!]|\d/;
const SHORT_NAME_REGEX = /^[A-Za-z]{1,2}'*$/;
const CODE_TAG_OPEN_REGEX = /^<(code|kbd|samp|pre)(?:\s(?:[^>"']|"[^"]*"|'[^']*')*)?>$/i;
const CODE_TAG_CLOSE_REGEX = /^<\/(code|kbd|samp|pre)\s*>$/i;

/** GitHub-flavored markdown without math: where prose is, not what math is. */
const proseParser = unified().use(remarkParse).use(remarkGfm);

/** The few mdast fields read here. */
interface ProseNode {
  readonly type: string;
  readonly value?: string;
  readonly position?: {
    readonly start: { readonly offset?: number | undefined };
    readonly end: { readonly offset?: number | undefined };
  };
  readonly children?: ReadonlyArray<ProseNode>;
}

type Range = readonly [start: number, end: number];

/** Nodes whose source is never rewritten. */
const UNTOUCHED_NODE_TYPES = new Set([
  "code",
  "inlineCode",
  "html",
  "link",
  "image",
  "definition",
  "footnoteDefinition",
]);

/** Where the parser found code and the rest (copied as written), and tables (math stays inline). */
function protectedRanges(text: string): {
  readonly untouched: ReadonlyArray<Range>;
  readonly tables: ReadonlyArray<Range>;
} {
  const untouched: Range[] = [];
  const tables: Range[] = [];
  const walk = (node: ProseNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (UNTOUCHED_NODE_TYPES.has(node.type)) {
        untouched.push([start, end]);
        return;
      }
      if (node.type === "table") tables.push([start, end]);
    }
    // The parser reads `<code>` and `</code>` as two bits of HTML with prose
    // between them; the words inside are code all the same. One pass, with
    // the openers still waiting for their closer by tag.
    const openTags = new Map<string, number[]>();
    for (const child of node.children ?? []) {
      if (child.type === "html") {
        const value = child.value ?? "";
        const opener = CODE_TAG_OPEN_REGEX.exec(value);
        const closer = opener ? null : CODE_TAG_CLOSE_REGEX.exec(value);
        const from = child.position?.start.offset;
        const to = child.position?.end.offset;
        if (opener && from !== undefined) {
          const tag = opener[1]!.toLowerCase();
          const waiting = openTags.get(tag);
          if (waiting) waiting.push(from);
          else openTags.set(tag, [from]);
        } else if (closer && to !== undefined) {
          const waiting = openTags.get(closer[1]!.toLowerCase());
          const openedAt = waiting?.pop();
          if (openedAt !== undefined) untouched.push([openedAt, to]);
        }
      }
      walk(child);
    }
  };
  walk(proseParser.parse(text) as ProseNode);
  return { untouched: mergeRanges(untouched), tables: mergeRanges(tables) };
}

/** Sorted, with overlapping ranges joined, so their ends ascend. */
function mergeRanges(ranges: ReadonlyArray<Range>): ReadonlyArray<Range> {
  const sorted = ranges.toSorted((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** The index of the first merged range ending after `offset`. */
function firstRangeEndingAfter(ranges: ReadonlyArray<Range>, offset: number): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ranges[middle]![1] > offset) high = middle;
    else low = middle + 1;
  }
  return low;
}

function overlaps(ranges: ReadonlyArray<Range>, start: number, end: number): boolean {
  const range = ranges[firstRangeEndingAfter(ranges, start)];
  return range !== undefined && range[0] < end;
}

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\t";
}

/**
 * The next index of `needle` at or after a position that only moves forward,
 * searched again only once the reader has passed the last answer: a line full
 * of unanswered `\(` stays linear.
 */
function forwardFinder(text: string, needle: string) {
  let found: number | null = null;
  return (from: number): number => {
    if (found === -1) return -1;
    if (found === null || found < from) found = text.indexOf(needle, from);
    return found;
  };
}

/** The single-dollar span starting at `start`, if it is math; its end is exclusive. */
function singleDollarMath(
  text: string,
  start: number,
  atTextEnd: boolean,
  streaming: boolean,
): { content: string; end: number } | null {
  const before = text[start - 1];
  const after = text[start + 1];
  if (before === "\\" || before === "$" || isWordCharacter(before)) return null;
  if (isWhitespace(after) || after === "$") return null;
  if (SHELL_VARIABLE_BRACES_REGEX.test(text.slice(start + 1, start + 66))) return null;

  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`") return null;
    if (char !== "$") continue;
    // The first unescaped `$` is the only closer considered.
    const closerBefore = text[index - 1];
    const closerAfter = text[index + 1];
    if (isWhitespace(closerBefore)) return null;
    if (closerAfter === "$" || closerAfter === "{" || isWordCharacter(closerAfter)) return null;
    if (closerAfter === undefined && atTextEnd && streaming) return null;
    const content = text.slice(start + 1, index);
    if (!MATH_SIGNAL_REGEX.test(content) && !SHORT_NAME_REGEX.test(content)) return null;
    return { content, end: index + 1 };
  }
  return null;
}

/**
 * The inline pass over one run of prose on a line: math in any of its forms
 * comes out as `$$ … $$`. Bare URLs are copied as written.
 */
function normalizeInlineMath(segment: string, atTextEnd: boolean, streaming: boolean): string {
  if (!MATH_CANDIDATE_REGEX.test(segment)) return segment;
  const nextParenClose = forwardFinder(segment, "\\)");
  const nextBracketClose = forwardFinder(segment, "\\]");
  const nextDoubleDollar = forwardFinder(segment, "$$");
  let output = "";
  let index = 0;
  while (index < segment.length) {
    const char = segment[index]!;

    if (
      (char === "h" || char === "f" || char === "H" || char === "F") &&
      !isWordCharacter(segment[index - 1]) &&
      URL_START_REGEX.test(segment.slice(index, index + 8))
    ) {
      const space = segment.slice(index).search(/\s/);
      const end = space === -1 ? segment.length : index + space;
      output += segment.slice(index, end);
      index = end;
      continue;
    }
    if (char === "\\") {
      const next = segment[index + 1];
      if (next === "(" || next === "[") {
        const close = (next === "(" ? nextParenClose : nextBracketClose)(index + 2);
        const content = close === -1 ? "" : segment.slice(index + 2, close);
        if (content.trim().length > 0 && !content.includes("$")) {
          output += `$$${content}$$`;
          index = close + 2;
          continue;
        }
      }
      // An escape keeps its character: `\$` is a literal dollar.
      output += segment.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "$") {
      if (segment[index + 1] === "$") {
        // Already double-dollar math: copy it whole, or the `$$` alone.
        const close = nextDoubleDollar(index + 2);
        const end = close === -1 ? index + 2 : close + 2;
        output += segment.slice(index, end);
        index = end;
        continue;
      }
      const math = singleDollarMath(segment, index, atTextEnd, streaming);
      if (math) {
        output += `$$${math.content}$$`;
        index = math.end;
        continue;
      }
    }
    output += char;
    index += 1;
  }
  return output;
}

/** The inline pass over a line, copying the parts inside untouched ranges as written. */
function normalizeProseRuns(
  text: string,
  lineStart: number,
  line: string,
  untouched: ReadonlyArray<Range>,
  streaming: boolean,
): string {
  const lineEnd = lineStart + line.length;
  const atTextEnd = lineEnd === text.length;
  let output = "";
  let cursor = lineStart;
  for (
    let rangeIndex = firstRangeEndingAfter(untouched, lineStart);
    rangeIndex < untouched.length && untouched[rangeIndex]![0] < lineEnd;
    rangeIndex += 1
  ) {
    const [start, end] = untouched[rangeIndex]!;
    if (start > cursor) {
      output += normalizeInlineMath(text.slice(cursor, start), false, streaming);
    }
    output += text.slice(Math.max(start, cursor), Math.min(end, lineEnd));
    cursor = Math.min(end, lineEnd);
  }
  if (cursor < lineEnd) {
    output += normalizeInlineMath(text.slice(cursor, lineEnd), atTextEnd, streaming);
  }
  return output;
}

/** The prefix later lines of the same container start with: list markers become spaces. */
function continuationOf(prefix: string): string {
  return prefix.replace(LIST_MARKER_REGEX, (marker) => " ".repeat(marker.length));
}

/** Rewrites a block's math into the `$$` form the renderer reads; see the module comment. */
export function normalizeChatMath(input: string, options?: NormalizeChatMathOptions): string {
  if (!MATH_CANDIDATE_REGEX.test(input)) return input;
  const text = input.includes("\r") ? input.replace(/\r\n?/g, "\n") : input;
  const streaming = options?.streaming === true;
  const { untouched, tables } = protectedRanges(text);
  const lines = text.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const lineRange = (index: number): Range => [
    lineStarts[index]!,
    lineStarts[index]! + lines[index]!.length,
  ];
  /** Wholly outside code, links and the rest, and not a table row. */
  const isBlockLine = (index: number) =>
    !overlaps(untouched, ...lineRange(index)) && !overlaps(tables, ...lineRange(index));

  // For each line, whether a later one closes a display block, by the same
  // rules the closing below uses: one backward pass.
  const dollarCloseAfter = Array.from({ length: lines.length + 1 }, () => false);
  const bracketCloseAfter = Array.from({ length: lines.length + 1 }, () => false);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const blockLine = isBlockLine(index);
    dollarCloseAfter[index] =
      dollarCloseAfter[index + 1]! || (blockLine && DOLLAR_MATH_CLOSE_REGEX.test(line));
    bracketCloseAfter[index] =
      bracketCloseAfter[index + 1]! || (blockLine && BRACKET_MATH_CLOSE_REGEX.test(line));
  }

  const output: string[] = [];
  /** Inside a display block, and which marker closes it. */
  let display: "dollar" | "bracket" | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (display === "bracket") {
      const close = BRACKET_MATH_CLOSE_REGEX.exec(line);
      if (close) {
        output.push(`${close[1]!}$$`);
        display = null;
      } else {
        output.push(line);
      }
      continue;
    }
    if (display === "dollar") {
      const close = DOLLAR_MATH_CLOSE_REGEX.exec(line);
      if (close) {
        // A `$$` fence line holds nothing else: `y = 2$$` closes on a line of its own.
        const content = close[2];
        output.push(...(content ? [`${close[1]!}${content.trimEnd()}`, `${close[1]!}$$`] : [line]));
        display = null;
      } else {
        output.push(line);
      }
      continue;
    }

    if (!isBlockLine(index)) {
      output.push(normalizeProseRuns(text, lineStarts[index]!, line, untouched, streaming));
      continue;
    }

    const whole =
      WHOLE_LINE_DOLLAR_DISPLAY_REGEX.exec(line) ?? WHOLE_LINE_BRACKET_DISPLAY_REGEX.exec(line);
    if (whole) {
      const continuation = continuationOf(whole[1]!);
      output.push(`${whole[1]!}$$`, `${continuation}${whole[2]!.trim()}`, `${continuation}$$`);
      continue;
    }
    const dollarOpen = DOLLAR_MATH_OPEN_REGEX.exec(line);
    if (dollarOpen) {
      const prefix = dollarOpen[1]!;
      const content = dollarOpen[2]!.trim();
      // A `$$` nothing closes would turn everything after it into math. A
      // reply still arriving may close a bare one yet; anything else is
      // written out, or the parser would read the line as a fence and drop
      // the words on it.
      if (dollarCloseAfter[index + 1]! || (streaming && content.length === 0)) {
        display = "dollar";
        output.push(...(content ? [`${prefix}$$`, `${continuationOf(prefix)}${content}`] : [line]));
      } else {
        output.push(`${prefix}\\$\\$${dollarOpen[2]!}`);
      }
      continue;
    }
    const bracketOpen = BRACKET_MATH_OPEN_REGEX.exec(line);
    if (bracketOpen && bracketCloseAfter[index + 1]!) {
      display = "bracket";
      output.push(`${bracketOpen[1]!}$$`);
      continue;
    }
    output.push(normalizeProseRuns(text, lineStarts[index]!, line, untouched, streaming));
  }
  return output.join("\n");
}

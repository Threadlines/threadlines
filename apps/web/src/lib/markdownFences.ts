/**
 * Fenced-block bookkeeping shared by the line-by-line passes over chat
 * markdown (the block splitter, the streaming-tail repair, the inline-code
 * pre-pass, the math normalizer): a fence marker line is never a block
 * boundary, and nothing between two markers is markup. Display math counts as
 * a fence too, so a formula with a blank line in it stays one block and its
 * `*`, `_` and `~` are left alone.
 */

const BLOCK_FENCE_MARKER_REGEX = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * What can start a line before a display formula: quote markers, and on the
 * first line of a list item its marker. Captured so a rewrite keeps it.
 */
export const OPENER_PREFIX = String.raw`((?:[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+))*[ \t]*)`;
/** What can start a later line of the same container: quote markers and indentation. */
export const CONTINUATION_PREFIX = String.raw`((?:[ \t]*>[ \t]?)*[ \t]*)`;

/** `$$` opening display math, alone or with the formula's first line after it. */
export const DOLLAR_MATH_OPEN_REGEX = new RegExp(
  String.raw`^${OPENER_PREFIX}\$\$(?!\$)((?:(?!\$\$)[^\r])*?)[ \t]*\r?$`,
);
/** `$$` closing it, alone or after the formula's last line (with no other `$`). */
export const DOLLAR_MATH_CLOSE_REGEX = new RegExp(
  String.raw`^${CONTINUATION_PREFIX}([^\s$][^$]*?)?\$\$[ \t]*\r?$`,
);
export const BRACKET_MATH_OPEN_REGEX = new RegExp(String.raw`^${OPENER_PREFIX}\\\[[ \t]*\r?$`);
export const BRACKET_MATH_CLOSE_REGEX = new RegExp(
  String.raw`^${CONTINUATION_PREFIX}\\\][ \t]*\r?$`,
);

export type MathFenceKind = "dollar" | "bracket";

/**
 * For each line of `lines`, whether a later line closes a display formula of
 * each kind: one backward pass, so many unanswered openers stay linear.
 */
export function laterMathClosers(lines: ReadonlyArray<string>) {
  const dollar = Array.from({ length: lines.length + 1 }, () => false);
  const bracket = Array.from({ length: lines.length + 1 }, () => false);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    dollar[index] = dollar[index + 1]! || DOLLAR_MATH_CLOSE_REGEX.test(line);
    bracket[index] = bracket[index + 1]! || BRACKET_MATH_CLOSE_REGEX.test(line);
  }
  return (index: number, kind: MathFenceKind) =>
    kind === "dollar" ? dollar[index + 1]! : bracket[index + 1]!;
}

export type FenceLine =
  /** Not a fence line, and outside every fence. */
  | "text"
  /** Inside an open fence, or a marker line that doesn't close it. */
  | "inside"
  /** A line opening a fence. */
  | "open"
  /** A line closing one. */
  | "close";

/**
 * Walks a document one line at a time. Code fences follow CommonMark (the
 * closer uses the opener's character, at least as many, and nothing after it);
 * inside a code fence, math markers are code. `closesLater` (from
 * {@link laterMathClosers}) keeps a `$$` or `\[` nothing closes from swallowing
 * the rest of a settled document; without it every opener opens.
 */
export function createFenceTracker(options?: {
  readonly closesLater?: (lineIndex: number, kind: MathFenceKind) => boolean;
}) {
  let code: { char: string; length: number } | null = null;
  let math: MathFenceKind | null = null;
  let lineIndex = -1;
  const opens = (kind: MathFenceKind) => options?.closesLater?.(lineIndex, kind) ?? true;
  return {
    isOpen: () => code !== null || math !== null,
    /** Feeds one line and says what it was. */
    feed(line: string): FenceLine {
      lineIndex += 1;
      if (math === null) {
        const fenceMatch = BLOCK_FENCE_MARKER_REGEX.exec(line);
        if (fenceMatch) {
          const marker = fenceMatch[1]!;
          if (code === null) {
            code = { char: marker[0]!, length: marker.length };
            return "open";
          }
          if (
            marker[0] === code.char &&
            marker.length >= code.length &&
            (fenceMatch[2] ?? "").trim() === ""
          ) {
            code = null;
            return "close";
          }
          return "inside";
        }
      }
      if (code !== null) return "inside";
      if (math !== null) {
        const closes =
          math === "dollar"
            ? DOLLAR_MATH_CLOSE_REGEX.test(line)
            : BRACKET_MATH_CLOSE_REGEX.test(line);
        if (closes) {
          math = null;
          return "close";
        }
        return "inside";
      }
      if (DOLLAR_MATH_OPEN_REGEX.test(line) && opens("dollar")) {
        math = "dollar";
        return "open";
      }
      if (BRACKET_MATH_OPEN_REGEX.test(line) && opens("bracket")) {
        math = "bracket";
        return "open";
      }
      return "text";
    },
  };
}

const FENCED_BLOCK_OPENER_REGEX =
  /^(?:[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+))*[ \t]*(`{3,}|~{3,}|\$\$)/;
const CONTINUATION_PREFIX_REGEX = new RegExp(`^${CONTINUATION_PREFIX}`);

/**
 * Whether the source of one fenced block (a code fence or `$$` display math,
 * as the parser found it) ends in its own closing marker. A fence the reply
 * hasn't closed yet runs to the end of the text, so this tells a block still
 * being written from one that just closed.
 */
export function fencedBlockIsClosed(source: string): boolean {
  const lines = source.replace(/\r/g, "").trimEnd().split("\n");
  if (lines.length < 2) return false;
  const opener = FENCED_BLOCK_OPENER_REGEX.exec(lines[0]!)?.[1];
  if (!opener) return false;
  const closer = lines.at(-1)!.replace(CONTINUATION_PREFIX_REGEX, "").trim();
  if (opener === "$$") return closer.endsWith("$$");
  return closer.length >= opener.length && [...closer].every((char) => char === opener[0]);
}

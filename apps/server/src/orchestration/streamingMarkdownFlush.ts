/**
 * Where a streaming reply can be cut for the next batch the server sends.
 *
 * Text is held back while a span it opened might still close (inline code, a
 * link, emphasis) or a table row is unfinished, so a user never sees markdown
 * half drawn. Each batch is cut from the text received since the last one,
 * so what the earlier batches left open travels in `StreamingMarkdownState`:
 * a code block, a table, and whether the next batch starts a line.
 *
 * Inside a code block nothing is markdown, so only a last line that may still
 * become its closing fence waits. A fenced block also ends any span before it,
 * so the inline rules read only the text after the last block.
 *
 * @module streamingMarkdownFlush
 */

const MARKDOWN_FENCE_INDENT_LIMIT = 3;

interface MarkdownFence {
  readonly marker: "`" | "~";
  readonly length: number;
}

/** What the batches sent so far left open. */
export interface StreamingMarkdownState {
  /** The code block still open, if any. */
  readonly fence: MarkdownFence | null;
  /** A table whose rows are still coming. */
  readonly continuingTable: boolean;
  /** The text sent so far ends a line (or none was sent). */
  readonly atLineStart: boolean;
}

/** A reply nothing has been sent of yet. */
export const STREAMING_MARKDOWN_START: StreamingMarkdownState = {
  fence: null,
  continuingTable: false,
  atLineStart: true,
};

/** A line made of up to three spaces, a run of one fence marker, and the rest. */
function fenceRunOf(line: string): { marker: "`" | "~"; length: number; rest: string } | null {
  let cursor = 0;
  while (line[cursor] === " " && cursor <= MARKDOWN_FENCE_INDENT_LIMIT) {
    cursor += 1;
  }
  if (cursor > MARKDOWN_FENCE_INDENT_LIMIT) {
    return null;
  }
  const marker = line[cursor];
  if (marker !== "`" && marker !== "~") {
    return null;
  }
  let end = cursor;
  while (line[end] === marker) {
    end += 1;
  }
  return { marker, length: end - cursor, rest: line.slice(end) };
}

/**
 * The fenced code blocks in `text`, read on from `state`: the block still open
 * at its end, where the text after the last block starts, and where a last
 * unfinished line starts that is only a fence's markers so far (it may yet
 * open or close a block, and is read once it has more).
 */
function scanFencedBlocks(
  text: string,
  state: StreamingMarkdownState,
): { fence: MarkdownFence | null; outsideStart: number; heldStart: number | null } {
  let fence = state.fence;
  let outsideStart = 0;
  let lineStart = 0;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const hasLineEnding = newline !== -1;
    const lineEnd = hasLineEnding ? newline : text.length;
    // The first line goes on with one an earlier batch began, unless that batch ended it.
    const run =
      lineStart === 0 && !state.atLineStart ? null : fenceRunOf(text.slice(lineStart, lineEnd));
    // An unfinished line that is so far only a fence's markers, or only the
    // spaces a fence may be indented by, waits until it shows what it is.
    const unfinishedOpening =
      !hasLineEnding &&
      (lineStart > 0 || state.atLineStart) &&
      lineEnd > lineStart &&
      (run !== null ? run.rest.trim() === "" : /^ {1,3}$/u.test(text.slice(lineStart, lineEnd)));
    if (unfinishedOpening) {
      return { fence, outsideStart, heldStart: lineStart };
    }
    if (fence === null) {
      if (run !== null && run.length >= 3 && (run.marker === "~" || !run.rest.includes("`"))) {
        fence = { marker: run.marker, length: run.length };
      }
    } else if (
      run !== null &&
      run.marker === fence.marker &&
      run.length >= fence.length &&
      run.rest.trim() === ""
    ) {
      fence = null;
      outsideStart = lineEnd + 1;
    }
    if (!hasLineEnding) {
      return { fence, outsideStart, heldStart: null };
    }
    lineStart = lineEnd + 1;
  }
}

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function isAsciiAlphaNumeric(char: string | undefined): boolean {
  return char !== undefined && /^[A-Za-z0-9]$/u.test(char);
}

function isMarkdownBoundaryBefore(char: string | undefined): boolean {
  return (
    char === undefined ||
    /\s/u.test(char) ||
    char === "(" ||
    char === "[" ||
    char === "{" ||
    char === "<" ||
    char === '"' ||
    char === "'"
  );
}

interface MarkdownLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly hasLineEnding: boolean;
}

function splitMarkdownLines(text: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\n") {
      continue;
    }
    lines.push({
      text: text.slice(start, index),
      start,
      end: index,
      hasLineEnding: true,
    });
    start = index + 1;
  }
  lines.push({
    text: text.slice(start),
    start,
    end: text.length,
    hasLineEnding: false,
  });
  return lines;
}

function isSyntheticTrailingMarkdownLine(line: MarkdownLine, sourceText: string): boolean {
  return !line.hasLineEnding && line.start === sourceText.length && line.text.length === 0;
}

function stripOuterTablePipes(line: string): string {
  let value = line.trim();
  if (value.startsWith("|")) {
    value = value.slice(1);
  }
  if (value.endsWith("|")) {
    value = value.slice(0, -1);
  }
  return value;
}

function isPotentialMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(">")) {
    return false;
  }
  if (trimmed.startsWith("|")) {
    return stripOuterTablePipes(trimmed).includes("|");
  }
  const firstPipe = trimmed.indexOf("|");
  return firstPipe >= 0 && trimmed.indexOf("|", firstPipe + 1) >= 0;
}

function isMarkdownTableSeparatorRow(line: string): boolean {
  if (!isPotentialMarkdownTableRow(line)) {
    return false;
  }
  const cells = stripOuterTablePipes(line)
    .split("|")
    .map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function findPendingMarkdownTableStart(
  text: string,
  options?: { readonly continuingTable?: boolean },
): number | null {
  const lines = splitMarkdownLines(text);
  let tableActive = options?.continuingTable === true;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const nextLine = lines[index + 1];
    if (isSyntheticTrailingMarkdownLine(line, text)) {
      break;
    }

    if (tableActive) {
      if (!isPotentialMarkdownTableRow(line.text)) {
        tableActive = false;
        continue;
      }
      if (!line.hasLineEnding) {
        return line.start;
      }
      continue;
    }

    if (!isPotentialMarkdownTableRow(line.text)) {
      continue;
    }

    if (!nextLine) {
      return line.start;
    }
    if (!nextLine.hasLineEnding && !isMarkdownTableSeparatorRow(nextLine.text)) {
      return line.start;
    }
    if (!isMarkdownTableSeparatorRow(nextLine.text)) {
      continue;
    }
    if (!nextLine.hasLineEnding) {
      return line.start;
    }

    tableActive = true;
    index += 1;
  }

  return null;
}

function markdownTableContinuesAfterFlush(
  text: string,
  options?: { readonly continuingTable?: boolean },
): boolean {
  const lines = splitMarkdownLines(text);
  let tableActive = options?.continuingTable === true;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (isSyntheticTrailingMarkdownLine(line, text)) {
      break;
    }

    if (tableActive) {
      if (isPotentialMarkdownTableRow(line.text)) {
        continue;
      }
      tableActive = false;
      continue;
    }

    if (!isPotentialMarkdownTableRow(line.text)) {
      continue;
    }

    const nextLine = lines[index + 1];
    if (
      nextLine &&
      !isSyntheticTrailingMarkdownLine(nextLine, text) &&
      isMarkdownTableSeparatorRow(nextLine.text)
    ) {
      tableActive = true;
      index += 1;
    }
  }

  return tableActive;
}

function findClosingMarkdownParenthesis(text: string, startIndex: number): number | null {
  let depth = 0;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (isEscapedMarkdownCharacter(text, index)) {
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char !== ")") {
      continue;
    }
    if (depth === 0) {
      return index;
    }
    depth -= 1;
  }
  return null;
}

/** The first inline code span left open. `text` holds no fenced code block. */
function findUnclosedInlineCodeSpanStart(text: string): number | null {
  let inlineCode: { start: number; tickCount: number } | null = null;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char !== "`") {
      continue;
    }

    const runStart = index;
    let runEnd = index;
    while (text[runEnd] === "`") {
      runEnd += 1;
    }
    const tickCount = runEnd - runStart;

    if (inlineCode && tickCount === inlineCode.tickCount) {
      inlineCode = null;
    } else if (inlineCode === null) {
      inlineCode = { start: runStart, tickCount };
    }

    index = runEnd - 1;
  }

  return inlineCode?.start ?? null;
}

function findUnclosedLinkStart(text: string): number | null {
  const labelStack: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (isEscapedMarkdownCharacter(text, index)) {
      continue;
    }

    if (char === "[") {
      labelStack.push(text[index - 1] === "!" ? index - 1 : index);
      continue;
    }

    if (char !== "]" || labelStack.length === 0) {
      continue;
    }

    const labelStart = labelStack.pop()!;
    const nextChar = text[index + 1];
    if (nextChar === "(") {
      const closeIndex = findClosingMarkdownParenthesis(text, index + 2);
      if (closeIndex === null) {
        return labelStart;
      }
      index = closeIndex;
      continue;
    }

    if (nextChar === "[") {
      const closeReferenceIndex = text.indexOf("]", index + 2);
      if (closeReferenceIndex < 0) {
        return labelStart;
      }
      index = closeReferenceIndex;
    }
  }

  return labelStack[0] ?? null;
}

function findUnclosedEmphasisStart(text: string): number | null {
  const markerStack: Array<{ marker: "*" | "~"; length: 1 | 2; start: number }> = [];

  for (let index = 0; index < text.length; index += 1) {
    const marker = text[index];
    if ((marker !== "*" && marker !== "~") || isEscapedMarkdownCharacter(text, index)) {
      continue;
    }

    let runEnd = index;
    while (text[runEnd] === marker) {
      runEnd += 1;
    }
    const runLength = runEnd - index;
    const length = Math.min(runLength, 2) as 1 | 2;
    const previousChar = text[index - 1];
    const nextChar = text[index + length];
    // A run that ends the text may open a span once its next character
    // arrives, so it waits for it.
    const canOpen =
      isMarkdownBoundaryBefore(previousChar) &&
      (isAsciiAlphaNumeric(nextChar) || runEnd === text.length) &&
      (marker === "*" || length === 2);
    // Closing only needs a non-space character before the run (CommonMark's
    // right-flanking rule). Requiring more — e.g. an alphanumeric — misses
    // closers like "**done.**" or "**Note:**", leaving a phantom open span
    // that wedges the streaming flush until the message completes.
    const canClose = previousChar !== undefined && !/\s/u.test(previousChar);
    const openIndex = markerStack.findLastIndex(
      (entry) => entry.marker === marker && entry.length === length,
    );

    if (openIndex >= 0 && canClose) {
      markerStack.splice(openIndex, 1);
    } else if (canOpen) {
      markerStack.push({ marker, length, start: index });
    }

    index = runEnd - 1;
  }

  return markerStack.length > 0 ? Math.min(...markerStack.map((entry) => entry.start)) : null;
}

/**
 * Cuts `text`, everything received since the last batch, into what can be
 * sent now and what waits for more.
 */
export function splitStreamingAssistantMarkdownFlush(
  text: string,
  state: StreamingMarkdownState,
): {
  readyText: string;
  pendingText: string;
} {
  const blocks = scanFencedBlocks(text, state);
  const end = blocks.heldStart ?? text.length;
  const pendingStarts: number[] = blocks.heldStart === null ? [] : [blocks.heldStart];
  if (blocks.fence === null) {
    const outside = text.slice(blocks.outsideStart, end);
    for (const start of [
      findUnclosedInlineCodeSpanStart(outside),
      findUnclosedLinkStart(outside),
      findUnclosedEmphasisStart(outside),
      findPendingMarkdownTableStart(outside, {
        continuingTable: blocks.outsideStart === 0 && state.continuingTable,
      }),
    ]) {
      if (start !== null) pendingStarts.push(blocks.outsideStart + start);
    }
  }
  if (pendingStarts.length === 0) {
    return { readyText: text, pendingText: "" };
  }
  const pendingStart = Math.min(...pendingStarts);
  return {
    readyText: text.slice(0, pendingStart),
    pendingText: text.slice(pendingStart),
  };
}

/** What is left open once `sentText` has been sent after the batches `state` describes. */
export function streamingMarkdownStateAfter(
  sentText: string,
  state: StreamingMarkdownState,
): StreamingMarkdownState {
  if (sentText.length === 0) {
    return state;
  }
  const blocks = scanFencedBlocks(sentText, state);
  return {
    fence: blocks.fence,
    continuingTable:
      blocks.fence === null &&
      markdownTableContinuesAfterFlush(
        sentText.slice(blocks.outsideStart, blocks.heldStart ?? undefined),
        {
          continuingTable: blocks.outsideStart === 0 && state.continuingTable,
        },
      ),
    atLineStart: sentText.endsWith("\n"),
  };
}

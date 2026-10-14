/**
 * Find in chat, as data: which rows hold matches for a query, how many, and
 * which one is current. Pure; ChatFind drives it and chatFindDom paints it.
 *
 * A match is addressed by its row, its block within the row and its place in
 * the block, never by a running number across the chat: rows above it can
 * gain or lose matches (an agent still writing, a revert) and the current
 * match stays the same words.
 */

/** One row's findable text, as chatFindText returns it. */
export interface ChatFindRow {
  readonly id: string;
  readonly blocks: ReadonlyArray<string>;
}

export interface ChatFindMatch {
  readonly rowId: string;
  readonly blockIndex: number;
  /** Which match within the block, from 0. */
  readonly occurrence: number;
}

export interface ChatFindRowResult {
  readonly id: string;
  /** Matches in each block, by block index. */
  readonly blockCounts: ReadonlyArray<number>;
  readonly total: number;
}

export interface ChatFindResult {
  /** Rows with at least one match, in reading order. */
  readonly rows: ReadonlyArray<ChatFindRowResult>;
  readonly total: number;
}

export const EMPTY_CHAT_FIND_RESULT: ChatFindResult = { rows: [], total: 0 };

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The query as a pattern: a literal phrase, any case, whose words match
 * across any run of whitespace. Null for a query with nothing to find.
 */
export function createChatFindPattern(query: string): RegExp | null {
  const words = query
    .trim()
    .split(/\s+/u)
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return new RegExp(words.map(escapeRegularExpression).join("\\s+"), "giu");
}

/** Where each match of `pattern` starts and ends in `text`. */
export function findPatternSpans(
  text: string,
  pattern: RegExp,
): Array<{ readonly start: number; readonly end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

function countPatternMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const match of text.matchAll(pattern)) {
    if (match[0].length > 0) count += 1;
  }
  return count;
}

export function searchChatFindRows(
  rows: ReadonlyArray<ChatFindRow>,
  pattern: RegExp,
): ChatFindResult {
  const matched: ChatFindRowResult[] = [];
  let total = 0;
  for (const row of rows) {
    let rowTotal = 0;
    const blockCounts = row.blocks.map((block) => {
      const count = countPatternMatches(block, pattern);
      rowTotal += count;
      return count;
    });
    if (rowTotal > 0) {
      matched.push({ id: row.id, blockCounts, total: rowTotal });
      total += rowTotal;
    }
  }
  return { rows: matched, total };
}

function firstMatchOf(row: ChatFindRowResult): ChatFindMatch | null {
  const blockIndex = row.blockCounts.findIndex((count) => count > 0);
  return blockIndex < 0 ? null : { rowId: row.id, blockIndex, occurrence: 0 };
}

function lastMatchOf(row: ChatFindRowResult): ChatFindMatch | null {
  const blockIndex = row.blockCounts.findLastIndex((count) => count > 0);
  return blockIndex < 0
    ? null
    : { rowId: row.id, blockIndex, occurrence: row.blockCounts[blockIndex]! - 1 };
}

function isMatchIn(result: ChatFindResult, match: ChatFindMatch): boolean {
  const row = result.rows.find((candidate) => candidate.id === match.rowId);
  const count = row?.blockCounts[match.blockIndex] ?? 0;
  return match.occurrence < count;
}

export function sameChatFindMatch(a: ChatFindMatch | null, b: ChatFindMatch | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.rowId === b.rowId &&
      a.blockIndex === b.blockIndex &&
      a.occurrence === b.occurrence)
  );
}

/** The current match's place across the whole chat, from 1, as the count shows it. */
export function chatFindMatchNumber(result: ChatFindResult, match: ChatFindMatch | null): number {
  if (match === null) return 0;
  let before = 0;
  for (const row of result.rows) {
    if (row.id !== match.rowId) {
      before += row.total;
      continue;
    }
    for (let blockIndex = 0; blockIndex < match.blockIndex; blockIndex += 1) {
      before += row.blockCounts[blockIndex] ?? 0;
    }
    return before + match.occurrence + 1;
  }
  return 0;
}

/**
 * The match `direction` steps from `current`, wrapping at either end. With
 * no current match, the first (or, going back, the last) in the chat.
 */
export function stepChatFindMatch(
  result: ChatFindResult,
  current: ChatFindMatch | null,
  direction: 1 | -1,
): ChatFindMatch | null {
  const rows = result.rows;
  if (rows.length === 0) return null;
  const rowIndex = current === null ? -1 : rows.findIndex((row) => row.id === current.rowId);
  if (current === null || rowIndex < 0) {
    return direction === 1 ? firstMatchOf(rows[0]!) : lastMatchOf(rows[rows.length - 1]!);
  }
  const row = rows[rowIndex]!;
  if (direction === 1) {
    if (current.occurrence + 1 < (row.blockCounts[current.blockIndex] ?? 0)) {
      return { ...current, occurrence: current.occurrence + 1 };
    }
    for (let block = current.blockIndex + 1; block < row.blockCounts.length; block += 1) {
      if ((row.blockCounts[block] ?? 0) > 0) {
        return { rowId: row.id, blockIndex: block, occurrence: 0 };
      }
    }
    return firstMatchOf(rows[(rowIndex + 1) % rows.length]!);
  }
  if (current.occurrence > 0) {
    return { ...current, occurrence: current.occurrence - 1 };
  }
  for (let block = current.blockIndex - 1; block >= 0; block -= 1) {
    const count = row.blockCounts[block] ?? 0;
    if (count > 0) {
      return { rowId: row.id, blockIndex: block, occurrence: count - 1 };
    }
  }
  return lastMatchOf(rows[(rowIndex - 1 + rows.length) % rows.length]!);
}

/**
 * Keeps the current match through a new result for the same query. It stays
 * when its words are still there; when its row lost them or went away, the
 * next match after its old place takes over (wrapping to the first).
 * `rowOrder` is every row id in reading order, matched or not, from the new
 * rows, so a vanished row's old neighbours can still be found.
 */
export function carryChatFindMatch(input: {
  readonly previous: ChatFindResult;
  readonly next: ChatFindResult;
  readonly current: ChatFindMatch | null;
  readonly rowOrder: ReadonlyArray<string>;
}): ChatFindMatch | null {
  const { previous, next, current } = input;
  if (current === null) return null;
  if (isMatchIn(next, current)) return current;
  if (next.rows.length === 0) return null;

  const nextRows = new Map(next.rows.map((row) => [row.id, row]));
  const sameRow = nextRows.get(current.rowId);
  if (sameRow) {
    // The row is still here with fewer matches: the next one in it after the
    // old place, else the row after it.
    for (let block = current.blockIndex; block < sameRow.blockCounts.length; block += 1) {
      const count = sameRow.blockCounts[block] ?? 0;
      const start = block === current.blockIndex ? current.occurrence : 0;
      if (start < count) {
        return { rowId: sameRow.id, blockIndex: block, occurrence: start };
      }
    }
  }

  // Walk forward from the old row: through the rows still on the page in
  // reading order, else through the rows the previous result had after it.
  const orderIndex = input.rowOrder.indexOf(current.rowId);
  if (orderIndex >= 0) {
    for (let index = orderIndex + 1; index < input.rowOrder.length; index += 1) {
      const row = nextRows.get(input.rowOrder[index]!);
      if (row) return firstMatchOf(row);
    }
  } else {
    const previousIndex = previous.rows.findIndex((row) => row.id === current.rowId);
    if (previousIndex >= 0) {
      for (const row of previous.rows.slice(previousIndex + 1)) {
        const carried = nextRows.get(row.id);
        if (carried) return firstMatchOf(carried);
      }
    }
  }
  return firstMatchOf(next.rows[0]!);
}

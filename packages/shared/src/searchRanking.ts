export type RankedSearchResult<T> = {
  item: T;
  score: number;
  tieBreaker: string;
};

export interface ParsedSearchQueryClause {
  readonly value: string;
  readonly quoted: boolean;
}

export interface ParsedSearchQuery {
  readonly clauses: ReadonlyArray<ParsedSearchQueryClause>;
  readonly phrase: string;
}

export interface SearchTextMatchRange {
  readonly clauseIndex: number;
  readonly start: number;
  readonly end: number;
}

export type SearchTextMatchKind = "exact-phrase" | "ordered" | "unordered";

export interface SearchTextMatchAnalysis {
  /** Lower scores are stronger. Match-kind tiers dominate proximity and position. */
  readonly score: number;
  readonly kind: SearchTextMatchKind;
  readonly ranges: ReadonlyArray<SearchTextMatchRange>;
}

const MAX_SEARCH_OCCURRENCES_PER_CLAUSE = 64;
const ORDERED_SEARCH_SCORE_BASE = 100_000_000;
const UNORDERED_SEARCH_SCORE_BASE = 200_000_000;

function normalizeSearchClause(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
}

function appendSearchQueryClause(
  clauses: ParsedSearchQueryClause[],
  seen: Set<string>,
  value: string,
  quoted: boolean,
): void {
  const normalized = normalizeSearchClause(value);
  if (!normalized) {
    return;
  }
  const values = quoted ? [normalized] : normalized.split(" ");
  for (const nextValue of values) {
    const key = `${quoted ? "quoted" : "term"}\u0000${nextValue}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    clauses.push({ value: nextValue, quoted });
  }
}

/**
 * Parses a forgiving search query. Unquoted whitespace separates required
 * terms; quoted text remains one required phrase. Backslash escapes the next
 * quote or backslash, and an unclosed quote is treated as an in-progress
 * phrase so search-as-you-type remains predictable.
 */
export function parseSearchQuery(input: string): ParsedSearchQuery {
  const clauses: ParsedSearchQueryClause[] = [];
  const seen = new Set<string>();
  let buffer = "";
  let quoted = false;
  let escaping = false;

  const flush = () => {
    appendSearchQueryClause(clauses, seen, buffer, quoted);
    buffer = "";
  };

  for (const character of input.normalize("NFKC")) {
    if (escaping) {
      buffer += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (character === `"`) {
      flush();
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/u.test(character)) {
      flush();
      continue;
    }
    buffer += character;
  }
  if (escaping) {
    buffer += "\\";
  }
  flush();

  return {
    clauses,
    phrase: clauses.map((clause) => clause.value).join(" "),
  };
}

function escapeSearchRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function searchClausePattern(value: string): string {
  return value.split(" ").map(escapeSearchRegularExpression).join("\\s+");
}

function findSearchTextOccurrences(
  text: string,
  value: string,
  clauseIndex: number,
): SearchTextMatchRange[] {
  const pattern = new RegExp(searchClausePattern(value), "giu");
  const ranges: SearchTextMatchRange[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const matchedText = match[0];
    if (start === undefined || matchedText.length === 0) {
      continue;
    }
    ranges.push({ clauseIndex, start, end: start + matchedText.length });
    if (ranges.length >= MAX_SEARCH_OCCURRENCES_PER_CLAUSE) {
      break;
    }
  }
  return ranges;
}

function orderedSearchRanges(
  occurrencesByClause: ReadonlyArray<ReadonlyArray<SearchTextMatchRange>>,
): SearchTextMatchRange[] | null {
  const firstClauseOccurrences = occurrencesByClause[0];
  if (!firstClauseOccurrences) {
    return null;
  }

  let best: SearchTextMatchRange[] | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const first of firstClauseOccurrences) {
    const selected = [first];
    let cursor = first.end;
    for (let clauseIndex = 1; clauseIndex < occurrencesByClause.length; clauseIndex += 1) {
      const next = occurrencesByClause[clauseIndex]?.find(
        (occurrence) => occurrence.start >= cursor,
      );
      if (!next) {
        selected.length = 0;
        break;
      }
      selected.push(next);
      cursor = next.end;
    }
    if (selected.length !== occurrencesByClause.length) {
      continue;
    }
    const span = (selected.at(-1)?.end ?? first.end) - first.start;
    if (span < bestSpan || (span === bestSpan && first.start < (best?.[0]?.start ?? Infinity))) {
      best = selected;
      bestSpan = span;
    }
  }
  return best;
}

function unorderedSearchRanges(
  occurrencesByClause: ReadonlyArray<ReadonlyArray<SearchTextMatchRange>>,
): SearchTextMatchRange[] {
  const events = occurrencesByClause
    .flatMap((occurrences) => occurrences)
    .toSorted((left, right) => left.start - right.start || left.end - right.end);
  const counts = Array.from({ length: occurrencesByClause.length }, () => 0);
  const maximumEndIndexes: number[] = [];
  let coveredClauses = 0;
  let left = 0;
  let bestLeft = 0;
  let bestRight = events.length - 1;
  let bestSpan = Number.POSITIVE_INFINITY;

  for (let right = 0; right < events.length; right += 1) {
    const event = events[right];
    if (!event) continue;
    if (counts[event.clauseIndex] === 0) {
      coveredClauses += 1;
    }
    counts[event.clauseIndex] = (counts[event.clauseIndex] ?? 0) + 1;
    while (
      maximumEndIndexes.length > 0 &&
      (events[maximumEndIndexes.at(-1) ?? -1]?.end ?? -1) <= event.end
    ) {
      maximumEndIndexes.pop();
    }
    maximumEndIndexes.push(right);

    while (coveredClauses === occurrencesByClause.length && left <= right) {
      const leftEvent = events[left];
      const maximumEnd = events[maximumEndIndexes[0] ?? -1]?.end;
      if (!leftEvent || maximumEnd === undefined) {
        break;
      }
      const span = maximumEnd - leftEvent.start;
      if (
        span < bestSpan ||
        (span === bestSpan && leftEvent.start < (events[bestLeft]?.start ?? 0))
      ) {
        bestLeft = left;
        bestRight = right;
        bestSpan = span;
      }

      counts[leftEvent.clauseIndex] = (counts[leftEvent.clauseIndex] ?? 1) - 1;
      if (counts[leftEvent.clauseIndex] === 0) {
        coveredClauses -= 1;
      }
      if (maximumEndIndexes[0] === left) {
        maximumEndIndexes.shift();
      }
      left += 1;
    }
  }

  const selectedByClause = new Map<number, SearchTextMatchRange>();
  for (let index = bestLeft; index <= bestRight; index += 1) {
    const event = events[index];
    if (event && !selectedByClause.has(event.clauseIndex)) {
      selectedByClause.set(event.clauseIndex, event);
    }
  }
  return occurrencesByClause.flatMap((_, clauseIndex) => {
    const selected = selectedByClause.get(clauseIndex);
    return selected ? [selected] : [];
  });
}

function scoreSearchRanges(base: number, ranges: ReadonlyArray<SearchTextMatchRange>): number {
  const firstStart = Math.min(...ranges.map((range) => range.start));
  const lastEnd = Math.max(...ranges.map((range) => range.end));
  const matchedLength = ranges.reduce((total, range) => total + range.end - range.start, 0);
  const gapLength = Math.max(0, lastEnd - firstStart - matchedLength);
  return (
    base +
    Math.min(999_999, gapLength) * 100 +
    Math.min(999_999, lastEnd - firstStart) +
    Math.min(999, firstStart)
  );
}

export function analyzeSearchText(
  text: string,
  query: string | ParsedSearchQuery,
): SearchTextMatchAnalysis | null {
  const parsed = typeof query === "string" ? parseSearchQuery(query) : query;
  if (!text || parsed.clauses.length === 0) {
    return null;
  }

  const occurrencesByClause = parsed.clauses.map((clause, clauseIndex) =>
    findSearchTextOccurrences(text, clause.value, clauseIndex),
  );
  if (occurrencesByClause.some((occurrences) => occurrences.length === 0)) {
    return null;
  }

  const phraseRange = findSearchTextOccurrences(text, parsed.phrase, -1)[0];
  if (phraseRange) {
    return {
      score: Math.min(99_999_999, phraseRange.start),
      kind: "exact-phrase",
      ranges: [phraseRange],
    };
  }

  const orderedRanges = orderedSearchRanges(occurrencesByClause);
  if (orderedRanges) {
    return {
      score: scoreSearchRanges(ORDERED_SEARCH_SCORE_BASE, orderedRanges),
      kind: "ordered",
      ranges: orderedRanges,
    };
  }

  const unorderedRanges = unorderedSearchRanges(occurrencesByClause);
  return {
    score: scoreSearchRanges(UNORDERED_SEARCH_SCORE_BASE, unorderedRanges),
    kind: "unordered",
    ranges: unorderedRanges,
  };
}

export function searchQueryHighlightValues(query: string | ParsedSearchQuery): string[] {
  const parsed = typeof query === "string" ? parseSearchQuery(query) : query;
  return [
    ...new Set([
      parsed.phrase,
      ...parsed.clauses.map((clause) => clause.value),
      ...parsed.clauses.flatMap((clause) => (clause.quoted ? clause.value.split(" ") : [])),
    ]),
  ]
    .filter((value) => value.length > 0)
    .toSorted((left, right) => right.length - left.length);
}

function searchSnippetFragment(text: string, start: number, end: number): string {
  const fragment = text.slice(start, end).trim();
  return `${start > 0 ? "… " : ""}${fragment}${end < text.length ? " …" : ""}`;
}

export function buildSearchTextSnippet(
  text: string,
  query: string | ParsedSearchQuery,
  options: { readonly maxLength?: number } = {},
): string {
  const displayText = text.trim().replace(/\s+/gu, " ");
  const parsed = typeof query === "string" ? parseSearchQuery(query) : query;
  const analysis = analyzeSearchText(displayText, parsed);
  const maxLength = Math.max(48, options.maxLength ?? 180);
  if (!analysis) {
    return searchSnippetFragment(displayText, 0, Math.min(displayText.length, maxLength));
  }

  const firstStart = Math.min(...analysis.ranges.map((range) => range.start));
  const lastEnd = Math.max(...analysis.ranges.map((range) => range.end));
  const matchSpan = lastEnd - firstStart;
  if (matchSpan <= Math.floor(maxLength * 0.7)) {
    const contextBudget = Math.max(0, maxLength - matchSpan);
    const start = Math.max(0, firstStart - Math.floor(contextBudget / 2));
    const end = Math.min(displayText.length, lastEnd + (contextBudget - (firstStart - start)));
    return searchSnippetFragment(displayText, start, end);
  }

  const ranges = analysis.ranges.toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const matchLength = ranges.reduce((total, range) => total + range.end - range.start, 0);
  const separatorLength = Math.max(0, ranges.length - 1) * 3;
  const contextPerSide = Math.max(
    4,
    Math.floor((maxLength - matchLength - separatorLength) / Math.max(1, ranges.length * 2)),
  );
  const windows = ranges.map((range) => ({
    start: Math.max(0, range.start - contextPerSide),
    end: Math.min(displayText.length, range.end + contextPerSide),
  }));
  const mergedWindows: Array<{ start: number; end: number }> = [];
  for (const window of windows) {
    const previous = mergedWindows.at(-1);
    if (previous && window.start <= previous.end) {
      previous.end = Math.max(previous.end, window.end);
    } else {
      mergedWindows.push({ ...window });
    }
  }

  const fragments = mergedWindows.map((window) =>
    displayText.slice(window.start, window.end).trim(),
  );
  const prefix = (mergedWindows[0]?.start ?? 0) > 0 ? "… " : "";
  const suffix = (mergedWindows.at(-1)?.end ?? displayText.length) < displayText.length ? " …" : "";
  return `${prefix}${fragments.join(" … ")}${suffix}`;
}

export function normalizeSearchQuery(
  input: string,
  options?: {
    trimLeadingPattern?: RegExp;
  },
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  return options?.trimLeadingPattern
    ? trimmed.replace(options.trimLeadingPattern, "").toLowerCase()
    : trimmed.toLowerCase();
}

export function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length));
}

function findBoundaryMatchIndex(
  value: string,
  query: string,
  boundaryMarkers: readonly string[],
): number | null {
  let bestIndex: number | null = null;

  for (const marker of boundaryMarkers) {
    const index = value.indexOf(`${marker}${query}`);
    if (index === -1) {
      continue;
    }

    const matchIndex = index + marker.length;
    if (bestIndex === null || matchIndex < bestIndex) {
      bestIndex = matchIndex;
    }
  }

  return bestIndex;
}

/**
 * Scores how well `value` matches `query` using tiered match strategies.
 *
 * **Expects pre-normalized inputs**: both `value` and `query` must already be
 * trimmed and lowercased (e.g. via {@link normalizeSearchQuery}).
 */
export function scoreQueryMatch(input: {
  value: string;
  query: string;
  exactBase: number;
  prefixBase?: number;
  boundaryBase?: number;
  includesBase?: number;
  fuzzyBase?: number;
  boundaryMarkers?: readonly string[];
}): number | null {
  const { value, query } = input;

  if (!value || !query) {
    return null;
  }

  if (value === query) {
    return input.exactBase;
  }

  if (input.prefixBase !== undefined && value.startsWith(query)) {
    return input.prefixBase + lengthPenalty(value, query);
  }

  if (input.boundaryBase !== undefined) {
    const boundaryIndex = findBoundaryMatchIndex(
      value,
      query,
      input.boundaryMarkers ?? [" ", "-", "_", "/"],
    );
    if (boundaryIndex !== null) {
      return input.boundaryBase + boundaryIndex * 2 + lengthPenalty(value, query);
    }
  }

  if (input.includesBase !== undefined) {
    const includesIndex = value.indexOf(query);
    if (includesIndex !== -1) {
      return input.includesBase + includesIndex * 2 + lengthPenalty(value, query);
    }
  }

  if (input.fuzzyBase !== undefined) {
    const fuzzyScore = scoreSubsequenceMatch(value, query);
    if (fuzzyScore !== null) {
      return input.fuzzyBase + fuzzyScore;
    }
  }

  return null;
}

export function compareRankedSearchResults<T>(
  left: RankedSearchResult<T>,
  right: RankedSearchResult<T>,
): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  return left.tieBreaker.localeCompare(right.tieBreaker);
}

function findInsertionIndex<T>(
  rankedEntries: RankedSearchResult<T>[],
  candidate: RankedSearchResult<T>,
): number {
  let low = 0;
  let high = rankedEntries.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = rankedEntries[middle];
    if (!current) {
      break;
    }

    if (compareRankedSearchResults(candidate, current) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
}

export function insertRankedSearchResult<T>(
  rankedEntries: RankedSearchResult<T>[],
  candidate: RankedSearchResult<T>,
  limit: number,
): void {
  if (limit <= 0) {
    return;
  }

  const insertionIndex = findInsertionIndex(rankedEntries, candidate);
  if (rankedEntries.length < limit) {
    rankedEntries.splice(insertionIndex, 0, candidate);
    return;
  }

  if (insertionIndex >= limit) {
    return;
  }

  rankedEntries.splice(insertionIndex, 0, candidate);
  rankedEntries.pop();
}

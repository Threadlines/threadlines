/**
 * Search as you type over the app's places and the things listed with them
 * (docs/design/settings-search.md). Settings search ranks its results with
 * it; the server's `app_guide` shares only `searchWords`, so both read words
 * the same way while the guide keeps its own question-style scoring.
 */

/**
 * The words of a text, lowercased: split at anything but letters, digits and
 * dots, so file names like "claude.md" stay one word ("12-hour" is two).
 */
export function searchWords(text: string): ReadonlyArray<string> {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}.]+/u)
    .map((word) => word.replace(/^\.+|\.+$/gu, ""))
    .filter((word) => word.length > 0);
}

/** Words a typed query can drop once they are finished: they name nothing on screen. */
const FILLER_WORDS = new Set(["a", "an", "the", "to", "of", "for", "my", "is", "and", "or"]);

/** A typed query: its words, the last one still being typed. */
export interface SearchQuery {
  readonly text: string;
  readonly words: ReadonlyArray<string>;
}

export function parseSearchQuery(text: string): SearchQuery {
  const words = searchWords(text);
  const last = words.length - 1;
  // The last word is still being typed ("a" may become "agents"), so only
  // finished words can be filler.
  const kept = words.filter((word, index) => index === last || !FILLER_WORDS.has(word));
  return { text: text.trim(), words: kept.length > 0 ? kept : words };
}

/** What a result is searched by. */
export interface SearchFields {
  readonly title: string;
  /** Words users say for it that its title doesn't ("dark mode", "opus"). */
  readonly keywords?: ReadonlyArray<string>;
  /** The section it sits in: "terminal" finds the Terminal section's rows. */
  readonly section?: string;
  /** Its page: counts only beside a word that matched the entry itself. */
  readonly page?: string;
  readonly about?: string;
}

export interface SearchMatch {
  readonly score: number;
  /** Whether every query word is in the title, so the title alone explains the match. */
  readonly inTitle: boolean;
  /** The keyword that carried the match when the title doesn't, for "matches “dark mode”". */
  readonly keyword: string | null;
}

const WEIGHT = { title: 3, keyword: 3, section: 2, about: 1, page: 1 } as const;

/** A query word names a field word when it begins it ("term" → "terminal"). */
const names = (fieldWords: ReadonlyArray<string>, word: string) =>
  fieldWords.some((candidate) => candidate.startsWith(word));

/**
 * How well `fields` match the query, or null when they don't: every query
 * word must begin a word of the entry (its title, keywords, section or
 * about). A page's words only help a query that also names the entry.
 */
export function matchSearchFields(query: SearchQuery, fields: SearchFields): SearchMatch | null {
  if (query.words.length === 0) return null;
  const title = searchWords(fields.title);
  const keywords = (fields.keywords ?? []).map((keyword) => ({
    keyword,
    words: searchWords(keyword),
  }));
  const section = searchWords(fields.section ?? "");
  const about = searchWords(fields.about ?? "");
  const page = searchWords(fields.page ?? "");

  let score = 0;
  let ownWords = 0;
  let pageWords = 0;
  let titleWords = 0;
  let keyword: string | null = null;
  for (const word of query.words) {
    let best = 0;
    if (names(title, word)) {
      best = WEIGHT.title;
      titleWords += 1;
      // A whole word typed ranks above a prefix of one.
      if (title.includes(word)) best += 0.5;
    }
    const keywordHit = keywords.find((entry) => names(entry.words, word));
    if (keywordHit !== undefined && WEIGHT.keyword > best) {
      best = WEIGHT.keyword;
      keyword ??= keywordHit.keyword;
    }
    if (best < WEIGHT.section && names(section, word)) best = WEIGHT.section;
    if (best < WEIGHT.about && names(about, word)) best = WEIGHT.about;
    if (best > 0) {
      ownWords += 1;
    } else if (names(page, word)) {
      best = WEIGHT.page;
      pageWords += 1;
    } else {
      return null;
    }
    score += best;
  }
  if (ownWords === 0) return null;
  // The title reading as the query, from its start, is the best match there is.
  if (fields.title.toLowerCase().startsWith(query.text.toLowerCase())) score += 2;
  const inTitle = titleWords === query.words.length;
  return {
    score: score - pageWords * 0.25,
    inTitle,
    keyword: inTitle ? null : keyword,
  };
}

/** Where a text shows the query: each word the query begins, up to what was typed. */
export function searchMatchRanges(
  text: string,
  query: SearchQuery,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  if (query.words.length === 0) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}.]*/gu)) {
    const word = match[0].toLowerCase();
    const typed = query.words
      .filter((queryWord) => word.startsWith(queryWord))
      .reduce((longest, queryWord) => Math.max(longest, queryWord.length), 0);
    if (typed > 0) ranges.push({ start: match.index, end: match.index + typed });
  }
  return ranges;
}

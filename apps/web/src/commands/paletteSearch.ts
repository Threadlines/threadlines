/**
 * The command palette's search over four kinds of thing
 * (docs/design/command-palette.md, section 5): threads, commands, settings
 * and projects. Each source's own matcher decides what matches; `matchTier`
 * then puts every match on one scale, so the best row leads whichever kind it
 * is. Pure: the palette hands in each source's entries.
 */
import {
  matchSearchFields,
  parseSearchQuery as parsePlaceQuery,
  type SearchFields,
  searchWords,
} from "@threadlines/shared/placeSearch";
import {
  parseSearchQuery as parseThreadQuery,
  scoreSubsequenceMatch,
} from "@threadlines/shared/searchRanking";

import { rankSearchTerms } from "../components/CommandPalette.logic";

/**
 * How well a row matches, best first:
 * 0. the title is the query
 * 1. the title starts with the query
 * 2. every query word begins a word of the title
 * 3. every query word is somewhere in the title
 * 4. every query word begins a word of the title or the second fields
 * 5. anything else its matcher accepted without a message
 * 6. only a message matched
 */
export type MatchTier = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** What `matchTier` reads of a row: its own words, never its matcher's flags. */
export interface TierFields {
  readonly title: string;
  /** A command's or setting's keywords, a thread's project name and branch. */
  readonly second?: ReadonlyArray<string>;
  /** Only a message matched this row (a thread found by the server's search). */
  readonly messageOnly?: boolean;
}

/** The query's words as `matchTier` reads them: lower case, quotes gone. */
export function tierQueryWords(query: string): ReadonlyArray<string> {
  return searchWords(query.replaceAll('"', " "));
}

/** Places a row its matcher accepted on the one scale (see MatchTier). */
export function matchTier(queryWords: ReadonlyArray<string>, fields: TierFields): MatchTier {
  if (fields.messageOnly) return 6;
  if (queryWords.length === 0) return 5;
  const titleWords = searchWords(fields.title);
  const titleText = titleWords.join(" ");
  const queryText = queryWords.join(" ");
  if (titleText === queryText) return 0;
  if (titleText.startsWith(queryText)) return 1;
  const begins = (words: ReadonlyArray<string>, word: string) =>
    words.some((candidate) => candidate.startsWith(word));
  if (queryWords.every((word) => begins(titleWords, word))) return 2;
  if (queryWords.every((word) => titleText.includes(word))) return 3;
  const secondWords = (fields.second ?? []).flatMap((field) => searchWords(field));
  if (queryWords.every((word) => begins(titleWords, word) || begins(secondWords, word))) {
    return 4;
  }
  return 5;
}

export type PaletteSource = "threads" | "commands" | "settings" | "projects";

/** Ties between sections whose best rows share a tier go in this order. */
const SOURCE_ORDER: ReadonlyArray<PaletteSource> = ["threads", "commands", "settings", "projects"];

/** A thread, matched with `searchRanking` (substrings and quoted phrases), as before. */
export interface ThreadSearchEntry<T> {
  readonly title: string;
  readonly projectName: string;
  readonly branch: string;
  /** The server's score for a message match (lower is better); null without one. */
  readonly messageScore: number | null;
  readonly value: T;
}

/** A command, a setting or a project, matched by word starts as Settings search does. */
export interface PlaceSearchEntry<T> {
  readonly fields: SearchFields;
  /** Breaks ties after tier and score: lower first (catalog or page order). */
  readonly order: number;
  /** How often this device used it; commands only. Higher first. */
  readonly usage?: number;
  readonly value: T;
}

export interface PaletteSearchRow<T> {
  readonly value: T;
  readonly tier: MatchTier;
}

export interface PaletteSearchSection<T> {
  readonly source: PaletteSource;
  readonly rows: ReadonlyArray<PaletteSearchRow<T>>;
}

export interface PaletteSearchResult<T> {
  readonly sections: ReadonlyArray<PaletteSearchSection<T>>;
  /** Commands and settings whose titles hold the query's letters in order; only when nothing matched. */
  readonly closeMatches: ReadonlyArray<T>;
}

/** "commands": the `>` filter. */
export type PaletteSearchFilter = "all" | "commands";

interface Scored<T> {
  readonly row: PaletteSearchRow<T>;
  /** Higher is better within a source. */
  readonly score: number;
  readonly usage: number;
  readonly order: number;
}

function sortSection<T>(rows: Scored<T>[]): ReadonlyArray<PaletteSearchRow<T>> {
  return rows
    .toSorted(
      (left, right) =>
        left.row.tier - right.row.tier ||
        right.score - left.score ||
        right.usage - left.usage ||
        left.order - right.order,
    )
    .map((scored) => scored.row);
}

function searchThreads<T>(
  entries: ReadonlyArray<ThreadSearchEntry<T>>,
  text: string,
  words: ReadonlyArray<string>,
): Scored<T>[] {
  const query = parseThreadQuery(text);
  if (query.clauses.length === 0) return [];
  const scored: Scored<T>[] = [];
  entries.forEach((entry, order) => {
    const terms = [entry.title, entry.projectName, entry.branch];
    const clientRank = rankSearchTerms(terms, null, query);
    const rank = rankSearchTerms(terms, entry.messageScore, query);
    if (rank === Number.NEGATIVE_INFINITY) return;
    const tier = matchTier(words, {
      title: entry.title,
      second: [entry.projectName, entry.branch],
      messageOnly: clientRank === Number.NEGATIVE_INFINITY,
    });
    // `searchRanking` scores lower-is-better inside the rank, which is already
    // turned so higher is better here.
    scored.push({ row: { value: entry.value, tier }, score: rank, usage: 0, order });
  });
  return scored;
}

function searchPlaces<T>(entries: ReadonlyArray<PlaceSearchEntry<T>>, text: string): Scored<T>[] {
  const query = parsePlaceQuery(text);
  if (query.words.length === 0) return [];
  const words = tierQueryWords(text);
  const scored: Scored<T>[] = [];
  for (const entry of entries) {
    const match = matchSearchFields(query, entry.fields);
    if (match === null) continue;
    const tier = matchTier(words, {
      title: entry.fields.title,
      second: entry.fields.keywords ?? [],
    });
    scored.push({
      row: { value: entry.value, tier },
      score: match.score,
      usage: entry.usage ?? 0,
      order: entry.order,
    });
  }
  return scored;
}

/** Letters (not digits) the query needs before close matches are offered. */
const CLOSE_MATCH_MIN_LETTERS = 3;

function closeMatches<T>(
  entries: ReadonlyArray<PlaceSearchEntry<T>>,
  text: string,
): ReadonlyArray<T> {
  if ((text.match(/\p{L}/gu) ?? []).length < CLOSE_MATCH_MIN_LETTERS) return [];
  const letters = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const found: { value: T; score: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    const title = entry.fields.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const score = scoreSubsequenceMatch(title, letters);
    if (score !== null) found.push({ value: entry.value, score, order });
  });
  return found
    .toSorted((left, right) => left.score - right.score || left.order - right.order)
    .map((entry) => entry.value);
}

/**
 * Searches every source for `query` and orders what it finds: rows in a
 * section by tier, then the source's own score, then (commands) use on this
 * device; sections by their best row's tier, ties going Threads, Commands,
 * Settings, Projects. When nothing matches at all, command and setting titles
 * with the query's letters in order come back as close matches.
 */
export function paletteSearch<TThread, TCommand, TSetting, TProject>(input: {
  readonly query: string;
  readonly filter: PaletteSearchFilter;
  readonly threads: ReadonlyArray<ThreadSearchEntry<TThread>>;
  readonly commands: ReadonlyArray<PlaceSearchEntry<TCommand>>;
  readonly settings: ReadonlyArray<PlaceSearchEntry<TSetting>>;
  readonly projects: ReadonlyArray<PlaceSearchEntry<TProject>>;
}): PaletteSearchResult<TThread | TCommand | TSetting | TProject> {
  type Value = TThread | TCommand | TSetting | TProject;
  const text = input.query.trim();
  const words = tierQueryWords(text);
  const commandsOnly = input.filter === "commands";
  const bySource: Array<{ source: PaletteSource; rows: ReadonlyArray<PaletteSearchRow<Value>> }> = [
    {
      source: "threads",
      rows: commandsOnly ? [] : sortSection<Value>(searchThreads(input.threads, text, words)),
    },
    { source: "commands", rows: sortSection<Value>(searchPlaces(input.commands, text)) },
    {
      source: "settings",
      rows: commandsOnly ? [] : sortSection<Value>(searchPlaces(input.settings, text)),
    },
    {
      source: "projects",
      rows: commandsOnly ? [] : sortSection<Value>(searchPlaces(input.projects, text)),
    },
  ];
  const sections = bySource
    .filter((section) => section.rows.length > 0)
    .toSorted(
      (left, right) =>
        left.rows[0]!.tier - right.rows[0]!.tier ||
        SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source),
    );
  return {
    sections,
    closeMatches:
      sections.length > 0
        ? []
        : closeMatches<Value>(
            commandsOnly ? input.commands : [...input.commands, ...input.settings],
            text,
          ),
  };
}

/** How one computer's message search went (see threadSearchReactQuery). */
export interface MessageSearchOutcome {
  readonly computerName: string;
  readonly outcome: "answered" | "failed" | "stoppedEarly";
}

export interface PaletteSearchStatus {
  /** "Searching messages" at the foot of the list. */
  readonly searching: boolean;
  /** Only once the search for the text in the field has answered and found nothing. */
  readonly noMatches: boolean;
  /** One per computer that couldn't be searched or stopped early. */
  readonly lines: ReadonlyArray<string>;
}

/**
 * What the palette says about its search. Messages are searched once the
 * text in the field is long enough; until the answer for that text arrives
 * (the wait before asking included) the list says it is still searching and
 * never "No matches". An answer to an earlier text doesn't count.
 */
export function paletteSearchStatus(input: {
  /** The text in the field can search messages (three letters in a word). */
  readonly searchesMessages: boolean;
  /** The answer in hand is for the text now in the field. */
  readonly answeredCurrentText: boolean;
  /** Each computer's outcome, for that answer. */
  readonly outcomes: ReadonlyArray<MessageSearchOutcome>;
  /** Rows the list shows, close matches included. */
  readonly rowCount: number;
}): PaletteSearchStatus {
  const searching = input.searchesMessages && !input.answeredCurrentText;
  const outcomes = input.searchesMessages && input.answeredCurrentText ? input.outcomes : [];
  return {
    searching,
    noMatches: !searching && input.rowCount === 0,
    lines: outcomes.flatMap((entry) =>
      entry.outcome === "failed"
        ? [`Couldn't search ${entry.computerName}`]
        : entry.outcome === "stoppedEarly"
          ? [`The search on ${entry.computerName} may be incomplete. Add a word to narrow it.`]
          : [],
    ),
  };
}

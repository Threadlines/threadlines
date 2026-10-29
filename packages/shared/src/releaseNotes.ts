/**
 * Release notes as the app's "What's new" shows them, shared by the three
 * places that handle them:
 *
 * - `scripts/generate-release-notes.ts` writes a hidden block into every
 *   GitHub release body: the release's title (stable) and its merged changes,
 *   sorted while their conventional-commit titles still say what they are.
 * - The web build bundles the reviewed stable notes
 *   (`apps/marketing/src/content/changelog/v<version>.md`) as
 *   `ReleaseNotesEntry` values.
 * - The web app reads GitHub releases it doesn't have yet (the update the
 *   rail button offers, the nightlies since the build you had) and takes
 *   their block, or for a body written before the block existed, its
 *   "What's Changed" bullets.
 *
 * @module releaseNotes
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { compareSemverVersions } from "./semver.ts";

/** Where the marketing site serves a release's video and poster from. */
export const RELEASE_NOTES_SITE_URL = "https://www.threadlines.dev";
/** The GitHub repository whose releases carry the notes. */
export const RELEASE_NOTES_REPOSITORY = "Threadlines/threadlines";

/** One reviewed stable release, from its changelog file's frontmatter. */
export const ReleaseNotesEntry = Schema.Struct({
  version: Schema.String,
  /** The release day, "2026-10-28". */
  date: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  githubRelease: Schema.String,
  highlights: Schema.Array(Schema.Struct({ title: Schema.String, description: Schema.String })),
  alsoImproved: Schema.Array(Schema.Struct({ description: Schema.String })),
  /** Paths on the marketing site (`RELEASE_NOTES_SITE_URL`). */
  video: Schema.optionalKey(
    Schema.Struct({ src: Schema.String, poster: Schema.String, caption: Schema.String }),
  ),
});
export type ReleaseNotesEntry = typeof ReleaseNotesEntry.Type;

export const ReleaseChangeKind = Schema.Literals(["new", "fixed", "faster", "security", "changed"]);
export type ReleaseChangeKind = typeof ReleaseChangeKind.Type;

/** One merged change, worded for people who use the app. */
export const ReleaseChange = Schema.Struct({
  kind: ReleaseChangeKind,
  text: Schema.String,
  pullRequest: Schema.optionalKey(Schema.Number),
});
export type ReleaseChange = typeof ReleaseChange.Type;

/**
 * One merged change as its pull request or commit was titled ("fix(web): a
 * thing works"). The app sorts these itself, so a change to the rules reaches
 * releases already published.
 */
export const RawReleaseChange = Schema.Struct({
  title: Schema.String,
  pullRequest: Schema.optionalKey(Schema.Number),
});
export type RawReleaseChange = typeof RawReleaseChange.Type;

/** What a release body's hidden block carries. */
export const ReleaseBodyNotes = Schema.Struct({
  v: Schema.Literal(2),
  /** A stable release's title, the one its changelog page leads with. */
  title: Schema.optionalKey(Schema.String),
  changes: Schema.Array(RawReleaseChange),
});
export type ReleaseBodyNotes = typeof ReleaseBodyNotes.Type;

/**
 * The first block, written by the first nightlies with "What's new": its
 * changes were already sorted, by rules that have changed since, so only its
 * title is read and the changes come from the body's bullets.
 */
const ReleaseBodyNotesV1 = Schema.Struct({
  v: Schema.Literal(1),
  title: Schema.optionalKey(Schema.String),
  changes: Schema.Array(Schema.Unknown),
});

const KIND_BY_TYPE: Readonly<Record<string, ReleaseChangeKind>> = {
  feat: "new",
  feature: "new",
  fix: "fixed",
  perf: "faster",
  performance: "faster",
};
const INTERNAL_TYPES = new Set([
  "docs",
  "doc",
  "test",
  "tests",
  "refactor",
  "chore",
  "build",
  "ci",
  "style",
  "revert",
]);
/**
 * Words that make any change of the app a security fix. Each alternative is a
 * fixed word or phrase, at most followed by more letters of it, so the
 * pattern can't backtrack.
 */
const SECURITY_WORDS =
  /\b(?:security|vulnerab\w*|cve-\d{4}-\d+|ghsa(?:-\w{4}){3}|xss|csrf|ssrf|redos|denial of service|sandbox escape|(?:path|directory) traversal|(?:command|code|shell|sql|prompt) injection)\b/i;
/**
 * Words that make a dependency update a security fix. Alone they also name
 * ordinary work ("bypass xterm for shortcuts"), so they only count when the
 * change is a dependency update, which otherwise stays out.
 */
const DEPENDENCY_SECURITY_WORDS =
  /\b(?:advisor(?:y|ies)|bypass\w*|exploit\w*|traversal|injection|spoof\w*|impersonat\w*)\b/i;
/** Scopes that never reach the app itself: the website, the release pipeline, analytics. */
const INTERNAL_SCOPES = new Set([
  "telemetry",
  "marketing",
  "release",
  "ci",
  "deps",
  "docs",
  "test",
  "tests",
  "readme",
]);
// Run on text whose whitespace is already collapsed to single spaces, and
// written so no two parts can match the same characters: titles and bodies
// come from GitHub, and a pattern that backtracks would let a long run of
// spaces stall the app.
const CONVENTIONAL_TITLE = /^([a-z][a-z0-9-]*)(?:\(([^)]*)\))?(!)?: (\S.*)$/i;

/** Every run of whitespace as one space, trimmed. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sentenceCase(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? `${trimmed[0]!.toUpperCase()}${trimmed.slice(1)}` : trimmed;
}

/**
 * A merged pull request's or commit's title as a change in the list, or null
 * when people using the app wouldn't notice it: docs, tests, refactors, the
 * website, the release pipeline, dependency updates. "fix(web): a thing
 * works" becomes { kind: "fixed", text: "A thing works" }. A security fix of
 * the app shows as "security", and so does a dependency update that fixes
 * one; one in the release pipeline or the website stays out with the rest. A
 * title with no type can't be sorted, so it stays, as "changed".
 */
export function classifyReleaseChange(
  title: string,
): { readonly kind: ReleaseChangeKind; readonly text: string } | null {
  const cleaned = collapseWhitespace(title)
    .replace(/ ?\(#\d+\)$/, "")
    .trimEnd();
  if (cleaned.length === 0) return null;
  const securityFix = (text: string, dependency: boolean) =>
    SECURITY_WORDS.test(text) || (dependency && DEPENDENCY_SECURITY_WORDS.test(text));
  const match = CONVENTIONAL_TITLE.exec(cleaned);
  if (!match) {
    const bump = /^bump\b/i.test(cleaned);
    if (securityFix(cleaned, bump)) return { kind: "security", text: sentenceCase(cleaned) };
    if (bump || /^(?:merge|revert|release)\b/i.test(cleaned)) return null;
    return { kind: "changed", text: sentenceCase(cleaned) };
  }
  const type = match[1]!.toLowerCase();
  const text = sentenceCase(match[4]!);
  const scopes = (match[2] ?? "")
    .split(",")
    .map((scope) => scope.trim().toLowerCase())
    .filter((scope) => scope.length > 0);
  if (scopes.includes("deps")) {
    return securityFix(text, true) ? { kind: "security", text } : null;
  }
  if (INTERNAL_TYPES.has(type)) return null;
  if (scopes.length > 0 && scopes.every((scope) => INTERNAL_SCOPES.has(scope))) return null;
  if (securityFix(text, false)) return { kind: "security", text };
  return { kind: KIND_BY_TYPE[type] ?? "changed", text };
}

const BLOCK_OPEN = "<!-- threadlines-release-notes ";
const BLOCK_CLOSE = " -->";
const encodeBlockJson = Schema.encodeSync(Schema.fromJsonString(ReleaseBodyNotes));
const decodeBlockJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([ReleaseBodyNotes, ReleaseBodyNotesV1])),
);

/**
 * The hidden block for a release body: an HTML comment GitHub doesn't show.
 * A "--" inside the JSON is escaped so no text can end the comment early.
 */
export function formatReleaseNotesBlock(notes: Omit<ReleaseBodyNotes, "v">): string {
  const json = encodeBlockJson({ v: 2, ...notes }).replaceAll("--", "-\\u002d");
  return `${BLOCK_OPEN}${json}${BLOCK_CLOSE}`;
}

/** The hidden block a release body carries, or null when it has none. */
export function parseReleaseNotesBlock(
  body: string,
): ReleaseBodyNotes | typeof ReleaseBodyNotesV1.Type | null {
  const start = body.lastIndexOf(BLOCK_OPEN);
  if (start === -1) return null;
  const end = body.indexOf(BLOCK_CLOSE, start + BLOCK_OPEN.length);
  if (end === -1) return null;
  return Option.getOrNull(decodeBlockJson(body.slice(start + BLOCK_OPEN.length, end)));
}

/**
 * The changes a release body lists, sorted by today's rules. The hidden block
 * carries each change's own title; a body without one (or with the first
 * block, whose changes came pre-sorted) is read from its "What's Changed"
 * bullets: GitHub's own ("- fix: a thing by [@who](…) in …/pull/12"), the
 * generator's fallback ("- A thing in [#12](…)", its type already gone) and
 * direct commits.
 */
export function readReleaseBodyChanges(body: string): ReadonlyArray<ReleaseChange> {
  const block = parseReleaseNotesBlock(body);
  if (block?.v === 2) {
    return block.changes.flatMap((raw) => {
      const change = classifyReleaseChange(raw.title);
      if (!change) return [];
      return raw.pullRequest === undefined
        ? [change]
        : [{ ...change, pullRequest: raw.pullRequest }];
    });
  }

  const lines = body.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((line) => /^## What's Changed$/i.test(collapseWhitespace(line)));
  if (start === -1) return [];
  const changes: Array<ReleaseChange> = [];
  for (const raw of lines.slice(start + 1)) {
    const line = collapseWhitespace(raw);
    if (/^\*\*Full Changelog\*\*/i.test(line) || /^## New Contributors/i.test(line)) break;
    if (/^<\/details>/i.test(line)) break;
    if (!/^[-*] /.test(line)) continue;
    let title = line.slice(2);
    const pullRequest = /\/pull\/(\d+)\)?$/.exec(title)?.[1];
    title = title
      // GitHub's "by @who in url" (or a linked @who).
      .replace(/ by (?:\[@[^\]]+\]\([^)]*\)|@\S+) in \S+$/i, "")
      // The generator's own "in [#12](url)".
      .replace(/ in \[#\d+\]\([^)]*\)$/i, "")
      // A direct commit's leading "[`abc1234`](url)".
      .replace(/^\[`[0-9a-f]+`\]\([^)]*\) /i, "");
    const change = classifyReleaseChange(title);
    if (!change) continue;
    changes.push(
      pullRequest === undefined ? change : { ...change, pullRequest: Number(pullRequest) },
    );
  }
  return changes;
}

/** "0.8.0-nightly.20261028.354": the stable version it leads to, its day, and its build. */
export interface NightlyVersion {
  readonly triple: string;
  readonly day: string;
  readonly build: number;
}

const NIGHTLY_VERSION = /^v?(\d+\.\d+\.\d+)-nightly\.(\d{8})\.(\d+)$/;

export function parseNightlyVersion(version: string): NightlyVersion | null {
  const match = NIGHTLY_VERSION.exec(version.trim());
  if (!match) return null;
  return { triple: match[1]!, day: match[2]!, build: Number(match[3]) };
}

/**
 * Which app versions ran on one device: the desktop keeps it in its state
 * folder, a browser in localStorage. "What's new" lists the nightlies after
 * `previous`, and announces a version once, on the first launch newer than
 * `newest`.
 */
export const VersionHistoryRecord = Schema.Struct({
  /** The version that ran last. */
  current: Schema.String,
  /** The one before it. */
  previous: Schema.NullOr(Schema.String),
  /** The newest version that ever ran, so going back and forward never announces one twice. */
  newest: Schema.String,
});
export type VersionHistoryRecord = typeof VersionHistoryRecord.Type;

/**
 * This launch against the kept record. Without one, `hasEarlierData` decides:
 * a device that already used Threadlines was updated from a build that kept
 * no record, so this launch counts as newer; one that didn't is a fresh
 * install, and nothing is announced.
 */
export function advanceVersionHistory(input: {
  readonly record: VersionHistoryRecord | null;
  readonly appVersion: string;
  readonly hasEarlierData: boolean;
}): {
  readonly record: VersionHistoryRecord;
  readonly previousVersion: string | null;
  readonly newerThanAnyBefore: boolean;
} {
  const { record, appVersion } = input;
  if (record === null) {
    return {
      record: { current: appVersion, previous: null, newest: appVersion },
      previousVersion: null,
      newerThanAnyBefore: input.hasEarlierData,
    };
  }
  if (record.current === appVersion) {
    return { record, previousVersion: record.previous, newerThanAnyBefore: false };
  }
  const newerThanAnyBefore = compareSemverVersions(appVersion, record.newest) > 0;
  return {
    record: {
      current: appVersion,
      previous: record.current,
      newest: newerThanAnyBefore ? appVersion : record.newest,
    },
    previousVersion: record.current,
    newerThanAnyBefore,
  };
}

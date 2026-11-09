/**
 * The Showcase (docs/design/custom-themes.md, "Showcase"): themes people
 * shared, in the public Threadlines/themes repository, which the app lists,
 * lets you try, and lets you share to from your own GitHub account as a pull
 * request.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  THEME_LICENSES,
  ThemeBase,
  ThemeColor,
  ThemeContentHash,
  ThemeCredits,
  ThemeEntryId,
  ThemeManifest,
} from "./themes.ts";

/** The Showcase's list format; a breaking change gets a new one, which older apps then say they can't read. */
export const THEME_SHOWCASE_FORMAT = "threadlines-showcase@1";

/** A theme's own licenses the Showcase lists: CC BY 4.0 or CC0 (the starters' MIT stays theirs). */
export const THEME_SHOWCASE_LICENSES = THEME_LICENSES.filter((license) => license !== "MIT");

/** A theme's folder in the repository: lowercase letters, digits and hyphens, at most 40. */
export const ThemeShowcaseSlug = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/),
);
export type ThemeShowcaseSlug = typeof ThemeShowcaseSlug.Type;

/** A GitHub login, as GitHub allows them. */
export const GitHubLogin = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),
);

const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

/** A file the list points to: where it is in the repository, and the digest of its exact bytes. */
export const ThemeShowcaseAsset = Schema.Struct({
  path: Schema.String.check(
    Schema.isPattern(
      /^themes\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\/(?:theme\.threadlines-theme|thumbnail\.png)$/,
    ),
  ),
  sha256: Sha256,
  bytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 * 1024 * 1024 })),
});
export type ThemeShowcaseAsset = typeof ThemeShowcaseAsset.Type;

/** One theme in the list: enough to draw its tile without fetching the theme. */
export const ThemeShowcaseEntry = Schema.Struct({
  id: ThemeShowcaseSlug,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  base: ThemeBase,
  hasArt: Schema.Boolean,
  colors: Schema.Struct({ background: ThemeColor, foreground: ThemeColor, accent: ThemeColor }),
  credits: Schema.optional(ThemeCredits),
  /** Who opened the pull request that added it, when someone did. */
  sharedBy: Schema.NullOr(GitHubLogin),
  featured: Schema.Boolean,
  /** The day it was added, YYYY-MM-DD. */
  addedAt: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  /** Its content hash, as a library names it. */
  hash: ThemeContentHash,
  file: ThemeShowcaseAsset,
  thumbnail: ThemeShowcaseAsset,
});
export type ThemeShowcaseEntry = typeof ThemeShowcaseEntry.Type;

/** `index.json` in the repository, which its workflow rebuilds on every merge. */
export const ThemeShowcaseIndex = Schema.Struct({
  format: Schema.Literal(THEME_SHOWCASE_FORMAT),
  themes: Schema.Array(ThemeShowcaseEntry).check(Schema.isMaxLength(2000)),
});
export type ThemeShowcaseIndex = typeof ThemeShowcaseIndex.Type;

/** What the app shows: the list as last fetched, and whether that fetch is old. */
export const ThemeShowcaseListing = Schema.Struct({
  themes: Schema.Array(ThemeShowcaseEntry),
  /** When the list was fetched; null when it never was. */
  fetchedAt: Schema.NullOr(Schema.String),
  /**
   * Why this is an older list, or none: the last fetch failed (`unreachable`),
   * or the list is in a format only a newer Threadlines reads (`updateNeeded`).
   */
  issue: Schema.NullOr(Schema.Literals(["unreachable", "updateNeeded"])),
});
export type ThemeShowcaseListing = typeof ThemeShowcaseListing.Type;

export const ThemeShowcaseListInput = Schema.Struct({
  /** Fetch again even if the list is fresh (Try again). */
  refresh: Schema.optional(Schema.Boolean),
});
export type ThemeShowcaseListInput = typeof ThemeShowcaseListInput.Type;

export const ThemeShowcaseIdInput = Schema.Struct({ id: ThemeShowcaseSlug });
export type ThemeShowcaseIdInput = typeof ThemeShowcaseIdInput.Type;

export const ThemeShowcasePicture = Schema.Struct({
  /** A PNG data URL, checked against the list's digest. */
  dataUrl: Schema.String,
});
export type ThemeShowcasePicture = typeof ThemeShowcasePicture.Type;

/** A theme from the Showcase, checked and matched to its list entry, for a trial. */
export const ThemeShowcaseTheme = Schema.Struct({
  id: ThemeShowcaseSlug,
  hash: ThemeContentHash,
  manifest: ThemeManifest,
});
export type ThemeShowcaseTheme = typeof ThemeShowcaseTheme.Type;

/** What sharing a theme would publish, worked out before anything is posted. */
export const ThemeShowcaseShareInput = Schema.Struct({
  entryId: ThemeEntryId,
  credits: Schema.NullOr(ThemeCredits),
  includePrompt: Schema.Boolean,
});
export type ThemeShowcaseShareInput = typeof ThemeShowcaseShareInput.Type;

/** An embedded font, as the share dialog lists it: its copyright notice and license, as the font file says. */
export const ThemeShowcaseFont = Schema.Struct({
  slot: Schema.Literals(["ui", "mono"]),
  family: Schema.String,
  copyright: Schema.NullOr(Schema.String),
  license: Schema.NullOr(Schema.Literals(["OFL-1.1", "Apache-2.0"])),
});
export type ThemeShowcaseFont = typeof ThemeShowcaseFont.Type;

export const ThemeShowcasePreparation = Schema.Struct({
  /** The file as it would be published, exactly. */
  manifest: ThemeManifest,
  /** The picture that goes with it (PNG data URL); null when it couldn't be made. */
  thumbnail: Schema.NullOr(Schema.String),
  fonts: Schema.Array(ThemeShowcaseFont),
  /** Why it can't be shared as it is; empty when it can. */
  problems: Schema.Array(Schema.String),
});
export type ThemeShowcasePreparation = typeof ThemeShowcasePreparation.Type;

/** A share's id, minted by the app; sending it again resumes the same share instead of starting another. */
export const ThemeShowcaseSubmissionId = Schema.String.check(Schema.isPattern(/^[a-z0-9]{12,32}$/));
export type ThemeShowcaseSubmissionId = typeof ThemeShowcaseSubmissionId.Type;

export const ThemeShowcaseSubmitInput = Schema.Struct({
  ...ThemeShowcaseShareInput.fields,
  submissionId: ThemeShowcaseSubmissionId,
  /** The account the person saw; the server refuses to post as anyone else. */
  login: GitHubLogin,
});
export type ThemeShowcaseSubmitInput = typeof ThemeShowcaseSubmitInput.Type;

/** Where a shared theme stands: its pull request open, merged (in the Showcase), or closed without it. */
export const ThemeShowcaseSubmissionState = Schema.Literals(["inReview", "listed", "notAdded"]);
export type ThemeShowcaseSubmissionState = typeof ThemeShowcaseSubmissionState.Type;

/** A share this computer made, and how it stands. */
export const ThemeShowcaseSubmission = Schema.Struct({
  submissionId: ThemeShowcaseSubmissionId,
  entryId: ThemeEntryId,
  /** The library theme it came from, and the file it published (credits and still added). */
  sourceHash: ThemeContentHash,
  publishedHash: ThemeContentHash,
  login: GitHubLogin,
  pullRequestUrl: Schema.String,
  state: ThemeShowcaseSubmissionState,
  createdAt: Schema.String,
});
export type ThemeShowcaseSubmission = typeof ThemeShowcaseSubmission.Type;

export const ThemeShowcaseSubmissions = Schema.Struct({
  submissions: Schema.Array(ThemeShowcaseSubmission),
});
export type ThemeShowcaseSubmissions = typeof ThemeShowcaseSubmissions.Type;

export const ThemeShowcaseSubmissionsInput = Schema.Struct({});
export type ThemeShowcaseSubmissionsInput = typeof ThemeShowcaseSubmissionsInput.Type;

/**
 * A share that went wrong. `uncertain`: GitHub may have taken part of it;
 * sending the same share again picks up where it stopped.
 */
export class ThemeShowcaseError extends Schema.TaggedError<ThemeShowcaseError>()(
  "ThemeShowcaseError",
  {
    detail: TrimmedNonEmptyString,
    uncertain: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

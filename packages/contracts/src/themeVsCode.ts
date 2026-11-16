/**
 * VS Code themes (docs/design/custom-themes.md, "VS Code themes"): color
 * themes from extensions on the Open VSX store, which the server searches and
 * turns into Threadlines themes to try. Only extensions under an open license
 * are listed.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThemeBase, ThemeColor, ThemeManifest } from "./themes.ts";

/** How results are ordered: by fit to the words, by downloads, or by rating. */
export const ThemeVsCodeSort = Schema.Literals(["relevance", "downloads", "rating"]);
export type ThemeVsCodeSort = typeof ThemeVsCodeSort.Type;

export const ThemeVsCodeSearchInput = Schema.Struct({
  /** Words to look for; empty lists the most downloaded. */
  query: Schema.String.check(Schema.isMaxLength(100)),
  sort: ThemeVsCodeSort,
  /** Where the page starts, from the last page's `nextOffset`. */
  offset: Schema.optional(NonNegativeInt),
});
export type ThemeVsCodeSearchInput = typeof ThemeVsCodeSearchInput.Type;

/** A name on Open VSX: a publisher's, an extension's, or a version. */
export const ThemeVsCodeName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
);

/** An extension with color themes in it, as a search lists it. */
export const ThemeVsCodeExtension = Schema.Struct({
  namespace: ThemeVsCodeName,
  name: ThemeVsCodeName,
  version: ThemeVsCodeName,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  /** Who published it, as the store names them. */
  publisher: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  description: Schema.String.check(Schema.isMaxLength(400)),
  downloads: NonNegativeInt,
  /** SPDX, one of the open licenses themes may be brought in under. */
  license: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** How many color themes it holds. */
  themeCount: NonNegativeInt,
});
export type ThemeVsCodeExtension = typeof ThemeVsCodeExtension.Type;

export const ThemeVsCodeSearchResult = Schema.Struct({
  extensions: Schema.Array(ThemeVsCodeExtension),
  /** Where the next page starts; null when this is the last. */
  nextOffset: Schema.NullOr(NonNegativeInt),
  /** Some extensions couldn't be checked this time, so the page may be missing some. */
  incomplete: Schema.optional(Schema.Boolean),
});
export type ThemeVsCodeSearchResult = typeof ThemeVsCodeSearchResult.Type;

export const ThemeVsCodeReadInput = Schema.Struct({
  namespace: ThemeVsCodeName,
  name: ThemeVsCodeName,
  version: ThemeVsCodeName,
});
export type ThemeVsCodeReadInput = typeof ThemeVsCodeReadInput.Type;

/** One color theme from an extension, as a Threadlines theme. */
export const ThemeVsCodeTheme = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  /** Its file in the extension, which with its label tells it apart from the extension's others. */
  file: Schema.String.check(Schema.isMaxLength(1024)),
  base: ThemeBase,
  /** Enough to draw its tile before it's tried. */
  colors: Schema.Struct({ background: ThemeColor, foreground: ThemeColor, accent: ThemeColor }),
  manifest: ThemeManifest,
  /** How many of its colors were moved to stay readable. */
  adjusted: NonNegativeInt,
});
export type ThemeVsCodeTheme = typeof ThemeVsCodeTheme.Type;

/** An extension's color themes, the ones that could be brought in and why the rest couldn't. */
export const ThemeVsCodePackage = Schema.Struct({
  extension: ThemeVsCodeExtension,
  themes: Schema.Array(ThemeVsCodeTheme),
  skipped: Schema.Array(
    Schema.Struct({
      label: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
      reason: TrimmedNonEmptyString,
    }),
  ),
});
export type ThemeVsCodePackage = typeof ThemeVsCodePackage.Type;

/** The store couldn't be reached, or an extension couldn't be read. */
export class ThemeVsCodeError extends Schema.TaggedError<ThemeVsCodeError>()("ThemeVsCodeError", {
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}

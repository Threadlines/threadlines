/**
 * A theme as a file to share (docs/design/custom-themes.md, "Sharing"). An
 * exported file never says which thread made the theme, carries the prompt
 * only when its author keeps it, and keeps whatever credits it already has:
 * re-sharing someone else's theme passes their credit on. A theme without
 * credits takes the ones its author gives now.
 */
import type { ThemeCredits, ThemeLicense, ThemeManifest } from "@threadlines/contracts";

/** Each license as the export and import dialogs name it, with what it lets others do. */
export const THEME_LICENSE_WORDS: Readonly<
  Record<ThemeLicense, { readonly name: string; readonly lets: string }>
> = {
  "CC-BY-4.0": { name: "CC BY 4.0", lets: "Anyone can use and change it if they credit you." },
  "CC0-1.0": { name: "CC0", lets: "Anyone can use it for anything, no credit needed." },
  MIT: { name: "MIT", lets: "Anyone can use and change it, keeping its notice." },
};

/** Credits without blank parts; null when nothing is left. */
export function cleanThemeCredits(credits: ThemeCredits | null | undefined): ThemeCredits | null {
  if (credits === null || credits === undefined) return null;
  // A part a newer build added rides along as it came.
  const { author: rawAuthor, link: rawLink, license: _license, ...others } = credits;
  const author = rawAuthor?.trim();
  const link = rawLink?.trim();
  const clean: ThemeCredits = {
    ...others,
    ...(author ? { author } : {}),
    ...(link ? { link } : {}),
    ...(credits.license !== undefined ? { license: credits.license } : {}),
  };
  return Object.keys(clean).length > 0 ? clean : null;
}

/** "By Threadlines · MIT": a theme's credits in one line, or null when it has none. */
export function themeCreditsLine(credits: ThemeCredits | null | undefined): string | null {
  const clean = cleanThemeCredits(credits);
  if (clean === null) return null;
  const parts = [
    clean.author !== undefined ? `By ${clean.author}` : null,
    clean.license !== undefined ? THEME_LICENSE_WORDS[clean.license].name : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface ThemeShareOptions {
  /** The name the file goes by. */
  readonly name: string;
  readonly includePrompt: boolean;
  /** Used only when the theme has no credits of its own. */
  readonly credits: ThemeCredits | null;
}

/** The theme as its shared file holds it. */
export function themeForSharing(
  manifest: ThemeManifest,
  options: ThemeShareOptions,
): ThemeManifest {
  const { prompt, credits: own, createdBy: _createdBy, ...rest } = manifest;
  const credits = cleanThemeCredits(own) ?? cleanThemeCredits(options.credits);
  return {
    ...rest,
    name: options.name,
    ...(options.includePrompt && prompt !== undefined ? { prompt } : {}),
    ...(credits !== null ? { credits } : {}),
  };
}

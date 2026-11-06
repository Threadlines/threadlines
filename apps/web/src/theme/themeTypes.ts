/**
 * The theme store's types (docs/design/custom-themes.md, "Applying a theme").
 * `themeStore.ts` re-exports them; they live apart so the store's pure core
 * and its storage helpers can share them without an import cycle.
 */
import type { EnvironmentId, ThemeBase, ThemeManifest } from "@threadlines/contracts";
import type { ThemeTokens } from "@threadlines/shared/themeTokens";

/** A theme a device can show. */
export type ThemeChoice =
  | { readonly kind: "builtin"; readonly id: "system" | "light" | "dark" }
  | { readonly kind: "starter"; readonly id: string }
  | {
      readonly kind: "library";
      readonly entryId: string;
      readonly hash: string;
      readonly name: string;
      /** The computer the entry was picked from; content is read from there until cached. */
      readonly environmentId: EnvironmentId | null;
    }
  | {
      /** Not in any library yet: an agent's offer or an imported file, during its trial. */
      readonly kind: "unsaved";
      readonly hash: string;
      readonly name: string;
    };

/** What the window shows now: the trial when there is one, else the committed choice. */
export interface ActiveTheme {
  readonly choice: ThemeChoice;
  /** Null for the built-ins (and while a custom theme's content is still loading). */
  readonly manifest: ThemeManifest | null;
  /** Null for the built-ins (index.css applies). */
  readonly tokens: ThemeTokens | null;
  readonly base: ThemeBase;
  readonly hash: string | null;
  readonly name: string;
}

export interface ThemeTrial {
  /** Unique per trial, so a countdown only ever ends its own trial. */
  readonly id: string;
  readonly choice: ThemeChoice;
  readonly name: string;
  /** Epoch ms when the trial ends by itself; null while held (the /theme picker shows it). */
  readonly expiresAt: number | null;
  /** The theme to save to the library on Keep (offers and imports); null for a built-in trial. */
  readonly manifest: ThemeManifest | null;
}

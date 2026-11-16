/**
 * The theme store's types (docs/design/custom-themes.md, "Applying a theme").
 * `themeStore.ts` re-exports them; they live apart so the store's pure core
 * and its storage helpers can share them without an import cycle.
 */
import type { EnvironmentId, ThemeBase, ThemeManifest } from "@threadlines/contracts";
import type { ThemeTokens } from "@threadlines/shared/themeTokens";

type StarterChoice = { readonly kind: "starter"; readonly id: string };

type LibraryChoice = {
  readonly kind: "library";
  readonly entryId: string;
  readonly hash: string;
  readonly name: string;
  /** The computer the entry was picked from; content is read from there until cached. */
  readonly environmentId: EnvironmentId | null;
};

/**
 * One side of System's pair: the built-in of that side's own mode (Light on
 * the light side, Dark on the dark side), a starter, or a library theme.
 */
export type ThemePairSide =
  | { readonly kind: "builtin"; readonly id: ThemeBase }
  | StarterChoice
  | LibraryChoice;

/** A theme a device can show. */
export type ThemeChoice =
  | { readonly kind: "builtin"; readonly id: "system" | "light" | "dark" }
  | StarterChoice
  | LibraryChoice
  | {
      /**
       * System with a theme of the user's for each mode: `light` while the
       * computer is light, `dark` while it is dark. Stored as System with
       * its two sides, which an older build reads as plain System.
       */
      readonly kind: "pair";
      readonly light: ThemePairSide;
      readonly dark: ThemePairSide;
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
  /** The theme to save to the library on Keep (offers and imports); null for a built-in trial or a pair's. */
  readonly manifest: ThemeManifest | null;
  /** A pair's trial: each custom side's content (null for a built-in side, or one not read). */
  readonly sides?: { readonly [Mode in ThemeBase]: ThemeManifest | null };
}

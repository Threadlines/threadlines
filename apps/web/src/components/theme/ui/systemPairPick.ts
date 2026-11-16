/**
 * Setting one side of System's pair, from the System themes row and from a
 * theme's options in the gallery ("Use when my computer is light"). A pick
 * switches the device to System with the new pair once both themes are
 * read; only the newest pick (or a reset) lands, and a second pick made
 * while the first loads builds on it.
 */
import type { ThemeBase } from "@threadlines/contracts";

import { systemThemeChoice } from "~/theme/themeChoice";
import {
  chooseTheme,
  readThemeState,
  rememberSystemPair,
  type ThemeChoice,
  type ThemePairSide,
} from "~/theme/themeStore";
import { loadPairManifests } from "~/themeLibrary/themeCatalog";
import { failureNotice, toastManager } from "../../ui/toast";

export const BUILTIN_SIDE = {
  light: { kind: "builtin", id: "light" },
  dark: { kind: "builtin", id: "dark" },
} as const satisfies Record<ThemeBase, ThemePairSide>;

let pending: { readonly id: number; readonly next: ThemeChoice } | null = null;
let picks = 0;

/** The pair System uses on this device: remembered, or the one showing; null for plain System. */
export function currentSystemPair(): Extract<ThemeChoice, { kind: "pair" }> | null {
  const { systemPair, committed } = readThemeState();
  return systemPair ?? (committed.kind === "pair" ? committed : null);
}

/** Both sides of a pair, or the built-ins for plain System. */
export function systemSides(choice: ThemeChoice | null): Record<ThemeBase, ThemePairSide> {
  return {
    light: choice?.kind === "pair" ? choice.light : BUILTIN_SIDE.light,
    dark: choice?.kind === "pair" ? choice.dark : BUILTIN_SIDE.dark,
  };
}

/** Sets System's theme for one mode and switches the device to System. */
export function pickSystemSide(mode: ThemeBase, side: ThemePairSide): void {
  const before = systemSides(pending?.next ?? currentSystemPair());
  const next =
    mode === "light" ? systemThemeChoice(side, before.dark) : systemThemeChoice(before.light, side);
  picks += 1;
  const id = picks;
  if (next.kind !== "pair") {
    // Both sides back to the built-ins: plain System.
    pending = null;
    rememberSystemPair(null);
    chooseTheme(next);
    return;
  }
  pending = { id, next };
  void loadPairManifests(next)
    .then((sides) => {
      if (pending?.id !== id) return;
      pending = null;
      chooseTheme(next, undefined, sides);
    })
    .catch((error: unknown) => {
      if (pending?.id === id) pending = null;
      toastManager.add(
        failureNotice({
          title: "Couldn't switch to System",
          reason: error instanceof Error ? error.message : "Try again.",
        }),
      );
    });
}

/** Forgets the pair (plain Light and Dark again), dropping any pick still loading. */
export function resetSystemPair(): void {
  picks += 1;
  pending = null;
  rememberSystemPair(null);
  if (readThemeState().committed.kind === "pair") chooseTheme({ kind: "builtin", id: "system" });
}

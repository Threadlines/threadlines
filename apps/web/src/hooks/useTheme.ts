/**
 * The light-or-dark view of the theme, for the many components that only
 * need to know which way the app leans (code and diff colors, the browser's
 * pick cursor, chart contrast). The theme itself lives in the theme store
 * (theme/themeStore.ts): built-in System, Light, Dark, a starter, or a
 * library theme. `resolvedTheme` is the active theme's base.
 */
import { useCallback } from "react";

import { THEME_STORAGE_KEY } from "../theme/themeChoice";
import {
  adoptStoredThemeChoice,
  chooseTheme,
  readThemeState,
  syncBrowserChromeColor,
  type ThemeChoice,
  useActiveTheme,
  useThemeChoice,
} from "../theme/themeStore";

export type Theme = "light" | "dark" | "system";

/**
 * The built-in a choice reads as: itself for the built-ins, and a custom
 * theme's base for the rest, since that is the light-or-dark it shows.
 */
function themeOfChoice(choice: ThemeChoice, base: "light" | "dark"): Theme {
  return choice.kind === "builtin" ? choice.id : base;
}

export function syncBrowserChromeTheme(): void {
  syncBrowserChromeColor();
}

/** This device's theme, as the Theme row shows it (a custom theme reads as its base). */
export function readThemePreference(): Theme {
  adoptStoredThemeChoice();
  const state = readThemeState();
  return themeOfChoice(state.committed, state.committedBase ?? state.active.base);
}

/**
 * Sets this device's theme to a built-in, as the Theme row does. Throws when
 * the browser won't keep it (no storage, or storage refused the write), so a
 * caller that reports whether a change landed can say so.
 */
export function setThemePreference(next: Theme): void {
  if (typeof localStorage === "undefined") {
    throw new Error("This browser can't keep a theme.");
  }
  chooseTheme({ kind: "builtin", id: next });
  let kept = false;
  try {
    kept = localStorage.getItem(THEME_STORAGE_KEY) === next;
  } catch {
    kept = false;
  }
  if (!kept) throw new Error("This browser can't keep a theme.");
}

export function useTheme() {
  const choice = useThemeChoice();
  const active = useActiveTheme();
  const resolvedTheme: "light" | "dark" = active.base;
  const theme = themeOfChoice(choice, resolvedTheme);

  const setTheme = useCallback((next: Theme) => {
    if (typeof localStorage === "undefined") return;
    setThemePreference(next);
  }, []);

  return { theme, setTheme, resolvedTheme, choice, active } as const;
}

/**
 * Shared xterm surface setup.
 *
 * The thread terminal drawer and the provider sign-in panel both render a
 * real interactive terminal; this module owns the pieces that must look and
 * behave the same in both (theme derived from the app's own colors and the
 * active theme's terminal palette, font stack, fit addon wiring, following
 * theme changes) so neither surface re-invents them.
 *
 * @module components/terminal/xtermSurface
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";

import { themeFontStack } from "../../theme/themeFonts";
import {
  readActiveTheme,
  subscribeTheme,
  subscribeThemeFontsLoaded,
  type ActiveTheme,
} from "../../theme/themeStore";

export const TERMINAL_FONT_FAMILY =
  '"Cascadia Mono Variable", "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

/** The terminal's font stack: the active theme's mono font first, when it has one. */
export function terminalFontFamily(theme: ActiveTheme = readActiveTheme()): string {
  return theme.manifest?.fonts?.mono
    ? themeFontStack(theme.manifest.fonts, "mono", theme.hash)
    : TERMINAL_FONT_FAMILY;
}

const ANSI_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** A custom theme's own terminal colors over the built-in ones for its base. */
function withThemeTerminalColors(base: ITheme, theme: ActiveTheme): ITheme {
  const tokens = theme.tokens;
  if (!tokens) return base;
  const palette = theme.manifest?.terminal;
  const ansi = palette
    ? Object.fromEntries(ANSI_NAMES.map((name, index) => [name, palette[index]]))
    : {};
  return {
    ...base,
    ...ansi,
    cursor: tokens["primary-readable"],
    selectionBackground: tokens["text-selection"],
  };
}

/**
 * Keeps a terminal's colors and font in step with the theme: on every theme
 * change (a same-base switch included) and once a theme's font has loaded.
 * `onFontChange` refits, since the cell size moves with the font.
 */
export function followTerminalTheme(input: {
  readonly terminal: Terminal;
  readonly themeSource: () => HTMLElement | null;
  readonly onFontChange: () => void;
}): () => void {
  let applied = readActiveTheme();
  const applyFont = () => {
    const fontFamily = terminalFontFamily();
    if (input.terminal.options.fontFamily === fontFamily) return;
    input.terminal.options.fontFamily = fontFamily;
    input.onFontChange();
  };
  const stopTheme = subscribeTheme(() => {
    const active = readActiveTheme();
    if (active === applied) return;
    applied = active;
    input.terminal.options.theme = terminalThemeFromApp(input.themeSource());
    input.terminal.refresh(0, input.terminal.rows - 1);
    applyFont();
  });
  const stopFonts = subscribeThemeFontsLoaded(() => {
    // Same family name, new metrics: reassigning makes xterm measure again.
    input.terminal.options.fontFamily = `${terminalFontFamily()} `;
    input.terminal.options.fontFamily = terminalFontFamily();
    input.onFontChange();
  });
  return () => {
    stopTheme();
    stopFonts();
  };
}

function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

/**
 * The terminal's colors: background and text from the surface it sits on,
 * the built-in ANSI set for the app's base, and a custom theme's own
 * terminal palette, cursor and selection over those.
 */
export function terminalThemeFromApp(mountElement?: HTMLElement | null): ITheme {
  const active = readActiveTheme();
  const builtin = builtinTerminalTheme(mountElement);
  if (!active.tokens) return builtin;
  const inDrawer =
    (mountElement?.closest(".thread-terminal-drawer") ??
      document.querySelector(".thread-terminal-drawer")) !== null;
  return withThemeTerminalColors(
    {
      ...builtin,
      // Outside the drawer the terminal sits on whatever is there, which
      // under glass is see-through: the theme's opaque base instead.
      ...(inDrawer ? {} : { background: active.tokens["surface-solid"] }),
      foreground: active.tokens.foreground,
    },
    active,
  );
}

function builtinTerminalTheme(mountElement?: HTMLElement | null): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const fallbackBackground = isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)";
  const fallbackForeground = isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)";
  const drawerSurface =
    mountElement?.closest(".thread-terminal-drawer") ??
    document.querySelector(".thread-terminal-drawer") ??
    document.body;
  const drawerStyles = getComputedStyle(drawerSurface);
  const bodyStyles = getComputedStyle(document.body);
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  );
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  );

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

export interface XtermSurface {
  readonly terminal: Terminal;
  readonly fitAddon: FitAddon;
}

/**
 * Create an xterm instance themed from the app and mounted into `element`,
 * with its fit addon already attached and a first fit applied.
 */
export function createXtermSurface(input: {
  readonly mount: HTMLElement;
  /** Element the theme reads its background/foreground from. */
  readonly themeSource?: HTMLElement | null;
  readonly fontSize?: number;
  readonly scrollback?: number;
  readonly cursorBlink?: boolean;
  readonly screenReaderMode?: boolean;
  /** Needed by the search addon's match highlights (decorations). */
  readonly allowProposedApi?: boolean;
}): XtermSurface {
  const fitAddon = new FitAddon();
  const terminal = new Terminal({
    cursorBlink: input.cursorBlink ?? true,
    lineHeight: 1.2,
    fontSize: input.fontSize ?? 12,
    scrollback: input.scrollback ?? 5_000,
    fontFamily: terminalFontFamily(),
    theme: terminalThemeFromApp(input.themeSource ?? input.mount),
    screenReaderMode: input.screenReaderMode ?? false,
    allowProposedApi: input.allowProposedApi ?? false,
  });
  terminal.loadAddon(fitAddon);
  terminal.open(input.mount);
  fitAddon.fit();
  return { terminal, fitAddon };
}

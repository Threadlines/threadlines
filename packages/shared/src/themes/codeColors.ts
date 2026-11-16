/**
 * Code text on what it's drawn on (docs/design/custom-themes.md, "Code"):
 * code blocks on the code background; the diff panel and file viewer on
 * their own background and line tints (DiffPanel.styles.ts paints them from
 * DIFF_TINT). Syntax colors are fitted when a code theme is built, each to
 * read on every one of these, its hue kept, so a theme's colors (or the
 * built-in ones) stay readable on a changed word in a removed line too.
 */
import {
  color,
  composite,
  contrastRatio,
  ensureContrast,
  formatHex,
  mix,
  parseColor,
  type Rgba,
} from "./color.ts";
import type { ThemeTokens } from "./tokens.ts";

/** Percent of a color mixed into the surface for each diff background. */
export const DIFF_TINT = {
  /** Unchanged lines, toward the text color. */
  context: 3,
  contextHover: 6,
  /** Added and removed lines, toward green and red. */
  line: 8,
  lineHover: 15,
  /** A changed word inside an added or removed line. */
  word: 20,
  /** The file viewer's hovered line, toward the text color over the panel. */
  rowHover: 10,
  /** A selected line (a line number clicked, a chat reference), toward the accent over the panel. */
  selected: 14,
  selectedHover: 20,
  /** Text selected in the editor, toward the accent over the panel (drawn opaque). */
  editorSelection: 25,
} as const;

/** Code text: syntax colors and plain code. */
export const CODE_TEXT_RATIO = 4.5;
/** Comments and punctuation: quiet on purpose, never gone. */
export const QUIET_CODE_RATIO = 3;

const QUIET_SCOPES = ["comment", "punctuation"];

/** The ratio a syntax rule's color needs: quiet only when every scope it paints is quiet. */
export function codeRatioForScopes(scopes: ReadonlyArray<string>): number {
  return scopes.length > 0 &&
    scopes.every((scope) => QUIET_SCOPES.some((quiet) => scope.split(".")[0] === quiet))
    ? QUIET_CODE_RATIO
    : CODE_TEXT_RATIO;
}

type CodeTokens = Pick<
  ThemeTokens,
  | "surface-solid"
  | "code-background"
  | "card"
  | "foreground"
  | "primary"
  | "success"
  | "destructive"
>;

const canvasOf = (tokens: CodeTokens) => ({ ...color(tokens["surface-solid"]), a: 1 });
/** The diff panel and file viewer: the card mixed into the surface. */
const panelOf = (tokens: CodeTokens) => {
  const canvas = canvasOf(tokens);
  return mix(canvas, composite(color(tokens.card), canvas), 0.9);
};
const editorSelection = (tokens: CodeTokens) => {
  const panel = panelOf(tokens);
  return mix(panel, composite(color(tokens.primary), panel), DIFF_TINT.editorSelection / 100);
};

/**
 * The background of text selected in the editor, as the code theme's
 * `editor.selectionBackground`: opaque, so what it covers can't change it.
 */
export function editorSelectionHex(tokens: CodeTokens): string {
  return formatHex(editorSelection(tokens));
}

/** Every background code text is drawn on under a theme, opaque. */
export function codeSurfaces(tokens: CodeTokens): Rgba[] {
  const canvas = canvasOf(tokens);
  const panel = panelOf(tokens);
  const toward = (token: keyof CodeTokens, percent: number) =>
    mix(canvas, composite(color(tokens[token]), canvas), percent / 100);
  return [
    composite(color(tokens["code-background"]), canvas),
    // The diff panel and file viewer: the card mixed into the surface, and
    // the file viewer's hovered line over it.
    panel,
    mix(panel, composite(color(tokens.foreground), panel), DIFF_TINT.rowHover / 100),
    mix(panel, composite(color(tokens.primary), panel), DIFF_TINT.selected / 100),
    mix(panel, composite(color(tokens.primary), panel), DIFF_TINT.selectedHover / 100),
    editorSelection(tokens),
    toward("foreground", DIFF_TINT.context),
    toward("foreground", DIFF_TINT.contextHover),
    ...(["success", "destructive"] as const).flatMap((tint) => [
      toward(tint, DIFF_TINT.line),
      toward(tint, DIFF_TINT.lineHover),
      toward(tint, DIFF_TINT.word),
    ]),
  ];
}

/**
 * `value` moved just enough (OKLCH lightness, hue kept) to reach `ratio` on
 * every surface; `value` itself, unchanged, when it already does. Surfaces
 * that lean opposite ways (a mid-gray code background in a dark theme) may
 * allow no such color: then the one that reads best on its worst surface,
 * never worse than `value`.
 */
export function fitCodeColor(value: string, surfaces: ReadonlyArray<Rgba>, ratio: number): string {
  const parsed = parseColor(value);
  if (parsed === null || surfaces.length === 0) return value;
  const on = (text: Rgba, surface: Rgba) => contrastRatio(composite(text, surface), surface);
  // A fit is judged as the hex it will be written as, aimed a hair above the
  // ratio so rounding can't land it under.
  const asWritten = (text: Rgba) => color(formatHex(text));
  const aim = ratio + 0.02;
  const worstOf = (text: Rgba) =>
    surfaces.reduce((first, second) => (on(text, first) <= on(text, second) ? first : second));
  let best = parsed;
  let bestRatio = on(parsed, worstOf(parsed));
  if (bestRatio >= ratio) return value;
  let fitted = parsed;
  // Moving away from the surface it reads worst on doesn't hurt the others
  // when they lean the same way (all light, or all dark): a few rounds settle it.
  for (let round = 0; round < 6; round += 1) {
    const worst = worstOf(fitted);
    fitted = asWritten(ensureContrast(composite(fitted, worst), worst, aim));
    const reached = on(fitted, worstOf(fitted));
    if (reached > bestRatio) {
      best = fitted;
      bestRatio = reached;
    }
    if (reached >= ratio) break;
  }
  return best === parsed ? value : formatHex(best);
}

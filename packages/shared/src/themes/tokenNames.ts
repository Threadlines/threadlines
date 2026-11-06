/**
 * The names of a theme's color tokens and the CSS that sets them
 * (docs/design/custom-themes.md, "What a theme is"). Apart from the
 * derivation in tokens.ts so the app can apply tokens it already has (the
 * pre-paint record) without loading the color math at startup.
 *
 * Token names are written without the leading `--`.
 */

/**
 * Every color token a theme sets. Provider, usage-chart and context-category
 * colors are not here: they mean something (a provider, a model, a kind of
 * context) and keep their built-in values under every theme.
 */
export const THEME_TOKEN_NAMES = [
  "background",
  "app-chrome-background",
  "frame",
  "foreground",
  "card",
  "card-foreground",
  "rail",
  "agent-line",
  "sidebar",
  "sidebar-foreground",
  "sidebar-border",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "popover",
  "popover-foreground",
  "app-accent-blue",
  "primary",
  "primary-hover",
  "primary-readable",
  "primary-graph",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "group-muted-foreground",
  "accent",
  "accent-foreground",
  "pick-selected",
  "control-active",
  "group",
  "group-ring",
  "group-divider",
  "control",
  "control-hover",
  "control-pressed",
  "field",
  "placeholder",
  "switch-off",
  "segmented-track",
  "destructive",
  "border",
  "input",
  "ring",
  "focus-ring",
  "destructive-foreground",
  "info",
  "info-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "text-selection",
  /** New with themes: the opaque base behind everything that must hide what scrolls under it. */
  "surface-solid",
  /** New with themes: the background of code blocks. */
  "code-background",
] as const;
export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Readonly<Record<ThemeTokenName, string>>;

/** The tokens as one CSS block body: `--background: #...; ...`. */
export function themeTokensCss(tokens: ThemeTokens): string {
  return THEME_TOKEN_NAMES.map((name) => `--${name}: ${tokens[name]};`).join(" ");
}

/**
 * VS Code color themes as Threadlines themes (docs/design/custom-themes.md,
 * "VS Code themes"). The server reads them from extensions on Open VSX, the
 * app from a file the person imports; both turn them into a theme file here.
 *
 * What comes over: the editor's background and text, a muted text, the
 * accent (the theme's button color), the status colors, the selection, the
 * side bar's background, the syntax colors (from the theme's token rules)
 * and the 16 terminal colors. VS Code themes have no fonts or art, so none
 * come over. A color that would fail the readability check is moved, its hue
 * kept, until it passes (`fitThemeColors`, fit.ts); the number moved is reported so
 * the person sees how faithful the copy is.
 */
import {
  THEME_FILE_FORMAT,
  THEME_LICENSES,
  type ThemeBase,
  type ThemeCodePalette,
  type ThemeCredits,
  type ThemeLicense,
  type ThemeManifest,
  type ThemeSeedColors,
} from "@threadlines/contracts";

import {
  color,
  composite,
  contrastRatio,
  formatHex,
  parseColor,
  relativeLuminance,
  rgbToOklch,
  type Rgba,
} from "./color.ts";
import { fitThemeColors } from "./fit.ts";

/** A VS Code theme file, as far as this reads it. */
export interface VsCodeThemeFile {
  readonly name?: string;
  /** "dark", "light", "hc" or "hcLight". */
  readonly type?: string;
  readonly colors: Readonly<Record<string, string>>;
  readonly tokenColors: ReadonlyArray<VsCodeTokenRule>;
}

export interface VsCodeTokenRule {
  readonly scope?: string | ReadonlyArray<string>;
  readonly settings: { readonly foreground?: string };
}

/** How deep a theme's `include` chain may go. */
export const VSCODE_MAX_INCLUDE_DEPTH = 8;

/**
 * The SPDX licenses a theme may be brought in under: open ones that let it
 * be copied and changed, crediting its author.
 */
export const VSCODE_THEME_LICENSES: ReadonlyArray<string> = [
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "CC-BY-4.0",
  "ISC",
  "MIT",
  "MPL-2.0",
  "Unlicense",
];

/** The license as SPDX spells it, when it's one a theme may be brought in under; else null. */
export function vsCodeThemeLicense(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\(|\)$/g, "");
  return VSCODE_THEME_LICENSES.find((name) => name.toLowerCase() === trimmed.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// Reading

/**
 * JSON with comments and trailing commas, as VS Code reads its theme files.
 * Throws on anything else that isn't JSON.
 */
export function parseJsonWithComments(text: string): unknown {
  let out = "";
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      // A string, escapes and all.
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (char === ",") {
      // A comma before a closing bracket, with only space or comments between, is dropped.
      let next = index + 1;
      for (;;) {
        while (next < text.length && /\s/.test(text[next]!)) next += 1;
        if (text[next] === "/" && text[next + 1] === "/") {
          while (next < text.length && text[next] !== "\n") next += 1;
        } else if (text[next] === "/" && text[next + 1] === "*") {
          const end = text.indexOf("*/", next + 2);
          next = end === -1 ? text.length : end + 2;
        } else {
          break;
        }
      }
      if (text[next] !== "}" && text[next] !== "]") out += char;
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return JSON.parse(out);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The parts of one theme file, before its `include` is followed. */
function readThemeParts(value: unknown): {
  readonly name?: string;
  readonly type?: string;
  readonly include?: string;
  readonly colors: Record<string, string>;
  readonly tokenColors: VsCodeTokenRule[];
} | null {
  if (!isRecord(value)) return null;
  const colors: Record<string, string> = {};
  if (isRecord(value.colors)) {
    for (const [key, entry] of Object.entries(value.colors)) {
      if (typeof entry === "string") colors[key] = entry;
    }
  }
  const tokenColors: VsCodeTokenRule[] = [];
  // A `tokenColors` that names a TextMate file isn't read: its syntax colors fall back to ours.
  if (Array.isArray(value.tokenColors)) {
    for (const rule of value.tokenColors) {
      if (!isRecord(rule) || !isRecord(rule.settings)) continue;
      const scope =
        typeof rule.scope === "string"
          ? rule.scope
          : Array.isArray(rule.scope)
            ? rule.scope.filter((item): item is string => typeof item === "string")
            : undefined;
      const foreground =
        typeof rule.settings.foreground === "string" ? rule.settings.foreground : undefined;
      tokenColors.push({
        ...(scope === undefined ? {} : { scope }),
        settings: foreground === undefined ? {} : { foreground },
      });
    }
  }
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(typeof value.include === "string" ? { include: value.include } : {}),
    colors,
    tokenColors,
  };
}

/**
 * A theme file's path joined to `relative`, inside the extension: null when
 * it leaves it (`..` past the top, an absolute path, a URL).
 */
export function joinThemePath(from: string, relative: string): string | null {
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(relative) ||
    relative.startsWith("/") ||
    relative.includes("\\")
  ) {
    return null;
  }
  const parts = from.split("/").slice(0, -1);
  for (const part of relative.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

/**
 * A theme file with its `include` chain followed: the included file's colors
 * and token rules first, this file's over them. `read` gives a file's text
 * by its path in the extension, or null when there's no such file.
 */
export async function readVsCodeTheme(
  path: string,
  read: (path: string) => Promise<string | null>,
): Promise<VsCodeThemeFile> {
  const chain: Array<NonNullable<ReturnType<typeof readThemeParts>>> = [];
  const seen = new Set<string>();
  let next: string | null = path;
  while (next !== null) {
    if (chain.length >= VSCODE_MAX_INCLUDE_DEPTH || seen.has(next)) {
      throw new Error("The theme includes other theme files too deeply.");
    }
    seen.add(next);
    const text = await read(next);
    if (text === null) {
      throw new Error(
        chain.length === 0
          ? `The theme file ${path} is missing.`
          : `The theme builds on ${next}, which is missing.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = parseJsonWithComments(text);
    } catch {
      throw new Error(`${next} isn't a theme file.`);
    }
    const parts = readThemeParts(parsed);
    if (parts === null) throw new Error(`${next} isn't a theme file.`);
    chain.push(parts);
    next = parts.include === undefined ? null : joinThemePath(next, parts.include);
    if (parts.include !== undefined && next === null) {
      throw new Error("The theme builds on a file outside its extension.");
    }
  }
  const top = chain[0]!;
  const ordered = chain.toReversed();
  const name = top.name ?? ordered.find((parts) => parts.name !== undefined)?.name;
  const type = top.type ?? ordered.find((parts) => parts.type !== undefined)?.type;
  return {
    ...(name === undefined ? {} : { name }),
    ...(type === undefined ? {} : { type }),
    colors: Object.assign({}, ...ordered.map((parts) => parts.colors)),
    tokenColors: ordered.flatMap((parts) => parts.tokenColors),
  };
}

/** Whether a parsed JSON file looks like a VS Code color theme rather than a Threadlines one. */
export function isVsCodeThemeFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.format === undefined &&
    (isRecord(value.colors) || Array.isArray(value.tokenColors))
  );
}

// ---------------------------------------------------------------------------
// Converting

/** A VS Code color as `#rrggbb` or `#rrggbbaa`; null for anything else. */
function vsColor(value: string | undefined): Rgba | null {
  if (value === undefined) return null;
  const hex = value.trim();
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  return parseColor(hex);
}

/** The first of `keys` the theme sets, laid over `over` when translucent. */
function pickColor(
  colors: Readonly<Record<string, string>>,
  keys: ReadonlyArray<string>,
  over: Rgba,
): Rgba | null {
  for (const key of keys) {
    const value = vsColor(colors[key]);
    // A fully clear color says nothing about how the theme looks.
    if (value !== null && value.a > 0.05) return composite(value, over);
  }
  return null;
}

/** For each syntax slot, the TextMate scopes to look up, most fitting first. */
const CODE_SCOPES: Readonly<Record<keyof ThemeCodePalette & string, ReadonlyArray<string>>> = {
  foreground: [],
  comment: ["comment.line", "comment"],
  keyword: ["keyword.control", "keyword", "storage.modifier"],
  string: ["string.quoted", "string"],
  number: ["constant.numeric", "constant"],
  function: ["entity.name.function", "support.function"],
  type: ["entity.name.type", "support.type", "entity.name.class", "storage.type"],
  variable: ["variable.other.readwrite", "variable"],
  operator: ["keyword.operator"],
  punctuation: ["punctuation.separator", "punctuation"],
};

/**
 * The foreground a theme's token rules give `scope`: the rule whose selector
 * is the longest prefix of it, the later of equals, as VS Code picks. Only
 * plain selectors count: one with a parent scope ("source.js keyword")
 * belongs to one language.
 */
function tokenForeground(rules: ReadonlyArray<VsCodeTokenRule>, scope: string): Rgba | null {
  let best: { readonly length: number; readonly value: Rgba } | null = null;
  for (const rule of rules) {
    const value = vsColor(rule.settings.foreground);
    if (value === null || rule.scope === undefined) continue;
    const selectors = (typeof rule.scope === "string" ? rule.scope.split(",") : rule.scope).map(
      (selector) => selector.trim(),
    );
    for (const selector of selectors) {
      if (selector === "" || /\s/.test(selector)) continue;
      if (scope !== selector && !scope.startsWith(`${selector}.`)) continue;
      if (best === null || selector.length >= best.length) {
        best = { length: selector.length, value };
      }
    }
  }
  return best?.value ?? null;
}

const TERMINAL_NAMES = ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"];
/** VS Code's 16 terminal colors, in the order a theme file lists them. */
const TERMINAL_KEYS = [
  ...TERMINAL_NAMES.map((name) => `terminal.ansi${name}`),
  ...TERMINAL_NAMES.map((name) => `terminal.ansiBright${name}`),
];

/** What a VS Code editor shows when a theme leaves its background or text out. */
const VSCODE_DEFAULTS: Readonly<Record<ThemeBase, { background: string; foreground: string }>> = {
  dark: { background: "#1e1e1e", foreground: "#cccccc" },
  light: { background: "#ffffff", foreground: "#3b3b3b" },
};

/** Black or white, whichever reads better on `surface`. */
const inkFor = (surface: Rgba) =>
  contrastRatio(color("#ffffff"), surface) >= contrastRatio(color("#000000"), surface)
    ? color("#ffffff")
    : color("#000000");

export interface VsCodeThemeSource {
  /** `publisher.name` on Open VSX. */
  readonly extension?: string;
  readonly version?: string;
  /** The license, as SPDX names it. */
  readonly license?: string;
  /** Who made it, for the theme's credits. */
  readonly author?: string;
  /** Their page or the theme's, an https address. */
  readonly link?: string;
}

export type VsCodeThemeConversion =
  | {
      readonly ok: true;
      readonly manifest: ThemeManifest;
      /** How many colors were moved to pass the readability check. */
      readonly adjusted: number;
    }
  | { readonly ok: false; readonly problem: string };

const truncate = (value: string, length: number) => [...value].slice(0, length).join("").trim();

/** The theme's credits from where it came: its author, a link, and the license when ours can carry it. */
function creditsOf(source: VsCodeThemeSource): ThemeCredits {
  // A name, never an address: an author field can hold one.
  const author =
    source.author === undefined
      ? ""
      : truncate(
          source.author
            .slice(0, 200)
            .split(/\s+/)
            .filter((word) => !word.includes("@"))
            .join(" "),
          60,
        );
  // The length first: the pattern is only ever run on a short string.
  const link =
    source.link !== undefined &&
    source.link.length <= 200 &&
    /^https:\/\/[^\s/]+\S*$/.test(source.link)
      ? source.link
      : undefined;
  const license = (THEME_LICENSES as ReadonlyArray<string>).includes(source.license ?? "")
    ? (source.license as ThemeLicense)
    : undefined;
  return {
    ...(author === "" ? {} : { author }),
    ...(link === undefined ? {} : { link }),
    ...(license === undefined ? {} : { license }),
    vscode: source.extension ?? "file",
  };
}

/**
 * One VS Code theme as a Threadlines theme, moved where it must be to pass
 * the readability check. `label` is its name in its extension; `uiTheme`
 * the kind the extension declares ("vs", "vs-dark", "hc-black", "hc-light").
 */
export function convertVsCodeTheme(input: {
  readonly theme: VsCodeThemeFile;
  readonly label: string;
  readonly uiTheme?: string;
  readonly source?: VsCodeThemeSource;
}): VsCodeThemeConversion {
  const { theme } = input;
  const declared: ThemeBase =
    input.uiTheme === "vs" || input.uiTheme === "hc-light" || theme.type === "light"
      ? "light"
      : theme.type === "hcLight"
        ? "light"
        : "dark";
  const editor = pickColor(
    theme.colors,
    ["editor.background"],
    color(VSCODE_DEFAULTS[declared].background),
  );
  const background = editor ?? color(VSCODE_DEFAULTS[declared].background);
  // The kind follows the background: a "dark" theme with a pale editor is drawn as a light one.
  const base: ThemeBase = relativeLuminance(background) < 0.2 ? "dark" : "light";
  const over = (keys: ReadonlyArray<string>) => pickColor(theme.colors, keys, background);
  // A token rule with no scope sets the editor's default text color, as VS Code reads it.
  const unscoped = theme.tokenColors.findLast(
    (rule) => rule.scope === undefined && vsColor(rule.settings.foreground) !== null,
  );
  const foreground =
    over(["editor.foreground"]) ??
    (unscoped === undefined
      ? null
      : composite(vsColor(unscoped.settings.foreground)!, background)) ??
    over(["foreground"]) ??
    color(VSCODE_DEFAULTS[base].foreground);
  // The theme's accent: the first of its brand colors with some color in it (a
  // gray button is common, and a gray accent can't mark anything as on).
  const accentCandidates = [
    "activityBarBadge.background",
    "button.background",
    "focusBorder",
    "textLink.foreground",
    "progressBar.background",
    "badge.background",
  ]
    .map((key) => over([key]))
    .filter((value): value is Rgba => value !== null);
  const accent =
    accentCandidates.find((value) => rgbToOklch(value).c >= 0.06) ??
    accentCandidates[0] ??
    color(base === "dark" ? "#3b82f6" : "#2563eb");
  const accentForeground =
    over(["button.foreground", "activityBarBadge.foreground", "badge.foreground"]) ??
    inkFor(accent);
  // A quieter text: the first the theme sets that is quieter than its text.
  const muted =
    [
      "descriptionForeground",
      "tab.inactiveForeground",
      "sideBarSectionHeader.foreground",
      "editorLineNumber.activeForeground",
      "editorLineNumber.foreground",
    ]
      .map((key) => over([key]))
      .find(
        (value) =>
          value !== null &&
          contrastRatio(value, foreground) >= 1.2 &&
          contrastRatio(value, background) < contrastRatio(foreground, background),
      ) ??
    // Between the text and the background, nearer the text.
    composite({ ...foreground, a: 0.7 }, background);
  const hex = (value: Rgba) => formatHex({ ...value, a: 1 });
  const optional = (key: keyof ThemeSeedColors, value: Rgba | null) =>
    value === null ? {} : { [key]: hex(value) };
  const selection = vsColor(theme.colors["editor.selectionBackground"]);
  const colors: ThemeSeedColors = {
    background: hex(background),
    foreground: hex(foreground),
    mutedForeground: hex(muted),
    accent: hex(accent),
    accentForeground: hex(accentForeground),
    ...optional(
      "success",
      over(["gitDecoration.addedResourceForeground", "terminal.ansiGreen", "testing.iconPassed"]),
    ),
    ...optional("warning", over(["editorWarning.foreground", "list.warningForeground"])),
    ...optional(
      "danger",
      over(["editorError.foreground", "errorForeground", "list.errorForeground"]),
    ),
    ...optional("info", over(["editorInfo.foreground"])),
    // The selection stays translucent where the theme made it so: text shows through it.
    ...(selection !== null && selection.a > 0.05 ? { selection: formatHex(selection) } : {}),
  };
  const sideBar = over(["sideBar.background"]);
  const overrides =
    sideBar !== null && hex(sideBar) !== hex(background) ? { sidebar: hex(sideBar) } : undefined;

  const code: Record<string, string> = {};
  for (const [slot, scopes] of Object.entries(CODE_SCOPES)) {
    if (slot === "foreground") {
      code.foreground = hex(foreground);
      continue;
    }
    for (const scope of scopes) {
      const value = tokenForeground(theme.tokenColors, scope);
      if (value !== null) {
        code[slot] = hex(composite(value, background));
        break;
      }
    }
  }
  const terminalBackground = over(["terminal.background"]) ?? background;
  const terminalColors = TERMINAL_KEYS.map((key) =>
    pickColor(theme.colors, [key], terminalBackground),
  );
  const terminal = terminalColors.every((value) => value !== null)
    ? terminalColors.map((value) => hex(value!))
    : undefined;

  const credits = creditsOf(input.source ?? {});
  const name = truncate(input.label, 60) || truncate(theme.name ?? "", 60) || "VS Code theme";
  const vscode = {
    theme: truncate(input.label, 120) || name,
    ...(input.source?.extension === undefined ? {} : { extension: input.source.extension }),
    ...(input.source?.version === undefined ? {} : { version: input.source.version }),
    ...(input.source?.license === undefined ? {} : { license: input.source.license }),
  };
  const manifest: ThemeManifest = {
    format: THEME_FILE_FORMAT,
    name,
    base,
    colors,
    ...(overrides === undefined ? {} : { overrides }),
    // The text color alone is worth keeping: missing slots use the built-in ones.
    code,
    ...(terminal === undefined ? {} : { terminal }),
    credits,
    createdBy: { kind: "imported", vscode },
  };
  const fitted = fitThemeColors(manifest);
  return fitted.ok
    ? fitted
    : {
        ok: false,
        problem: "Its colors can't be made readable in Threadlines without changing how it looks.",
      };
}

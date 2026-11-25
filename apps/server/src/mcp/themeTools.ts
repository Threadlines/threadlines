/**
 * The theme tools, `preview_theme` and `show_theme`
 * (docs/design/custom-themes.md, "Agent tools"), served beside the page tools
 * at `/mcp/pages` by McpPagesServer. A theme an agent shows is a page of kind
 * `theme`: the chat draws it as a theme row with Try it.
 */
import { THEME_FILE_EXTENSION, THEME_FILE_FORMAT } from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { loadedOnDemand } from "./toolLoading.ts";

export const THEME_PREVIEW_TOOL_NAME = "preview_theme";
export const THEME_SHOW_TOOL_NAME = "show_theme";
export const THEME_FIND_VSCODE_TOOL_NAME = "find_vscode_theme";

const Theme = Schema.Record(Schema.String, Schema.Unknown).annotate({
  description:
    "The theme as one JSON object. Call preview_theme({ guide: true }) for the full schema, backdrop art API, and design rules.",
});
const ThemePath = Schema.String.annotate({
  description:
    "Instead of theme: the absolute path of a .threadlines-theme or .json file in this thread's page assets folder.",
});

export const PreviewThemeParameters = Schema.Struct({
  theme: Schema.optional(Theme),
  path: Schema.optional(ThemePath),
  guide: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Set true to return the full theme format, threadlines.backdrop art API, performance rules, and design guide without rendering.",
    }),
  ),
});

export const ShowThemeParameters = Schema.Struct({
  theme: Schema.optional(Theme),
  path: Schema.optional(ThemePath),
  pageId: Schema.optional(
    Schema.String.annotate({
      description:
        "Update a theme you showed earlier in this thread: pass the pageId show_theme returned. Within one turn it replaces that row; in a later turn the new version shows in that turn. Leave out for a new theme.",
    }),
  ),
});

export const ShowThemeResult = Schema.Struct({
  outcome: Schema.Literals(["shown", "off", "not_allowed", "refused", "failed"]),
  pageId: Schema.optional(Schema.String),
  version: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});

export const PreviewThemeTool = loadedOnDemand(
  Tool.make(THEME_PREVIEW_TOOL_NAME, {
    description: [
      "Render a Threadlines theme (colors, fonts, glass and optional live backdrop art) in a mock of the app at 1440×900 (thread, new-thread, and Settings layouts) and on a phone (390×844). Returns screenshots, readability checks, art cost/energy, and console errors. Iterate until it passes, then offer it with show_theme.",
      `Give theme (a JSON object) or path (a ${THEME_FILE_EXTENSION} file). Minimal shape: {"format":"${THEME_FILE_FORMAT}","name":"...","base":"dark"|"light","colors":{"background":"#rrggbb","foreground":"#rrggbb","mutedForeground":"#rrggbb","accent":"#rrggbb","accentForeground":"#rrggbb"}}; optional: extra color seeds, code, terminal, fonts, glass, backdrop, prompt (omit credits).`,
      "Before writing a theme (especially fonts, glass, or live backdrop art), call preview_theme({ guide: true }) for the full format, threadlines.backdrop draw API, art performance rules, and design guidance.",
      "The first preview on a machine can report that Threadlines is still installing its preview browser; try again a minute later.",
    ].join(" "),
    parameters: PreviewThemeParameters,
    success: Schema.Struct({}),
  })
    .annotate(Tool.Title, "Preview a theme")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, false),
);

// Read-only in the MCP sense, like show_page: the row shows in the caller's
// own thread, and nothing changes until the user tries and keeps the theme.
export const ShowThemeTool = loadedOnDemand(
  Tool.make(THEME_SHOW_TOOL_NAME, {
    description: [
      "Offer the user a Threadlines theme: a row in this thread above your reply, with a still of it, its name and Try it, which lets the user try the theme and keep it. Check it with preview_theme first: a theme that fails the readability checks is refused.",
      "Give the same theme object, or path, you previewed (call preview_theme({ guide: true }) for the full format). Threadlines embeds its fonts and captures a still of its art.",
      "The user sees the row, so don't describe the theme again in your reply.",
    ].join(" "),
    parameters: ShowThemeParameters,
    success: ShowThemeResult,
  })
    .annotate(Tool.Title, "Offer a theme")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, false),
);

export const FindVsCodeThemeParameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      'The theme\'s name or words about it, as on the VS Code marketplace ("Dracula", "tokyo night").',
  }),
});

// Read-only in the MCP sense: it writes theme files into this thread's own
// page assets folder, and nothing changes until the user tries one.
export const FindVsCodeThemeTool = loadedOnDemand(
  Tool.make(THEME_FIND_VSCODE_TOOL_NAME, {
    description: [
      "Find a VS Code color theme on the Open VSX store, for when the user asks for a theme that exists for VS Code (Dracula, Catppuccin, Tokyo Night...). Only openly licensed extensions are searched.",
      "Each theme in the best matches comes back as a .threadlines-theme file in this thread's page assets folder, already passing the readability checks, with its author credited. Offer one with show_theme and its path; no preview is needed unless you change it.",
      "They carry colors only, no fonts or art.",
    ].join(" "),
    parameters: FindVsCodeThemeParameters,
    success: Schema.Struct({}),
  })
    .annotate(Tool.Title, "Find a VS Code theme")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true),
);

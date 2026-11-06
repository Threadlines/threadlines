/**
 * The theme tools, `preview_theme` and `show_theme`
 * (docs/design/custom-themes.md, "Agent tools"), served beside the page tools
 * at `/mcp/pages` by McpPagesServer. A theme an agent shows is a page of kind
 * `theme`: the chat draws it as a theme row with Try it.
 */
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import {
  THEME_ART_CONTRACT_GUIDE,
  THEME_ART_RULES_GUIDE,
  THEME_DESIGN_GUIDE,
  THEME_FORMAT_GUIDE,
} from "../themes/themeGuide.ts";

export const THEME_PREVIEW_TOOL_NAME = "preview_theme";
export const THEME_SHOW_TOOL_NAME = "show_theme";

const Theme = Schema.Record(Schema.String, Schema.Unknown).annotate({
  description: "The theme: one JSON object in the format this tool's description gives.",
});
const ThemePath = Schema.String.annotate({
  description:
    "Instead of theme: the absolute path of a .threadlines-theme or .json file in this thread's page assets folder.",
});

export const PreviewThemeParameters = Schema.Struct({
  theme: Schema.optional(Theme),
  path: Schema.optional(ThemePath),
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

export const PreviewThemeTool = Tool.make(THEME_PREVIEW_TOOL_NAME, {
  description: [
    "Render a Threadlines theme (how the whole app looks: colors, fonts, glass and optional live art behind it) in a mock of the app at 1440×900: in a thread, on the new-thread screen and on a Settings page (every page that isn't a chat looks like it). You get the screenshots and a report: the readability checks, what the art costs (frames and milliseconds of work a second, and an energy label), and console errors. Use it until the theme looks right and passes, then offer it with show_theme.",
    "Give the theme as theme (the object) or path (a file).",
    THEME_FORMAT_GUIDE,
    THEME_ART_CONTRACT_GUIDE,
    THEME_ART_RULES_GUIDE,
    THEME_DESIGN_GUIDE,
    "The app guide's themes topic says more. The first preview on a machine can report that Threadlines is still installing its preview browser; try again a minute later.",
  ].join(" "),
  parameters: PreviewThemeParameters,
  success: Schema.Struct({}),
})
  .annotate(Tool.Title, "Preview a theme")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

// Read-only in the MCP sense, like show_page: the row shows in the caller's
// own thread, and nothing changes until the user tries and keeps the theme.
export const ShowThemeTool = Tool.make(THEME_SHOW_TOOL_NAME, {
  description: [
    "Offer the user a Threadlines theme: a row in this thread above your reply, with a still of it, its name and Try it, which lets the user try the theme and keep it. Check it with preview_theme first: a theme that fails the readability checks is refused.",
    "Give the same theme object, or path, you previewed (the format is in preview_theme's description). Threadlines embeds its fonts and captures a still of its art.",
    "The user sees the row, so don't describe the theme again in your reply.",
  ].join(" "),
  parameters: ShowThemeParameters,
  success: ShowThemeResult,
})
  .annotate(Tool.Title, "Offer a theme")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

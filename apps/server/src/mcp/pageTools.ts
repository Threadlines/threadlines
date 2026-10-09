/**
 * The page tools, `show_page` and `preview_page` (docs/agent-pages.md),
 * served at `/mcp/pages` by McpPagesServer.
 */
import {
  AGENT_PAGE_COLUMN_WIDTH,
  AGENT_PAGE_LAYOUT_GUIDE,
  AGENT_PAGE_MAX_HEIGHT,
  AGENT_PAGE_MAX_TITLE_LENGTH,
  AGENT_PAGE_MIN_HEIGHT,
  AGENT_PAGE_NETWORK_GUIDE,
  AGENT_PAGE_PREVIEW_TOOL_NAME,
  AGENT_PAGE_SHOW_TOOL_NAME,
  AGENT_PAGE_THEME_GUIDE,
} from "@threadlines/shared/agentPages";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

/** How the tools are namespaced to a provider: `mcp__threadlines_pages__show_page`. */
export const PAGES_MCP_SERVER_NAME = "threadlines_pages";

/** The page tools as Claude names them, for its allow list. */
export const CLAUDE_PAGE_TOOL_IDS = [
  `mcp__${PAGES_MCP_SERVER_NAME}__${AGENT_PAGE_SHOW_TOOL_NAME}`,
  `mcp__${PAGES_MCP_SERVER_NAME}__${AGENT_PAGE_PREVIEW_TOOL_NAME}`,
] as const;

const Html = Schema.String.annotate({
  description: "A complete, self-contained HTML document or fragment.",
});

export const ShowPageParameters = Schema.Struct({
  title: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(AGENT_PAGE_MAX_TITLE_LENGTH),
  ).annotate({ description: "A short, distinctive name for the page." }),
  html: Schema.optional(Html),
  markdown: Schema.optional(
    Schema.String.annotate({
      description:
        "A document in GitHub-flavored Markdown, shown as a styled page (raw HTML in it is shown as text). Give html or markdown, not both.",
    }),
  ),
  height: Schema.optional(
    Schema.Int.annotate({
      description: `The frame height in CSS pixels, ${AGENT_PAGE_MIN_HEIGHT}-${AGENT_PAGE_MAX_HEIGHT}. Usually leave it out: Threadlines fits the frame to the page. Set it below the page's contentHeight (from preview_page) to make long content scroll inside the frame.`,
    }),
  ),
  pageId: Schema.optional(
    Schema.String.annotate({
      description:
        "Update a page you showed earlier in this thread: pass the pageId show_page returned. Within one turn the page is replaced where it stands (a live status board); in a later turn the new version shows in that turn. Leave out for a new page.",
    }),
  ),
  icon: Schema.optional(
    Schema.String.annotate({
      description: "One generic word for the page, such as chart, table, diagram, mockup or doc.",
    }),
  ),
});

export const ShowPageResult = Schema.Struct({
  outcome: Schema.Literals(["shown", "off", "not_allowed", "refused", "failed"]),
  pageId: Schema.optional(Schema.String),
  version: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
});

export const PreviewPageParameters = Schema.Struct({
  html: Html,
  width: Schema.optional(
    Schema.Int.annotate({
      description: `Viewport width in CSS pixels, 240-1600. Defaults to ${AGENT_PAGE_COLUMN_WIDTH}, the reply column; use about 390 to check phones.`,
    }),
  ),
  appearance: Schema.optional(
    Schema.Literals(["dark", "light"]).annotate({
      description: "Theme to preview. Defaults to dark.",
    }),
  ),
});

// Read-only in the MCP sense: a page shows in the caller's own thread and
// touches no workspace, so plan mode and read-only sandboxes can use it.
export const ShowPageTool = Tool.make(AGENT_PAGE_SHOW_TOOL_NAME, {
  description: [
    "Show a page inline in this thread, above your final text reply: a chart, table, diagram, image collage, UI mockup, or a written document (markdown). Use it when a visual says more than prose, or when the user asks for one. Call it before writing that reply.",
    "The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page doesn't say.",
    "Check an HTML page with preview_page first.",
    AGENT_PAGE_NETWORK_GUIDE,
    AGENT_PAGE_LAYOUT_GUIDE,
    AGENT_PAGE_THEME_GUIDE,
  ].join(" "),
  parameters: ShowPageParameters,
  success: ShowPageResult,
})
  .annotate(Tool.Title, "Show a page")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const PreviewPageTool = Tool.make(AGENT_PAGE_PREVIEW_TOOL_NAME, {
  description: [
    "Render an HTML page exactly as show_page would show it and get back a PNG screenshot, contentHeight (the height the page needs at this width), and its console output: log, info, warning, error and uncaught exceptions. console.log is a fine way to report your own checks.",
    "Use it to check and fix a page before show_page. The first preview on a machine can report that Threadlines is still installing its preview browser; try again a minute later.",
    AGENT_PAGE_NETWORK_GUIDE,
  ].join(" "),
  parameters: PreviewPageParameters,
  success: Schema.Struct({}),
})
  .annotate(Tool.Title, "Preview a page")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/**
 * The short note a provider gets at session start: that pages exist, and
 * where this thread's page images go. The rules are in the tool descriptions.
 */
export function buildAgentPageInstructions(input: {
  readonly assetsDir: string;
  /** What precedes each page tool's name for this provider. */
  readonly toolPrefix?: string;
  /** This provider's own way of showing visuals, which Threadlines does not display. */
  readonly rival?: string;
}): string {
  const prefix = input.toolPrefix ?? `mcp__${PAGES_MCP_SERVER_NAME}__`;
  return `<threadlines_pages>
When a chart, table, diagram, image collage, UI mockup or written document would say more than prose, show it as a page with \`${prefix}${AGENT_PAGE_SHOW_TOOL_NAME}\` (check HTML first with \`${prefix}${AGENT_PAGE_PREVIEW_TOOL_NAME}\`); it appears in the chat above your reply. Do not write HTML files for the user to open instead.${input.rival !== undefined ? ` ${input.rival}` : ""} Local images for a page go in ${input.assetsDir}; reference them there by absolute path.
</threadlines_pages>`;
}

/** Claude Code's own publishing tools, which put a page on claude.ai. */
export const CLAUDE_ARTIFACT_TOOL_NAME = "Artifact";
export const CLAUDE_ARTIFACT_TOOL_NAMES = [
  CLAUDE_ARTIFACT_TOOL_NAME,
  "ArtifactComments",
  "ArtifactData",
] as const;

/** Environment that turns the Artifact tool on for an SDK session, without opening a browser tab per publish. */
export const CLAUDE_ARTIFACT_ENVIRONMENT = {
  CLAUDE_CODE_ARTIFACT: "1",
  CLAUDE_CODE_ARTIFACT_AUTO_OPEN: "0",
} as const;

/**
 * What a Claude session with artifacts on is told: `show_page` stays the
 * default, and a publish needs no second page (docs/agent-pages.md).
 */
export const CLAUDE_ARTIFACT_INSTRUCTIONS = `<threadlines_artifacts>
Your ${CLAUDE_ARTIFACT_TOOL_NAME} tool is on. It uploads a page to claude.ai, so use it only when the user asks for an artifact, or for a page they can open or share on claude.ai. Threadlines then shows the file you published in the chat as a page, with its claude.ai link, so do not also show it with \`mcp__${PAGES_MCP_SERVER_NAME}__${AGENT_PAGE_SHOW_TOOL_NAME}\`. Every other page goes through \`mcp__${PAGES_MCP_SERVER_NAME}__${AGENT_PAGE_SHOW_TOOL_NAME}\`, which keeps it on this computer.
</threadlines_artifacts>`;

/**
 * Environment that keeps the Artifact tool off, even when Threadlines itself
 * was started with it switched on: the setting is what decides.
 */
export const CLAUDE_ARTIFACT_OFF_ENVIRONMENT = {
  CLAUDE_CODE_ARTIFACT: "0",
} as const;

/** What Claude is told when it tries to publish after artifacts were turned off. */
export const CLAUDE_ARTIFACTS_OFF_REASON = `Claude artifacts are turned off in this Threadlines, so nothing was uploaded. Show the page with mcp__${PAGES_MCP_SERVER_NAME}__${AGENT_PAGE_SHOW_TOOL_NAME} instead, and don't try again.`;

/**
 * Codex's Visualize plugin claims "visualize" and in-conversation visuals
 * for itself, and its output is a reference only OpenAI's app draws.
 */
export const CODEX_PAGE_RIVAL =
  "Do not use the Visualize skill or write visualize{...} references for this; Threadlines does not display them.";

/**
 * The browser panel, introduced to a model.
 *
 * Two jobs, in this order. First, sell it: an agent that needs to look at a web
 * page reaches for whatever browser it already knows -- Chrome DevTools,
 * Playwright, a bundled browser plugin -- unless its instructions say the panel
 * beside the chat is the one to use, and why. Second, disambiguate: Codex ships
 * a browser plugin whose skill claims the phrase "in-app browser" as one of its
 * own aliases and tells the model outright not to use external MCP browser
 * tools for it. Asked to click something "in our browser", the model followed
 * that skill, found no ChatGPT in-app browser, silently fell back to the user's
 * real Chrome, and reported on a signed-in personal session -- while telling
 * the user it was using the in-app browser. It was not being careless; it was
 * obeying a skill that had claimed the words.
 *
 * A tool description can do neither job. The model commits to a skill before
 * it reads the tool list, and Claude does not see MCP tool descriptions at all
 * until it searches for them. System-level text can, because developer-role
 * instructions outrank a skill file, which reaches the model as tool output.
 *
 * One body with the rivals named per provider, so both providers hear the same
 * story about the same panel. Kept short on purpose: every line here competes
 * with the user's actual task on every turn.
 */

interface PreviewPanelRivals {
  /** What the user does not mean by "the in-app browser", for this provider. */
  readonly notThePanel: string;
  /** The browser tooling this provider would otherwise reach for. */
  readonly doNotUse: string;
}

const RIVALS: Record<"claude" | "codex", PreviewPanelRivals> = {
  claude: {
    notThePanel: "Claude in Chrome",
    doNotUse:
      "Do not use Claude in Chrome, the Chrome DevTools MCP tools, Playwright, or any other browser automation for the user's panel.",
  },
  codex: {
    notThePanel: "Codex's own in-app browser",
    doNotUse:
      "Do not use the Browser plugin, the Chrome plugin, or any other browser automation for the user's panel.",
  },
};

export function buildPreviewPanelInstructions(provider: "claude" | "codex"): string {
  const rivals = RIVALS[provider];
  return `<threadlines_browser>
This session runs inside Threadlines, a desktop workspace for coding agents. A browser panel sits beside this chat. Use it for any work that involves looking at a web page: opening a local dev server, checking a layout or a style change, reproducing a UI bug, reading console errors, or filling in a form. Prefer it over Chrome, headless browsers, and other browser automation, because the user watches every step in the panel, sees where you click, and can mark up the page and send the marks back to you. A browser you open anywhere else shows them nothing.

The panel is reachable only through the MCP tools \`mcp__threadlines_browser__*\` (browser_snapshot, browser_screenshot, browser_navigate, browser_click, browser_type, and the rest). Start with \`mcp__threadlines_browser__browser_snapshot\`. You do not need to ask the user to open the panel: your first browser tool call opens it. If a call reports that no browser is connected, the user is not viewing this thread in the Threadlines desktop app; say so before reaching for any other browser.

When the user says "our browser", "the browser", "the in-app browser", "the preview", or "the page", they mean that panel. They do not mean Chrome, and they do not mean ${rivals.notThePanel}; those are different surfaces and none of them can see what the user is looking at.

${rivals.doNotUse} Use those only when the user explicitly asks for Chrome or for a browser outside Threadlines.
</threadlines_browser>`;
}

/** Appended to Claude's system prompt on every session. */
export const CLAUDE_PREVIEW_PANEL_INSTRUCTIONS = buildPreviewPanelInstructions("claude");

/** Appended to Codex's developer instructions on every turn. */
export const CODEX_PREVIEW_PANEL_DEVELOPER_INSTRUCTIONS = buildPreviewPanelInstructions("codex");

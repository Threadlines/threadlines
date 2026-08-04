/**
 * The browser, described to a model.
 *
 * These descriptions are the entire interface: the agent never sees this code,
 * only these sentences, and a tool it misunderstands is worse than one it does
 * not have. So each says what the tool is for and what to reach for instead,
 * and `browser_snapshot` says outright that it comes first -- an agent that
 * guesses selectors on a page it has not read will spend a turn missing.
 *
 * Deliberately fewer tools than the page can do. Every extra one is another
 * thing to choose wrongly between, and the set below is enough to find a bug,
 * reproduce it, and show what it looks like.
 */
import {
  PreviewAutomationClickInputSchema,
  PreviewAutomationCloseTabInputSchema,
  PreviewAutomationDragInputSchema,
  PreviewAutomationEmptyInputSchema,
  PreviewAutomationErrorSchema,
  PreviewAutomationEvaluateInputSchema,
  PreviewAutomationNavigateInputSchema,
  PreviewAutomationMoveInputSchema,
  PreviewAutomationOpenTabInputSchema,
  PreviewAutomationPressInputSchema,
  PreviewAutomationResizeInputSchema,
  PreviewAutomationScreenshotSchema,
  PreviewAutomationSelectTabInputSchema,
  PreviewAutomationSetAppearanceInputSchema,
  PreviewAutomationScrollInputSchema,
  PreviewAutomationSnapshotSchema,
  PreviewAutomationStatusSchema,
  PreviewAutomationTabsSchema,
  PreviewAutomationTypeInputSchema,
  PreviewAutomationWaitForInputSchema,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { McpInvocationContext } from "./McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../preview/PreviewAutomationBroker.ts";

const dependencies = [McpInvocationContext, PreviewAutomationBroker];

/** Everything here reaches out of the machine and into a live page. */
const pageTool = <T extends Tool.Any>(tool: T): T => tool.annotate(Tool.OpenWorld, true) as T;

const readsOnly = <T extends Tool.Any>(tool: T): T =>
  pageTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Destructive, false) as T;

const changesThePage = <T extends Tool.Any>(tool: T): T =>
  pageTool(tool).annotate(Tool.Readonly, false).annotate(Tool.Destructive, true) as T;

export const BrowserSnapshotTool = readsOnly(
  Tool.make("browser_snapshot", {
    description:
      'Read the page the user has open. Returns it as an accessibility tree -- nesting, roles, accessible names and the actual text -- with a `[ref=eN]` on every node, plus the URL, title, console output and failed requests. Call this before acting. Name things by their `ref` where you can; where you cannot, `locator` takes a Playwright locator and is the only way to say something like "the delete button in the third row". Console errors are included because they are usually the answer.',
    parameters: PreviewAutomationEmptyInputSchema,
    success: PreviewAutomationSnapshotSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Read the page"),
);

export const BrowserScreenshotTool = readsOnly(
  Tool.make("browser_screenshot", {
    description:
      "See what the page in the Threadlines preview panel currently looks like. Use this for anything visual -- layout, spacing, colour, whether something is actually on screen -- and use browser_snapshot instead when you need to act on an element or read an error.",
    parameters: PreviewAutomationEmptyInputSchema,
    success: PreviewAutomationScreenshotSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Look at the page"),
);

export const BrowserStatusTool = readsOnly(
  Tool.make("browser_status", {
    description:
      "Where the Threadlines preview panel is right now: its URL, title, size, and whether it is still loading. Cheap; use it to confirm a navigation landed rather than taking a whole snapshot.",
    parameters: PreviewAutomationEmptyInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Check the browser"),
);

export const BrowserTabsTool = readsOnly(
  Tool.make("browser_tabs", {
    description:
      "Every page open in the Threadlines preview panel, including each stable tab id, with the user's visible tab and your pinned tab marked. Use a tab id on any browser tool to act there without changing what the user sees.",
    success: PreviewAutomationTabsSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "List tabs"),
);

export const BrowserOpenTabTool = changesThePage(
  Tool.make("browser_open_tab", {
    description:
      "Create a browser tab and pin your future browser actions to it. Give a URL to load it immediately. Set background true to leave the user's visible tab alone; otherwise the new tab is brought to the front.",
    parameters: PreviewAutomationOpenTabInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Open a tab"),
);

export const BrowserCloseTabTool = changesThePage(
  Tool.make("browser_close_tab", {
    description:
      "Close a browser tab. Omit tabId to close your pinned tab, or use a stable id from browser_tabs. Returns the remaining tabs.",
    parameters: PreviewAutomationCloseTabInputSchema,
    success: PreviewAutomationTabsSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Close a tab"),
);

export const BrowserSelectTabTool = changesThePage(
  Tool.make("browser_select_tab", {
    description:
      "Pin your future browser actions to another open tab. Prefer its stable tabId from browser_tabs. Set background true to leave the user's visible tab alone; otherwise the tab is also brought to the front.",
    parameters: PreviewAutomationSelectTabInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Switch tab"),
);

export const BrowserNavigateTool = changesThePage(
  Tool.make("browser_navigate", {
    description:
      "Go to a URL in the Threadlines preview panel the user is watching. This replaces what they are looking at, so navigate when you need to be somewhere else, not to reset state you can reach by clicking. Local and private addresses always work, but a site outside the project's approved list needs the user's approval: if this is refused for that reason, wait for them to allow it in the browser panel and then navigate again.",
    parameters: PreviewAutomationNavigateInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Go to a page"),
);

export const BrowserClickTool = changesThePage(
  Tool.make("browser_click", {
    description:
      'Click one thing, and get back the page state afterwards so you can see what changed. Name it with a `ref` from browser_snapshot where you can. `locator` takes a Playwright locator for anything a ref cannot reach -- `internal:role=button[name="Save"i]`, or `tbody > tr:nth-child(3) >> internal:role=button` for the third row\'s button -- and refuses rather than guessing when it matches more than one thing. `selector` is plain CSS and `text` matches visible text. The page is real: a button that deletes something will delete it, so do not retry a click that reported success.',
    parameters: PreviewAutomationClickInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Click"),
);

export const BrowserMoveTool = changesThePage(
  Tool.make("browser_move", {
    description:
      'Move the pointer onto something without clicking it. Use it for menus, tooltips and controls that only appear on hover, and to show where you are about to work. Name the target the same way as browser_click, or give `{"point": {"x": 0, "y": 0}}` to move to a place rather than an element.',
    parameters: PreviewAutomationMoveInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Move"),
);

export const BrowserDragTool = changesThePage(
  Tool.make("browser_drag", {
    description:
      'Press on one thing, drag to another, release. This is how you select a range of text, reorder an item in a list, or work a slider. Name both ends the same way as browser_click, or give `{"point": {"x": 0, "y": 0}}` for a place rather than an element -- a selection that starts and ends mid-word needs coordinates, which browser_evaluate can measure for you with a Range and getBoundingClientRect.',
    parameters: PreviewAutomationDragInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Drag"),
);

export const BrowserTypeTool = changesThePage(
  Tool.make("browser_type", {
    description:
      "Type into a field. Set `clear` to replace what is already there rather than appending, and `submit` to press Enter afterwards, which is how most single-field forms are sent.",
    parameters: PreviewAutomationTypeInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Type"),
);

export const BrowserPressTool = changesThePage(
  Tool.make("browser_press", {
    description:
      "Press a key on whatever has focus: Enter, Escape, Tab, an arrow, or a shortcut with modifiers. For entering text into a field, use browser_type.",
    parameters: PreviewAutomationPressInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Press a key"),
);

export const BrowserScrollTool = changesThePage(
  Tool.make("browser_scroll", {
    description:
      "Scroll the page, either by an amount or until a given element is in view, and get back the page state afterwards. Worth doing before a screenshot when the thing you care about is below the fold. A page that has nothing to scroll succeeds and stays where it is.",
    parameters: PreviewAutomationScrollInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  })
    .annotate(Tool.Title, "Scroll")
    .annotate(Tool.Destructive, false),
);

export const BrowserWaitForTool = readsOnly(
  Tool.make("browser_wait_for", {
    description:
      "Wait until the page catches up: an element appears, some text shows, or the URL changes. Use this after an action that kicks off a request, instead of taking snapshots until one happens to look right.",
    parameters: PreviewAutomationWaitForInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Wait for the page"),
);

export const BrowserEvaluateTool = changesThePage(
  Tool.make("browser_evaluate", {
    description:
      "Run JavaScript in the page and get the result back, wrapped as {result}. The escape hatch for what the other tools cannot reach -- reading a computed style, inspecting app state, checking a global. Anything that survives JSON comes back, arrays and primitives included.",
    parameters: PreviewAutomationEvaluateInputSchema,
    success: Schema.Struct({ result: Schema.Unknown }),
    failure: PreviewAutomationErrorSchema,
    dependencies,
  }).annotate(Tool.Title, "Run JavaScript"),
);

export const BrowserResizeTool = changesThePage(
  Tool.make("browser_resize", {
    description:
      "Resize the page the user is looking at, to check a layout at a given width. Pass null for both to let it fill the panel and reflow with it. Returns the page state at the new size.",
    parameters: PreviewAutomationResizeInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  })
    .annotate(Tool.Title, "Resize the page")
    .annotate(Tool.Destructive, false),
);

export const BrowserSetAppearanceTool = changesThePage(
  Tool.make("browser_set_appearance", {
    description:
      "Emulate the page's preferred light or dark color scheme without changing the Threadlines app theme.",
    parameters: PreviewAutomationSetAppearanceInputSchema,
    success: PreviewAutomationStatusSchema,
    failure: PreviewAutomationErrorSchema,
    dependencies,
  })
    .annotate(Tool.Title, "Set page appearance")
    .annotate(Tool.Destructive, false),
);

/**
 * Everything except the screenshot.
 *
 * The screenshot is registered by hand rather than through the toolkit,
 * because a toolkit puts a tool's result in `structuredContent` and a picture
 * in a JSON string is a picture nobody can see. See McpHttpServer.
 */
export const BrowserStandardToolkit = Toolkit.make(
  BrowserSnapshotTool,
  BrowserStatusTool,
  BrowserTabsTool,
  BrowserOpenTabTool,
  BrowserCloseTabTool,
  BrowserSelectTabTool,
  BrowserNavigateTool,
  BrowserClickTool,
  BrowserMoveTool,
  BrowserDragTool,
  BrowserTypeTool,
  BrowserPressTool,
  BrowserScrollTool,
  BrowserWaitForTool,
  BrowserEvaluateTool,
  BrowserResizeTool,
  BrowserSetAppearanceTool,
);

/** On its own, so it can answer with an image instead of a description of one. */
export const BrowserScreenshotToolkit = Toolkit.make(BrowserScreenshotTool);

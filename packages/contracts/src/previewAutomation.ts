/**
 * The browser, as the agent sees it.
 *
 * Everything the agent can do to a page has to cross three boundaries: the
 * provider session lives in the server, the page lives in a webview owned by
 * the desktop main process, and the only thing joining them is the browser tab
 * the user already has open. So a tool call becomes a request the server hands
 * to whichever client is showing that thread, and the answer comes back the
 * same way.
 *
 * These are the shapes on that wire. They are deliberately about the page
 * rather than about CDP: an operation names something a person would ask for
 * ("click the sign-in button"), and how it happens is the desktop's business.
 */
import * as Schema from "effect/Schema";

/**
 * Numbers, as a tool schema should describe them.
 *
 * `Schema.Number` round-trips NaN and the infinities as strings, so its JSON
 * Schema is an anyOf of a number and three magic words. That is honest about
 * the codec and useless as a description of "a ref" -- and a client reading it
 * has to decide what to do with a field that might be the string "Infinity".
 */

import { ThreadId } from "./baseSchemas.ts";

/**
 * What the agent may ask of a page.
 *
 * A closed set rather than free-form CDP: the client declares which of these it
 * can service, so a browser panel from an older build is told it cannot do
 * something instead of being handed a command it will silently drop.
 */
export const PreviewAutomationOperationSchema = Schema.Literals([
  "status",
  "tabs",
  "openTab",
  "closeTab",
  "selectTab",
  "snapshot",
  "navigate",
  "click",
  "move",
  "drag",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "screenshot",
  "resize",
  "setAppearance",
]);
export type PreviewAutomationOperation = typeof PreviewAutomationOperationSchema.Type;

export const PREVIEW_AUTOMATION_OPERATIONS = [
  "status",
  "tabs",
  "openTab",
  "closeTab",
  "selectTab",
  "snapshot",
  "navigate",
  "click",
  "move",
  "drag",
  "type",
  "press",
  "scroll",
  "evaluate",
  "waitFor",
  "screenshot",
  "resize",
  "setAppearance",
] as const satisfies ReadonlyArray<PreviewAutomationOperation>;

/**
 * How the agent names a thing on the page.
 *
 * `ref` is what a snapshot handed it -- the `eN` beside each node, resolved
 * against the tree it came from. `locator` is a Playwright locator, which
 * is the only one of these that can say "the delete button in the third row" --
 * a thing that is ordinary to want and impossible to express as a role and a
 * name. `selector` is plain CSS, and `text` is for when the agent knows what
 * the button says and nothing else.
 *
 * `point` is none of those: it is a place rather than a thing. A mouse works in
 * coordinates, and an element-only vocabulary quietly rules out everything that
 * happens between elements -- selecting two words out of a heading, drawing on
 * a canvas, dropping onto empty space. Asked to drag across part of a heading,
 * an agent declined the drag tool and scripted a DOM Range instead, which was
 * the right call given what it had been offered.
 *
 * Only the pointer operations take it. There is no node behind a point, so
 * anything that needs an element says so rather than guessing at whatever
 * happens to be under the cursor.
 */
export const PreviewAutomationTargetSchema = Schema.Union([
  Schema.Struct({ ref: Schema.String }),
  Schema.Struct({ locator: Schema.String }),
  Schema.Struct({ selector: Schema.String }),
  Schema.Struct({ text: Schema.String }),
  Schema.Struct({ point: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }) }),
]);
export type PreviewAutomationTarget = typeof PreviewAutomationTargetSchema.Type;

// --- Failures ---------------------------------------------------------------

/**
 * Told apart because the agent should react differently to each.
 *
 * "No browser is open" is a thing to ask the user for; "that element is gone"
 * is a thing to re-snapshot and retry; "the page threw" is a finding to report.
 * Collapsing them into one string would make all three look like the tool being
 * broken.
 */
export class PreviewAutomationNoHostError extends Schema.TaggedErrorClass<PreviewAutomationNoHostError>()(
  "PreviewAutomationNoHostError",
  { threadId: ThreadId, operation: PreviewAutomationOperationSchema },
) {
  override get message(): string {
    return `No browser preview is open for this thread, so ${this.operation} has nothing to act on. Ask the user to open the browser panel.`;
  }
}

export class PreviewAutomationUnsupportedError extends Schema.TaggedErrorClass<PreviewAutomationUnsupportedError>()(
  "PreviewAutomationUnsupportedError",
  { operation: PreviewAutomationOperationSchema },
) {
  override get message(): string {
    return `The connected browser preview cannot perform ${this.operation}.`;
  }
}

export class PreviewAutomationTimeoutError extends Schema.TaggedErrorClass<PreviewAutomationTimeoutError>()(
  "PreviewAutomationTimeoutError",
  { operation: PreviewAutomationOperationSchema, timeoutMs: Schema.Finite },
) {
  override get message(): string {
    return `The browser preview did not answer ${this.operation} within ${this.timeoutMs}ms.`;
  }
}

export class PreviewAutomationDisconnectedError extends Schema.TaggedErrorClass<PreviewAutomationDisconnectedError>()(
  "PreviewAutomationDisconnectedError",
  { operation: PreviewAutomationOperationSchema },
) {
  override get message(): string {
    return `The browser preview closed while ${this.operation} was in flight.`;
  }
}

/** The page was reached and said no: a bad selector, a missing element, a throw. */
export class PreviewAutomationExecutionError extends Schema.TaggedErrorClass<PreviewAutomationExecutionError>()(
  "PreviewAutomationExecutionError",
  { operation: PreviewAutomationOperationSchema, detail: Schema.String },
) {
  override get message(): string {
    return `${this.operation} failed: ${this.detail}`;
  }
}

/** A page can hand back more than a context window can hold. Refuse, don't truncate silently. */
export class PreviewAutomationResultTooLargeError extends Schema.TaggedErrorClass<PreviewAutomationResultTooLargeError>()(
  "PreviewAutomationResultTooLargeError",
  {
    operation: PreviewAutomationOperationSchema,
    bytes: Schema.Finite,
    limitBytes: Schema.Finite,
  },
) {
  override get message(): string {
    return `${this.operation} returned ${this.bytes} bytes, over the ${this.limitBytes} byte limit. Narrow the request.`;
  }
}

export const PreviewAutomationErrorSchema = Schema.Union([
  PreviewAutomationNoHostError,
  PreviewAutomationUnsupportedError,
  PreviewAutomationTimeoutError,
  PreviewAutomationDisconnectedError,
  PreviewAutomationExecutionError,
  PreviewAutomationResultTooLargeError,
]);
export type PreviewAutomationError = typeof PreviewAutomationErrorSchema.Type;

// --- The wire ---------------------------------------------------------------

/** A client offering to service requests for one thread's browser panel. */
export const PreviewAutomationHostSchema = Schema.Struct({
  threadId: ThreadId,
  /** Survives a reconnect under the same identity, so a refresh is not a new host. */
  hostId: Schema.String,
  operations: Schema.Array(PreviewAutomationOperationSchema),
});
export type PreviewAutomationHost = typeof PreviewAutomationHostSchema.Type;

export const PreviewAutomationRequestSchema = Schema.Struct({
  requestId: Schema.String,
  /** Opaque identity minted with the provider runtime's browser credential. */
  agentId: Schema.String,
  operation: PreviewAutomationOperationSchema,
  /** Shaped by the operation; the host validates it against the matching input schema. */
  input: Schema.Json,
});
export type PreviewAutomationRequest = typeof PreviewAutomationRequestSchema.Type;

export const PreviewAutomationResponseSchema = Schema.Struct({
  requestId: Schema.String,
  result: Schema.optionalKey(Schema.Json),
  /** Set when the page refused; carried through as an execution failure. */
  error: Schema.optionalKey(Schema.String),
});
export type PreviewAutomationResponse = typeof PreviewAutomationResponseSchema.Type;

// --- Operation inputs -------------------------------------------------------

const PreviewAutomationTabTargetFields = {
  /** Exact tab to target. Omit to use this agent session's pinned tab. */
  tabId: Schema.optionalKey(Schema.String),
};

export const PreviewAutomationTabTargetInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
});

export const PreviewAutomationNavigateInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.String,
});

export const PreviewAutomationOpenTabInputSchema = Schema.Struct({
  /** Optional initial address. Omit for a blank tab. */
  url: Schema.optionalKey(Schema.String),
  /** Keep the user's current tab in front. Defaults to false. */
  background: Schema.optionalKey(Schema.Boolean),
});

export const PreviewAutomationCloseTabInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
});

/**
 * Every page the panel has open, not just the one being acted on.
 *
 * Without this an agent has no way to know a second tab exists, so it answers
 * questions about the tab it happens to be on and states, wrongly and with
 * confidence, that there is nothing else.
 */
export const PreviewAutomationTabSchema = Schema.Struct({
  /** Stable identity accepted by every tab-targeted browser tool. */
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  /** The tab the user is looking at, which is the one they mean. */
  active: Schema.Boolean,
  /** The tab this agent's actions land on. */
  agent: Schema.Boolean,
});

export const PreviewAutomationTabsSchema = Schema.Struct({
  tabs: Schema.Array(PreviewAutomationTabSchema),
  /** Whether the browser panel remains visible after this operation. */
  panelOpen: Schema.Boolean,
  /** The page that was closed, present only on a successful close. */
  closedTab: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      url: Schema.String,
    }),
  ),
});

/** Pin the agent to another tab, optionally leaving the user's view alone. */
export const PreviewAutomationSelectTabInputSchema = Schema.Struct({
  /** Stable tab identity from browser_tabs. Prefer this over index. */
  tabId: Schema.optionalKey(Schema.String),
  /** Compatibility fallback: position in browser_tabs, counting from zero. */
  index: Schema.optionalKey(Schema.Finite),
  /** Pin the agent without changing the user's visible tab. Defaults to false. */
  background: Schema.optionalKey(Schema.Boolean),
});

export const PreviewAutomationClickInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  target: PreviewAutomationTargetSchema,
  /** A double click is one gesture, not two calls: two calls are two clicks. */
  doubleClick: Schema.optionalKey(Schema.Boolean),
});

export const PreviewAutomationMoveInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  target: PreviewAutomationTargetSchema,
});

export const PreviewAutomationDragInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  from: PreviewAutomationTargetSchema,
  to: PreviewAutomationTargetSchema,
});

export const PreviewAutomationTypeInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  target: PreviewAutomationTargetSchema,
  text: Schema.String,
  /** Replaces what is there. Without it the text is appended. */
  clear: Schema.optionalKey(Schema.Boolean),
  /** Presses Enter afterwards, which is how most single-field forms are sent. */
  submit: Schema.optionalKey(Schema.Boolean),
});

export const PreviewAutomationPressInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  key: Schema.String,
  modifiers: Schema.optionalKey(Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]))),
});

export const PreviewAutomationScrollInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  /** Positive is down and right, matching a wheel. */
  deltaX: Schema.optionalKey(Schema.Finite),
  deltaY: Schema.optionalKey(Schema.Finite),
  /** Scrolls this into view instead, when the agent knows where it wants to be. */
  target: Schema.optionalKey(PreviewAutomationTargetSchema),
});

export const PreviewAutomationEvaluateInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  /** Evaluated in the page. The result has to survive JSON. */
  expression: Schema.String,
});

export const PreviewAutomationWaitForInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  /** All supplied conditions have to hold at once before this returns. */
  target: Schema.optionalKey(PreviewAutomationTargetSchema),
  text: Schema.optionalKey(Schema.String),
  urlContains: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Finite),
});

export const PreviewAutomationResizeInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  /** null for both means fill the panel and reflow with it. */
  width: Schema.NullOr(Schema.Finite),
  height: Schema.NullOr(Schema.Finite),
});

export const PreviewAutomationSetAppearanceInputSchema = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  colorScheme: Schema.Literals(["light", "dark"]),
});

export const PreviewAutomationEmptyInputSchema = PreviewAutomationTabTargetInputSchema;

// --- Operation results ------------------------------------------------------

export const PreviewAutomationStatusSchema = Schema.Struct({
  tabId: Schema.String,
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  width: Schema.Finite,
  height: Schema.Finite,
});
export type PreviewAutomationStatus = typeof PreviewAutomationStatusSchema.Type;

export const PreviewAutomationSnapshotSchema = Schema.Struct({
  ...PreviewAutomationStatusSchema.fields,
  /**
   * The page as an aria tree, the way Playwright renders it: nesting, roles,
   * accessible names, the actual text, and a `[ref=eN]` on everything. One
   * string rather than an array of elements, because the shape of a page is
   * half of what it means and a flat list throws that away.
   */
  page: Schema.String,
  /** What the page has complained about since it loaded. Usually the answer. */
  console: Schema.Array(Schema.Struct({ level: Schema.String, text: Schema.String })),
  networkFailures: Schema.Array(Schema.Struct({ url: Schema.String, detail: Schema.String })),
});
export type PreviewAutomationSnapshot = typeof PreviewAutomationSnapshotSchema.Type;

export const PreviewAutomationScreenshotSchema = Schema.Struct({
  /** Base64 PNG, so it can go back as an image block the model actually sees. */
  data: Schema.String,
  width: Schema.Finite,
  height: Schema.Finite,
});
export type PreviewAutomationScreenshot = typeof PreviewAutomationScreenshotSchema.Type;

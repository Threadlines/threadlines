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
  "snapshot",
  "navigate",
  "click",
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
  "snapshot",
  "navigate",
  "click",
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
 * `ref` is what a snapshot handed it, and is the only one that cannot go stale
 * in an interesting way -- it is checked against the snapshot it came from.
 * `selector` is the escape hatch for a page the snapshot described poorly, and
 * `text` is for the times the agent knows what the button says and nothing else.
 */
export const PreviewAutomationTargetSchema = Schema.Union([
  Schema.Struct({ ref: Schema.Number }),
  Schema.Struct({ selector: Schema.String }),
  Schema.Struct({ text: Schema.String }),
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
  { operation: PreviewAutomationOperationSchema, timeoutMs: Schema.Number },
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
    bytes: Schema.Number,
    limitBytes: Schema.Number,
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

export const PreviewAutomationNavigateInputSchema = Schema.Struct({
  url: Schema.String,
});

export const PreviewAutomationClickInputSchema = Schema.Struct({
  target: PreviewAutomationTargetSchema,
  /** A double click is one gesture, not two calls: two calls are two clicks. */
  doubleClick: Schema.optionalKey(Schema.Boolean),
});

export const PreviewAutomationTypeInputSchema = Schema.Struct({
  target: PreviewAutomationTargetSchema,
  text: Schema.String,
  /** Replaces what is there. Without it the text is appended. */
  clear: Schema.optionalKey(Schema.Boolean),
  /** Presses Enter afterwards, which is how most single-field forms are sent. */
  submit: Schema.optionalKey(Schema.Boolean),
});

export const PreviewAutomationPressInputSchema = Schema.Struct({
  key: Schema.String,
  modifiers: Schema.optionalKey(Schema.Array(Schema.Literals(["Alt", "Control", "Meta", "Shift"]))),
});

export const PreviewAutomationScrollInputSchema = Schema.Struct({
  /** Positive is down and right, matching a wheel. */
  deltaX: Schema.optionalKey(Schema.Number),
  deltaY: Schema.optionalKey(Schema.Number),
  /** Scrolls this into view instead, when the agent knows where it wants to be. */
  target: Schema.optionalKey(PreviewAutomationTargetSchema),
});

export const PreviewAutomationEvaluateInputSchema = Schema.Struct({
  /** Evaluated in the page. The result has to survive JSON. */
  expression: Schema.String,
});

export const PreviewAutomationWaitForInputSchema = Schema.Struct({
  /** All supplied conditions have to hold at once before this returns. */
  target: Schema.optionalKey(PreviewAutomationTargetSchema),
  text: Schema.optionalKey(Schema.String),
  urlContains: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(Schema.Number),
});

export const PreviewAutomationResizeInputSchema = Schema.Struct({
  /** null for both means fill the panel and reflow with it. */
  width: Schema.NullOr(Schema.Number),
  height: Schema.NullOr(Schema.Number),
});

export const PreviewAutomationSetAppearanceInputSchema = Schema.Struct({
  colorScheme: Schema.Literals(["light", "dark"]),
});

export const PreviewAutomationEmptyInputSchema = Schema.Struct({});

// --- Operation results ------------------------------------------------------

export const PreviewAutomationStatusSchema = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  width: Schema.Number,
  height: Schema.Number,
});
export type PreviewAutomationStatus = typeof PreviewAutomationStatusSchema.Type;

/**
 * One element as the agent sees it.
 *
 * `ref` is the handle for every later call. Role and name come from the
 * accessibility tree, which is the same vocabulary a person uses to describe a
 * control -- "the Sign in button" -- and is far steadier across a redesign than
 * a class name.
 */
export const PreviewAutomationElementSchema = Schema.Struct({
  ref: Schema.Number,
  role: Schema.String,
  name: Schema.String,
  /** Present when it is a field, so the agent knows what is already in it. */
  value: Schema.optionalKey(Schema.String),
  disabled: Schema.optionalKey(Schema.Boolean),
});
export type PreviewAutomationElement = typeof PreviewAutomationElementSchema.Type;

export const PreviewAutomationSnapshotSchema = Schema.Struct({
  ...PreviewAutomationStatusSchema.fields,
  elements: Schema.Array(PreviewAutomationElementSchema),
  /** What the page has complained about since it loaded. Usually the answer. */
  console: Schema.Array(Schema.Struct({ level: Schema.String, text: Schema.String })),
  networkFailures: Schema.Array(Schema.Struct({ url: Schema.String, detail: Schema.String })),
});
export type PreviewAutomationSnapshot = typeof PreviewAutomationSnapshotSchema.Type;

export const PreviewAutomationScreenshotSchema = Schema.Struct({
  /** Base64 PNG, so it can go back as an image block the model actually sees. */
  data: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});
export type PreviewAutomationScreenshot = typeof PreviewAutomationScreenshotSchema.Type;

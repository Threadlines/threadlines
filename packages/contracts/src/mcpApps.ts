/**
 * MCP Apps (SEP-1865): an MCP tool that ships a `ui://` HTML view, shown in
 * the chat as an interactive card under the step that ran the tool
 * (docs/mcp-apps.md). The shared runtime helpers (content policy, bridge
 * messages) live in @threadlines/shared/mcpApps.
 */
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

/** An MCP `CallToolResult` as a view receives it: content blocks as the
 *  server sent them. */
export const McpAppToolResult = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.optional(JsonObject),
  isError: Schema.optional(Schema.Boolean),
  _meta: Schema.optional(JsonObject),
});
export type McpAppToolResult = typeof McpAppToolResult.Type;

/**
 * A completed MCP tool call whose tool declares an app, as a provider
 * runtime reports it on the call's `item.completed` (ItemLifecyclePayload
 * `mcpApp`). Ingestion keeps the whole of it for the card and puts only
 * McpAppRef on the step.
 */
export const RuntimeMcpAppCall = Schema.Struct({
  server: TrimmedNonEmptyString,
  /** The tool's name on its server. */
  tool: TrimmedNonEmptyString,
  resourceUri: TrimmedNonEmptyString,
  arguments: Schema.optional(JsonObject),
  /** Null when the call ended without a result (it was cancelled). */
  result: Schema.NullOr(McpAppToolResult),
});
export type RuntimeMcpAppCall = typeof RuntimeMcpAppCall.Type;

/** The app a completed MCP tool step shipped, on the step's activity payload
 *  as `mcpApp`. The card loads the rest by the step's tool call id. */
export const McpAppRef = Schema.Struct({
  server: TrimmedNonEmptyString,
  tool: TrimmedNonEmptyString,
  resourceUri: TrimmedNonEmptyString,
});
export type McpAppRef = typeof McpAppRef.Type;

/** Hosts a view may reach, as its resource declared them (checked). */
export const McpAppCsp = Schema.Struct({
  connectDomains: Schema.optional(Schema.Array(Schema.String)),
  resourceDomains: Schema.optional(Schema.Array(Schema.String)),
  frameDomains: Schema.optional(Schema.Array(Schema.String)),
  baseUriDomains: Schema.optional(Schema.Array(Schema.String)),
});
export type McpAppCsp = typeof McpAppCsp.Type;

export const McpAppPermissions = Schema.Struct({
  camera: Schema.optional(Schema.Boolean),
  microphone: Schema.optional(Schema.Boolean),
  geolocation: Schema.optional(Schema.Boolean),
  clipboardWrite: Schema.optional(Schema.Boolean),
});
export type McpAppPermissions = typeof McpAppPermissions.Type;

/** A view as its server served it, with what it declared it needs. */
export const McpAppView = Schema.Struct({
  html: Schema.String,
  csp: McpAppCsp,
  permissions: McpAppPermissions,
  prefersBorder: Schema.NullOr(Schema.Boolean),
});
export type McpAppView = typeof McpAppView.Type;

/**
 * Open a card: the call it shows and its view. The view is read through the
 * session of the agent that made the call, once, and kept with the call.
 * `recover`: the reader asked to start that agent's session again to read
 * it; otherwise a card never starts a session.
 */
export const McpAppLoadInput = Schema.Struct({
  threadId: ThreadId,
  toolCallId: TrimmedNonEmptyString,
  recover: Schema.optional(Schema.Boolean),
});
export type McpAppLoadInput = typeof McpAppLoadInput.Type;

export const McpAppLoadResult = Schema.Struct({
  server: TrimmedNonEmptyString,
  tool: TrimmedNonEmptyString,
  resourceUri: TrimmedNonEmptyString,
  arguments: JsonObject,
  result: Schema.NullOr(McpAppToolResult),
  /** The call's input and result were too large to keep whole: the view
   *  gets an empty input and a result with the content dropped. */
  truncated: Schema.Boolean,
  view: McpAppView,
  /** Whether the app's calls run without asking: the agent works with full
   *  access and not in plan mode. */
  callsAllowed: Schema.Boolean,
});
export type McpAppLoadResult = typeof McpAppLoadResult.Type;

/**
 * A tool a view calls on its own server. `confirmed`: the reader allowed
 * this call (or every call of this card); a call that needs it and lacks it
 * is refused with `needs-confirmation`.
 */
export const McpAppCallToolInput = Schema.Struct({
  threadId: ThreadId,
  toolCallId: TrimmedNonEmptyString,
  tool: TrimmedNonEmptyString,
  arguments: Schema.optional(JsonObject),
  confirmed: Schema.Boolean,
});
export type McpAppCallToolInput = typeof McpAppCallToolInput.Type;

export const McpAppFailureReason = Schema.Literals([
  /** No such call, or its tool ships no app. */
  "not-found",
  /** The agent's session ended; reading the view needs it back. */
  "session-ended",
  /** The provider cannot do this (an older CLI, an unsupported provider). */
  "unsupported",
  /** The view is not an MCP App document, or is too large. */
  "invalid-view",
  "needs-confirmation",
  /** The tool is not on the call's server, or not callable by apps. */
  "not-allowed",
  "failed",
]);
export type McpAppFailureReason = typeof McpAppFailureReason.Type;

export class McpAppError extends Schema.TaggedError<McpAppError>()("McpAppError", {
  reason: McpAppFailureReason,
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}

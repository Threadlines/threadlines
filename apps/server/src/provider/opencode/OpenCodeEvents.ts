/**
 * OpenCodeEvents — decode frames from OpenCode 2's `/api/event` stream.
 *
 * The Promise client only `JSON.parse`s each frame, so this module is the
 * validation boundary. Each event the driver acts on has a schema naming just
 * the fields it reads; extra fields are ignored and unknown event types pass
 * through as `unknown`, so a newer server only ever adds noise. An execution
 * start or end that fails its schema is still honoured from its type and
 * session id alone, because losing one leaves a turn running forever.
 *
 * @module provider/opencode/OpenCodeEvents
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Id = Schema.String;
const OptionalString = Schema.optional(Schema.String);

const Tokens = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  reasoning: Schema.optional(Schema.Number),
  cache: Schema.optional(
    Schema.Struct({
      read: Schema.optional(Schema.Number),
      write: Schema.optional(Schema.Number),
    }),
  ),
});
export type OpenCodeTokens = typeof Tokens.Type;

const StructuredError = Schema.Struct({
  type: OptionalString,
  message: OptionalString,
});

const ModelRef = Schema.Struct({
  providerID: Schema.String,
  id: Schema.String,
  variant: OptionalString,
});

const sessionEvent = <const Type extends string, Fields extends Schema.Struct.Fields>(
  type: Type,
  fields: Fields,
) =>
  Schema.Struct({
    type: Schema.Literal(type),
    data: Schema.Struct({ sessionID: Id, ...fields }),
  });

const blockFields = {
  assistantMessageID: Id,
  ordinal: Schema.Number,
};

const InboxItem = Schema.Struct({
  type: Schema.String,
  delivery: OptionalString,
  payload: Schema.optional(Schema.Unknown),
});

const FormField = Schema.Struct({
  key: Schema.String,
  title: OptionalString,
  description: OptionalString,
  type: Schema.String,
  options: Schema.optional(
    Schema.Array(
      Schema.Struct({
        value: Schema.Unknown,
        label: OptionalString,
        description: OptionalString,
      }),
    ),
  ),
  custom: Schema.optional(Schema.Boolean),
});
export type OpenCodeFormField = typeof FormField.Type;

const Form = Schema.Struct({
  id: Id,
  sessionID: Id,
  title: OptionalString,
  metadata: Schema.optional(Schema.Unknown),
  fields: Schema.Array(FormField),
});
export type OpenCodeForm = typeof Form.Type;

const PermissionRequest = Schema.Struct({
  id: Id,
  sessionID: Id,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  save: Schema.optional(Schema.Array(Schema.String)),
  metadata: Schema.optional(Schema.Unknown),
  source: Schema.optional(
    Schema.Struct({
      type: OptionalString,
      messageID: OptionalString,
      id: OptionalString,
    }),
  ),
});
export type OpenCodePermissionRequest = typeof PermissionRequest.Type;

const ShellInfo = Schema.Struct({
  id: Id,
  command: OptionalString,
  status: OptionalString,
  metadata: Schema.optional(
    Schema.Struct({
      sessionID: OptionalString,
      background: Schema.optional(Schema.Boolean),
    }),
  ),
});

const OpenCodeEventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("server.connected") }),
  sessionEvent("session.created", {
    parentID: Schema.optional(Schema.NullOr(Id)),
    title: OptionalString,
    agent: OptionalString,
    model: Schema.optional(ModelRef),
  }),
  sessionEvent("session.deleted", {}),
  sessionEvent("session.inbox.enqueued", { inboxID: Id, item: InboxItem }),
  sessionEvent("session.inbox.delivered", { inboxID: Id }),
  sessionEvent("session.inbox.cancelled", { inboxID: Id }),
  sessionEvent("session.execution.started", {}),
  sessionEvent("session.execution.succeeded", {}),
  sessionEvent("session.execution.failed", { error: Schema.optional(StructuredError) }),
  sessionEvent("session.execution.interrupted", { reason: OptionalString }),
  sessionEvent("session.step.started", {
    assistantMessageID: Id,
    agent: OptionalString,
    model: Schema.optional(ModelRef),
  }),
  sessionEvent("session.step.ended", {
    assistantMessageID: Id,
    finish: OptionalString,
    tokens: Schema.optional(Tokens),
  }),
  sessionEvent("session.step.failed", {
    assistantMessageID: Id,
    error: Schema.optional(StructuredError),
    tokens: Schema.optional(Tokens),
  }),
  sessionEvent("session.text.started", blockFields),
  sessionEvent("session.text.delta", { ...blockFields, delta: Schema.String }),
  sessionEvent("session.text.ended", { ...blockFields, text: OptionalString }),
  sessionEvent("session.reasoning.started", blockFields),
  sessionEvent("session.reasoning.delta", { ...blockFields, delta: Schema.String }),
  sessionEvent("session.reasoning.ended", { ...blockFields, text: OptionalString }),
  sessionEvent("session.tool.input.started", {
    assistantMessageID: Id,
    id: Id,
    name: Schema.String,
  }),
  sessionEvent("session.tool.called", {
    assistantMessageID: OptionalString,
    id: Id,
    input: Schema.optional(Schema.Unknown),
  }),
  sessionEvent("session.tool.progress", { id: Id, metadata: Schema.optional(Schema.Unknown) }),
  sessionEvent("session.tool.success", {
    id: Id,
    content: Schema.optional(Schema.Array(Schema.Unknown)),
    metadata: Schema.optional(Schema.Unknown),
  }),
  sessionEvent("session.tool.failed", {
    id: Id,
    error: Schema.optional(StructuredError),
    content: Schema.optional(Schema.Array(Schema.Unknown)),
    metadata: Schema.optional(Schema.Unknown),
  }),
  sessionEvent("session.usage.updated", { tokens: Schema.optional(Tokens) }),
  sessionEvent("session.retry.scheduled", {
    attempt: Schema.optional(Schema.Number),
    at: Schema.optional(Schema.Number),
    error: Schema.optional(StructuredError),
  }),
  sessionEvent("session.compaction.started", { reason: OptionalString }),
  sessionEvent("session.compaction.ended", {
    reason: OptionalString,
    text: OptionalString,
    tokens: Schema.optional(Tokens),
  }),
  sessionEvent("session.compaction.failed", {
    reason: OptionalString,
    error: Schema.optional(StructuredError),
  }),
  sessionEvent("session.revert.staged", {}),
  sessionEvent("session.revert.committed", {}),
  sessionEvent("session.revert.cleared", {}),
  Schema.Struct({ type: Schema.Literal("permission.asked"), data: PermissionRequest }),
  Schema.Struct({
    type: Schema.Literal("permission.replied"),
    data: Schema.Struct({ sessionID: Id, requestID: Id, reply: OptionalString }),
  }),
  Schema.Struct({ type: Schema.Literal("form.created"), data: Schema.Struct({ form: Form }) }),
  Schema.Struct({
    type: Schema.Literal("form.replied"),
    data: Schema.Struct({ id: Id, sessionID: Id }),
  }),
  Schema.Struct({
    type: Schema.Literal("form.cancelled"),
    data: Schema.Struct({ id: Id, sessionID: Id }),
  }),
  Schema.Struct({
    type: Schema.Literal("shell.created"),
    data: Schema.Struct({ info: ShellInfo }),
  }),
  Schema.Struct({
    type: Schema.Literal("shell.exited"),
    data: Schema.Struct({ id: Id, exit: Schema.optional(Schema.NullOr(Schema.Number)) }),
  }),
]);

export type OpenCodeEvent = typeof OpenCodeEventSchema.Type;
export type OpenCodeEventOf<Type extends OpenCodeEvent["type"]> = Extract<
  OpenCodeEvent,
  { readonly type: Type }
>;

const decodeEvent = Schema.decodeUnknownOption(OpenCodeEventSchema);

const KNOWN_TYPES: ReadonlySet<string> = new Set(
  OpenCodeEventSchema.members.map((member) => member.fields.type.literal),
);

export type DecodedOpenCodeFrame =
  | { readonly _tag: "Event"; readonly event: OpenCodeEvent }
  /** A type this driver acts on whose payload no longer matches. */
  | { readonly _tag: "Malformed"; readonly type: string }
  /** Anything else; callers ignore it. */
  | { readonly _tag: "Ignored"; readonly type: string };

function frameRecord(frame: unknown): Record<string, unknown> | undefined {
  return typeof frame === "object" && frame !== null && !Array.isArray(frame)
    ? (frame as Record<string, unknown>)
    : undefined;
}

/**
 * An execution frame with a session id but an unexpected payload still
 * settles or starts its turn, with the payload details dropped.
 */
function salvageExecutionFrame(type: string, frame: Record<string, unknown>) {
  const data = frameRecord(frame.data);
  const sessionID = data?.sessionID;
  if (typeof sessionID !== "string") return undefined;
  switch (type) {
    case "session.execution.started":
    case "session.execution.succeeded":
      return { type, data: { sessionID } } as OpenCodeEvent;
    case "session.execution.failed":
      return { type, data: { sessionID, error: undefined } } as OpenCodeEvent;
    case "session.execution.interrupted":
      return { type, data: { sessionID, reason: undefined } } as OpenCodeEvent;
    default:
      return undefined;
  }
}

export function decodeOpenCodeFrame(frame: unknown): DecodedOpenCodeFrame {
  const record = frameRecord(frame);
  const type = typeof record?.type === "string" ? record.type : "";
  if (!record || !KNOWN_TYPES.has(type)) {
    return { _tag: "Ignored", type };
  }
  const decoded = decodeEvent(record);
  if (Option.isSome(decoded)) {
    return { _tag: "Event", event: decoded.value };
  }
  const salvaged = salvageExecutionFrame(type, record);
  return salvaged ? { _tag: "Event", event: salvaged } : { _tag: "Malformed", type };
}

/** The session an event belongs to; forms carry it inside the form. */
export function openCodeEventSessionId(event: OpenCodeEvent): string | undefined {
  switch (event.type) {
    case "server.connected":
    case "shell.exited":
      return undefined;
    case "form.created":
      return event.data.form.sessionID;
    case "shell.created":
      return event.data.info.metadata?.sessionID;
    default:
      return event.data.sessionID;
  }
}

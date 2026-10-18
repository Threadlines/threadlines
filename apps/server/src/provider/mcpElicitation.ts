/**
 * MCP elicitations (a tool server asking the user to fill in a form or open a
 * sign-in link), translated at the provider boundary into the prompt the
 * composer shows (`McpElicitation`) and back into the server's answer.
 *
 * Codex and Claude both hand over the server's request as MCP defines it; only
 * the envelope differs. The requested schema arrives untyped from Claude, so
 * it is decoded here against the MCP spec's primitive schema definitions
 * before anything is shown. A request outside them is not shown at all.
 */
import type { McpElicitation, McpElicitationField } from "@threadlines/contracts";
import {
  mcpElicitationUrl,
  validateMcpElicitationContent,
} from "@threadlines/shared/mcpElicitation";
import * as Schema from "effect/Schema";

/** Optional in MCP, and sometimes sent as null. */
const optional = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.Union([schema, Schema.Null]));

const ConstOption = Schema.Struct({ const: Schema.String, title: Schema.String });

const StringField = Schema.Struct({
  type: Schema.Literal("string"),
  title: optional(Schema.String),
  description: optional(Schema.String),
  default: optional(Schema.String),
  minLength: optional(Schema.Number),
  maxLength: optional(Schema.Number),
  format: optional(Schema.Literals(["email", "uri", "date", "date-time"])),
  enum: optional(Schema.Array(Schema.String)),
  enumNames: optional(Schema.Array(Schema.String)),
  oneOf: optional(Schema.Array(ConstOption)),
});

const NumberField = Schema.Struct({
  type: Schema.Literals(["number", "integer"]),
  title: optional(Schema.String),
  description: optional(Schema.String),
  default: optional(Schema.Number),
  minimum: optional(Schema.Number),
  maximum: optional(Schema.Number),
});

const BooleanField = Schema.Struct({
  type: Schema.Literal("boolean"),
  title: optional(Schema.String),
  description: optional(Schema.String),
  default: optional(Schema.Boolean),
});

const ArrayField = Schema.Struct({
  type: Schema.Literal("array"),
  title: optional(Schema.String),
  description: optional(Schema.String),
  default: optional(Schema.Array(Schema.String)),
  minItems: optional(Schema.Number),
  maxItems: optional(Schema.Number),
  items: Schema.Union([
    Schema.Struct({ type: optional(Schema.Literal("string")), enum: Schema.Array(Schema.String) }),
    Schema.Struct({ anyOf: Schema.Array(ConstOption) }),
  ]),
});

const RequestedSchema = Schema.Struct({
  properties: Schema.Record(
    Schema.String,
    Schema.Union([StringField, NumberField, BooleanField, ArrayField]),
  ),
  required: optional(Schema.Array(Schema.String)),
});
type RequestedField = (typeof RequestedSchema.Type)["properties"][string];

const decodeRequestedSchema = Schema.decodeUnknownOption(RequestedSchema);

/** Null and absent read the same. */
const given = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

function fieldOptions(field: RequestedField): McpElicitationField["options"] {
  if (field.type === "array") {
    return "enum" in field.items
      ? field.items.enum.map((value) => ({ value, label: value }))
      : field.items.anyOf.map((option) => ({ value: option.const, label: option.title }));
  }
  if (field.type !== "string") return undefined;
  if (given(field.enum)) {
    return field.enum.map((value, index) => ({
      value,
      label: field.enumNames?.[index] ?? value,
    }));
  }
  if (given(field.oneOf)) {
    return field.oneOf.map((option) => ({ value: option.const, label: option.title }));
  }
  return undefined;
}

function promptField(name: string, field: RequestedField, required: boolean): McpElicitationField {
  const options = fieldOptions(field);
  const bounds = {
    ...("minimum" in field && given(field.minimum) ? { minimum: field.minimum } : {}),
    ...("maximum" in field && given(field.maximum) ? { maximum: field.maximum } : {}),
    ...("minLength" in field && given(field.minLength) ? { minLength: field.minLength } : {}),
    ...("maxLength" in field && given(field.maxLength) ? { maxLength: field.maxLength } : {}),
    ...("minItems" in field && given(field.minItems) ? { minItems: field.minItems } : {}),
    ...("maxItems" in field && given(field.maxItems) ? { maxItems: field.maxItems } : {}),
    ...("format" in field && given(field.format) ? { format: field.format } : {}),
  };
  return {
    name,
    title: field.title ?? name,
    type: field.type,
    required,
    ...(given(field.description) ? { description: field.description } : {}),
    ...(given(field.default) ? { defaultValue: field.default } : {}),
    ...(options ? { options } : {}),
    ...bounds,
  };
}

/**
 * The prompt for a server's request, or null when it is not one the composer
 * can show: an unknown mode, a link that is not an ordinary web URL, or a form
 * outside MCP's primitive fields.
 */
export function mcpElicitationPrompt(request: {
  readonly serverName: string;
  readonly message: string;
  /** Absent means a form, as MCP defaults it. */
  readonly mode?: string | null;
  readonly url?: string | null;
  readonly requestedSchema?: unknown;
}): McpElicitation | null {
  const { serverName, message } = request;
  if (request.mode === "url") {
    const url = given(request.url) ? mcpElicitationUrl(request.url) : null;
    return url ? { mode: "url", serverName, message, url } : null;
  }
  if (given(request.mode) && request.mode !== "form") return null;
  const schema = decodeRequestedSchema(request.requestedSchema);
  if (schema._tag === "None") return null;
  const required = new Set(schema.value.required ?? []);
  const fields = Object.entries(schema.value.properties).map(([name, field]) =>
    promptField(name, field, required.has(name)),
  );
  return { mode: "form", serverName, message, fields };
}

const isJson = Schema.is(Schema.Json);

/**
 * The answer for the server, from what the composer sent back. No answers at
 * all (a session ending, the provider cancelling) cancel; anything else must
 * be a valid accept, decline or cancel, or this throws with what to fix.
 */
export function mcpElicitationResponse(
  prompt: McpElicitation,
  answers: Readonly<Record<string, unknown>>,
): {
  readonly action: "accept" | "decline" | "cancel";
  readonly content: Schema.Json | null;
} {
  const action = answers.action ?? (Object.keys(answers).length === 0 ? "cancel" : undefined);
  if (action === "cancel" || action === "decline") return { action, content: null };
  if (action !== "accept") throw new Error("Choose Accept, Decline, or Cancel.");
  if (prompt.mode === "url") return { action, content: null };
  const error = validateMcpElicitationContent(prompt, answers.content);
  if (error) throw new Error(error);
  if (!isJson(answers.content)) throw new Error("The form contains an invalid value.");
  return { action, content: answers.content };
}

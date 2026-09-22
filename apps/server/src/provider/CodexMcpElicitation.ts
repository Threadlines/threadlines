import type { McpElicitation, McpElicitationField } from "@threadlines/contracts";
import {
  mcpElicitationUrl,
  validateMcpElicitationContent,
} from "@threadlines/shared/mcpElicitation";
import type {
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
} from "effect-codex-app-server/schema";
import * as Schema from "effect/Schema";

/** Translate standard MCP forms at the provider boundary; native verification remains unsupported. */
export function codexMcpElicitation(
  params: McpServerElicitationRequestParams,
): McpElicitation | null {
  if (params.mode === "url") {
    const url = mcpElicitationUrl(params.url);
    return url
      ? { mode: "url", serverName: params.serverName, message: params.message, url }
      : null;
  }
  if (params.mode !== "form") return null;
  const fields = Object.entries(params.requestedSchema.properties).map(
    ([name, field]): McpElicitationField => {
      const options =
        field.type === "array"
          ? "enum" in field.items
            ? field.items.enum.map((value) => ({ value, label: value }))
            : field.items.anyOf.map((option) => ({ value: option.const, label: option.title }))
          : "enum" in field
            ? field.enum.map((value, index) => ({
                value,
                label: "enumNames" in field ? (field.enumNames?.[index] ?? value) : value,
              }))
            : "oneOf" in field
              ? field.oneOf.map((option) => ({ value: option.const, label: option.title }))
              : undefined;
      return {
        name,
        title: field.title ?? name,
        type: field.type,
        required: params.requestedSchema.required?.includes(name) ?? false,
        ...(field.description != null ? { description: field.description } : {}),
        ...(field.default != null ? { defaultValue: field.default } : {}),
        ...(options ? { options } : {}),
        ...("minimum" in field && field.minimum != null ? { minimum: field.minimum } : {}),
        ...("maximum" in field && field.maximum != null ? { maximum: field.maximum } : {}),
        ...("minLength" in field && field.minLength != null ? { minLength: field.minLength } : {}),
        ...("maxLength" in field && field.maxLength != null ? { maxLength: field.maxLength } : {}),
        ...("minItems" in field && field.minItems != null ? { minItems: field.minItems } : {}),
        ...("maxItems" in field && field.maxItems != null ? { maxItems: field.maxItems } : {}),
        ...("format" in field && field.format != null ? { format: field.format } : {}),
      };
    },
  );
  return { mode: "form", serverName: params.serverName, message: params.message, fields };
}

const isJson = Schema.is(Schema.Json);

export function codexMcpElicitationResponse(
  prompt: McpElicitation,
  answers: Readonly<Record<string, unknown>>,
): McpServerElicitationRequestResponse {
  // Session teardown and provider-side cancellation settle pending inputs with no answers.
  const action = answers.action ?? (Object.keys(answers).length === 0 ? "cancel" : undefined);
  if (action === "cancel" || action === "decline") return { action, content: null };
  if (action !== "accept") throw new Error("Choose Accept, Decline, or Cancel.");
  if (prompt.mode === "url") return { action, content: null };
  const error = validateMcpElicitationContent(prompt, answers.content);
  if (error) throw new Error(error);
  if (!isJson(answers.content)) throw new Error("The form contains an invalid value.");
  return { action, content: answers.content };
}

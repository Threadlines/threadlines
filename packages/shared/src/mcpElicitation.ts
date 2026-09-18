import type { McpElicitation, McpElicitationField } from "@threadlines/contracts";

/** Only ordinary web URLs may be opened from a tool's confirmation prompt. */
export function mcpElicitationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function fieldError(field: McpElicitationField, value: unknown): string | undefined {
  const invalid = `Check ${field.title}.`;
  if (value === undefined) return field.required ? `${field.title} is required.` : undefined;
  if (field.type === "boolean") return typeof value === "boolean" ? undefined : invalid;
  if (field.type === "number" || field.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (field.type === "integer" && !Number.isInteger(value)) ||
      (field.minimum !== undefined && value < field.minimum) ||
      (field.maximum !== undefined && value > field.maximum)
    )
      return invalid;
    return undefined;
  }
  if (field.type === "array") {
    if (
      !Array.isArray(value) ||
      value.some(
        (entry) =>
          typeof entry !== "string" || !field.options?.some((option) => option.value === entry),
      ) ||
      new Set(value).size !== value.length ||
      (field.minItems !== undefined && value.length < field.minItems) ||
      (field.maxItems !== undefined && value.length > field.maxItems)
    )
      return invalid;
    return undefined;
  }
  if (
    typeof value !== "string" ||
    (field.minLength !== undefined && [...value].length < field.minLength) ||
    (field.maxLength !== undefined && [...value].length > field.maxLength) ||
    (field.options !== undefined && !field.options.some((option) => option.value === value))
  )
    return invalid;
  if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return invalid;
  if (field.format === "uri" && !URL.canParse(value)) return invalid;
  if (
    field.format === "date" &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value)
  )
    return invalid;
  if (
    field.format === "date-time" &&
    (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
      !Number.isFinite(Date.parse(value)))
  )
    return invalid;
  return undefined;
}

/** Validate the same typed form values in the client and before releasing the provider request. */
export function validateMcpElicitationContent(
  prompt: McpElicitation,
  content: unknown,
): string | undefined {
  if (prompt.mode === "url") return undefined;
  if (!content || typeof content !== "object" || Array.isArray(content))
    return "Enter the requested details.";
  const record = content as Record<string, unknown>;
  if (Object.keys(record).some((key) => !prompt.fields.some((field) => field.name === key)))
    return "The response contains an unknown field.";
  for (const field of prompt.fields) {
    const error = fieldError(
      field,
      Object.hasOwn(record, field.name) ? record[field.name] : undefined,
    );
    if (error) return error;
  }
  return undefined;
}

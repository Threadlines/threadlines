// @effect-diagnostics preferSchemaOverJson:off
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";

export const decodeJsonResult = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
) => {
  const decode = Schema.decodeExit(Schema.fromJsonString(schema));
  return (input: string) => {
    const result = decode(input);
    if (Exit.isFailure(result)) {
      return Result.fail(result.cause);
    }
    return Result.succeed(result.value);
  };
};

export const decodeUnknownJsonResult = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
) => {
  const decode = Schema.decodeUnknownExit(Schema.fromJsonString(schema));
  return (input: unknown) => {
    const result = decode(input);
    if (Exit.isFailure(result)) {
      return Result.fail(result.cause);
    }
    return Result.succeed(result.value);
  };
};

export const formatSchemaError = (cause: Cause.Cause<Schema.SchemaError>) => {
  const squashed = Cause.squash(cause);
  return Schema.isSchemaError(squashed)
    ? SchemaIssue.makeFormatterDefault()(squashed.issue)
    : Cause.pretty(cause);
};

/** Index just past the string literal that opens at `start`, escapes included. */
function endOfJsonString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === '"') return index + 1;
    index += 1;
  }
  return text.length;
}

/**
 * Strict JSON from a hand-edited JSONC text: `//` and `/* *\/` comments and
 * commas right before `}` or `]` removed, string contents left exactly as
 * written. One pass each, in step with string literals, so a comma, bracket
 * or slash inside a value is never mistaken for syntax. An unterminated
 * block comment is left in place, so the text still fails to parse.
 */
function jsoncToJson(input: string): string {
  const withoutComments: string[] = [];
  let index = 0;
  while (index < input.length) {
    const character = input[index];
    const next = input[index + 1];
    if (character === '"') {
      const end = endOfJsonString(input, index);
      withoutComments.push(input.slice(index, end));
      index = end;
    } else if (character === "/" && next === "/") {
      const lineEnd = input.indexOf("\n", index + 2);
      index = lineEnd === -1 ? input.length : lineEnd;
    } else if (character === "/" && next === "*") {
      const close = input.indexOf("*/", index + 2);
      if (close === -1) {
        withoutComments.push(input.slice(index));
        index = input.length;
      } else {
        index = close + 2;
      }
    } else {
      withoutComments.push(character ?? "");
      index += 1;
    }
  }

  const text = withoutComments.join("");
  const output: string[] = [];
  index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"') {
      const end = endOfJsonString(text, index);
      output.push(text.slice(index, end));
      index = end;
      continue;
    }
    if (character === ",") {
      let ahead = index + 1;
      while (ahead < text.length && /\s/.test(text[ahead] ?? "")) ahead += 1;
      if (text[ahead] === "}" || text[ahead] === "]") {
        index += 1;
        continue;
      }
    }
    output.push(character ?? "");
    index += 1;
  }
  return output.join("");
}

/**
 * A `Getter` that parses a lenient JSON string (tolerating trailing commas
 * and JS-style comments) into an unknown value.
 *
 * Mirrors `SchemaGetter.parseJson()` but strips JSONC syntax with
 * `jsoncToJson` before `JSON.parse`.
 */
const parseLenientJsonGetter = SchemaGetter.transformEffect((input: string) =>
  Effect.try({
    try: () => JSON.parse(jsoncToJson(input)) as unknown,
    catch: (e) => new SchemaIssue.InvalidValue({ message: String(e) }),
  }),
);

/**
 * Schema transformation: lenient JSONC string ↔ unknown.
 *
 * Same API as `SchemaTransformation.fromJsonString`, but the decode side
 * strips trailing commas and JS-style comments before parsing.
 * Encoding produces strict JSON via `JSON.stringify`.
 */
export const fromLenientJsonString = new SchemaTransformation.Transformation(
  parseLenientJsonGetter,
  SchemaGetter.stringifyJson(),
);

export const prettyJsonString = SchemaGetter.compose(
  SchemaGetter.parseJson<string>(),
  SchemaGetter.stringifyJson({ space: 2 }),
);

/**
 * Build a schema that decodes a lenient JSON string into `A`.
 *
 * Drop-in replacement for `Schema.fromJsonString(schema)` that tolerates
 * trailing commas and comments in the input.
 */
export const fromLenientJson = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromLenientJsonString));

export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  if (start < 0) {
    return trimmed;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return trimmed.slice(start, index + 1);
      }
    }
  }

  return trimmed.slice(start);
}

/**
 * Build a JSON string schema that encodes with stable 2-space formatting.
 *
 * Decode behavior matches `Schema.fromJsonString(schema)`. Encode behavior
 * keeps the transformation schema-based while preserving human-readable JSON.
 */
export const fromJsonStringPretty = <S extends Schema.Top>(schema: S) =>
  Schema.fromJsonString(schema).pipe(
    Schema.encode({
      decode: prettyJsonString,
      encode: prettyJsonString,
    }),
  );

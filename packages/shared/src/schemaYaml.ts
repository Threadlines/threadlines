import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  parse as parseYamlString,
  stringify as stringifyYamlValue,
  type CreateNodeOptions,
  type DocumentOptions,
  type ParseOptions,
  type SchemaOptions,
  type ToJSOptions,
  type ToStringOptions,
} from "yaml";

export type YamlParseOptions = ParseOptions & DocumentOptions & SchemaOptions & ToJSOptions;
export type YamlStringifyOptions = DocumentOptions &
  SchemaOptions &
  ParseOptions &
  CreateNodeOptions &
  ToStringOptions;

function formatYamlError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseYaml<E extends string>(
  options?: YamlParseOptions,
): SchemaGetter.Getter<unknown, E> {
  return SchemaGetter.transformOrFail((input: E) =>
    Effect.try({
      try: () => parseYamlString(input, options) as unknown,
      catch: (error) =>
        new SchemaIssue.InvalidValue(Option.some(input), { message: formatYamlError(error) }),
    }),
  );
}

export function stringifyYaml(
  options?: YamlStringifyOptions,
): SchemaGetter.Getter<string, unknown> {
  return SchemaGetter.transformOrFail((input: unknown) =>
    Effect.try({
      try: () => stringifyYamlValue(input, options),
      catch: (error) =>
        new SchemaIssue.InvalidValue(Option.some(input), { message: formatYamlError(error) }),
    }),
  );
}

export const fromYamlString = new SchemaTransformation.Transformation<unknown, string>(
  parseYaml(),
  stringifyYaml(),
);

export const fromYaml = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromYamlString));

#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { make as makeJsonSchemaGenerator } from "@effect/openapi-generator/JsonSchemaGenerator";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const CODEX_PROTOCOL_VERSION = "0.167.0";
const UPSTREAM_REF = `rust-v${CODEX_PROTOCOL_VERSION}`;
const CODEX_SCHEMA_BINARY_ENV = "THREADLINES_CODEX_SCHEMA_BINARY";
/**
 * Codex's JSON Schema links definitions as `#/definitions/<name>`. The OpenAPI
 * 3.1 generator takes refs as `#/components/schemas/<name>` (Effect 4.1 refuses
 * anything else), so every rewritten ref points there.
 */
const COMPONENT_REF_PREFIX = "#/components/schemas/";

/**
 * Lists of words Codex keeps adding to: plan names, hook events and sources,
 * model and plugin metadata. Each sits inside a reply that fills a whole
 * screen or status (the account read, the model list, the hooks and plugin
 * lists) or a notification about the same things, and one word our bindings
 * don't know would otherwise fail all of it (a new plan made the Codex sign-in
 * check fail). In what Codex sends us, each of these also takes any other
 * string, so a new word arrives as text. Requests we send keep the closed list,
 * and statuses the runtime acts on (turn, item and hook run status) stay closed.
 */
const OPEN_ENUM_DEFINITIONS: ReadonlySet<string> = new Set([
  "AccountRoutingOverride",
  "AppTemplateUnavailableReason",
  "AuthMode",
  "CyberAccessProgram",
  "HookEventName",
  "HookExecutionMode",
  "HookHandlerType",
  "HookOutputEntryKind",
  "HookScope",
  "HookSource",
  "HookTrustStatus",
  "InputModality",
  "MultiAgentVersion",
  "PlanType",
  "PluginAuthPolicy",
  "PluginAvailability",
  "PluginDisabledReason",
  "PluginInstallPolicy",
  "PluginInstallPolicySource",
  "PluginShareDiscoverability",
  "PluginSharePrincipalRole",
  "PluginSharePrincipalType",
  "RateLimitReachedType",
  "RateLimitResetCreditStatus",
  "RateLimitResetType",
  "SkillScope",
]);

const JsonSchemaDocument = Schema.StructWithRest(
  Schema.Struct({
    definitions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
);
const decodeJsonSchemaDocument = Schema.decodeEffect(Schema.fromJsonString(JsonSchemaDocument));

interface GeneratedPaths {
  readonly generatedDir: string;
  readonly schemaOutputPath: string;
  readonly metaOutputPath: string;
  readonly namespacesOutputPath: string;
}

interface MethodEntry {
  readonly method: string;
  readonly paramsType?: string;
}

interface JsonSchemaFile {
  readonly namespace?: string;
  readonly exportName: string;
  readonly fileName: string;
  readonly sourcePath: string;
  readonly qualifiedName: string;
}

interface ProtocolSchemaPaths {
  readonly jsonDir: string;
  readonly typescriptDir: string;
}

class GeneratorError extends Schema.TaggedError<GeneratorError>()("GeneratorError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

const ManualSchemas: Record<string, Schema.Json> = {
  GetAuthStatusParams: {
    type: "object",
    title: "GetAuthStatusParams",
    properties: {
      includeToken: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
      refreshToken: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
    },
  },
  GetConversationSummaryParams: {
    title: "GetConversationSummaryParams",
    oneOf: [
      {
        type: "object",
        properties: {
          rolloutPath: { type: "string" },
        },
        required: ["rolloutPath"],
      },
      {
        type: "object",
        properties: {
          conversationId: { type: "string" },
        },
        required: ["conversationId"],
      },
    ],
  },
  GetConversationSummaryResponse: {
    type: "object",
    title: "GetConversationSummaryResponse",
    properties: {
      summary: {},
    },
    required: ["summary"],
  },
  GitDiffToRemoteParams: {
    type: "object",
    title: "GitDiffToRemoteParams",
    properties: {
      cwd: { type: "string" },
    },
    required: ["cwd"],
  },
  GitDiffToRemoteResponse: {
    type: "object",
    title: "GitDiffToRemoteResponse",
    properties: {
      sha: { type: "string" },
      diff: { type: "string" },
    },
    required: ["sha", "diff"],
  },
  GetAuthStatusResponse: {
    type: "object",
    title: "GetAuthStatusResponse",
    properties: {
      authMethod: {
        anyOf: [{}, { type: "null" }],
      },
      authToken: {
        anyOf: [{ type: "string" }, { type: "null" }],
      },
      requiresOpenaiAuth: {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      },
    },
    required: ["authMethod", "authToken", "requiresOpenaiAuth"],
  },
};

const getGeneratedPaths = Effect.fn("getGeneratedPaths")(function* () {
  const path = yield* Path.Path;
  const generatedDir = path.join(import.meta.dirname, "..", "src", "_generated");
  return {
    generatedDir,
    schemaOutputPath: path.join(generatedDir, "schema.gen.ts"),
    metaOutputPath: path.join(generatedDir, "meta.gen.ts"),
    namespacesOutputPath: path.join(generatedDir, "namespaces.gen.ts"),
  } satisfies GeneratedPaths;
});

const ensureGeneratedDir = Effect.fn("ensureGeneratedDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { generatedDir } = yield* getGeneratedPaths();
  yield* fs.makeDirectory(generatedDir, { recursive: true });
});

const runCommand = Effect.fn("runCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Windows runs .cmd shims through cmd.exe, and Effect takes a shell command
  // as one command line, joined as Node would join it.
  const shell = process.platform === "win32";
  const handle = yield* spawner.spawn(
    shell
      ? ChildProcess.make([command, ...args].join(" "), [], { shell })
      : ChildProcess.make(command, args),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      handle.stdout.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (output, chunk) => output + chunk,
        ),
      ),
      handle.stderr.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (output, chunk) => output + chunk,
        ),
      ),
      handle.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0) {
    return yield* new GeneratorError({
      detail: `${command} ${args.join(" ")} failed with exit code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    });
  }
  return { stdout, stderr };
});

const generateProtocolSchemas = Effect.fn("generateProtocolSchemas")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const temporaryDir = yield* fs.makeTempDirectoryScoped({
    prefix: "threadlines-codex-protocol-",
  });
  const jsonDir = path.join(temporaryDir, "json");
  const typescriptDir = path.join(temporaryDir, "typescript");
  const binary = process.env[CODEX_SCHEMA_BINARY_ENV]?.trim() || "codex";
  const version = yield* runCommand(binary, ["--version"]);
  const expectedVersion = `codex-cli ${CODEX_PROTOCOL_VERSION}`;
  if (version.stdout.trim() !== expectedVersion) {
    return yield* new GeneratorError({
      detail: `Codex schema generation requires ${expectedVersion}; received ${version.stdout.trim() || "no version output"}. Set ${CODEX_SCHEMA_BINARY_ENV} to the matching binary.`,
    });
  }

  yield* fs.makeDirectory(jsonDir, { recursive: true });
  yield* fs.makeDirectory(typescriptDir, { recursive: true });
  yield* runCommand(binary, [
    "app-server",
    "generate-json-schema",
    "--experimental",
    "--out",
    jsonDir,
  ]);
  yield* runCommand(binary, [
    "app-server",
    "generate-ts",
    "--experimental",
    "--out",
    typescriptDir,
  ]);

  return { jsonDir, typescriptDir } satisfies ProtocolSchemaPaths;
});

function collectSchemaEntries(
  chunk: string,
): ReadonlyArray<{ readonly name: string; readonly code: string }> {
  const lines = chunk
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
  const entries: Array<{ name: string; code: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const typeLine = lines[index];
    if (!typeLine?.startsWith("export type ")) {
      continue;
    }

    const constLine = lines[index + 1];
    if (!constLine?.startsWith("export const ")) {
      throw new Error(`Malformed generator output near: ${typeLine}`);
    }

    const match = /^export type ([A-Za-z0-9_]+)/.exec(typeLine);
    if (!match?.[1]) {
      throw new Error(`Could not extract schema name from: ${typeLine}`);
    }

    entries.push({
      name: match[1],
      code: `${typeLine}\n${constLine}`,
    });
    index += 1;
  }

  return entries;
}

function normalizeNullableTypes(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(normalizeNullableTypes);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const normalizedEntries = Object.entries(value).map(([key, child]) => [
    key,
    normalizeNullableTypes(child),
  ]);
  const normalizedObject = Object.fromEntries(normalizedEntries) as Record<string, Schema.Json>;
  const typeValue = normalizedObject.type;

  if (!Array.isArray(typeValue)) {
    return normalizedObject;
  }

  const normalizedTypes = typeValue.filter((entry): entry is string => typeof entry === "string");
  if (normalizedTypes.length !== typeValue.length || !normalizedTypes.includes("null")) {
    return normalizedObject;
  }

  const nonNullTypes = normalizedTypes.filter((entry) => entry !== "null");
  if (nonNullTypes.length !== 1) {
    return normalizedObject;
  }
  const nonNullType = nonNullTypes[0]!;

  const nextObject: Record<string, Schema.Json> = {};
  for (const [key, child] of Object.entries(normalizedObject)) {
    if (key !== "type") {
      nextObject[key] = child;
    }
  }

  return {
    anyOf: [
      {
        ...nextObject,
        type: nonNullType,
      },
      { type: "null" },
    ],
  };
}

function stripNullDefaults(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(stripNullDefaults);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, child]) => !(key === "default" && child === null))
      .map(([key, child]) => [key, stripNullDefaults(child)]),
  ) as Schema.Json;
}

/** A JSON value that is an object, not an array or null. */
function isJsonObject(value: Schema.Json | undefined): value is Schema.JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a generated file holds something Codex sends us: a reply or a notification. */
function isSentByCodex(exportName: string): boolean {
  return /(Response|Notification)$/.test(exportName) && exportName !== "ClientNotification";
}

/** A closed list of strings: an enum, or alternatives that are each one. */
function isStringEnumSchema(schema: Schema.Json): schema is Schema.JsonObject {
  if (!isJsonObject(schema)) return false;
  if (Array.isArray(schema.enum)) {
    return schema.enum.length > 0 && schema.enum.every((value) => typeof value === "string");
  }
  const alternatives = schema.oneOf ?? schema.anyOf;
  return (
    Array.isArray(alternatives) && alternatives.length > 0 && alternatives.every(isStringEnumSchema)
  );
}

/** The same closed list, plus any other string (see `OPEN_ENUM_DEFINITIONS`). */
function openStringEnum(schema: Schema.JsonObject): Schema.Json {
  return {
    ...(schema.title !== undefined ? { title: schema.title } : {}),
    ...(schema.description !== undefined ? { description: schema.description } : {}),
    anyOf: [schema, { type: "string" }],
  };
}

/** Keys whose value is one schema, or an array of schemas. */
const SUBSCHEMA_KEYS = new Set([
  "items",
  "prefixItems",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
]);
/** Keys whose value maps names to schemas; the map itself is not a schema. */
const SUBSCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "definitions", "$defs"]);

/**
 * Rebuilds a schema with `transform` applied to each schema directly inside it
 * (property schemas, items, alternatives). Data such as `enum`, `required` or
 * `default`, and the name maps themselves, are never treated as schemas, so a
 * property that happens to be called `properties` stays a property.
 */
function mapSubschemas(
  schema: Schema.JsonObject,
  transform: (child: Schema.Json) => Schema.Json,
): Record<string, Schema.Json> {
  return Object.fromEntries(
    Object.entries(schema).map(([key, child]) => {
      if (SUBSCHEMA_MAP_KEYS.has(key) && isJsonObject(child)) {
        return [
          key,
          Object.fromEntries(Object.entries(child).map(([name, sub]) => [name, transform(sub)])),
        ];
      }
      if (SUBSCHEMA_KEYS.has(key)) {
        return [key, Array.isArray(child) ? child.map(transform) : transform(child)];
      }
      return [key, child];
    }),
  );
}

/** An inline object schema: its own properties, no ref and no alternatives. */
function isPlainObjectSchema(value: Schema.Json): value is Schema.JsonObject {
  return (
    isJsonObject(value) &&
    isJsonObject(value.properties) &&
    !("$ref" in value) &&
    !("anyOf" in value) &&
    !("oneOf" in value) &&
    !("allOf" in value)
  );
}

/**
 * Codex's schema leaves `additionalProperties` unset, which JSON Schema reads
 * as "any other key, any JSON value". Effect 4.1's generator honours that with
 * an index signature on every object type. Marking these objects closed keeps
 * them plain `Schema.Struct`s, which still decode a reply that carries keys a
 * newer Codex added: decoding drops the keys it doesn't know. Objects that say
 * what else they allow (records, free-form maps) keep their own setting.
 */
function closeUnspecifiedObjects(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(closeUnspecifiedObjects);
  }
  if (!isJsonObject(value)) {
    return value;
  }

  const next = mapSubschemas(value, closeUnspecifiedObjects);
  return isJsonObject(next.properties) && !("additionalProperties" in next)
    ? { ...next, additionalProperties: false }
    : next;
}

/**
 * Codex writes some objects as shared properties plus alternatives, such as an
 * image content item that has `type` and `detail` and then either `image_url`
 * or `file_id`. Effect 4.1's generator refuses to intersect such alternatives,
 * so each alternative is merged with the shared part into an object of its own
 * (the union Effect 4.0 used to emit itself).
 */
function distributeObjectAlternatives(value: Schema.Json): Schema.Json {
  if (Array.isArray(value)) {
    return value.map(distributeObjectAlternatives);
  }
  if (!isJsonObject(value)) {
    return value;
  }

  const next = mapSubschemas(value, distributeObjectAlternatives);
  const alternativesKey = "anyOf" in next ? "anyOf" : "oneOf" in next ? "oneOf" : undefined;
  const nested = alternativesKey ? next[alternativesKey] : undefined;
  if (!alternativesKey || !Array.isArray(nested) || !isJsonObject(next.properties)) {
    return next;
  }
  // An alternative that was itself split above (an image item that carries
  // either a URL or a file id) contributes each of its own alternatives.
  const alternatives = nested.flatMap((alternative) => {
    if (!isJsonObject(alternative)) return [alternative];
    const inner = alternative.anyOf ?? alternative.oneOf;
    return Array.isArray(inner) && Object.keys(alternative).length === 1 ? inner : [alternative];
  });
  if (!alternatives.every(isPlainObjectSchema)) {
    return next;
  }

  const { [alternativesKey]: _alternatives, ...shared } = next;
  const sharedProperties = next.properties;
  const sharedRequired = Array.isArray(next.required) ? next.required : [];
  return {
    [alternativesKey]: alternatives.map((alternative) => {
      const required = [
        ...(Array.isArray(alternative.required) ? alternative.required : []),
        ...sharedRequired,
      ];
      return {
        ...shared,
        ...alternative,
        properties: {
          ...(isJsonObject(alternative.properties) ? alternative.properties : {}),
          ...sharedProperties,
        },
        ...(required.length > 0 ? { required: [...new Set(required)] } : {}),
      };
    }),
  };
}

function toPascalCaseMethod(method: string) {
  return method
    .split("/")
    .flatMap((segment) => segment.split(/(?=[A-Z])/))
    .flatMap((segment) => segment.split(/[-_]/))
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
}

function parseRequestEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  // `params?:` marks a request whose params may be omitted (0.150+, e.g.
  // account/usage/read). The generated client still sends the object form.
  const entryPattern = /\{\s*"method":\s*"([^"]+)",\s*id:\s*RequestId,\s*params\??:\s*([^,}]+)/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      // Some compatibility endpoints accept either their ordinary params object
      // or null/undefined. The generated client always sends the object form,
      // so retain the concrete schema name used for request validation and
      // inference.
      paramsType: match[2]!
        .trim()
        .replace(/\s*\|\s*undefined$/, "")
        .replace(/\s*\|\s*null$/, ""),
    });
  }
  return entries;
}

function parseNotificationEntries(fileContents: string): ReadonlyArray<MethodEntry> {
  const entryPattern = /\{\s*"method":\s*"([^"]+)"(?:,\s*"params":\s*([^ }]+))?\s*\}/g;
  const entries: Array<MethodEntry> = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(fileContents)) !== null) {
    entries.push({
      method: match[1]!,
      ...(match[2] ? { paramsType: match[2].trim() } : {}),
    });
  }
  return entries;
}

function resolveSchemaTypeName(
  rawTypeName: string,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  if (rawTypeName === "undefined") {
    return "undefined";
  }

  const candidates = [
    rawTypeName,
    `V2${rawTypeName}`,
    `V2Nullable${rawTypeName}`,
    `V1${rawTypeName}`,
    `SerdeJson${rawTypeName}`,
  ];
  for (const candidate of candidates) {
    if (generatedSchemaNames.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to resolve schema type name: ${rawTypeName}`);
}

function resolveResponseTypeName(
  method: string,
  paramsType: string | undefined,
  generatedSchemaNames: ReadonlySet<string>,
): string {
  const overrides: Record<string, string> = {
    "accountSession/list": "AccountSessionsResponse",
    "account/gatewayOAuth/cancel": "GatewayOAuthCancelResponse",
    "account/gatewayOAuth/login": "GatewayOAuthLoginResponse",
    "account/gatewayOAuth/read": "GatewayOAuthReadResponse",
    "account/logout": "LogoutAccountResponse",
    "account/rateLimits/read": "GetAccountRateLimitsResponse",
    "account/usage/read": "GetAccountTokenUsageResponse",
    "account/workspaceMessages/read": "GetWorkspaceMessagesResponse",
    "config/batchWrite": "ConfigWriteResponse",
    "config/mcpServer/reload": "McpServerRefreshResponse",
    "config/value/write": "ConfigWriteResponse",
    "configRequirements/read": "ConfigRequirementsReadResponse",
    "externalAgentConfig/import/readHistories": "ExternalAgentConfigImportHistoriesReadResponse",
  };

  const override = overrides[method];
  if (override) {
    return resolveSchemaTypeName(override, generatedSchemaNames);
  }

  if (paramsType && paramsType !== "undefined") {
    const fromParams = paramsType.replace(/Params$/, "Response");
    try {
      return resolveSchemaTypeName(fromParams, generatedSchemaNames);
    } catch {
      // Fall through to method-based lookup.
    }
  }

  return resolveSchemaTypeName(`${toPascalCaseMethod(method)}Response`, generatedSchemaNames);
}

function renderMethodConstants(constantName: string, entries: ReadonlyArray<MethodEntry>) {
  return [
    `export const ${constantName} = {`,
    ...entries.map(
      (entry) => `  ${JSON.stringify(entry.method)}: ${JSON.stringify(entry.method)},`,
    ),
    "} as const;",
    "",
  ].join("\n");
}

function renderTypeInterface(
  interfaceName: string,
  entries: ReadonlyArray<MethodEntry>,
  typeName: (entry: MethodEntry) => string,
) {
  return [
    `export interface ${interfaceName} {`,
    ...entries.map((entry) => `  readonly ${JSON.stringify(entry.method)}: ${typeName(entry)};`),
    "}",
    "",
  ].join("\n");
}

function renderSchemaMap(
  constantName: string,
  entries: ReadonlyArray<MethodEntry>,
  typeName: (entry: MethodEntry) => string,
) {
  return [
    `export const ${constantName} = {`,
    ...entries.map((entry) => {
      const schemaName = typeName(entry);
      return `  ${JSON.stringify(entry.method)}: ${
        schemaName === "undefined" ? "undefined" : `CodexSchema.${schemaName}`
      },`;
    }),
    "} as const;",
    "",
  ].join("\n");
}

function renderSchemaTypeReference(schemaName: string) {
  return schemaName === "undefined" ? "undefined" : `typeof CodexSchema.${schemaName}.Type`;
}

function exportNameForPath(filePath: string): string {
  const relative = filePath.replace(/^schema\/json\//, "").replace(/\.json$/, "");
  if (!relative.includes("/")) {
    return relative;
  }

  const [namespace, name] = relative.split("/", 2) as [string, string];
  const namespacePrefix = namespace
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment[0]!.toUpperCase() + segment.slice(1))
    .join("");
  return `${namespacePrefix}${name}`;
}

const buildJsonSchemaFiles = Effect.fn("buildJsonSchemaFiles")(function* (
  directory: string,
  namespace?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(directory);
  return names
    .filter((name) => name.endsWith(".json") && !name.startsWith("codex_app_server_protocol."))
    .map((fileName) => {
      const relative = namespace ? `${namespace}/${fileName}` : fileName;
      return {
        ...(namespace ? { namespace } : {}),
        exportName: exportNameForPath(relative),
        fileName,
        sourcePath: path.join(directory, fileName),
        qualifiedName: relative.replace(/\.json$/, ""),
      } satisfies JsonSchemaFile;
    });
});

function rewriteExternalRefs(
  value: Schema.Json,
  localDefinitionNames: ReadonlyMap<string, string>,
  currentNamespace: string | undefined,
  exportNameByQualifiedName: ReadonlyMap<string, string>,
): Schema.Json {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      rewriteExternalRefs(entry, localDefinitionNames, currentNamespace, exportNameByQualifiedName),
    );
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/definitions/")) {
        const definitionName = child.slice("#/definitions/".length);
        const localRewrite = localDefinitionNames.get(definitionName);
        if (localRewrite) {
          return [key, `${COMPONENT_REF_PREFIX}${localRewrite}`];
        }

        const candidates = [
          ...(currentNamespace ? [`${currentNamespace}/${definitionName}`] : []),
          definitionName,
          definitionName.replace(/^v[12]\//, ""),
          definitionName.replace(/^serde_json\//, ""),
          `v2/${definitionName}`,
          `v1/${definitionName}`,
          `serde_json/${definitionName}`,
        ];

        const rewritten = candidates
          .map((candidate) => exportNameByQualifiedName.get(candidate))
          .find((candidate) => candidate !== undefined);

        if (!rewritten) {
          throw new Error(`Missing rewritten definition for ref: ${child}`);
        }

        return [key, `${COMPONENT_REF_PREFIX}${rewritten}`];
      }

      return [
        key,
        rewriteExternalRefs(
          child,
          localDefinitionNames,
          currentNamespace,
          exportNameByQualifiedName,
        ),
      ];
    }),
  ) as Schema.Json;
}

const generateFiles = Effect.fn("generateFiles")(function* () {
  yield* ensureGeneratedDir();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const protocolSchemas = yield* generateProtocolSchemas();

  const jsonSchemaFiles = [
    ...(yield* buildJsonSchemaFiles(protocolSchemas.jsonDir)),
    ...(yield* buildJsonSchemaFiles(path.join(protocolSchemas.jsonDir, "v1"), "v1")),
    ...(yield* buildJsonSchemaFiles(path.join(protocolSchemas.jsonDir, "v2"), "v2")),
  ].toSorted((left, right) => left.exportName.localeCompare(right.exportName));

  const exportNameByQualifiedName = new Map(
    jsonSchemaFiles.map((file) => [file.qualifiedName, file.exportName]),
  );
  const aggregateSchemas: Record<string, Schema.Json> = {};
  const openedEnumDefinitions = new Set<string>();

  for (const file of jsonSchemaFiles) {
    const raw = yield* fs.readFileString(file.sourcePath);
    const parsed = yield* decodeJsonSchemaDocument(raw);
    const localDefinitionNames = new Map(
      Object.keys(parsed.definitions ?? {}).map((definitionName) => [
        definitionName,
        `${file.exportName}__${definitionName.replace(/[^A-Za-z0-9]/g, "")}`,
      ]),
    );

    for (const [definitionName, definitionSchema] of Object.entries(parsed.definitions ?? {})) {
      const normalized = stripNullDefaults(
        normalizeNullableTypes(
          rewriteExternalRefs(
            definitionSchema,
            localDefinitionNames,
            file.namespace,
            exportNameByQualifiedName,
          ),
        ),
      );
      const opensEnum =
        OPEN_ENUM_DEFINITIONS.has(definitionName) &&
        isSentByCodex(file.exportName) &&
        isStringEnumSchema(normalized);
      if (opensEnum) openedEnumDefinitions.add(definitionName);
      aggregateSchemas[localDefinitionNames.get(definitionName)!] = opensEnum
        ? openStringEnum(normalized)
        : normalized;
    }

    const topLevelSchema: Record<string, Schema.Json> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key !== "definitions") {
        topLevelSchema[key] = value;
      }
    }

    aggregateSchemas[file.exportName] = stripNullDefaults(
      normalizeNullableTypes(
        rewriteExternalRefs(
          topLevelSchema,
          localDefinitionNames,
          file.namespace,
          exportNameByQualifiedName,
        ),
      ),
    );
  }

  // A listed name that no longer exists, or stopped being a list of strings,
  // means Codex renamed or reshaped it: the list needs a look, not silence.
  const unopenedEnums = [...OPEN_ENUM_DEFINITIONS].filter(
    (name) => !openedEnumDefinitions.has(name),
  );
  if (unopenedEnums.length > 0) {
    return yield* new GeneratorError({
      detail: `OPEN_ENUM_DEFINITIONS names no string enum in what Codex sends: ${unopenedEnums.join(", ")}`,
    });
  }

  for (const [name, schema] of Object.entries(ManualSchemas)) {
    if (!(name in aggregateSchemas)) {
      aggregateSchemas[name] = stripNullDefaults(normalizeNullableTypes(schema));
    }
  }

  // Older Codex versions omit isBlocking. The runtime treats those questions
  // as blocking, while preserving an explicit false from newer versions.
  for (const [name, schema] of Object.entries(aggregateSchemas)) {
    if (
      name.endsWith("ToolRequestUserInputParams") &&
      schema !== null &&
      typeof schema === "object" &&
      !Array.isArray(schema) &&
      "required" in schema &&
      Array.isArray(schema.required)
    ) {
      aggregateSchemas[name] = {
        ...schema,
        required: schema.required.filter((field) => field !== "isBlocking"),
      };
    }
  }

  for (const [name, schema] of Object.entries(aggregateSchemas)) {
    aggregateSchemas[name] = closeUnspecifiedObjects(distributeObjectAlternatives(schema));
  }

  const generator = makeJsonSchemaGenerator();
  for (const [name, schema] of Object.entries(aggregateSchemas).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    generator.addSchema(name, schema as never);
  }

  const generatedEntries = new Map<string, string>();
  const output = generator.generate("openapi-3.1", aggregateSchemas as never, false).trim();
  if (output.length > 0) {
    for (const entry of collectSchemaEntries(output)) {
      if (!generatedEntries.has(entry.name)) {
        generatedEntries.set(entry.name, entry.code);
      }
    }
  }

  const generatedSchemaNames = new Set(generatedEntries.keys());
  const clientRequestRaw = yield* fs.readFileString(
    path.join(protocolSchemas.typescriptDir, "ClientRequest.ts"),
  );
  const clientNotificationRaw = yield* fs.readFileString(
    path.join(protocolSchemas.typescriptDir, "ClientNotification.ts"),
  );
  const serverRequestRaw = yield* fs.readFileString(
    path.join(protocolSchemas.typescriptDir, "ServerRequest.ts"),
  );
  const serverNotificationRaw = yield* fs.readFileString(
    path.join(protocolSchemas.typescriptDir, "ServerNotification.ts"),
  );

  const clientRequestEntries = parseRequestEntries(clientRequestRaw);
  const clientNotificationEntries = parseNotificationEntries(clientNotificationRaw);
  const serverRequestEntries = parseRequestEntries(serverRequestRaw);
  const serverNotificationEntries = parseNotificationEntries(serverNotificationRaw);

  const prelude = [
    "// This file is generated by the effect-codex-app-server package. Do not edit manually.",
    `// Upstream protocol ref: ${UPSTREAM_REF}`,
    "",
  ];

  const schemaOutput = [
    ...prelude,
    'import * as Schema from "effect/Schema";',
    "",
    [...generatedEntries.values()].join("\n\n"),
    "",
  ].join("\n");

  const metaOutput = [
    ...prelude,
    'import * as CodexSchema from "./schema.gen.ts";',
    "",
    renderMethodConstants("CLIENT_REQUEST_METHODS", clientRequestEntries),
    renderMethodConstants("CLIENT_NOTIFICATION_METHODS", clientNotificationEntries),
    renderMethodConstants("SERVER_REQUEST_METHODS", serverRequestEntries),
    renderMethodConstants("SERVER_NOTIFICATION_METHODS", serverNotificationEntries),
    "export type ClientRequestMethod = keyof typeof CLIENT_REQUEST_METHODS;",
    "export type ClientNotificationMethod = keyof typeof CLIENT_NOTIFICATION_METHODS;",
    "export type ServerRequestMethod = keyof typeof SERVER_REQUEST_METHODS;",
    "export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_METHODS;",
    "",
    renderTypeInterface("ClientRequestParamsByMethod", clientRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ClientRequestResponsesByMethod", clientRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ClientNotificationParamsByMethod", clientNotificationEntries, (entry) =>
      renderSchemaTypeReference(
        resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ServerRequestParamsByMethod", serverRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ServerRequestResponsesByMethod", serverRequestEntries, (entry) =>
      renderSchemaTypeReference(
        resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
      ),
    ),
    renderTypeInterface("ServerNotificationParamsByMethod", serverNotificationEntries, (entry) =>
      renderSchemaTypeReference(
        resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
      ),
    ),
    renderSchemaMap("CLIENT_REQUEST_PARAMS", clientRequestEntries, (entry) =>
      resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap("CLIENT_REQUEST_RESPONSES", clientRequestEntries, (entry) =>
      resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
    ),
    renderSchemaMap("CLIENT_NOTIFICATION_PARAMS", clientNotificationEntries, (entry) =>
      resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap("SERVER_REQUEST_PARAMS", serverRequestEntries, (entry) =>
      resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
    renderSchemaMap("SERVER_REQUEST_RESPONSES", serverRequestEntries, (entry) =>
      resolveResponseTypeName(entry.method, entry.paramsType, generatedSchemaNames),
    ),
    renderSchemaMap("SERVER_NOTIFICATION_PARAMS", serverNotificationEntries, (entry) =>
      resolveSchemaTypeName(entry.paramsType ?? "undefined", generatedSchemaNames),
    ),
  ].join("\n");

  const namespaceGroups = new Map<string, Array<JsonSchemaFile>>();
  for (const file of jsonSchemaFiles) {
    if (!file.namespace) {
      continue;
    }
    const current = namespaceGroups.get(file.namespace) ?? [];
    current.push(file);
    namespaceGroups.set(file.namespace, current);
  }

  const namespacesOutput = [
    ...prelude,
    'import * as CodexSchema from "./schema.gen.ts";',
    "",
    ...[...namespaceGroups.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([namespace, files]) => {
        const constantName = namespace.replace(/[^A-Za-z0-9]/g, "");
        return [
          `export const ${constantName} = {`,
          ...files
            .toSorted((left, right) => left.fileName.localeCompare(right.fileName))
            .map(
              (file) =>
                `  ${JSON.stringify(file.fileName.replace(/\.json$/, ""))}: CodexSchema.${file.exportName},`,
            ),
          "} as const;",
          "",
        ].join("\n");
      }),
  ].join("\n");

  const { generatedDir, metaOutputPath, namespacesOutputPath, schemaOutputPath } =
    yield* getGeneratedPaths();
  yield* fs.writeFileString(schemaOutputPath, schemaOutput);
  yield* fs.writeFileString(metaOutputPath, metaOutput);
  yield* fs.writeFileString(namespacesOutputPath, namespacesOutput);

  yield* Effect.log(`Generated Codex App Server schemas from ${UPSTREAM_REF}`);

  yield* Effect.service(ChildProcessSpawner.ChildProcessSpawner).pipe(
    Effect.flatMap((spawner) =>
      spawner.spawn(
        process.platform === "win32"
          ? ChildProcess.make(`vp fmt ${generatedDir}`, [], { shell: true })
          : ChildProcess.make("vp", ["fmt", generatedDir]),
      ),
    ),
    Effect.flatMap((child) => child.exitCode),
    Effect.tap((code) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new GeneratorError({
              detail: `vp fmt failed with exit code ${code}`,
            }),
          ),
    ),
  );
});

generateFiles().pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer)),
  NodeRuntime.runMain,
);

import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import { randomUUID } from "node:crypto";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  type ProviderExtensionMcpOAuthStartInput,
  type ProviderExtensionMcpOAuthStartResult,
  type ProviderExtensionMcpReloadInput,
  type ProviderExtensionMcpReloadResult,
  type ProviderExtensionMcpResource,
  type ProviderExtensionMcpResourceReadInput,
  type ProviderExtensionMcpResourceReadResult,
  type ProviderExtensionMcpResourceTemplate,
  ProviderExtensionsError,
  type ProviderExtensionApp,
  type ProviderExtensionMcpServer,
  type ProviderExtensionMcpTool,
  type ProviderExtensionMcpToolCallInput,
  type ProviderExtensionMcpToolCallResult,
  type ProviderExtensionOperationStatusInput,
  type ProviderExtensionOperationStatusResult,
  type ProviderExtensionPlugin,
  type ProviderExtensionPluginInstallInput,
  type ProviderExtensionPluginInstallResult,
  type ProviderExtensionPluginMarketplaceRefreshInput,
  type ProviderExtensionPluginMarketplaceRefreshResult,
  type ProviderExtensionPluginReadInput,
  type ProviderExtensionPluginReadResult,
  type ProviderExtensionPluginToggleInput,
  type ProviderExtensionPluginToggleResult,
  type ProviderExtensionPluginUninstallInput,
  type ProviderExtensionPluginUninstallResult,
  type ProviderExtensionPluginUpdateInput,
  type ProviderExtensionPluginUpdateResult,
  type ProviderExtensionsInventoryInput,
  type ProviderExtensionsInventoryResult,
  type ProviderExtensionProviderInventory,
  type ProviderExtensionSkill,
  type ProviderExtensionSkillToggleInput,
  type ProviderExtensionSkillToggleResult,
  type ProviderInstanceConfig,
  ProviderInstanceId,
  type ProviderInstructionFile,
  type ProviderInstructionFilesInput,
  type ProviderInstructionFilesResult,
  type ProviderInstructionFileKind,
  type ProviderInstructionFileReadOnlyReason,
  type ProviderInstructionWriteInput,
  type ProviderInstructionWriteResult,
  type ServerProvider,
  type ServerSettings,
} from "@threadlines/contracts";

import { makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import { materializeCodexShadowHome, resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { buildCodexInitializeParams } from "./Layers/CodexProvider.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { spawnAndCollect } from "./providerSnapshot.ts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const INVENTORY_COMMAND_TIMEOUT = Duration.seconds(20);
const CODEX_APP_SERVER_INVENTORY_TIMEOUT = Duration.seconds(20);
const CODEX_APP_SERVER_REQUEST_TIMEOUT = Duration.seconds(15);
const CODEX_APP_SERVER_ACTION_TIMEOUT = Duration.seconds(120);
const CLAUDE_PLUGIN_ACTION_TIMEOUT = Duration.seconds(120);
const CODEX_PLUGIN_MARKETPLACE_ACTION_TIMEOUT = Duration.seconds(120);
const CODEX_MCP_OAUTH_DEFAULT_TIMEOUT_SECONDS = 300;
const CODEX_MCP_OAUTH_MAX_TIMEOUT_SECONDS = 900;
const CLAUDE_MCP_LOGIN_VERIFY_INTERVAL_SECONDS = 3;
const MAX_SKILL_FILE_BYTES = 32_000;
const MAX_SKILL_ROOT_SCAN_DIRECTORIES = 250;
const MAX_SKILL_ROOT_SCAN_DEPTH = 6;
const MAX_CLAUDE_NESTED_SKILL_ROOT_SCAN_DIRECTORIES = 400;
const MAX_CLAUDE_NESTED_SKILL_ROOT_SCAN_DEPTH = 5;
const MAX_ERROR_MESSAGE_LENGTH = 240;

const CLAUDE_NESTED_SKILL_ROOT_SKIP_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".claude",
  ".codex",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function requiredText(value: string | null | undefined): string | null {
  return optionalText(value) ?? null;
}

function quotedCodexConfigPathSegment(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function codexPluginEnabledConfigPath(pluginId: string): string {
  return ["plugins", quotedCodexConfigPathSegment(pluginId), "enabled"].join(".");
}

function sanitizeErrorMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const htmlStart = normalized.search(/<(!doctype|html|head|body|div|meta|style|svg)\b/i);
  const withoutHtml = htmlStart >= 0 ? normalized.slice(0, htmlStart) : normalized;
  const withoutTags = withoutHtml
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cleaned = withoutTags.replace(/[:\s]+$/g, "");

  if (cleaned.length === 0) return "Provider command failed.";
  if (cleaned.length <= MAX_ERROR_MESSAGE_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3).trimEnd()}...`;
}

function toErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return sanitizeErrorMessage(cause.message);
  }
  if (cause && typeof cause === "object" && "message" in cause) {
    const message = String((cause as { readonly message?: unknown }).message ?? "").trim();
    if (message.length > 0) return sanitizeErrorMessage(message);
  }
  return sanitizeErrorMessage(String(cause));
}

export function isCodexAppsDirectoryAccessDeniedError(cause: unknown): boolean {
  const message = toErrorMessage(cause);
  return /\b403\b/i.test(message) && /\bforbidden\b/i.test(message);
}

function resultMessage<A>(result: Result.Result<A, unknown>): string | undefined {
  return Result.isFailure(result) ? toErrorMessage(result.failure) : undefined;
}

function relativePathWithinRoot(path: Path.Path, root: string, relativePath: string) {
  const absolutePath = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, absolutePath).replaceAll("\\", "/");
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot === ".." ||
    relativeToRoot.startsWith("../") ||
    path.isAbsolute(relativeToRoot)
  ) {
    return null;
  }
  return { absolutePath, relativePath: relativeToRoot };
}

function instructionRelativePath(kind: ProviderInstructionFileKind): string {
  switch (kind) {
    case "codex-agents":
      return "AGENTS.md";
    case "claude-instructions":
      return "CLAUDE.md";
  }
}

function instructionProviderLabel(kind: ProviderInstructionFileKind): string {
  switch (kind) {
    case "codex-agents":
      return "Codex";
    case "claude-instructions":
      return "Claude";
  }
}

function makeInstructionFile(input: {
  readonly kind: ProviderInstructionFileKind;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly exists: boolean;
  readonly editable: boolean;
  readonly readOnlyReason?: ProviderInstructionFileReadOnlyReason | undefined;
  readonly contents?: string | undefined;
}): ProviderInstructionFile {
  return {
    kind: input.kind,
    scope: "project",
    path: input.absolutePath,
    relativePath: input.relativePath,
    exists: input.exists,
    editable: input.editable,
    ...(input.readOnlyReason !== undefined ? { readOnlyReason: input.readOnlyReason } : {}),
    ...(input.contents !== undefined ? { contents: input.contents } : {}),
  };
}

const readSymbolicLinkTarget = Effect.fn("providerExtensions.readSymbolicLinkTarget")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readLink(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
});

const readInstructionFile = Effect.fn("providerExtensions.readInstructionFile")(function* (
  cwd: string,
  kind: ProviderInstructionFileKind,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const normalizedCwd = path.resolve(cwd);
  const target = relativePathWithinRoot(path, normalizedCwd, instructionRelativePath(kind));
  if (!target) {
    return yield* new ProviderExtensionsError({
      message: `Invalid ${instructionProviderLabel(kind)} instruction path.`,
    });
  }

  const linkTarget = yield* readSymbolicLinkTarget(target.absolutePath);
  if (linkTarget !== null) {
    const contents = yield* fileSystem
      .readFileString(target.absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    return makeInstructionFile({
      kind,
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      exists: true,
      editable: false,
      readOnlyReason: "symbolic-link",
      ...(contents !== undefined ? { contents } : {}),
    });
  }

  const stat = yield* fileSystem
    .stat(target.absolutePath)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!stat) {
    return makeInstructionFile({
      kind,
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      exists: false,
      editable: true,
      contents: "",
    });
  }
  if (stat.type !== "File") {
    return makeInstructionFile({
      kind,
      absolutePath: target.absolutePath,
      relativePath: target.relativePath,
      exists: true,
      editable: false,
      readOnlyReason: "not-regular-file",
    });
  }

  const contents = yield* fileSystem
    .readFileString(target.absolutePath)
    .pipe(Effect.catch(() => Effect.void));
  return makeInstructionFile({
    kind,
    absolutePath: target.absolutePath,
    relativePath: target.relativePath,
    exists: true,
    editable: contents !== undefined,
    ...(contents === undefined ? { readOnlyReason: "unreadable" as const } : {}),
    ...(contents !== undefined ? { contents } : {}),
  });
});

export const writeInstructionFile = Effect.fn("providerExtensions.writeInstructionFile")(function* (
  input: ProviderInstructionWriteInput,
): Effect.fn.Return<
  ProviderInstructionWriteResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const normalizedCwd = path.resolve(input.cwd);
  const target = relativePathWithinRoot(path, normalizedCwd, instructionRelativePath(input.kind));
  if (!target) {
    return yield* new ProviderExtensionsError({
      message: `Invalid ${instructionProviderLabel(input.kind)} instruction path.`,
    });
  }

  const linkTarget = yield* readSymbolicLinkTarget(target.absolutePath);
  if (linkTarget !== null) {
    return yield* new ProviderExtensionsError({
      message: `${target.relativePath} is a symbolic link and cannot be edited from settings.`,
    });
  }

  yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderExtensionsError({
          message: `Failed to create instruction directory: ${cause.message}`,
          cause,
        }),
    ),
  );
  yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderExtensionsError({
          message: `Failed to write ${target.relativePath}: ${cause.message}`,
          cause,
        }),
    ),
  );

  const file = yield* readInstructionFile(normalizedCwd, input.kind);
  return { file };
});

const readInstructionFiles = Effect.fn("providerExtensions.readInstructionFiles")(function* (
  cwd: string | undefined,
) {
  if (!cwd) return [];
  return yield* Effect.all(
    [readInstructionFile(cwd, "codex-agents"), readInstructionFile(cwd, "claude-instructions")],
    { concurrency: "unbounded" },
  );
});

export const readProviderInstructionFiles = Effect.fn(
  "providerExtensions.readProviderInstructionFiles",
)(function* (
  input: ProviderInstructionFilesInput,
): Effect.fn.Return<
  ProviderInstructionFilesResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const cwd = path.resolve(input.cwd);
  const generatedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const instructionFiles = yield* readInstructionFiles(cwd);
  return {
    cwd,
    generatedAt,
    instructionFiles,
  };
});

function codexPluginSource(source: CodexSchema.V2PluginListResponse__PluginSource): string {
  switch (source.type) {
    case "local":
      return source.path;
    case "git":
      return source.url;
    case "npm":
      return source.version ? `${source.package}@${source.version}` : source.package;
    case "remote":
      return "Remote catalog";
  }
}

function mapCodexPlugins(response: CodexSchema.V2PluginListResponse): ProviderExtensionPlugin[] {
  const byId = new Map<string, ProviderExtensionPlugin>();
  for (const marketplace of response.marketplaces) {
    const marketplaceName = requiredText(marketplace.name);
    const marketplacePath = optionalText(marketplace.path ?? null);
    for (const plugin of marketplace.plugins) {
      const id = requiredText(plugin.id);
      if (!id) continue;
      const mapped = {
        id,
        name: requiredText(plugin.name) ?? id,
        displayName: optionalText(plugin.interface?.displayName ?? null),
        description: optionalText(
          plugin.interface?.shortDescription ??
            plugin.interface?.longDescription ??
            plugin.interface?.category ??
            null,
        ),
        enabled: plugin.enabled,
        installed: plugin.installed,
        source: optionalText(codexPluginSource(plugin.source)),
        authPolicy: optionalText(plugin.authPolicy),
        installPolicy: optionalText(plugin.installPolicy),
        availability: optionalText(plugin.availability),
        ...(marketplaceName ? { marketplaceName } : {}),
        ...(marketplacePath ? { marketplacePath } : {}),
        ...(!marketplacePath && marketplaceName ? { remoteMarketplaceName: marketplaceName } : {}),
      } satisfies ProviderExtensionPlugin;
      const existing = byId.get(id);
      if (!existing || (mapped.installed === true && existing.installed !== true)) {
        byId.set(id, mapped);
      }
    }
  }
  return [...byId.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

function mapCodexSkills(
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): ProviderExtensionSkill[] {
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const skills = matchingEntry
    ? matchingEntry.skills
    : response.data.flatMap((entry) => entry.skills);
  return skills
    .flatMap((skill) => {
      const path = requiredText(skill.path);
      if (!path) return [];
      const displayName = optionalText(skill.interface?.displayName ?? null);
      return [
        {
          name: requiredText(skill.name) ?? displayName ?? path,
          path,
          displayName,
          description: optionalText(skill.description),
          shortDescription: optionalText(
            skill.shortDescription ?? skill.interface?.shortDescription ?? null,
          ),
          enabled: skill.enabled,
          scope: skill.scope,
          source: "Codex app-server",
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function codexMcpAuthStatusLabel(
  authStatus: CodexSchema.V2ListMcpServerStatusResponse__McpAuthStatus,
): string {
  switch (authStatus) {
    case "unsupported":
      return "No auth required";
    case "notLoggedIn":
      return "Not logged in";
    case "bearerToken":
      return "Bearer token";
    case "oAuth":
      return "OAuth";
  }
}

function codexMcpServerStatusLabel(
  authStatus: CodexSchema.V2ListMcpServerStatusResponse__McpAuthStatus,
): string {
  return authStatus === "notLoggedIn" ? "Needs auth" : "Ready";
}

export function mapCodexMcpServers(
  response: CodexSchema.V2ListMcpServerStatusResponse,
): ProviderExtensionMcpServer[] {
  return response.data
    .flatMap((server) => {
      const name = requiredText(server.name);
      if (!name) return [];
      const toolDefinitions = Object.entries(server.tools ?? {})
        .flatMap(([toolName, tool]) => {
          const resolvedName = requiredText(tool.name) ?? requiredText(toolName);
          if (!resolvedName) return [];
          return [
            {
              name: resolvedName,
              title: optionalText(tool.title ?? null),
              description: optionalText(tool.description ?? null),
              inputSchema: tool.inputSchema,
              ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
              ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
            } satisfies ProviderExtensionMcpTool,
          ];
        })
        .toSorted((left, right) => left.name.localeCompare(right.name));
      const tools = toolDefinitions.map((tool) => tool.name);
      const resources = (server.resources ?? [])
        .flatMap((resource) => {
          const resourceName = requiredText(resource.name);
          const uri = requiredText(resource.uri);
          if (!resourceName || !uri) return [];
          return [
            {
              name: resourceName,
              uri,
              title: optionalText(resource.title ?? null),
              description: optionalText(resource.description ?? null),
              mimeType: optionalText(resource.mimeType ?? null),
              ...(typeof resource.size === "number" && resource.size >= 0
                ? { size: resource.size }
                : {}),
              ...(resource.annotations !== undefined ? { annotations: resource.annotations } : {}),
            } satisfies ProviderExtensionMcpResource,
          ];
        })
        .toSorted((left, right) => left.name.localeCompare(right.name));
      const resourceTemplates = (server.resourceTemplates ?? [])
        .flatMap((template) => {
          const templateName = requiredText(template.name);
          const uriTemplate = requiredText(template.uriTemplate);
          if (!templateName || !uriTemplate) return [];
          return [
            {
              name: templateName,
              uriTemplate,
              title: optionalText(template.title ?? null),
              description: optionalText(template.description ?? null),
              mimeType: optionalText(template.mimeType ?? null),
              ...(template.annotations !== undefined ? { annotations: template.annotations } : {}),
            } satisfies ProviderExtensionMcpResourceTemplate,
          ];
        })
        .toSorted((left, right) => left.name.localeCompare(right.name));
      return [
        {
          name,
          authStatus: codexMcpAuthStatusLabel(server.authStatus),
          status: codexMcpServerStatusLabel(server.authStatus),
          ...(tools.length > 0 ? { tools } : {}),
          ...(toolDefinitions.length > 0 ? { toolDefinitions } : {}),
          ...(resources.length > 0 ? { resources } : {}),
          ...(resourceTemplates.length > 0 ? { resourceTemplates } : {}),
          toolCount: tools.length,
          resourceCount: resources.length + resourceTemplates.length,
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function mapCodexApps(response: CodexSchema.V2AppsListResponse): ProviderExtensionApp[] {
  return response.data
    .flatMap((app) => {
      const id = requiredText(app.id);
      const name = requiredText(app.name);
      if (!id || !name) return [];
      return [
        {
          id,
          name,
          description: optionalText(app.description ?? app.appMetadata?.seoDescription ?? null),
          enabled: app.isEnabled,
          accessible: app.isAccessible,
        },
      ];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function codexInventoryTimeoutMessage(label: string): string {
  return `Timed out reading Codex ${label}.`;
}

function collectCodexRequest<A, E, R>(
  label: string,
): (
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<Result.Result<A, E | ProviderExtensionsError>, never, R> {
  return (effect) =>
    effect.pipe(
      Effect.timeoutOption(CODEX_APP_SERVER_REQUEST_TIMEOUT),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.fail(
              new ProviderExtensionsError({
                message: codexInventoryTimeoutMessage(label),
              }),
            ),
      ),
      Effect.result,
    );
}

function isThreadNotFoundError(cause: unknown): boolean {
  return /\bthread not found\b/i.test(toErrorMessage(cause));
}

type CodexProviderExtensionActionContext = {
  readonly config: CodexSettings;
  readonly cwd: string;
  readonly environment: Record<string, string>;
};

type ClaudeProviderExtensionActionContext = {
  readonly config: ClaudeSettings;
  readonly cwd: string;
  readonly environment: Record<string, string>;
};

const providerExtensionOperations = new Map<string, ProviderExtensionOperationStatusResult>();
const isProviderExtensionsError = Schema.is(ProviderExtensionsError);

function recordProviderExtensionOperation(
  status: ProviderExtensionOperationStatusResult,
): ProviderExtensionOperationStatusResult {
  providerExtensionOperations.set(status.operationId, status);
  return status;
}

const nowIsoString = Effect.map(DateTime.now, DateTime.formatIso);

function isoStringAfterSeconds(seconds: number): Effect.Effect<string> {
  return DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(DateTime.add(now, { seconds }))));
}

function boundedOAuthTimeoutSeconds(value: number | undefined): number {
  if (value === undefined || value <= 0) return CODEX_MCP_OAUTH_DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.max(value, 30), CODEX_MCP_OAUTH_MAX_TIMEOUT_SECONDS);
}

function commandArg(value: string): string {
  return /^[A-Za-z0-9._:/?=&,-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

function powerShellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function posixSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function codexHomeCommandPrefix(codexHomePath: string | undefined): ReadonlyArray<string> {
  const normalized = optionalText(codexHomePath);
  if (!normalized) return [];
  return process.platform === "win32"
    ? [`$env:CODEX_HOME=${powerShellSingleQuote(normalized)};`]
    : [`CODEX_HOME=${posixSingleQuote(normalized)}`];
}

export function codexMcpLoginCommandForDisplay(input: {
  readonly serverName: string;
  readonly scopes?: ReadonlyArray<string> | undefined;
  readonly binaryPath?: string | undefined;
  readonly codexHomePath?: string | undefined;
}): string {
  const prefix = codexHomeCommandPrefix(input.codexHomePath);
  const args = [
    commandArg(optionalText(input.binaryPath) ?? "codex"),
    "mcp",
    "login",
    commandArg(input.serverName),
  ];
  const scopes = input.scopes ?? [];
  if (scopes.length > 0) {
    args.push("--scopes", commandArg(scopes.join(",")));
  }
  return [...prefix, ...args].join(" ");
}

export function codexSkillConfigWriteParams(
  input: Pick<ProviderExtensionSkillToggleInput, "enabled" | "name" | "path">,
): CodexSchema.V2SkillsConfigWriteParams | null {
  const path = optionalText(input.path);
  if (path) return { enabled: input.enabled, path };

  const name = optionalText(input.name);
  if (name) return { enabled: input.enabled, name };

  return null;
}

function claudeMcpLoginCommand(serverName: string): string {
  return ["claude", "mcp", "login", serverName].map(commandArg).join(" ");
}

function claudeShellArg(value: string): string {
  return process.platform === "win32" ? commandArg(value) : value;
}

function compactProcessEnv(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function toProviderExtensionsError(cause: unknown): ProviderExtensionsError {
  return isProviderExtensionsError(cause)
    ? cause
    : new ProviderExtensionsError({
        message: toErrorMessage(cause),
        cause,
      });
}

function mapCodexRequestError<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ProviderExtensionsError, R> {
  return effect.pipe(Effect.mapError(toProviderExtensionsError));
}

const resolveProviderActionConfig = Effect.fn("providerExtensions.resolveProviderActionConfig")(
  function* (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly settings: ServerSettings;
  }): Effect.fn.Return<ProviderInstanceConfig, ProviderExtensionsError> {
    const configMap = deriveProviderInstanceConfigMap(input.settings);
    const providerConfig = configMap[input.providerInstanceId];
    if (!providerConfig) {
      return yield* new ProviderExtensionsError({
        message: `Provider ${input.providerInstanceId} is not configured.`,
      });
    }
    return providerConfig;
  },
);

const resolveCodexActionContext = Effect.fn("providerExtensions.resolveCodexActionContext")(
  function* (input: {
    readonly cwd?: string | undefined;
    readonly providerInstanceId: ProviderInstanceId;
    readonly settings: ServerSettings;
  }): Effect.fn.Return<
    CodexProviderExtensionActionContext,
    ProviderExtensionsError,
    FileSystem.FileSystem | Path.Path
  > {
    const cwd = input.cwd ?? process.cwd();
    const providerConfig = yield* resolveProviderActionConfig(input);
    if (providerConfig.driver !== CODEX_DRIVER) {
      return yield* new ProviderExtensionsError({
        message: "Native extension actions are currently implemented for Codex providers.",
      });
    }

    const decoded = yield* Effect.try({
      try: () => decodeCodexSettings(providerConfig.config ?? {}),
      catch: (cause) =>
        new ProviderExtensionsError({
          message: `Could not decode Codex settings for ${input.providerInstanceId}.`,
          cause,
        }),
    });
    const enabled = providerConfig.enabled ?? decoded.enabled;
    if (!enabled) {
      return yield* new ProviderExtensionsError({
        message: "Provider is disabled.",
      });
    }

    const config = { ...decoded, enabled };
    const layout = yield* resolveCodexHomeLayout(config);
    yield* materializeCodexShadowHome(layout).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderExtensionsError({
            message: cause.message,
            cause,
          }),
      ),
    );
    return {
      config,
      cwd,
      environment: compactProcessEnv({
        ...mergeProviderInstanceEnvironment(providerConfig.environment ?? []),
        ...(layout.effectiveHomePath ? { CODEX_HOME: layout.effectiveHomePath } : {}),
      }),
    };
  },
);

const resolveClaudeActionContext = Effect.fn("providerExtensions.resolveClaudeActionContext")(
  function* (input: {
    readonly cwd?: string | undefined;
    readonly providerInstanceId: ProviderInstanceId;
    readonly settings: ServerSettings;
  }): Effect.fn.Return<ClaudeProviderExtensionActionContext, ProviderExtensionsError, Path.Path> {
    const cwd = input.cwd ?? process.cwd();
    const providerConfig = yield* resolveProviderActionConfig(input);
    if (providerConfig.driver !== CLAUDE_DRIVER) {
      return yield* new ProviderExtensionsError({
        message: "Claude plugin actions are only available for Claude providers.",
      });
    }

    const decoded = yield* Effect.try({
      try: () => decodeClaudeSettings(providerConfig.config ?? {}),
      catch: (cause) =>
        new ProviderExtensionsError({
          message: `Could not decode Claude settings for ${input.providerInstanceId}.`,
          cause,
        }),
    });
    const enabled = providerConfig.enabled ?? decoded.enabled;
    if (!enabled) {
      return yield* new ProviderExtensionsError({
        message: "Provider is disabled.",
      });
    }

    const config = { ...decoded, enabled };
    const baseEnvironment = mergeProviderInstanceEnvironment(providerConfig.environment ?? []);
    const claudeEnvironment = yield* makeClaudeEnvironment(config, baseEnvironment);
    return {
      config,
      cwd,
      environment: compactProcessEnv(claudeEnvironment),
    };
  },
);

function runCodexAppServerAction<A>(
  context: CodexProviderExtensionActionContext,
  action: (
    client: CodexClient.CodexAppServerClientShape,
  ) => Effect.Effect<A, ProviderExtensionsError>,
): Effect.Effect<A, ProviderExtensionsError, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.scoped(
    Effect.gen(function* () {
      const clientContext = yield* Layer.build(
        CodexClient.layerCommand({
          command: context.config.binaryPath,
          args: ["app-server"],
          cwd: context.cwd,
          env: context.environment,
        }),
      );
      const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
        Effect.provide(clientContext),
      );
      yield* client
        .request("initialize", buildCodexInitializeParams())
        .pipe(Effect.mapError(toProviderExtensionsError));
      yield* client
        .notify("initialized", undefined)
        .pipe(Effect.mapError(toProviderExtensionsError));
      return yield* action(client);
    }),
  ).pipe(
    Effect.timeoutOption(CODEX_APP_SERVER_ACTION_TIMEOUT),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.succeed(result.value)
        : Effect.fail(
            new ProviderExtensionsError({
              message: "Timed out running Codex extension action.",
            }),
          ),
    ),
    Effect.mapError(toProviderExtensionsError),
  );
}

const runCodexCommand = Effect.fn("providerExtensions.runCodexCommand")(function* (input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout?: Duration.Duration | undefined;
}) {
  const result = yield* spawnAndCollect(
    input.binaryPath,
    ChildProcess.make(
      input.binaryPath,
      [...input.args],
      hideWindowsConsole({
        cwd: input.cwd,
        env: input.env,
        shell: process.platform === "win32",
      }),
    ),
  ).pipe(Effect.timeoutOption(input.timeout ?? INVENTORY_COMMAND_TIMEOUT));
  if (Option.isNone(result)) {
    return yield* new ProviderExtensionsError({
      message: `Timed out running ${input.binaryPath} ${input.args.join(" ")}.`,
    });
  }
  return result.value;
});

function providerCommandFailureMessage(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}): string {
  const detail = optionalText(input.stderr) ?? optionalText(input.stdout);
  const command = `${input.command} ${input.args.join(" ")}`;
  return detail
    ? `${command} failed: ${detail}`
    : `${command} failed with exit code ${input.code}.`;
}

const readCodexAppServerInventory = Effect.fn("providerExtensions.readCodexAppServerInventory")(
  function* (input: {
    readonly config: CodexSettings;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly providerThreadId?: string | undefined;
    readonly includeMcpServers?: boolean | undefined;
  }): Effect.fn.Return<
    Pick<
      ProviderExtensionProviderInventory,
      | "plugins"
      | "skills"
      | "mcpServers"
      | "mcpServersStatus"
      | "mcpServersMessage"
      | "apps"
      | "status"
      | "message"
    >,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    const layout = yield* resolveCodexHomeLayout(input.config);
    const materialized = yield* materializeCodexShadowHome(layout).pipe(Effect.result);
    if (Result.isFailure(materialized)) {
      return {
        status: "error",
        message: materialized.failure.message,
        plugins: [],
        skills: [],
        mcpServers: [],
        apps: [],
      };
    }

    const env = {
      ...input.environment,
      ...(layout.effectiveHomePath ? { CODEX_HOME: layout.effectiveHomePath } : {}),
    };
    const clientResult = yield* Effect.scoped(
      Effect.gen(function* () {
        const clientContext = yield* Layer.build(
          CodexClient.layerCommand({
            command: input.config.binaryPath,
            args: ["app-server"],
            cwd: input.cwd,
            env,
          }),
        );
        const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(clientContext),
        );
        yield* client.request("initialize", buildCodexInitializeParams());
        yield* client.notify("initialized", undefined);

        const mcpStatusParams = {
          detail: "toolsAndAuthOnly" as const,
          limit: 100,
          ...(input.providerThreadId !== undefined ? { threadId: input.providerThreadId } : {}),
        };
        const mcpStatusWithoutThreadParams = {
          detail: "toolsAndAuthOnly" as const,
          limit: 100,
        };
        const appListParams = {
          limit: 100,
          ...(input.providerThreadId !== undefined ? { threadId: input.providerThreadId } : {}),
        };
        const appListWithoutThreadParams = {
          limit: 100,
        };

        const includeMcpServers = input.includeMcpServers ?? true;
        const mcpServersEffect = includeMcpServers
          ? client.request("mcpServerStatus/list", mcpStatusParams).pipe(
              Effect.catch((cause) =>
                input.providerThreadId !== undefined && isThreadNotFoundError(cause)
                  ? client.request("mcpServerStatus/list", mcpStatusWithoutThreadParams)
                  : Effect.fail(cause),
              ),
              Effect.map(mapCodexMcpServers),
              collectCodexRequest("MCP servers"),
            )
          : Effect.succeed(Result.succeed([] as ProviderExtensionMcpServer[]));

        const [plugins, skills, mcpServers, apps] = yield* Effect.all(
          [
            client
              .request("plugin/list", { cwds: [input.cwd] })
              .pipe(Effect.map(mapCodexPlugins), collectCodexRequest("plugins")),
            client.request("skills/list", { cwds: [input.cwd] }).pipe(
              Effect.map((response) => mapCodexSkills(response, input.cwd)),
              collectCodexRequest("skills"),
            ),
            mcpServersEffect,
            client.request("app/list", appListParams).pipe(
              Effect.catch((cause) =>
                input.providerThreadId !== undefined && isThreadNotFoundError(cause)
                  ? client.request("app/list", appListWithoutThreadParams)
                  : Effect.fail(cause),
              ),
              Effect.catch((cause) =>
                isCodexAppsDirectoryAccessDeniedError(cause)
                  ? Effect.succeed({ data: [] })
                  : Effect.fail(cause),
              ),
              Effect.map(mapCodexApps),
              collectCodexRequest("apps"),
            ),
          ],
          { concurrency: 2 },
        );
        return { includeMcpServers, plugins, skills, mcpServers, apps };
      }),
    ).pipe(Effect.result, Effect.timeoutOption(CODEX_APP_SERVER_INVENTORY_TIMEOUT));

    if (Option.isNone(clientResult)) {
      return {
        status: "error",
        message: codexInventoryTimeoutMessage("extension inventory"),
        plugins: [],
        skills: [],
        mcpServers: [],
        apps: [],
      };
    }

    if (Result.isFailure(clientResult.value)) {
      return {
        status: "error",
        message: toErrorMessage(clientResult.value.failure),
        plugins: [],
        skills: [],
        mcpServers: [],
        apps: [],
      };
    }

    const data = clientResult.value.success;
    const messages = [
      resultMessage(data.plugins),
      resultMessage(data.skills),
      resultMessage(data.apps),
    ].filter((message): message is string => Boolean(message));
    const mcpServersMessage = Result.isFailure(data.mcpServers)
      ? resultMessage(data.mcpServers)
      : undefined;

    const plugins = Result.isSuccess(data.plugins) ? data.plugins.success : [];
    const skills = Result.isSuccess(data.skills)
      ? annotatePluginBackedSkills(data.skills.success, plugins)
      : [];
    const mcpServersStatus = data.includeMcpServers
      ? Result.isSuccess(data.mcpServers)
        ? "ready"
        : "error"
      : "deferred";

    return {
      status: messages.length > 0 ? "partial" : "ready",
      ...(messages.length > 0 ? { message: messages.join(" ") } : {}),
      plugins,
      skills,
      mcpServers: Result.isSuccess(data.mcpServers) ? data.mcpServers.success : [],
      mcpServersStatus,
      ...(mcpServersMessage ? { mcpServersMessage } : {}),
      apps: Result.isSuccess(data.apps) ? data.apps.success : [],
    };
  },
);

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? optionalText(value) : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function nonNegativeIntegerField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function jsonString(value: unknown): string | undefined {
  if (typeof value === "string") return optionalText(value);
  if (!value || typeof value !== "object") return undefined;
  try {
    return optionalText(JSON.stringify(value));
  } catch {
    return undefined;
  }
}

function shortClaudePluginName(id: string): string {
  return optionalText(id.split("@")[0]) ?? id;
}

function claudePluginMarketplaceName(id: string): string | undefined {
  return optionalText(id.split("@")[1]);
}

function knownIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function claudePluginSource(source: unknown): string | undefined {
  if (typeof source === "string") return optionalText(source);
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const record = source as Record<string, unknown>;
  return stringField(record, "url") ?? stringField(record, "path") ?? jsonString(source);
}

function mapClaudeInstalledPlugin(record: Record<string, unknown>): ProviderExtensionPlugin | null {
  const id = stringField(record, "id");
  if (!id) return null;
  const marketplaceName = claudePluginMarketplaceName(id);
  const version = stringField(record, "version");
  const scope = stringField(record, "scope");
  const installPath = stringField(record, "installPath");
  const installedAt = knownIsoDate(stringField(record, "installedAt"));
  const lastUpdated = knownIsoDate(stringField(record, "lastUpdated"));
  const projectPath = stringField(record, "projectPath");
  return {
    id,
    name: shortClaudePluginName(id),
    installed: true,
    enabled: booleanField(record, "enabled") ?? false,
    source: "Claude CLI",
    ...(marketplaceName ? { marketplaceName, remoteMarketplaceName: marketplaceName } : {}),
    ...(scope ? { scope } : {}),
    ...(version && version !== "unknown" ? { version, description: `Version ${version}` } : {}),
    ...(installPath ? { installPath } : {}),
    ...(installedAt ? { installedAt } : {}),
    ...(lastUpdated ? { lastUpdated } : {}),
    ...(projectPath ? { projectPath } : {}),
  };
}

function mapClaudeAvailablePlugin(record: Record<string, unknown>): ProviderExtensionPlugin | null {
  const id = stringField(record, "pluginId");
  const name = stringField(record, "name") ?? (id ? shortClaudePluginName(id) : undefined);
  const marketplaceName =
    stringField(record, "marketplaceName") ?? (id ? claudePluginMarketplaceName(id) : undefined);
  if (!id || !name) return null;
  const source = claudePluginSource(record.source);
  const description = stringField(record, "description");
  const version = stringField(record, "version");
  const installCount = nonNegativeIntegerField(record, "installCount");
  return {
    id,
    name,
    installed: false,
    ...(description ? { description } : {}),
    ...(source ? { source } : {}),
    ...(marketplaceName ? { marketplaceName, remoteMarketplaceName: marketplaceName } : {}),
    ...(version ? { version } : {}),
    ...(installCount !== undefined ? { installCount } : {}),
  };
}

function parseClaudePluginListJson(value: unknown): ProviderExtensionPlugin[] {
  const root = Array.isArray(value) ? { installed: value } : value;
  if (!root || typeof root !== "object" || Array.isArray(root)) return [];
  const record = root as Record<string, unknown>;
  const byId = new Map<string, ProviderExtensionPlugin>();

  const available = Array.isArray(record.available) ? record.available : [];
  for (const entry of available) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const plugin = mapClaudeAvailablePlugin(entry as Record<string, unknown>);
    if (plugin) byId.set(plugin.id, plugin);
  }

  const installed = Array.isArray(record.installed) ? record.installed : [];
  for (const entry of installed) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const plugin = mapClaudeInstalledPlugin(entry as Record<string, unknown>);
    if (!plugin) continue;
    const availablePlugin = byId.get(plugin.id);
    const description = availablePlugin?.description ?? plugin.description;
    const source = plugin.source ?? availablePlugin?.source;
    const version = plugin.version ?? availablePlugin?.version;
    const installCount = availablePlugin?.installCount;
    byId.set(plugin.id, {
      ...availablePlugin,
      ...plugin,
      ...(description ? { description } : {}),
      ...(source ? { source } : {}),
      ...(version ? { version } : {}),
      ...(installCount !== undefined ? { installCount } : {}),
    });
  }

  return [...byId.values()].toSorted((left, right) => {
    const installedRank = Number(right.installed === true) - Number(left.installed === true);
    return installedRank !== 0 ? installedRank : left.name.localeCompare(right.name);
  });
}

export function parseClaudePluginList(output: string): ProviderExtensionPlugin[] {
  const trimmed = output.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return parseClaudePluginListJson(JSON.parse(trimmed));
    } catch {
      // Fall back to Claude's human-readable format below.
    }
  }

  const plugins: ProviderExtensionPlugin[] = [];
  let current: ProviderExtensionPlugin | null = null;

  for (const line of output.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("> ")) {
      if (current) plugins.push(current);
      const id = trimmed.slice(2).trim();
      current = { id, name: id, installed: true, source: "Claude CLI" };
      continue;
    }

    if (!current) continue;
    const version = trimmed.match(/^Version:\s*(.+)$/i)?.[1]?.trim();
    if (version && version !== "unknown") {
      current = { ...current, description: `Version ${version}` };
      continue;
    }
    const scope = trimmed.match(/^Scope:\s*(.+)$/i)?.[1]?.trim();
    if (scope) {
      current = { ...current, scope };
      continue;
    }
    const status = trimmed
      .match(/^Status:\s*(.+)$/i)?.[1]
      ?.trim()
      .toLowerCase();
    if (status) {
      current = { ...current, enabled: status.includes("enabled") };
    }
  }

  if (current) plugins.push(current);
  return plugins.toSorted((left, right) => left.name.localeCompare(right.name));
}

function normalizeClaudeMcpStatus(value: string | undefined): string | undefined {
  const normalized = optionalText(value?.replace(/^!+\s*/, ""));
  if (!normalized) return undefined;
  return /^needs authentication$/i.test(normalized) ? "Needs authentication" : normalized;
}

function claudeMcpDisplayName(rawName: string): string {
  const parts = rawName
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts[0] === "plugin" && parts.length >= 3) {
    const pluginName = parts[1]!;
    const serverName = parts.slice(2).join(":");
    return serverName === pluginName ? pluginName : `${pluginName}:${serverName}`;
  }
  return rawName.trim();
}

export function parseClaudeMcpList(output: string): ProviderExtensionMcpServer[] {
  const servers: ProviderExtensionMcpServer[] = [];
  for (const line of output.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith("checking ")) continue;
    const match = trimmed.match(/^(.+?):\s+(.+?)(?:\s+-\s+(.+))?$/);
    if (!match) continue;
    const name = claudeMcpDisplayName(match[1]!);
    const target = match[2] ?? "";
    const status = normalizeClaudeMcpStatus(match[3]);
    const transport = target.match(/\(([^)]+)\)\s*$/)?.[1]?.trim();
    const detail = optionalText(target.replace(/\s*\([^)]*\)\s*$/, ""));
    const authStatus = status?.toLowerCase().includes("auth") ? status : undefined;
    servers.push({
      name,
      status: optionalText(status) ?? "configured",
      ...(authStatus ? { authStatus } : {}),
      transport: optionalText(transport),
      ...(detail ? { detail } : {}),
    });
  }
  return servers.toSorted((left, right) => left.name.localeCompare(right.name));
}

function providerExtensionMcpNeedsAuthStatus(
  input: Pick<ProviderExtensionMcpServer, "authStatus" | "status" | "detail">,
): boolean {
  return [input.authStatus, input.status, input.detail]
    .map((value) => value?.trim().toLowerCase() ?? "")
    .some(
      (value) =>
        value.includes("unauth") ||
        value.includes("not logged in") ||
        value.includes("not authenticated") ||
        value.includes("needs auth") ||
        value.includes("login required") ||
        value.includes("expired"),
    );
}

const verifyClaudeMcpLoginStatus = Effect.fn("providerExtensions.verifyClaudeMcpLoginStatus")(
  function* (
    context: ClaudeProviderExtensionActionContext,
    serverName: string,
  ): Effect.fn.Return<
    { readonly authenticated: boolean; readonly message: string },
    ProviderExtensionsError,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    const result = yield* runClaudeCommand({
      binaryPath: context.config.binaryPath,
      args: ["mcp", "list"],
      cwd: context.cwd,
      env: context.environment,
      timeout: INVENTORY_COMMAND_TIMEOUT,
    }).pipe(Effect.mapError(toProviderExtensionsError));
    if (result.code !== 0) {
      return yield* new ProviderExtensionsError({
        message: claudeCommandFailureMessage({ args: ["mcp", "list"], ...result }),
      });
    }

    const servers = parseClaudeMcpList(result.stdout);
    const server = servers.find((entry) => entry.name === serverName);
    if (!server) {
      return {
        authenticated: false,
        message: `Claude login command exited, but ${serverName} was not reported by \`claude mcp list\`.`,
      };
    }

    if (providerExtensionMcpNeedsAuthStatus(server)) {
      return {
        authenticated: false,
        message: `${serverName} still needs authentication after the browser login flow. The browser sign-in may have been cancelled or not completed.`,
      };
    }

    return {
      authenticated: true,
      message: `${serverName} login completed.`,
    };
  },
);

const waitForClaudeMcpLoginStatus = Effect.fn("providerExtensions.waitForClaudeMcpLoginStatus")(
  function* (input: {
    readonly context: ClaudeProviderExtensionActionContext;
    readonly serverName: string;
    readonly operationId: string;
    readonly timeoutSecs: number;
  }): Effect.fn.Return<
    { readonly authenticated: boolean; readonly message: string },
    ProviderExtensionsError,
    ChildProcessSpawner.ChildProcessSpawner
  > {
    const maxAttempts = Math.max(
      1,
      Math.ceil(input.timeoutSecs / CLAUDE_MCP_LOGIN_VERIFY_INTERVAL_SECONDS),
    );

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const verification = yield* verifyClaudeMcpLoginStatus(input.context, input.serverName);
      if (verification.authenticated) return verification;

      recordProviderExtensionOperation({
        operationId: input.operationId,
        kind: "mcp-oauth",
        status: "running",
        message: `Waiting for ${input.serverName} browser sign-in to complete.`,
      });

      if (attempt < maxAttempts - 1) {
        yield* Effect.sleep(Duration.seconds(CLAUDE_MCP_LOGIN_VERIFY_INTERVAL_SECONDS));
      }
    }

    return {
      authenticated: false,
      message: `${input.serverName} still needs authentication after waiting for the browser login flow. The browser sign-in may have been cancelled or not completed.`,
    };
  },
);

function parseSkillMarkdown(input: {
  readonly name: string;
  readonly path: string;
  readonly contents: string;
}) {
  const frontMatter = input.contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata = new Map<string, string>();
  if (frontMatter) {
    for (const line of frontMatter[1]!.split(/\r?\n/g)) {
      const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.*?)\s*$/);
      if (!match) continue;
      metadata.set(normalizeSkillMetadataKey(match[1]!), parseSkillMetadataValue(match[2] ?? ""));
    }
  }
  const enabled = parseSkillMetadataBoolean(metadata.get("defaultenabled")) ?? true;
  return {
    name: optionalText(metadata.get("name")) ?? input.name,
    path: input.path,
    ...(optionalText(metadata.get("displayname"))
      ? { displayName: optionalText(metadata.get("displayname")) }
      : {}),
    ...(optionalText(metadata.get("description"))
      ? { description: optionalText(metadata.get("description")) }
      : {}),
    ...(optionalText(metadata.get("shortdescription"))
      ? { shortDescription: optionalText(metadata.get("shortdescription")) }
      : {}),
    enabled,
    source: "Filesystem",
  } satisfies ProviderExtensionSkill;
}

function normalizeSkillMetadataKey(value: string): string {
  return value.replace(/[-_]/g, "").toLowerCase();
}

function parseSkillMetadataValue(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseSkillMetadataBoolean(value: string | undefined): boolean | undefined {
  const normalized = optionalText(value)?.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function withSkillInventoryMetadata(
  skill: ProviderExtensionSkill,
  input: { readonly scope: "project" | "user"; readonly source: string },
): ProviderExtensionSkill {
  return {
    name: skill.name,
    path: skill.path,
    ...(skill.displayName !== undefined ? { displayName: skill.displayName } : {}),
    ...(skill.description !== undefined ? { description: skill.description } : {}),
    ...(skill.shortDescription !== undefined ? { shortDescription: skill.shortDescription } : {}),
    ...(skill.enabled !== undefined ? { enabled: skill.enabled } : {}),
    scope: input.scope,
    source: input.source,
    ...(skill.bundleId !== undefined ? { bundleId: skill.bundleId } : {}),
    ...(skill.bundleName !== undefined ? { bundleName: skill.bundleName } : {}),
    ...(skill.bundleDisplayName !== undefined
      ? { bundleDisplayName: skill.bundleDisplayName }
      : {}),
  };
}

interface DiscoveredClaudeSkill {
  readonly skill: ProviderExtensionSkill;
  readonly scope: "project" | "user";
  readonly source: string;
  readonly priority: number;
  readonly namespace?: string | undefined;
  readonly relativeDirectory: string;
}

interface ClaudeSkillRoot {
  readonly root: string;
  readonly scope: "project" | "user";
  readonly source: string;
  readonly priority: number;
  readonly namespace?: string | undefined;
}

function posixRelativePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizedPathKey(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export interface PluginBackedSkillBundle {
  readonly bundleId: string;
  readonly bundleName: string;
}

export function derivePluginBackedSkillBundle(skillPath: string): PluginBackedSkillBundle | null {
  const normalized = skillPath.replaceAll("\\", "/");
  const pluginCacheMatch = normalized.match(/\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+\/skills\//i);
  if (pluginCacheMatch) {
    const marketplaceName = optionalText(pluginCacheMatch[1]);
    const pluginName = optionalText(pluginCacheMatch[2]);
    if (marketplaceName && pluginName) {
      return {
        bundleId: `${pluginName}@${marketplaceName}`,
        bundleName: pluginName,
      };
    }
  }

  const runtimePluginMatch = normalized.match(/\/plugins\/([^/]+)\/plugins\/([^/]+)\/skills\//i);
  if (runtimePluginMatch) {
    const marketplaceName = optionalText(runtimePluginMatch[1]);
    const pluginName = optionalText(runtimePluginMatch[2]);
    if (marketplaceName && pluginName) {
      return {
        bundleId: `${pluginName}@${marketplaceName}`,
        bundleName: pluginName,
      };
    }
  }

  return null;
}

function annotatePluginBackedSkills(
  skills: ReadonlyArray<ProviderExtensionSkill>,
  plugins: ReadonlyArray<ProviderExtensionPlugin>,
): ProviderExtensionSkill[] {
  const pluginsById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  return skills.map((skill) => {
    const bundle = derivePluginBackedSkillBundle(skill.path);
    if (!bundle) return skill;

    const plugin = pluginsById.get(bundle.bundleId);
    return {
      ...skill,
      bundleId: plugin?.id ?? bundle.bundleId,
      bundleName: plugin?.name ?? bundle.bundleName,
      ...(plugin?.displayName !== undefined ? { bundleDisplayName: plugin.displayName } : {}),
    };
  });
}

function skillNamespace(input: {
  readonly rootNamespace?: string | undefined;
  readonly relativeDirectory: string;
}): string | undefined {
  const parent = input.relativeDirectory.split("/").slice(0, -1).join("/");
  const parts = [input.rootNamespace, parent].flatMap((value) => {
    const trimmed = optionalText(value);
    return trimmed ? [trimmed] : [];
  });
  return parts.length > 0 ? parts.join("/") : undefined;
}

function namespaceSkillName(
  skill: ProviderExtensionSkill,
  namespace: string,
): ProviderExtensionSkill {
  return {
    ...skill,
    name: `${namespace}:${skill.name}`,
  };
}

function finalizeClaudeSkills(
  discovered: ReadonlyArray<DiscoveredClaudeSkill>,
): ProviderExtensionSkill[] {
  const byName = new Map<string, DiscoveredClaudeSkill[]>();
  for (const entry of discovered) {
    const group = byName.get(entry.skill.name) ?? [];
    group.push(entry);
    byName.set(entry.skill.name, group);
  }

  const output: ProviderExtensionSkill[] = [];
  for (const group of byName.values()) {
    if (group.length === 1) {
      output.push(group[0]!.skill);
      continue;
    }

    const namespaceEntries: ProviderExtensionSkill[] = [];
    const unprefixedEntries: DiscoveredClaudeSkill[] = [];
    for (const entry of group) {
      if (entry.namespace) {
        namespaceEntries.push(namespaceSkillName(entry.skill, entry.namespace));
      } else {
        unprefixedEntries.push(entry);
      }
    }

    if (unprefixedEntries.length > 0) {
      const winner = unprefixedEntries.toSorted(
        (left, right) => right.priority - left.priority,
      )[0]!;
      output.push(winner.skill);
    }
    output.push(...namespaceEntries);
  }

  const uniqueByNameAndPath = new Map<string, ProviderExtensionSkill>();
  for (const skill of output) {
    uniqueByNameAndPath.set(`${skill.name}\0${skill.path}`, skill);
  }
  return [...uniqueByNameAndPath.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
}

const readSkillsFromRoot = Effect.fn("providerExtensions.readSkillsFromRoot")(function* (
  rootInput: ClaudeSkillRoot,
): Effect.fn.Return<DiscoveredClaudeSkill[], never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(rootInput.root);
  const stat = yield* fileSystem.stat(root).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!stat || stat.type !== "Directory") return [];

  let scannedDirectories = 0;
  const skillDirectories: Array<{
    readonly directory: string;
    readonly skillPath: string;
    readonly size: number;
  }> = [];

  const walk = (directory: string, depth: number): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (depth > MAX_SKILL_ROOT_SCAN_DEPTH) return;
      if (scannedDirectories >= MAX_SKILL_ROOT_SCAN_DIRECTORIES) return;
      scannedDirectories += 1;

      const skillPath = path.join(directory, "SKILL.md");
      const skillStat = yield* fileSystem
        .stat(skillPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (directory !== root && skillStat?.type === "File") {
        skillDirectories.push({ directory, skillPath, size: Number(skillStat.size) });
        return;
      }

      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.catch(() => Effect.succeed([])));
      for (const entry of entries) {
        const child = path.join(directory, entry);
        const childStat = yield* fileSystem
          .stat(child)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (childStat?.type === "Directory") {
          yield* walk(child, depth + 1);
        }
      }
    });

  yield* walk(root, 0);

  const skills: Array<DiscoveredClaudeSkill | null> = yield* Effect.forEach(
    skillDirectories,
    ({ directory, skillPath, size }) =>
      Effect.gen(function* () {
        const entry = path.basename(directory);
        const relativeDirectory = posixRelativePath(path.relative(root, directory));
        const namespace = skillNamespace({
          rootNamespace: rootInput.namespace,
          relativeDirectory,
        });
        if (size > MAX_SKILL_FILE_BYTES) {
          const skill = withSkillInventoryMetadata(
            {
              name: entry,
              path: skillPath,
              enabled: true,
            },
            rootInput,
          );
          return {
            skill,
            scope: rootInput.scope,
            source: rootInput.source,
            priority: rootInput.priority,
            namespace,
            relativeDirectory,
          } satisfies DiscoveredClaudeSkill;
        }
        const contents = yield* fileSystem
          .readFileString(skillPath)
          .pipe(Effect.catch(() => Effect.succeed("")));
        const skill = withSkillInventoryMetadata(
          parseSkillMarkdown({ name: entry, path: skillPath, contents }),
          rootInput,
        );
        return {
          skill,
          scope: rootInput.scope,
          source: rootInput.source,
          priority: rootInput.priority,
          namespace,
          relativeDirectory,
        } satisfies DiscoveredClaudeSkill;
      }),
    { concurrency: 8 },
  );

  return skills
    .filter((skill): skill is DiscoveredClaudeSkill => skill !== null)
    .toSorted((left, right) => left.skill.name.localeCompare(right.skill.name));
});

const discoverNestedClaudeSkillRoots = Effect.fn(
  "providerExtensions.discoverNestedClaudeSkillRoots",
)(function* (
  cwd: string,
): Effect.fn.Return<ClaudeSkillRoot[], never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(cwd);
  const roots: ClaudeSkillRoot[] = [];
  let scannedDirectories = 0;

  const walk = (directory: string, depth: number): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (depth > MAX_CLAUDE_NESTED_SKILL_ROOT_SCAN_DEPTH) return;
      if (scannedDirectories >= MAX_CLAUDE_NESTED_SKILL_ROOT_SCAN_DIRECTORIES) return;
      scannedDirectories += 1;

      const skillRoot = path.join(directory, ".claude", "skills");
      const skillRootStat = yield* fileSystem
        .stat(skillRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (skillRootStat?.type === "Directory") {
        const relativeDirectory = posixRelativePath(path.relative(root, directory));
        const namespace =
          relativeDirectory.length > 0 && relativeDirectory !== "." ? relativeDirectory : undefined;
        roots.push({
          root: skillRoot,
          scope: "project",
          source: namespace ? `Claude project: ${namespace}` : "Claude project",
          priority: 1_500 - depth,
          namespace,
        });
      }

      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.catch(() => Effect.succeed([])));
      for (const entry of entries) {
        if (CLAUDE_NESTED_SKILL_ROOT_SKIP_DIRECTORIES.has(entry)) continue;
        const child = path.join(directory, entry);
        const childStat = yield* fileSystem
          .stat(child)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (childStat?.type === "Directory") {
          yield* walk(child, depth + 1);
        }
      }
    });

  yield* walk(root, 0);
  return roots;
});

function claudeAncestorSkillRoots(path: Path.Path, cwd: string): ClaudeSkillRoot[] {
  const roots: ClaudeSkillRoot[] = [];
  const startingDirectory = path.resolve(cwd);
  let current = startingDirectory;
  let depth = 0;

  while (true) {
    const relativeDirectory = posixRelativePath(path.relative(startingDirectory, current));
    const label =
      relativeDirectory.length > 0 && relativeDirectory !== "." ? relativeDirectory : undefined;
    roots.push({
      root: path.join(current, ".claude", "skills"),
      scope: "project",
      source: label ? `Claude project: ${label}` : "Claude project",
      priority: 1_000 - depth,
    });

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    depth += 1;
  }

  return roots;
}

function uniqueClaudeSkillRoots(
  roots: ReadonlyArray<ClaudeSkillRoot>,
  path: Path.Path,
): ClaudeSkillRoot[] {
  const byPath = new Map<string, ClaudeSkillRoot>();
  for (const root of roots) {
    const resolved = path.resolve(root.root);
    const key = normalizedPathKey(resolved);
    const existing = byPath.get(key);
    if (!existing || root.priority > existing.priority) {
      byPath.set(key, { ...root, root: resolved });
    }
  }
  return [...byPath.values()].toSorted((left, right) => right.priority - left.priority);
}

const readClaudeSkills = Effect.fn("providerExtensions.readClaudeSkills")(function* (
  claudeHome: string,
  cwd: string,
) {
  const path = yield* Path.Path;
  const nestedProjectRoots = yield* discoverNestedClaudeSkillRoots(cwd);
  const skillRoots = uniqueClaudeSkillRoots(
    [
      ...nestedProjectRoots,
      ...claudeAncestorSkillRoots(path, cwd),
      {
        root: path.join(claudeHome, ".claude", "skills"),
        scope: "user",
        source: "Claude user",
        priority: 0,
      },
    ],
    path,
  );
  const discovered = yield* Effect.forEach(skillRoots, readSkillsFromRoot, {
    concurrency: 8,
  });
  return finalizeClaudeSkills(discovered.flat());
});

const runClaudeCommand = Effect.fn("providerExtensions.runClaudeCommand")(function* (input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout?: Duration.Duration | undefined;
}) {
  const result = yield* spawnAndCollect(
    input.binaryPath,
    ChildProcess.make(
      input.binaryPath,
      [...input.args],
      hideWindowsConsole({
        cwd: input.cwd,
        env: input.env,
        shell: process.platform === "win32",
      }),
    ),
  ).pipe(Effect.timeoutOption(input.timeout ?? INVENTORY_COMMAND_TIMEOUT));
  if (Option.isNone(result)) {
    return yield* new ProviderExtensionsError({
      message: `Timed out running ${input.binaryPath} ${input.args.join(" ")}.`,
    });
  }
  return result.value;
});

function claudeCommandFailureMessage(input: {
  readonly args: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}): string {
  const detail = optionalText(input.stderr) ?? optionalText(input.stdout);
  const command = `claude ${input.args.join(" ")}`;
  return detail
    ? `${command} failed: ${detail}`
    : `${command} failed with exit code ${input.code}.`;
}

function claudeMcpLoginFailureMessage(input: {
  readonly serverName: string;
  readonly args: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}): string {
  const base = claudeCommandFailureMessage(input);
  if (
    /\b(awaiting|pending) approval\b/i.test(base) ||
    /\.mcp\.json servers are awaiting approval/i.test(base)
  ) {
    return `${base}\n\nClaude has not approved one or more .mcp.json servers for this project yet. Run \`claude\` in this project, approve the MCP configuration, then retry authorization in Threadlines.`;
  }
  if (/\bNo MCP server named\b/i.test(base) && /\s/.test(input.serverName)) {
    return `${base}\n\nThreadlines tried to log in to "${input.serverName}". If Claude still cannot find it after refreshing, run \`claude mcp list\` in this project and use the exact server name reported by Claude.`;
  }
  return base;
}

const runClaudePluginAction = Effect.fn("providerExtensions.runClaudePluginAction")(function* (
  context: ClaudeProviderExtensionActionContext,
  args: ReadonlyArray<string>,
) {
  const result = yield* runClaudeCommand({
    binaryPath: context.config.binaryPath,
    args,
    cwd: context.cwd,
    env: context.environment,
    timeout: CLAUDE_PLUGIN_ACTION_TIMEOUT,
  }).pipe(Effect.mapError(toProviderExtensionsError));
  if (result.code !== 0) {
    return yield* new ProviderExtensionsError({
      message: claudeCommandFailureMessage({ args, ...result }),
    });
  }
  return result;
});

function claudePluginSelector(input: {
  readonly pluginId?: string | undefined;
  readonly pluginName?: string | undefined;
  readonly remoteMarketplaceName?: string | undefined;
}): string {
  const raw = optionalText(input.pluginId) ?? optionalText(input.pluginName) ?? "";
  if (!raw || raw.includes("@") || !input.remoteMarketplaceName) return raw;
  return `${raw}@${input.remoteMarketplaceName}`;
}

function claudePluginScopeArgs(
  scope: string | undefined,
  allowedScopes: ReadonlySet<string> = new Set(["user", "project", "local"]),
): ReadonlyArray<string> {
  const normalized = optionalText(scope)?.toLowerCase();
  return normalized && allowedScopes.has(normalized) ? ["--scope", normalized] : [];
}

function unsupportedProviderExtensionAction(driver: ProviderDriverKind, action: string) {
  return new ProviderExtensionsError({
    message: `${action} is not implemented for provider driver ${driver}.`,
  });
}

const readClaudeInventory = Effect.fn("providerExtensions.readClaudeInventory")(function* (input: {
  readonly config: ClaudeSettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const claudeEnvironment = yield* makeClaudeEnvironment(input.config, input.environment);
  const path = yield* Path.Path;
  const claudeHome = claudeEnvironment.HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? "";

  const [pluginResult, mcpResult, skillsResult] = yield* Effect.all(
    [
      runClaudeCommand({
        binaryPath: input.config.binaryPath,
        args: ["plugin", "list", "--available", "--json"],
        cwd: input.cwd,
        env: claudeEnvironment,
      }).pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result)
            : Effect.fail(
                new ProviderExtensionsError({
                  message: claudeCommandFailureMessage({
                    args: ["plugin", "list", "--available", "--json"],
                    ...result,
                  }),
                }),
              ),
        ),
        Effect.map((result) => parseClaudePluginList(result.stdout)),
        Effect.result,
      ),
      runClaudeCommand({
        binaryPath: input.config.binaryPath,
        args: ["mcp", "list"],
        cwd: input.cwd,
        env: claudeEnvironment,
      }).pipe(
        Effect.map((result) => parseClaudeMcpList(result.stdout)),
        Effect.result,
      ),
      readClaudeSkills(path.resolve(claudeHome), input.cwd).pipe(Effect.result),
    ],
    { concurrency: "unbounded" },
  );

  const messages = [
    resultMessage(pluginResult),
    resultMessage(mcpResult),
    resultMessage(skillsResult),
  ].filter((message): message is string => Boolean(message));
  const plugins = Result.isSuccess(pluginResult) ? pluginResult.success : [];
  const skills = Result.isSuccess(skillsResult)
    ? annotatePluginBackedSkills(skillsResult.success, plugins)
    : [];
  return {
    status: messages.length > 0 ? "partial" : "ready",
    ...(messages.length > 0 ? { message: messages.join(" ") } : {}),
    plugins,
    skills,
    mcpServers: Result.isSuccess(mcpResult) ? mcpResult.success : [],
    apps: [],
  } satisfies Pick<
    ProviderExtensionProviderInventory,
    "plugins" | "skills" | "mcpServers" | "apps" | "status" | "message"
  >;
});

function fallbackSkillsFromSnapshot(
  snapshot: ServerProvider | undefined,
): ProviderExtensionSkill[] {
  return (snapshot?.skills ?? []).map((skill) => ({
    name: skill.name,
    path: skill.path,
    displayName: skill.displayName,
    description: skill.description,
    shortDescription: skill.shortDescription,
    enabled: skill.enabled,
    scope: skill.scope,
    source: "Provider status",
  }));
}

const readProviderInventory = Effect.fn("providerExtensions.readProviderInventory")(
  function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly config: ProviderInstanceConfig;
    readonly snapshot: ServerProvider | undefined;
    readonly cwd: string;
    readonly providerThreadId?: string | undefined;
    readonly includeMcpServers?: boolean | undefined;
  }) {
    const processEnv = mergeProviderInstanceEnvironment(input.config.environment ?? []);
    const base = {
      instanceId: input.instanceId,
      driver: input.config.driver,
      displayName: input.config.displayName ?? input.snapshot?.displayName,
    };

    if (input.config.driver === CODEX_DRIVER) {
      const decoded = yield* Effect.try({
        try: () => decodeCodexSettings(input.config.config ?? {}),
        catch: (cause) =>
          new ProviderExtensionsError({
            message: `Could not decode Codex settings for ${input.instanceId}.`,
            cause,
          }),
      });
      const enabled = input.config.enabled ?? decoded.enabled;
      if (!enabled) {
        return {
          ...base,
          status: "disabled",
          message: "Provider is disabled.",
          plugins: [],
          skills: fallbackSkillsFromSnapshot(input.snapshot),
          mcpServers: [],
          apps: [],
        } satisfies ProviderExtensionProviderInventory;
      }

      const inventory = yield* readCodexAppServerInventory({
        config: { ...decoded, enabled },
        cwd: input.cwd,
        environment: processEnv,
        ...(input.providerThreadId !== undefined
          ? { providerThreadId: input.providerThreadId }
          : {}),
        ...(input.includeMcpServers !== undefined
          ? { includeMcpServers: input.includeMcpServers }
          : {}),
      });
      return {
        ...base,
        ...inventory,
        skills:
          inventory.skills.length > 0
            ? inventory.skills
            : fallbackSkillsFromSnapshot(input.snapshot),
      } satisfies ProviderExtensionProviderInventory;
    }

    if (input.config.driver === CLAUDE_DRIVER) {
      const decoded = yield* Effect.try({
        try: () => decodeClaudeSettings(input.config.config ?? {}),
        catch: (cause) =>
          new ProviderExtensionsError({
            message: `Could not decode Claude settings for ${input.instanceId}.`,
            cause,
          }),
      });
      const enabled = input.config.enabled ?? decoded.enabled;
      if (!enabled) {
        return {
          ...base,
          status: "disabled",
          message: "Provider is disabled.",
          plugins: [],
          skills: [],
          mcpServers: [],
          apps: [],
        } satisfies ProviderExtensionProviderInventory;
      }
      const inventory = yield* readClaudeInventory({
        config: { ...decoded, enabled },
        cwd: input.cwd,
        environment: processEnv,
      });
      return { ...base, ...inventory } satisfies ProviderExtensionProviderInventory;
    }

    return {
      ...base,
      status: "unsupported",
      message: "Extension inventory is only implemented for Codex and Claude.",
      plugins: [],
      skills: [],
      mcpServers: [],
      apps: [],
    } satisfies ProviderExtensionProviderInventory;
  },
);

export const startProviderExtensionMcpOAuth = Effect.fn(
  "providerExtensions.startProviderExtensionMcpOAuth",
)(function* (input: {
  readonly request: ProviderExtensionMcpOAuthStartInput;
  readonly settings: ServerSettings;
}): Effect.fn.Return<
  ProviderExtensionMcpOAuthStartResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const providerConfig = yield* resolveProviderActionConfig({
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  if (providerConfig.driver === CLAUDE_DRIVER) {
    const context = yield* resolveClaudeActionContext({
      cwd: input.request.cwd,
      providerInstanceId: input.request.providerInstanceId,
      settings: input.settings,
    });
    const timeoutSecs = boundedOAuthTimeoutSeconds(input.request.timeoutSecs);
    const operationId = randomUUID();
    const expiresAt = yield* isoStringAfterSeconds(timeoutSecs);
    const args = ["mcp", "login", claudeShellArg(input.request.serverName)];
    const terminalCommand = claudeMcpLoginCommand(input.request.serverName);

    recordProviderExtensionOperation({
      operationId,
      kind: "mcp-oauth",
      status: "running",
      message: `Opening ${input.request.serverName} login with Claude.`,
    });

    yield* runClaudeCommand({
      binaryPath: context.config.binaryPath,
      args,
      cwd: context.cwd,
      env: context.environment,
      timeout: Duration.seconds(timeoutSecs),
    }).pipe(
      Effect.tap((result) =>
        Effect.gen(function* () {
          const completedAt = yield* nowIsoString;
          if (result.code === 0) {
            const verification = yield* waitForClaudeMcpLoginStatus({
              context,
              serverName: input.request.serverName,
              operationId,
              timeoutSecs,
            });
            if (verification.authenticated) {
              recordProviderExtensionOperation({
                operationId,
                kind: "mcp-oauth",
                status: "completed",
                message: verification.message,
                completedAt,
              });
            } else {
              recordProviderExtensionOperation({
                operationId,
                kind: "mcp-oauth",
                status: "failed",
                message: `${input.request.serverName} login was not completed.`,
                error: verification.message,
                completedAt,
              });
            }
            return;
          }

          recordProviderExtensionOperation({
            operationId,
            kind: "mcp-oauth",
            status: "failed",
            message: `${input.request.serverName} login failed.`,
            error: claudeMcpLoginFailureMessage({
              serverName: input.request.serverName,
              args,
              ...result,
            }),
            completedAt,
          });
        }),
      ),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const message = toErrorMessage(cause);
          const completedAt = yield* nowIsoString;
          recordProviderExtensionOperation({
            operationId,
            kind: "mcp-oauth",
            status: message.toLowerCase().includes("timed out") ? "expired" : "failed",
            message: `${input.request.serverName} login failed.`,
            error: message,
            completedAt,
          });
        }),
      ),
      Effect.forkDetach,
    );

    return {
      operationId,
      serverName: input.request.serverName,
      terminalCommand,
      expiresAt,
    } satisfies ProviderExtensionMcpOAuthStartResult;
  }

  if (providerConfig.driver !== CODEX_DRIVER) {
    return yield* unsupportedProviderExtensionAction(providerConfig.driver, "MCP OAuth");
  }

  const context = yield* resolveCodexActionContext({
    cwd: input.request.cwd,
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  const timeoutSecs = boundedOAuthTimeoutSeconds(input.request.timeoutSecs);
  const operationId = randomUUID();
  const expiresAt = yield* isoStringAfterSeconds(timeoutSecs);
  const scopes = input.request.scopes ?? [];
  const scope = yield* Scope.make("sequential");

  const startResult = yield* Effect.gen(function* () {
    const clientContext = yield* Layer.buildWithScope(
      CodexClient.layerCommand({
        command: context.config.binaryPath,
        args: ["app-server"],
        cwd: context.cwd,
        env: context.environment,
      }),
      scope,
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );

    yield* client.handleServerNotification("mcpServer/oauthLogin/completed", (payload) => {
      if (payload.name !== input.request.serverName) return Effect.void;
      return Effect.gen(function* () {
        const completedAt = yield* nowIsoString;
        recordProviderExtensionOperation({
          operationId,
          kind: "mcp-oauth",
          status: payload.success ? "completed" : "failed",
          message: payload.success
            ? `${input.request.serverName} OAuth completed.`
            : `${input.request.serverName} OAuth failed.`,
          ...(payload.error ? { error: payload.error } : {}),
          completedAt,
        });
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      });
    });

    yield* client
      .request("initialize", buildCodexInitializeParams())
      .pipe(Effect.mapError(toProviderExtensionsError));
    yield* client.notify("initialized", undefined).pipe(Effect.mapError(toProviderExtensionsError));

    const response = yield* mapCodexRequestError(
      client.request("mcpServer/oauth/login", {
        name: input.request.serverName,
        ...(scopes.length > 0 ? { scopes } : {}),
        timeoutSecs,
      }),
    );

    recordProviderExtensionOperation({
      operationId,
      kind: "mcp-oauth",
      status: "running",
      message: `Waiting for ${input.request.serverName} OAuth completion.`,
    });

    yield* Effect.sleep(Duration.seconds(timeoutSecs + 15)).pipe(
      Effect.tap(() =>
        Effect.gen(function* () {
          const current = providerExtensionOperations.get(operationId);
          if (current?.status === "running") {
            const completedAt = yield* nowIsoString;
            recordProviderExtensionOperation({
              operationId,
              kind: "mcp-oauth",
              status: "expired",
              message: `${input.request.serverName} OAuth timed out.`,
              completedAt,
            });
          }
        }),
      ),
      Effect.ensuring(Scope.close(scope, Exit.void).pipe(Effect.ignore)),
      Effect.forkDetach,
    );

    return {
      operationId,
      serverName: input.request.serverName,
      authorizationUrl: response.authorizationUrl,
      terminalCommand: codexMcpLoginCommandForDisplay({
        binaryPath: context.config.binaryPath,
        codexHomePath: context.environment.CODEX_HOME,
        serverName: input.request.serverName,
        scopes,
      }),
      expiresAt,
    } satisfies ProviderExtensionMcpOAuthStartResult;
  }).pipe(
    Effect.catch((cause) =>
      Scope.close(scope, Exit.void).pipe(
        Effect.andThen(Effect.fail(toProviderExtensionsError(cause))),
      ),
    ),
  );

  return startResult;
});

export const getProviderExtensionOperationStatus = Effect.fn(
  "providerExtensions.getProviderExtensionOperationStatus",
)(function* (
  input: ProviderExtensionOperationStatusInput,
): Effect.fn.Return<ProviderExtensionOperationStatusResult, ProviderExtensionsError> {
  const status = providerExtensionOperations.get(input.operationId);
  if (!status) {
    return yield* new ProviderExtensionsError({
      message: "Extension operation was not found.",
    });
  }
  return status;
});

export const reloadProviderExtensionMcpServers = Effect.fn(
  "providerExtensions.reloadProviderExtensionMcpServers",
)(function* (input: {
  readonly request: ProviderExtensionMcpReloadInput;
  readonly settings: ServerSettings;
}): Effect.fn.Return<
  ProviderExtensionMcpReloadResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const context = yield* resolveCodexActionContext({
    cwd: input.request.cwd,
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  yield* runCodexAppServerAction(context, (client) =>
    mapCodexRequestError(client.request("config/mcpServer/reload", undefined)),
  );
  return { reloaded: true };
});

export const setProviderExtensionSkillEnabled = Effect.fn(
  "providerExtensions.setProviderExtensionSkillEnabled",
)(function* (input: {
  readonly request: ProviderExtensionSkillToggleInput;
  readonly settings: ServerSettings;
}): Effect.fn.Return<
  ProviderExtensionSkillToggleResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const params = codexSkillConfigWriteParams(input.request);
  if (!params) {
    return yield* new ProviderExtensionsError({
      message: "Skill name or path is required.",
    });
  }
  const context = yield* resolveCodexActionContext({
    cwd: input.request.cwd,
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  const response = yield* runCodexAppServerAction(context, (client) =>
    mapCodexRequestError(client.request("skills/config/write", params)),
  );
  return { effectiveEnabled: response.effectiveEnabled };
});

export const readProviderExtensionPlugin = Effect.fn(
  "providerExtensions.readProviderExtensionPlugin",
)(function* (input: {
  readonly request: ProviderExtensionPluginReadInput;
  readonly settings: ServerSettings;
}): Effect.fn.Return<
  ProviderExtensionPluginReadResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const providerConfig = yield* resolveProviderActionConfig({
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  if (providerConfig.driver === CLAUDE_DRIVER) {
    const context = yield* resolveClaudeActionContext({
      cwd: input.request.cwd,
      providerInstanceId: input.request.providerInstanceId,
      settings: input.settings,
    });
    const selector = claudePluginSelector(input.request);
    const result = yield* runClaudePluginAction(context, ["plugin", "details", selector]);
    return {
      plugin: {
        output: optionalText(result.stdout) ?? optionalText(result.stderr) ?? "",
      },
    };
  }
  if (providerConfig.driver !== CODEX_DRIVER) {
    return yield* unsupportedProviderExtensionAction(providerConfig.driver, "Plugin details");
  }

  const context = yield* resolveCodexActionContext({
    cwd: input.request.cwd,
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  const response = yield* runCodexAppServerAction(context, (client) =>
    mapCodexRequestError(
      client.request("plugin/read", {
        pluginName: input.request.pluginName,
        ...(input.request.marketplacePath
          ? { marketplacePath: input.request.marketplacePath }
          : {}),
        ...(input.request.remoteMarketplaceName
          ? { remoteMarketplaceName: input.request.remoteMarketplaceName }
          : {}),
      }),
    ),
  );
  return { plugin: response.plugin };
});

export const installProviderExtensionPlugin = Effect.fn(
  "providerExtensions.installProviderExtensionPlugin",
)(function* (input: {
  readonly request: ProviderExtensionPluginInstallInput;
  readonly settings: ServerSettings;
}): Effect.fn.Return<
  ProviderExtensionPluginInstallResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const providerConfig = yield* resolveProviderActionConfig({
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  if (providerConfig.driver === CLAUDE_DRIVER) {
    const context = yield* resolveClaudeActionContext({
      cwd: input.request.cwd,
      providerInstanceId: input.request.providerInstanceId,
      settings: input.settings,
    });
    const selector = claudePluginSelector(input.request);
    yield* runClaudePluginAction(context, [
      "plugin",
      "install",
      selector,
      ...claudePluginScopeArgs(input.request.scope ?? "user"),
    ]);
    return {
      authPolicy: "provider-managed",
      appsNeedingAuth: [],
    };
  }
  if (providerConfig.driver !== CODEX_DRIVER) {
    return yield* unsupportedProviderExtensionAction(providerConfig.driver, "Plugin install");
  }

  const context = yield* resolveCodexActionContext({
    cwd: input.request.cwd,
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  const response = yield* runCodexAppServerAction(context, (client) =>
    mapCodexRequestError(
      client.request("plugin/install", {
        pluginName: input.request.pluginName,
        ...(input.request.marketplacePath
          ? { marketplacePath: input.request.marketplacePath }
          : {}),
        ...(input.request.remoteMarketplaceName
          ? { remoteMarketplaceName: input.request.remoteMarketplaceName }
          : {}),
      }),
    ),
  );
  return {
    authPolicy: response.authPolicy,
    appsNeedingAuth: [...response.appsNeedingAuth],
  };
});

export const uninstallProviderExtensionPlugin = Effect.fn(
  "providerExtensions.uninstallProviderExtensionPlugin",
)(function* (input: {
  readonly request: ProviderExtensionPluginUninstallInput;
  readonly settings: ServerSettings;
}): Effect.fn.Return<
  ProviderExtensionPluginUninstallResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const providerConfig = yield* resolveProviderActionConfig({
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  if (providerConfig.driver === CLAUDE_DRIVER) {
    const context = yield* resolveClaudeActionContext({
      cwd: input.request.cwd,
      providerInstanceId: input.request.providerInstanceId,
      settings: input.settings,
    });
    yield* runClaudePluginAction(context, [
      "plugin",
      "uninstall",
      input.request.pluginId,
      ...claudePluginScopeArgs(input.request.scope),
    ]);
    return { uninstalled: true };
  }
  if (providerConfig.driver !== CODEX_DRIVER) {
    return yield* unsupportedProviderExtensionAction(providerConfig.driver, "Plugin uninstall");
  }

  const context = yield* resolveCodexActionContext({
    cwd: input.request.cwd,
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  yield* runCodexAppServerAction(context, (client) =>
    mapCodexRequestError(client.request("plugin/uninstall", { pluginId: input.request.pluginId })),
  );
  return { uninstalled: true };
});

export const setProviderExtensionPluginEnabled = Effect.fn(
  "providerExtensions.setProviderExtensionPluginEnabled",
)(function* (input: {
  readonly request: ProviderExtensionPluginToggleInput;
  readonly settings: ServerSettings;
}): Effect.fn.Return<
  ProviderExtensionPluginToggleResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const providerConfig = yield* resolveProviderActionConfig({
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  if (providerConfig.driver === CODEX_DRIVER) {
    const context = yield* resolveCodexActionContext({
      cwd: input.request.cwd,
      providerInstanceId: input.request.providerInstanceId,
      settings: input.settings,
    });
    yield* runCodexAppServerAction(context, (client) =>
      mapCodexRequestError(
        client.request("config/value/write", {
          keyPath: codexPluginEnabledConfigPath(input.request.pluginId),
          mergeStrategy: "upsert",
          value: input.request.enabled,
        }),
      ),
    );
    return { effectiveEnabled: input.request.enabled };
  }
  if (providerConfig.driver !== CLAUDE_DRIVER) {
    return yield* unsupportedProviderExtensionAction(providerConfig.driver, "Plugin enablement");
  }
  const context = yield* resolveClaudeActionContext({
    cwd: input.request.cwd,
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  yield* runClaudePluginAction(context, [
    "plugin",
    input.request.enabled ? "enable" : "disable",
    input.request.pluginId,
    ...claudePluginScopeArgs(input.request.scope),
  ]);
  return { effectiveEnabled: input.request.enabled };
});

export const updateProviderExtensionPlugin = Effect.fn(
  "providerExtensions.updateProviderExtensionPlugin",
)(function* (input: {
  readonly request: ProviderExtensionPluginUpdateInput;
  readonly settings: ServerSettings;
}): Effect.fn.Return<
  ProviderExtensionPluginUpdateResult,
  ProviderExtensionsError,
  Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const providerConfig = yield* resolveProviderActionConfig({
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  if (providerConfig.driver !== CLAUDE_DRIVER) {
    return yield* unsupportedProviderExtensionAction(providerConfig.driver, "Plugin update");
  }
  const context = yield* resolveClaudeActionContext({
    cwd: input.request.cwd,
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  yield* runClaudePluginAction(context, [
    "plugin",
    "update",
    input.request.pluginId,
    ...claudePluginScopeArgs(input.request.scope, new Set(["user", "project", "local", "managed"])),
  ]);
  return { updated: true };
});

export const refreshProviderExtensionPluginMarketplaces = Effect.fn(
  "providerExtensions.refreshProviderExtensionPluginMarketplaces",
)(function* (input: {
  readonly request: ProviderExtensionPluginMarketplaceRefreshInput;
  readonly settings: ServerSettings;
}): Effect.fn.Return<
  ProviderExtensionPluginMarketplaceRefreshResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const context = yield* resolveCodexActionContext({
    cwd: input.request.cwd,
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  const args = [
    "plugin",
    "marketplace",
    "upgrade",
    ...(input.request.marketplaceName ? [input.request.marketplaceName] : []),
  ];
  const result = yield* runCodexCommand({
    binaryPath: context.config.binaryPath,
    args,
    cwd: context.cwd,
    env: context.environment,
    timeout: CODEX_PLUGIN_MARKETPLACE_ACTION_TIMEOUT,
  }).pipe(Effect.mapError(toProviderExtensionsError));
  if (result.code !== 0) {
    return yield* new ProviderExtensionsError({
      message: providerCommandFailureMessage({
        command: context.config.binaryPath,
        args,
        ...result,
      }),
    });
  }
  return {
    refreshed: true,
    ...((optionalText(result.stdout) ?? optionalText(result.stderr))
      ? { output: optionalText(result.stdout) ?? optionalText(result.stderr) }
      : {}),
  };
});

export const callProviderExtensionMcpTool = Effect.fn(
  "providerExtensions.callProviderExtensionMcpTool",
)(function* (input: {
  readonly request: ProviderExtensionMcpToolCallInput;
  readonly settings: ServerSettings;
}): Effect.fn.Return<
  ProviderExtensionMcpToolCallResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const context = yield* resolveCodexActionContext({
    cwd: input.request.cwd,
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  const response = yield* runCodexAppServerAction(context, (client) =>
    mapCodexRequestError(
      client.request("mcpServer/tool/call", {
        server: input.request.serverName,
        tool: input.request.toolName,
        threadId: input.request.providerThreadId,
        ...(input.request.arguments !== undefined ? { arguments: input.request.arguments } : {}),
      }),
    ),
  );
  return {
    content: [...response.content],
    ...(response.structuredContent !== undefined
      ? { structuredContent: response.structuredContent }
      : {}),
    ...(response.isError !== undefined && response.isError !== null
      ? { isError: response.isError }
      : {}),
    ...(response._meta !== undefined ? { meta: response._meta } : {}),
  };
});

export const readProviderExtensionMcpResource = Effect.fn(
  "providerExtensions.readProviderExtensionMcpResource",
)(function* (input: {
  readonly request: ProviderExtensionMcpResourceReadInput;
  readonly settings: ServerSettings;
}): Effect.fn.Return<
  ProviderExtensionMcpResourceReadResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const context = yield* resolveCodexActionContext({
    cwd: input.request.cwd,
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
  const response = yield* runCodexAppServerAction(context, (client) =>
    mapCodexRequestError(
      client.request("mcpServer/resource/read", {
        server: input.request.serverName,
        uri: input.request.uri,
        ...(input.request.providerThreadId ? { threadId: input.request.providerThreadId } : {}),
      }),
    ),
  );
  return { contents: [...response.contents] };
});

export const readProviderExtensionsInventory = Effect.fn(
  "providerExtensions.readProviderExtensionsInventory",
)(function* (input: {
  readonly request: ProviderExtensionsInventoryInput;
  readonly settings: ServerSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
}): Effect.fn.Return<
  ProviderExtensionsInventoryResult,
  ProviderExtensionsError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const generatedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const cwd = input.request.cwd ?? process.cwd();
  const configMap = deriveProviderInstanceConfigMap(input.settings);
  const snapshotsByInstanceId = new Map(
    input.providers.map((provider) => [provider.instanceId, provider]),
  );
  const providerEntries = Object.entries(configMap)
    .map(([id, config]) => ({
      instanceId: ProviderInstanceId.make(id),
      config,
    }))
    .filter(
      (entry) => entry.config.driver === CODEX_DRIVER || entry.config.driver === CLAUDE_DRIVER,
    )
    .filter(
      (entry) =>
        input.request.providerInstanceId === undefined ||
        String(entry.instanceId) === String(input.request.providerInstanceId),
    );

  const [providers, instructionFiles] = yield* Effect.all(
    [
      Effect.forEach(
        providerEntries,
        (entry) => {
          const scopedProviderThreadId =
            input.request.providerThreadId !== undefined &&
            (input.request.providerInstanceId === undefined ||
              String(input.request.providerInstanceId) === String(entry.instanceId))
              ? input.request.providerThreadId
              : undefined;
          return readProviderInventory({
            instanceId: entry.instanceId,
            config: entry.config,
            snapshot: snapshotsByInstanceId.get(entry.instanceId),
            cwd,
            providerThreadId: scopedProviderThreadId,
            includeMcpServers: input.request.includeMcpServers,
          }).pipe(
            Effect.catch((error: ProviderExtensionsError) =>
              Effect.succeed({
                instanceId: entry.instanceId,
                driver: entry.config.driver,
                displayName: entry.config.displayName,
                status: "error" as const,
                message: error.message,
                plugins: [],
                skills: fallbackSkillsFromSnapshot(snapshotsByInstanceId.get(entry.instanceId)),
                mcpServers: [],
                apps: [],
              }),
            ),
          );
        },
        { concurrency: 3 },
      ),
      readInstructionFiles(cwd),
    ],
    { concurrency: "unbounded" },
  );

  return {
    cwd,
    generatedAt,
    providers,
    instructionFiles,
  };
});

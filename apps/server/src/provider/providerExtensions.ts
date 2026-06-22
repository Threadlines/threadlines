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
const MAX_SKILL_FILE_BYTES = 32_000;
const MAX_ERROR_MESSAGE_LENGTH = 240;

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);

function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function requiredText(value: string | null | undefined): string | null {
  return optionalText(value) ?? null;
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
  readonly contents?: string | undefined;
}): ProviderInstructionFile {
  return {
    kind: input.kind,
    scope: "project",
    path: input.absolutePath,
    relativePath: input.relativePath,
    exists: input.exists,
    editable: input.editable,
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

function codexMcpLoginCommand(serverName: string, scopes: ReadonlyArray<string> = []): string {
  const args = ["codex", "mcp", "login", serverName];
  if (scopes.length > 0) {
    args.push("--scopes", scopes.join(","));
  }
  return args.map(commandArg).join(" ");
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
    ChildProcess.make(input.binaryPath, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      shell: process.platform === "win32",
    }),
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
  }): Effect.fn.Return<
    Pick<
      ProviderExtensionProviderInventory,
      "plugins" | "skills" | "mcpServers" | "apps" | "status" | "message"
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

        const [plugins, skills, mcpServers, apps] = yield* Effect.all(
          [
            client
              .request("plugin/list", { cwds: [input.cwd] })
              .pipe(Effect.map(mapCodexPlugins), collectCodexRequest("plugins")),
            client.request("skills/list", { cwds: [input.cwd] }).pipe(
              Effect.map((response) => mapCodexSkills(response, input.cwd)),
              collectCodexRequest("skills"),
            ),
            client.request("mcpServerStatus/list", mcpStatusParams).pipe(
              Effect.catch((cause) =>
                input.providerThreadId !== undefined && isThreadNotFoundError(cause)
                  ? client.request("mcpServerStatus/list", mcpStatusWithoutThreadParams)
                  : Effect.fail(cause),
              ),
              Effect.map(mapCodexMcpServers),
              collectCodexRequest("MCP servers"),
            ),
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
        return { plugins, skills, mcpServers, apps };
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
      resultMessage(data.mcpServers),
      resultMessage(data.apps),
    ].filter((message): message is string => Boolean(message));

    return {
      status: messages.length > 0 ? "partial" : "ready",
      ...(messages.length > 0 ? { message: messages.join(" ") } : {}),
      plugins: Result.isSuccess(data.plugins) ? data.plugins.success : [],
      skills: Result.isSuccess(data.skills) ? data.skills.success : [],
      mcpServers: Result.isSuccess(data.mcpServers) ? data.mcpServers.success : [],
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

function parseSkillMarkdown(input: {
  readonly name: string;
  readonly path: string;
  readonly contents: string;
}) {
  const frontMatter = input.contents.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const metadata = new Map<string, string>();
  if (frontMatter) {
    for (const line of frontMatter[1]!.split(/\r?\n/g)) {
      const match = line.match(/^([a-zA-Z0-9_-]+):\s*"?(.+?)"?\s*$/);
      if (match) metadata.set(match[1]!.toLowerCase(), match[2]!.trim());
    }
  }
  return {
    name: optionalText(metadata.get("name")) ?? input.name,
    path: input.path,
    ...(optionalText(metadata.get("display_name"))
      ? { displayName: optionalText(metadata.get("display_name")) }
      : {}),
    ...(optionalText(metadata.get("description"))
      ? { description: optionalText(metadata.get("description")) }
      : {}),
    ...(optionalText(metadata.get("short_description"))
      ? { shortDescription: optionalText(metadata.get("short_description")) }
      : {}),
    enabled: true,
    source: "Filesystem",
  } satisfies ProviderExtensionSkill;
}

function withSkillScope(
  skill: ProviderExtensionSkill,
  scope: "project" | "user",
): ProviderExtensionSkill {
  return {
    name: skill.name,
    path: skill.path,
    ...(skill.displayName !== undefined ? { displayName: skill.displayName } : {}),
    ...(skill.description !== undefined ? { description: skill.description } : {}),
    ...(skill.shortDescription !== undefined ? { shortDescription: skill.shortDescription } : {}),
    ...(skill.enabled !== undefined ? { enabled: skill.enabled } : {}),
    scope,
    ...(skill.source !== undefined ? { source: skill.source } : {}),
  };
}

const readSkillsFromRoot = Effect.fn("providerExtensions.readSkillsFromRoot")(function* (
  root: string,
): Effect.fn.Return<ProviderExtensionSkill[], never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fileSystem.stat(root).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!stat || stat.type !== "Directory") return [];

  const entries = yield* fileSystem
    .readDirectory(root)
    .pipe(Effect.catch(() => Effect.succeed([])));
  const skills: Array<ProviderExtensionSkill | null> = yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.gen(function* () {
        const skillPath = path.join(root, entry, "SKILL.md");
        const skillStat = yield* fileSystem
          .stat(skillPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!skillStat || skillStat.type !== "File") return null;
        if (skillStat.size > MAX_SKILL_FILE_BYTES) {
          return {
            name: entry,
            path: skillPath,
            enabled: true,
            source: "Filesystem",
          } satisfies ProviderExtensionSkill;
        }
        const contents = yield* fileSystem
          .readFileString(skillPath)
          .pipe(Effect.catch(() => Effect.succeed("")));
        return parseSkillMarkdown({ name: entry, path: skillPath, contents });
      }),
    { concurrency: 8 },
  );

  return skills
    .filter((skill): skill is ProviderExtensionSkill => skill !== null)
    .toSorted((left, right) => left.name.localeCompare(right.name));
});

const readClaudeSkills = Effect.fn("providerExtensions.readClaudeSkills")(function* (
  claudeHome: string,
  cwd: string,
) {
  const path = yield* Path.Path;
  const [userSkills, projectSkills] = yield* Effect.all(
    [
      readSkillsFromRoot(path.join(claudeHome, ".claude", "skills")),
      readSkillsFromRoot(path.join(cwd, ".claude", "skills")),
    ],
    { concurrency: "unbounded" },
  );
  const userTagged = userSkills.map((skill) => withSkillScope(skill, "user"));
  const projectTagged = projectSkills.map((skill) => withSkillScope(skill, "project"));
  return [...projectTagged, ...userTagged];
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
    ChildProcess.make(input.binaryPath, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      shell: process.platform === "win32",
    }),
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
  return {
    status: messages.length > 0 ? "partial" : "ready",
    ...(messages.length > 0 ? { message: messages.join(" ") } : {}),
    plugins: Result.isSuccess(pluginResult) ? pluginResult.success : [],
    skills: Result.isSuccess(skillsResult) ? skillsResult.success : [],
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
      terminalCommand: codexMcpLoginCommand(input.request.serverName, scopes),
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
  if (!input.request.name && !input.request.path) {
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
    mapCodexRequestError(
      client.request("skills/config/write", {
        enabled: input.request.enabled,
        ...(input.request.name ? { name: input.request.name } : {}),
        ...(input.request.path ? { path: input.request.path } : {}),
      }),
    ),
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
  Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const providerConfig = yield* resolveProviderActionConfig({
    providerInstanceId: input.request.providerInstanceId,
    settings: input.settings,
  });
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

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderExtensionsError,
  type ProviderExtensionApp,
  type ProviderExtensionMcpServer,
  type ProviderExtensionPlugin,
  type ProviderExtensionsInventoryInput,
  type ProviderExtensionsInventoryResult,
  type ProviderExtensionProviderInventory,
  type ProviderExtensionSkill,
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
} from "@t3tools/contracts";

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
    for (const plugin of marketplace.plugins) {
      const id = requiredText(plugin.id);
      if (!id || byId.has(id) || (plugin.installed !== true && plugin.enabled !== true)) continue;
      byId.set(id, {
        id,
        name: requiredText(plugin.name) ?? id,
        displayName: optionalText(plugin.interface?.displayName ?? null),
        description: optionalText(plugin.interface?.shortDescription ?? null),
        enabled: plugin.enabled,
        installed: plugin.installed,
        source: optionalText(codexPluginSource(plugin.source)),
      });
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

function mapCodexMcpServers(
  response: CodexSchema.V2ListMcpServerStatusResponse,
): ProviderExtensionMcpServer[] {
  return response.data
    .flatMap((server) => {
      const name = requiredText(server.name);
      if (!name) return [];
      return [
        {
          name,
          authStatus: optionalText(server.authStatus),
          status: optionalText(server.authStatus),
          toolCount: Object.keys(server.tools ?? {}).length,
          resourceCount: (server.resources ?? []).length + (server.resourceTemplates ?? []).length,
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

        const [plugins, skills, mcpServers] = yield* Effect.all(
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
          ],
          { concurrency: 2 },
        );
        const apps = Result.succeed([] as ProviderExtensionApp[]);
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

function parseClaudePluginList(output: string): ProviderExtensionPlugin[] {
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

function parseClaudeMcpList(output: string): ProviderExtensionMcpServer[] {
  const servers: ProviderExtensionMcpServer[] = [];
  for (const line of output.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith("checking ")) continue;
    const match = trimmed.match(/^([^:]+):\s*(.+?)(?:\s+-\s+(.+))?$/);
    if (!match) continue;
    const name = match[1]!;
    const target = match[2] ?? "";
    const status = match[3];
    const transport = target?.match(/\(([^)]+)\)/)?.[1]?.trim();
    servers.push({
      name: name.trim(),
      status: optionalText(status) ?? "configured",
      transport: optionalText(transport),
      detail: optionalText(status),
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
}) {
  const result = yield* spawnAndCollect(
    input.binaryPath,
    ChildProcess.make(input.binaryPath, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      shell: process.platform === "win32",
    }),
  ).pipe(Effect.timeoutOption(INVENTORY_COMMAND_TIMEOUT));
  if (Option.isNone(result)) {
    return yield* new ProviderExtensionsError({
      message: `Timed out running ${input.binaryPath} ${input.args.join(" ")}.`,
    });
  }
  return result.value;
});

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
        args: ["plugin", "list"],
        cwd: input.cwd,
        env: claudeEnvironment,
      }).pipe(
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

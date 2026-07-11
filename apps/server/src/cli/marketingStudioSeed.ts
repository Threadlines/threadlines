#!/usr/bin/env node

import * as FileSystem from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ThreadId, type ModelSelection } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";

interface MarketingThreadSeed {
  readonly title: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly createdAt: string;
  readonly modelSelection: ModelSelection;
}

interface MarketingProjectSeed {
  readonly workspaceRoot: string;
  readonly threads: ReadonlyArray<MarketingThreadSeed>;
}

interface MarketingStudioSeedInput {
  readonly baseDir: string;
  readonly cwd: string;
  readonly devUrl: string;
  readonly projects: ReadonlyArray<MarketingProjectSeed>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readSeedInput = (inputPath: string): MarketingStudioSeedInput => {
  const decoded: unknown = JSON.parse(FileSystem.readFileSync(inputPath, "utf8"));
  if (
    !isRecord(decoded) ||
    typeof decoded.baseDir !== "string" ||
    typeof decoded.cwd !== "string" ||
    typeof decoded.devUrl !== "string" ||
    !Array.isArray(decoded.projects)
  ) {
    throw new Error("Marketing Studio thread seed input is invalid.");
  }

  for (const project of decoded.projects) {
    if (!isRecord(project) || typeof project.workspaceRoot !== "string") {
      throw new Error("Marketing Studio project seed is invalid.");
    }
    if (!Array.isArray(project.threads)) {
      throw new Error("Marketing Studio project thread list is invalid.");
    }
    for (const thread of project.threads) {
      if (
        !isRecord(thread) ||
        typeof thread.title !== "string" ||
        (thread.branch !== null && typeof thread.branch !== "string") ||
        (thread.worktreePath !== null && typeof thread.worktreePath !== "string") ||
        typeof thread.createdAt !== "string" ||
        !isRecord(thread.modelSelection) ||
        typeof thread.modelSelection.instanceId !== "string" ||
        typeof thread.modelSelection.model !== "string"
      ) {
        throw new Error("Marketing Studio thread seed is invalid.");
      }
    }
  }

  return decoded as unknown as MarketingStudioSeedInput;
};

const makeServerConfig = (input: MarketingStudioSeedInput): ServerConfigShape => {
  const devUrl = new URL(input.devUrl);
  const stateDir = NodePath.join(input.baseDir, "dev");
  const logsDir = NodePath.join(stateDir, "logs");
  const providerLogsDir = NodePath.join(logsDir, "provider");

  return {
    appVersion: "marketing-studio",
    logLevel: "Error",
    traceMinLevel: "Error",
    traceTimingEnabled: false,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 3,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "threadlines-marketing-studio-seed",
    mode: "desktop",
    port: 0,
    host: undefined,
    cwd: input.cwd,
    baseDir: input.baseDir,
    staticDir: undefined,
    devUrl,
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    stateDir,
    dbPath: NodePath.join(stateDir, "state.sqlite"),
    keybindingsConfigPath: NodePath.join(stateDir, "keybindings.json"),
    settingsPath: NodePath.join(stateDir, "settings.json"),
    providerStatusCacheDir: NodePath.join(input.baseDir, "caches"),
    worktreesDir: NodePath.join(input.baseDir, "worktrees"),
    attachmentsDir: NodePath.join(stateDir, "attachments"),
    logsDir,
    serverLogPath: NodePath.join(logsDir, "server.log"),
    serverTracePath: NodePath.join(logsDir, "server.trace.ndjson"),
    providerLogsDir,
    providerEventLogPath: NodePath.join(providerLogsDir, "events.log"),
    terminalLogsDir: NodePath.join(logsDir, "terminals"),
    anonymousIdPath: NodePath.join(stateDir, "anonymous-id"),
    environmentIdPath: NodePath.join(stateDir, "environment-id"),
    serverRuntimeStatePath: NodePath.join(stateDir, "server-runtime.json"),
    secretsDir: NodePath.join(stateDir, "secrets"),
  };
};

const makeRuntimeLayer = (config: ServerConfigShape) =>
  Layer.mergeAll(
    WorkspacePathsLive,
    OrchestrationLayerLive.pipe(
      Layer.provideMerge(RepositoryIdentityResolverLive),
      Layer.provideMerge(SqlitePersistenceLayerLive),
    ),
  ).pipe(
    Layer.provide(Layer.succeed(ServerConfig, config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
  );

const seedThreads = (input: MarketingStudioSeedInput) =>
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const snapshot = yield* snapshots.getSnapshot();
    let createdCount = 0;
    let updatedCount = 0;
    let unarchivedCount = 0;
    let removedPlaceholderCount = 0;

    for (const projectSeed of input.projects) {
      const project = snapshot.projects.find(
        (candidate) =>
          candidate.deletedAt === null && candidate.workspaceRoot === projectSeed.workspaceRoot,
      );
      if (!project) {
        return yield* Effect.fail(
          new Error(
            "Marketing Studio project is missing from the orchestration snapshot: " +
              projectSeed.workspaceRoot,
          ),
        );
      }

      const existingThreads = snapshot.threads.filter(
        (thread) => thread.deletedAt === null && thread.projectId === project.id,
      );
      for (const placeholder of existingThreads.filter((thread) => thread.title === "New thread")) {
        yield* engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: placeholder.id,
        });
        removedPlaceholderCount += 1;
      }

      for (const threadSeed of projectSeed.threads) {
        const existing = existingThreads.find(
          (thread) => thread.title === threadSeed.title && thread.title !== "New thread",
        );
        if (existing) {
          if (existing.archivedAt !== null) {
            yield* engine.dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make(crypto.randomUUID()),
              threadId: existing.id,
            });
            unarchivedCount += 1;
          }
          if (
            existing.branch !== threadSeed.branch ||
            existing.worktreePath !== threadSeed.worktreePath ||
            JSON.stringify(existing.modelSelection) !== JSON.stringify(threadSeed.modelSelection)
          ) {
            yield* engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.make(crypto.randomUUID()),
              threadId: existing.id,
              branch: threadSeed.branch,
              worktreePath: threadSeed.worktreePath,
              modelSelection: threadSeed.modelSelection,
            });
            updatedCount += 1;
          }
          continue;
        }

        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: ThreadId.make(crypto.randomUUID()),
          projectId: project.id,
          title: threadSeed.title,
          modelSelection: threadSeed.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: threadSeed.branch,
          worktreePath: threadSeed.worktreePath,
          createdAt: threadSeed.createdAt,
        });
        createdCount += 1;
      }
    }

    return { createdCount, updatedCount, unarchivedCount, removedPlaceholderCount };
  });

const main = async (): Promise<void> => {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("Usage: node apps/server/src/cli/marketingStudioSeed.ts <seed-input.json>");
  }

  const input = readSeedInput(NodePath.resolve(inputPath));
  const config = makeServerConfig(input);
  const result = await Effect.runPromise(
    seedThreads(input).pipe(
      Effect.scoped,
      Effect.provide(makeRuntimeLayer(config)),
      Effect.provide(NodeServices.layer),
    ),
  );

  console.log(
    `Marketing Studio threads: ${result.createdCount} created, ${result.updatedCount} updated, ${result.unarchivedCount} unarchived, ${result.removedPlaceholderCount} placeholders removed.`,
  );
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

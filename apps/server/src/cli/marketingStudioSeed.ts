#!/usr/bin/env node

import * as FileSystem from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type ModelSelection,
} from "@threadlines/contracts";
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
  readonly interactionMode?: "default" | "plan";
  readonly scenario?: {
    readonly status:
      | "idle"
      | "working"
      | "starting"
      | "completed"
      | "pending-approval"
      | "awaiting-input"
      | "plan-ready"
      | "background"
      | "failed";
    readonly prompt: string;
    readonly assistantText?: string;
  };
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

const MARKETING_SCENARIO_STATUSES = new Set([
  "idle",
  "working",
  "starting",
  "completed",
  "pending-approval",
  "awaiting-input",
  "plan-ready",
  "background",
  "failed",
]);

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
        typeof thread.modelSelection.model !== "string" ||
        (thread.interactionMode !== undefined &&
          thread.interactionMode !== "default" &&
          thread.interactionMode !== "plan") ||
        (thread.scenario !== undefined &&
          (!isRecord(thread.scenario) ||
            typeof thread.scenario.status !== "string" ||
            !MARKETING_SCENARIO_STATUSES.has(thread.scenario.status) ||
            typeof thread.scenario.prompt !== "string" ||
            (thread.scenario.assistantText !== undefined &&
              typeof thread.scenario.assistantText !== "string")))
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

const timestampAfter = (timestamp: string, seconds: number): string =>
  new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();

const seedThreads = (input: MarketingStudioSeedInput) =>
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const snapshot = yield* snapshots.getSnapshot();
    let createdCount = 0;
    let updatedCount = 0;
    let unarchivedCount = 0;
    let removedPlaceholderCount = 0;
    let scenarioCount = 0;

    const seedScenario = (
      threadId: ThreadId,
      threadSeed: MarketingThreadSeed,
    ): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const scenario = threadSeed.scenario;
        if (!scenario) {
          return;
        }

        const prefix = `marketing-studio-v6:${threadId}`;
        const turnId = TurnId.make(`${prefix}:turn`);
        const userMessageId = MessageId.make(`${prefix}:user`);
        const assistantMessageId = MessageId.make(`${prefix}:assistant`);
        const requestedAt = timestampAfter(threadSeed.createdAt, 30);
        const assistantAt = timestampAfter(threadSeed.createdAt, 60);
        const completedAt = timestampAfter(threadSeed.createdAt, 90);
        const providerName = threadSeed.modelSelection.instanceId === "codex" ? "codex" : "claude";
        const commandId = (suffix: string) => CommandId.make(`${prefix}:${suffix}`);

        yield* engine.dispatch({
          type: "thread.message.user.record",
          commandId: commandId("user-message"),
          threadId,
          messageId: userMessageId,
          text: scenario.prompt,
          turnId,
          createdAt: requestedAt,
        });

        if (scenario.assistantText !== undefined) {
          yield* engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: commandId("assistant-message"),
            threadId,
            messageId: assistantMessageId,
            delta: scenario.assistantText,
            turnId,
            createdAt: assistantAt,
          });
          if (scenario.status !== "working") {
            yield* engine.dispatch({
              type: "thread.message.assistant.complete",
              commandId: commandId("assistant-complete"),
              threadId,
              messageId: assistantMessageId,
              turnId,
              createdAt: completedAt,
            });
          }
        }

        if (scenario.status === "idle") {
          scenarioCount += 1;
          return;
        }

        if (scenario.status === "starting") {
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: commandId("session-starting"),
            threadId,
            session: {
              threadId,
              status: "starting",
              providerName,
              providerInstanceId: threadSeed.modelSelection.instanceId,
              providerSessionId: `${prefix}:session`,
              providerThreadId: `${prefix}:provider-thread`,
              runtimeMode: "full-access",
              activeTurnId: null,
              pendingBackgroundTaskCount: 0,
              lastError: null,
              updatedAt: requestedAt,
            },
            createdAt: requestedAt,
          });
          scenarioCount += 1;
          return;
        }

        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("session-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName,
            providerInstanceId: threadSeed.modelSelection.instanceId,
            providerSessionId: `${prefix}:session`,
            providerThreadId: `${prefix}:provider-thread`,
            runtimeMode: "full-access",
            activeTurnId: turnId,
            pendingBackgroundTaskCount: 0,
            lastError: null,
            updatedAt: requestedAt,
          },
          createdAt: requestedAt,
        });

        if (scenario.status === "pending-approval") {
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("approval"),
            threadId,
            activity: {
              id: EventId.make(`${prefix}:approval`),
              tone: "approval",
              kind: "approval.requested",
              summary: "Command approval requested",
              payload: {
                requestId: `${prefix}:approval-request`,
                requestKind: "command",
                requestType: "command_execution_approval",
                detail: "npm run verify:checkout",
              },
              turnId,
              createdAt: completedAt,
            },
            createdAt: completedAt,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: commandId("session-awaiting-approval"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName,
              providerInstanceId: threadSeed.modelSelection.instanceId,
              providerSessionId: `${prefix}:session`,
              providerThreadId: `${prefix}:provider-thread`,
              runtimeMode: "full-access",
              activeTurnId: turnId,
              pendingBackgroundTaskCount: 0,
              lastError: null,
              updatedAt: timestampAfter(completedAt, 1),
            },
            createdAt: timestampAfter(completedAt, 1),
          });
          scenarioCount += 1;
          return;
        }

        if (scenario.status === "awaiting-input") {
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("user-input"),
            threadId,
            activity: {
              id: EventId.make(`${prefix}:user-input`),
              tone: "info",
              kind: "user-input.requested",
              summary: "User input requested",
              payload: {
                requestId: `${prefix}:user-input-request`,
                questions: [
                  {
                    id: "baseline",
                    header: "Baseline",
                    question: "Which region should be the comparison baseline?",
                    options: [
                      { label: "US East", description: "Use the highest-volume region." },
                      { label: "EU West", description: "Use the most stable recent deploy." },
                    ],
                  },
                ],
              },
              turnId,
              createdAt: completedAt,
            },
            createdAt: completedAt,
          });
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: commandId("session-awaiting-input"),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName,
              providerInstanceId: threadSeed.modelSelection.instanceId,
              providerSessionId: `${prefix}:session`,
              providerThreadId: `${prefix}:provider-thread`,
              runtimeMode: "full-access",
              activeTurnId: turnId,
              pendingBackgroundTaskCount: 0,
              lastError: null,
              updatedAt: timestampAfter(completedAt, 1),
            },
            createdAt: timestampAfter(completedAt, 1),
          });
          scenarioCount += 1;
          return;
        }

        if (scenario.status === "working") {
          scenarioCount += 1;
          return;
        }

        yield* engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: commandId("turn-complete"),
          threadId,
          turnId,
          completedAt,
          checkpointRef: CheckpointRef.make(`${prefix}:checkpoint`),
          status: scenario.status === "failed" ? "error" : "ready",
          files: [
            {
              path: "src/demoData.js",
              kind: "modified",
              additions: 12,
              deletions: 3,
            },
          ],
          ...(scenario.assistantText !== undefined ? { assistantMessageId } : {}),
          checkpointTurnCount: 1,
          createdAt: completedAt,
        });

        if (scenario.status === "plan-ready") {
          yield* engine.dispatch({
            type: "thread.proposed-plan.upsert",
            commandId: commandId("proposed-plan"),
            threadId,
            proposedPlan: {
              id: `${prefix}:plan`,
              turnId,
              planMarkdown:
                "1. Normalize cohort rules.\n2. Apply explicit precedence.\n3. Add overlap coverage.",
              implementedAt: null,
              implementationThreadId: null,
              dismissedAt: null,
              createdAt: completedAt,
              updatedAt: completedAt,
            },
            createdAt: completedAt,
          });
        }

        if (scenario.status === "failed") {
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("runtime-error"),
            threadId,
            activity: {
              id: EventId.make(`${prefix}:runtime-error`),
              tone: "error",
              kind: "runtime.error",
              summary: "Runtime error",
              payload: {
                message: "Generated stylesheet could not be parsed safely.",
                provider: providerName,
              },
              turnId,
              createdAt: completedAt,
            },
            createdAt: completedAt,
          });
        }

        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("session-settled"),
          threadId,
          session: {
            threadId,
            status: scenario.status === "failed" ? "error" : "ready",
            providerName,
            providerInstanceId: threadSeed.modelSelection.instanceId,
            providerSessionId: `${prefix}:session`,
            providerThreadId: `${prefix}:provider-thread`,
            runtimeMode: "full-access",
            activeTurnId: null,
            pendingBackgroundTaskCount: scenario.status === "background" ? 1 : 0,
            lastError:
              scenario.status === "failed"
                ? "Generated stylesheet could not be parsed safely."
                : null,
            updatedAt: completedAt,
          },
          createdAt: completedAt,
        });
        scenarioCount += 1;
      });

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
        let threadId: ThreadId;
        if (existing) {
          threadId = existing.id;
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
          if (
            threadSeed.interactionMode !== undefined &&
            existing.interactionMode !== threadSeed.interactionMode
          ) {
            yield* engine.dispatch({
              type: "thread.interaction-mode.set",
              commandId: CommandId.make(`marketing-studio-v6:${existing.id}:interaction-mode`),
              threadId: existing.id,
              interactionMode: threadSeed.interactionMode,
              createdAt: threadSeed.createdAt,
            });
          }
        } else {
          threadId = ThreadId.make(crypto.randomUUID());
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(crypto.randomUUID()),
            threadId,
            projectId: project.id,
            title: threadSeed.title,
            modelSelection: threadSeed.modelSelection,
            runtimeMode: "full-access",
            interactionMode: threadSeed.interactionMode ?? "default",
            branch: threadSeed.branch,
            worktreePath: threadSeed.worktreePath,
            createdAt: threadSeed.createdAt,
          });
          createdCount += 1;
        }

        yield* seedScenario(threadId, threadSeed);
      }
    }

    // ProjectionPipeline applies shell-summary derivatives (pending approval /
    // input counts) asynchronously after the event store accepts each command.
    // Give that normal pipeline a short convergence window before verifying the
    // exact state the marketing sidebar will consume.
    yield* Effect.sleep("250 millis");
    const verifiedSnapshot = yield* snapshots.getSnapshot();
    const verifiedShell = yield* snapshots.getShellSnapshot();
    for (const projectSeed of input.projects) {
      const project = verifiedSnapshot.projects.find(
        (candidate) =>
          candidate.deletedAt === null && candidate.workspaceRoot === projectSeed.workspaceRoot,
      );
      if (!project) {
        return yield* Effect.fail(
          new Error(`Marketing Studio verification could not find ${projectSeed.workspaceRoot}.`),
        );
      }
      for (const threadSeed of projectSeed.threads) {
        const scenario = threadSeed.scenario;
        if (!scenario) continue;
        const thread = verifiedSnapshot.threads.find(
          (candidate) =>
            candidate.deletedAt === null &&
            candidate.projectId === project.id &&
            candidate.title === threadSeed.title,
        );
        if (!thread || !thread.messages.some((message) => message.text === scenario.prompt)) {
          return yield* Effect.fail(
            new Error(`Marketing Studio scenario transcript is missing: ${threadSeed.title}.`),
          );
        }
        const shellThread = verifiedShell.threads.find(
          (candidate) => candidate.projectId === project.id && candidate.id === thread.id,
        );
        if (!shellThread) {
          return yield* Effect.fail(
            new Error(`Marketing Studio shell scenario is missing: ${threadSeed.title}.`),
          );
        }

        const matchesStatus = (() => {
          switch (scenario.status) {
            case "idle":
              return (
                shellThread.session === null &&
                shellThread.latestTurn === null &&
                !shellThread.hasPendingApprovals &&
                !shellThread.hasPendingUserInput
              );
            case "working":
              return (
                shellThread.session?.status === "running" &&
                shellThread.latestTurn?.state === "running"
              );
            case "starting":
              return shellThread.session?.status === "starting";
            case "completed":
              return (
                shellThread.session?.status === "ready" &&
                shellThread.latestTurn?.state === "completed"
              );
            case "pending-approval":
              return shellThread.hasPendingApprovals && shellThread.session?.status === "running";
            case "awaiting-input":
              return shellThread.hasPendingUserInput && shellThread.session?.status === "running";
            case "plan-ready":
              return (
                shellThread.interactionMode === "plan" &&
                shellThread.session?.status === "ready" &&
                shellThread.hasActionableProposedPlan
              );
            case "background":
              return (
                shellThread.session?.status === "ready" &&
                shellThread.session.pendingBackgroundTaskCount === 1 &&
                shellThread.latestTurn?.state === "completed"
              );
            case "failed":
              return (
                shellThread.session?.status === "error" && shellThread.latestTurn?.state === "error"
              );
          }
        })();
        if (!matchesStatus) {
          return yield* Effect.fail(
            new Error(
              `Marketing Studio scenario status '${scenario.status}' is not projected for ${threadSeed.title}: ${JSON.stringify(
                {
                  sessionStatus: shellThread.session?.status ?? null,
                  latestTurnState: shellThread.latestTurn?.state ?? null,
                  hasPendingApprovals: shellThread.hasPendingApprovals,
                  hasPendingUserInput: shellThread.hasPendingUserInput,
                  activityKinds: thread.activities.map((activity) => activity.kind),
                },
              )}`,
            ),
          );
        }
      }
    }

    return {
      createdCount,
      updatedCount,
      unarchivedCount,
      removedPlaceholderCount,
      scenarioCount,
    };
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
    `Marketing Studio threads: ${result.createdCount} created, ${result.updatedCount} updated, ${result.unarchivedCount} unarchived, ${result.removedPlaceholderCount} placeholders removed, ${result.scenarioCount} realistic scenarios seeded.`,
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

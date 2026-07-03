/**
 * Streaming write-path smoke test.
 *
 * Guards the per-delta cost of the hot path: one flushed assistant delta =
 * one orchestration command = decide → append → project (all projectors) →
 * receipt, all on the synchronous SQLite driver. During a real turn these
 * arrive every ~50ms per streaming session, so a regression here (an extra
 * per-event table scan, a lost index, per-projector transactions) directly
 * becomes typing-latency and UI jank on older machines.
 *
 * The bound is deliberately generous — CI machines are slow and shared —
 * so a failure means a structural regression, not noise.
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@threadlines/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { describe, expect, it } from "vitest";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

const DELTA_COUNT = 300;
/**
 * 50ms per delta command end-to-end — an order of magnitude above the
 * expected per-command cost, low enough to catch anything that turns the
 * per-delta write path quadratic or reintroduces per-projector commits.
 */
const MAX_TOTAL_MILLIS = DELTA_COUNT * 50;

const NOW_ISO = "2026-01-01T00:00:00.000Z";

async function createOrchestrationSystem() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "threadlines-streaming-perf-test-",
  });
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  return {
    engine,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

describe("streaming write-path throughput", () => {
  it(
    `handles ${DELTA_COUNT} assistant delta commands within ${MAX_TOTAL_MILLIS}ms`,
    { timeout: MAX_TOTAL_MILLIS + 30_000 },
    async () => {
      const system = await createOrchestrationSystem();
      try {
        const { engine } = system;
        await system.run(
          engine.dispatch({
            type: "project.create",
            commandId: CommandId.make("cmd-perf-project"),
            projectId: ProjectId.make("project-perf"),
            title: "Perf Project",
            workspaceRoot: "/tmp/project-perf",
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            createdAt: NOW_ISO,
          }),
        );
        await system.run(
          engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cmd-perf-thread"),
            threadId: ThreadId.make("thread-perf"),
            projectId: ProjectId.make("project-perf"),
            title: "Perf Thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt: NOW_ISO,
          }),
        );

        const messageId = MessageId.make("msg-perf-stream");
        // ~80 chars per flush approximates a 50ms flush window of fast
        // streaming; the message grows to ~24KB like a long real answer.
        const delta = "x".repeat(80);

        const startedAt = performance.now();
        let lastSequence = 0;
        for (let index = 0; index < DELTA_COUNT; index += 1) {
          const result = await system.run(
            engine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: CommandId.make(`cmd-perf-delta-${index}`),
              threadId: ThreadId.make("thread-perf"),
              messageId,
              delta,
              createdAt: NOW_ISO,
            }),
          );
          lastSequence = result.sequence;
        }
        const elapsedMillis = performance.now() - startedAt;

        // Every command produced a persisted event.
        expect(lastSequence).toBeGreaterThanOrEqual(DELTA_COUNT);

        console.info(
          `streaming perf: ${DELTA_COUNT} deltas in ${elapsedMillis.toFixed(0)}ms ` +
            `(${(elapsedMillis / DELTA_COUNT).toFixed(2)}ms/command)`,
        );
        expect(elapsedMillis).toBeLessThan(MAX_TOTAL_MILLIS);
      } finally {
        await system.dispose();
      }
    },
  );
});

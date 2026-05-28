import { randomUUID } from "node:crypto";

import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const activeProviderThreadIds = yield* providerService.listSessions().pipe(
        Effect.map((sessions) => new Set(sessions.map((session) => session.threadId))),
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.reaper.list-sessions-failed", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (activeProviderThreadIds?.has(binding.threadId)) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread?.session?.activeTurnId ?? null,
            idleDurationMs,
            reason: "provider_session_active",
          });
          continue;
        }
        if (activeProviderThreadIds === null && thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
            reason: "provider_session_list_unavailable",
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() => {
            return Effect.all(
              [
                Effect.logInfo("provider.session.reaped", {
                  threadId: binding.threadId,
                  provider: binding.provider,
                  idleDurationMs,
                  reason: "inactivity_threshold",
                }),
                !thread?.session || thread.session.status === "stopped"
                  ? Effect.void
                  : orchestrationEngine
                      .dispatch({
                        type: "thread.session.set",
                        commandId: CommandId.make(
                          `provider-session-reaper:${binding.threadId}:${randomUUID()}`,
                        ),
                        threadId: binding.threadId,
                        session: {
                          threadId: binding.threadId,
                          status: "stopped",
                          providerName: thread?.session?.providerName ?? binding.provider,
                          ...(thread?.session?.providerInstanceId !== undefined
                            ? { providerInstanceId: thread.session.providerInstanceId }
                            : binding.providerInstanceId !== undefined
                              ? { providerInstanceId: binding.providerInstanceId }
                              : {}),
                          runtimeMode:
                            thread?.session?.runtimeMode ?? binding.runtimeMode ?? "full-access",
                          activeTurnId: null,
                          lastError: thread?.session?.lastError ?? null,
                          updatedAt: nowIso,
                        },
                        createdAt: nowIso,
                      })
                      .pipe(Effect.asVoid),
              ],
              { discard: true },
            );
          }),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();

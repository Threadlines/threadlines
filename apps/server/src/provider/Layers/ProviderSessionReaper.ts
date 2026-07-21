import { randomUUID } from "node:crypto";

import { CommandId, type OrchestrationSession, type ThreadId } from "@threadlines/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
} from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

type ThreadShellWithSession = {
  readonly session?: OrchestrationSession | null;
};

type StopProjectionReason = "inactivity_threshold" | "startup_binding_stopped" | "startup_orphaned";

const shouldClearProjectedSessionOnStartup = (session: OrchestrationSession) =>
  session.status === "starting" || session.status === "running";

const buildStoppedProjectionSession = (input: {
  readonly binding: ProviderRuntimeBindingWithMetadata;
  readonly thread: ThreadShellWithSession | undefined;
  readonly nowIso: string;
}): OrchestrationSession => {
  const session = input.thread?.session ?? null;
  return {
    threadId: input.binding.threadId,
    status: "stopped",
    providerName: session?.providerName ?? input.binding.provider,
    ...(session?.providerInstanceId !== undefined
      ? { providerInstanceId: session.providerInstanceId }
      : input.binding.providerInstanceId !== undefined
        ? { providerInstanceId: input.binding.providerInstanceId }
        : {}),
    ...(session?.providerSessionId !== undefined
      ? { providerSessionId: session.providerSessionId }
      : {}),
    ...(session?.providerThreadId !== undefined
      ? { providerThreadId: session.providerThreadId }
      : {}),
    runtimeMode: session?.runtimeMode ?? input.binding.runtimeMode ?? "full-access",
    activeTurnId: null,
    lastError: session?.lastError ?? null,
    updatedAt: input.nowIso,
  };
};

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

    const listProviderSessions = providerService
      .listSessions()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.reaper.list-sessions-failed", { cause }).pipe(
            Effect.as(null),
          ),
        ),
      );

    // Any live session, regardless of activity. Used by startup reconciliation
    // to decide whether a projected session still has a runtime behind it.
    const toLiveProviderThreadIds = (sessions: ReadonlyArray<{ threadId: ThreadId }> | null) =>
      sessions === null ? null : new Set(sessions.map((session) => session.threadId));

    // Only sessions doing work right now. Idle `ready` (and dead `error`/
    // `closed`) sessions must NOT exempt a thread from the inactivity sweep —
    // that would keep one provider subprocess alive per opened thread forever.
    const toBusyProviderThreadIds = (
      sessions: ReadonlyArray<{ threadId: ThreadId; status: string }> | null,
    ) =>
      sessions === null
        ? null
        : new Set(
            sessions
              .filter((session) => session.status === "connecting" || session.status === "running")
              .map((session) => session.threadId),
          );

    const dispatchStoppedProjection = (input: {
      readonly binding: ProviderRuntimeBindingWithMetadata;
      readonly thread: ThreadShellWithSession | undefined;
      readonly nowIso: string;
      readonly reason: StopProjectionReason;
    }) =>
      Effect.gen(function* () {
        const session = input.thread?.session ?? null;
        if (!session || session.status === "stopped") {
          return false;
        }

        yield* orchestrationEngine
          .dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(
              `provider-session-reaper:${input.reason}:${input.binding.threadId}:${randomUUID()}`,
            ),
            threadId: input.binding.threadId,
            session: buildStoppedProjectionSession(input),
            createdAt: input.nowIso,
          })
          .pipe(Effect.asVoid);
        return true;
      });

    const reconcileStartup = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const activeProviderThreadIds = toLiveProviderThreadIds(yield* listProviderSessions);
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      let reconciledCount = 0;
      let orphanedCount = 0;

      for (const binding of bindings) {
        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        const session = thread?.session ?? null;
        if (!session || session.status === "stopped") {
          continue;
        }

        if (binding.status === "stopped") {
          const reconciled = yield* dispatchStoppedProjection({
            binding,
            thread,
            nowIso,
            reason: "startup_binding_stopped",
          });
          if (reconciled) {
            reconciledCount += 1;
          }
          continue;
        }

        if (!shouldClearProjectedSessionOnStartup(session)) {
          continue;
        }
        if (activeProviderThreadIds === null || activeProviderThreadIds.has(binding.threadId)) {
          continue;
        }

        const stopped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.startup-stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
        if (!stopped) {
          continue;
        }

        const reconciled = yield* dispatchStoppedProjection({
          binding,
          thread,
          nowIso,
          reason: "startup_orphaned",
        });
        if (reconciled) {
          reconciledCount += 1;
        }
        orphanedCount += 1;
      }

      if (reconciledCount > 0 || orphanedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.startup-reconciled", {
          reconciledCount,
          orphanedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const busyProviderThreadIds = toBusyProviderThreadIds(yield* listProviderSessions);
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
        if (busyProviderThreadIds?.has(binding.threadId)) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread?.session?.activeTurnId ?? null,
            idleDurationMs,
            reason: "provider_session_active",
          });
          continue;
        }
        if (busyProviderThreadIds === null && thread?.session?.activeTurnId != null) {
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
                  : dispatchStoppedProjection({
                      binding,
                      thread,
                      nowIso,
                      reason: "inactivity_threshold",
                    }).pipe(Effect.asVoid),
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
        yield* reconcileStartup.pipe(
          Effect.catch((error: unknown) =>
            Effect.logWarning("provider.session.reaper.startup-reconcile-failed", {
              error,
            }),
          ),
          Effect.catchDefect((defect: unknown) =>
            Effect.logWarning("provider.session.reaper.startup-reconcile-defect", {
              defect,
            }),
          ),
        );

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

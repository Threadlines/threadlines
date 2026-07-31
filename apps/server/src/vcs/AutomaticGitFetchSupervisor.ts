import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { VcsStatusBroadcaster } from "./VcsStatusBroadcaster.ts";

const SNAPSHOT_RETRY_DELAY = Duration.seconds(30);
const MONITOR_RETRY_DELAY = Duration.seconds(30);

export interface AutomaticGitFetchSupervisorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class AutomaticGitFetchSupervisor extends Context.Service<
  AutomaticGitFetchSupervisor,
  AutomaticGitFetchSupervisorShape
>()("threadlines/vcs/AutomaticGitFetchSupervisor") {}

const makeAutomaticGitFetchSupervisor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;

  const automaticRemoteRefreshInterval = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.automaticGitFetchInterval),
    Effect.catch((error) =>
      Effect.logWarning("vcs.automatic-fetch.settings-read-failed", { error }).pipe(
        Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL),
      ),
    ),
  );

  const monitorWorkspaceRoot = (workspaceRoot: string): Effect.Effect<void, never> =>
    Effect.forever(
      Stream.runDrain(
        vcsStatusBroadcaster.streamStatus(
          { cwd: workspaceRoot },
          { automaticRemoteRefreshInterval },
        ),
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning("vcs.automatic-fetch.monitor-failed", {
            workspaceRoot,
            error,
          }),
        ),
        Effect.andThen(Effect.sleep(MONITOR_RETRY_DELAY)),
      ),
    );

  const loadInitialProjects = (): Effect.Effect<{
    readonly snapshotSequence: number;
    readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  }> =>
    projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.map(({ snapshotSequence, projects }) => ({ snapshotSequence, projects })),
      Effect.catch((error) =>
        Effect.logWarning("vcs.automatic-fetch.snapshot-query-failed", { error }).pipe(
          Effect.andThen(Effect.sleep(SNAPSHOT_RETRY_DELAY)),
          Effect.andThen(Effect.suspend(loadInitialProjects)),
        ),
      ),
    );

  const start: AutomaticGitFetchSupervisorShape["start"] = () =>
    Effect.gen(function* () {
      // Subscribe before loading the snapshot so project changes made during
      // the query are buffered and applied after its sequence cursor.
      const domainEvents = yield* orchestrationEngine.subscribeDomainEvents;

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const initial = yield* loadInitialProjects();
          let lastSequence = initial.snapshotSequence;
          const projectRoots = new Map<ProjectId, string>(
            initial.projects
              .filter((project) => project.kind === "workspace")
              .map((project) => [project.id, project.workspaceRoot]),
          );
          const activeMonitors = new Map<string, Fiber.Fiber<void, never>>();

          const reconcileMonitors = Effect.gen(function* () {
            const desiredRoots = new Set(projectRoots.values());

            for (const [workspaceRoot, fiber] of activeMonitors) {
              if (!desiredRoots.has(workspaceRoot)) {
                activeMonitors.delete(workspaceRoot);
                yield* Fiber.interrupt(fiber).pipe(Effect.ignore);
              }
            }

            for (const workspaceRoot of desiredRoots) {
              if (activeMonitors.has(workspaceRoot)) {
                continue;
              }
              const fiber = yield* Effect.forkScoped(monitorWorkspaceRoot(workspaceRoot));
              activeMonitors.set(workspaceRoot, fiber);
            }
          });

          const applyProjectEvent = (
            event: OrchestrationEvent,
          ): Effect.Effect<void, never, Scope.Scope> =>
            Effect.gen(function* () {
              if (event.sequence <= lastSequence) {
                return;
              }
              lastSequence = event.sequence;

              switch (event.type) {
                case "project.created":
                  if (event.payload.kind === "workspace") {
                    projectRoots.set(event.payload.projectId, event.payload.workspaceRoot);
                    yield* reconcileMonitors;
                  }
                  break;
                case "project.meta-updated":
                  if (
                    event.payload.workspaceRoot !== undefined &&
                    projectRoots.has(event.payload.projectId)
                  ) {
                    projectRoots.set(event.payload.projectId, event.payload.workspaceRoot);
                    yield* reconcileMonitors;
                  }
                  break;
                case "project.deleted":
                  if (projectRoots.delete(event.payload.projectId)) {
                    yield* reconcileMonitors;
                  }
                  break;
              }
            });

          yield* reconcileMonitors;
          yield* Stream.runForEach(domainEvents, applyProjectEvent);
        }).pipe(
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("vcs.automatic-fetch.supervisor-failed", {
                  detail: cause.toString(),
                }),
          ),
        ),
      );

      yield* Effect.logInfo("vcs.automatic-fetch.started");
    });

  return AutomaticGitFetchSupervisor.of({ start });
});

export const AutomaticGitFetchSupervisorLive = Layer.effect(
  AutomaticGitFetchSupervisor,
  makeAutomaticGitFetchSupervisor,
);

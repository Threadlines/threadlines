import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  ProjectId,
  type VcsStatusStreamEvent,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  AutomaticGitFetchSupervisor,
  AutomaticGitFetchSupervisorLive,
} from "./AutomaticGitFetchSupervisor.ts";
import { VcsStatusBroadcaster } from "./VcsStatusBroadcaster.ts";

const NOW = "2026-07-31T00:00:00.000Z";

function project(
  id: string,
  workspaceRoot: string,
  kind: "workspace" | "general-chat" = "workspace",
): OrchestrationProjectShell {
  return {
    id: ProjectId.make(id),
    kind,
    title: id,
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function eventBase(sequence: number, projectId: ProjectId) {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "project" as const,
    aggregateId: projectId,
    occurredAt: NOW,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: CommandId.make(`command-${sequence}`),
    metadata: {},
  };
}

describe("AutomaticGitFetchSupervisor", () => {
  it("monitors workspace projects without a browser subscriber and follows project roots", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
        const transitions = yield* Queue.unbounded<string>();
        const takeTransition = Queue.take(transitions).pipe(Effect.timeout("1 second"));
        const activeRoots = yield* Ref.make(new Set<string>());
        const projectA = project("project-a", "/repo-a");
        const projectB = project("project-b", "/repo-b");

        const broadcasterLayer = Layer.mock(VcsStatusBroadcaster)({
          streamStatus: ({ cwd }) =>
            Stream.concat(
              Stream.fromEffect(
                Ref.update(activeRoots, (roots) => new Set(roots).add(cwd)).pipe(
                  Effect.andThen(Queue.offer(transitions, `started:${cwd}`)),
                  Effect.as({
                    _tag: "snapshot",
                    local: {
                      isRepo: false,
                      hasPrimaryRemote: false,
                      isDefaultRef: false,
                      refName: null,
                      hasWorkingTreeChanges: false,
                      workingTree: { files: [], insertions: 0, deletions: 0 },
                    },
                    remote: null,
                  } satisfies VcsStatusStreamEvent),
                ),
              ),
              Stream.never,
            ).pipe(
              Stream.ensuring(
                Ref.update(activeRoots, (roots) => {
                  const next = new Set(roots);
                  next.delete(cwd);
                  return next;
                }).pipe(Effect.andThen(Queue.offer(transitions, `stopped:${cwd}`)), Effect.asVoid),
              ),
            ),
        });
        const engineLayer = Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: Effect.map(
            PubSub.subscribe(domainEvents),
            Stream.fromSubscription,
          ),
        } satisfies Partial<OrchestrationEngineShape>);
        const snapshotLayer = Layer.mock(ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [projectA, project("general", "/not-a-repository", "general-chat")],
              threads: [],
              updatedAt: NOW,
            }),
        });
        const liveLayer = AutomaticGitFetchSupervisorLive.pipe(
          Layer.provide(broadcasterLayer),
          Layer.provide(engineLayer),
          Layer.provide(snapshotLayer),
          Layer.provide(
            ServerSettingsService.layerTest({ automaticGitFetchInterval: Duration.zero }),
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const supervisor = yield* AutomaticGitFetchSupervisor;
            yield* supervisor.start();
            expect(yield* takeTransition).toBe("started:/repo-a");

            yield* PubSub.publish(domainEvents, {
              ...eventBase(2, projectB.id),
              type: "project.created",
              payload: {
                projectId: projectB.id,
                kind: projectB.kind,
                title: projectB.title,
                workspaceRoot: projectB.workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: NOW,
                updatedAt: NOW,
              },
            });
            expect(yield* takeTransition).toBe("started:/repo-b");

            yield* PubSub.publish(domainEvents, {
              ...eventBase(3, projectB.id),
              type: "project.meta-updated",
              payload: {
                projectId: projectB.id,
                workspaceRoot: "/repo-c",
                updatedAt: NOW,
              },
            });
            expect(yield* takeTransition).toBe("stopped:/repo-b");
            expect(yield* takeTransition).toBe("started:/repo-c");

            yield* PubSub.publish(domainEvents, {
              ...eventBase(4, projectA.id),
              type: "project.deleted",
              payload: {
                projectId: projectA.id,
                deletedAt: NOW,
              },
            });
            expect(yield* takeTransition).toBe("stopped:/repo-a");
            expect(yield* Ref.get(activeRoots)).toEqual(new Set(["/repo-c"]));
          }).pipe(Effect.provide(liveLayer)),
        );

        expect(yield* Ref.get(activeRoots)).toEqual(new Set());
      }),
    );
  });
});

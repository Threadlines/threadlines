/**
 * The outside agents' tools bound to the running server's orchestration,
 * settings and git: what both doors (`/mcp/connect`, McpConnectServer, and
 * the assistants door, AssistantMcpServer) build their handlers from.
 */
import type { ScheduledTaskRequest, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import packageJson from "../../package.json" with { type: "json" };
import { AssistantEvents } from "../assistants/AssistantEvents.ts";
import { hostedAppOrigin, hostedThreadLink } from "../assistants/hostedAppLinks.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrap } from "../orchestration/Services/ThreadBootstrap.ts";
import { ThreadSearch } from "../orchestration/Services/ThreadSearch.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledTasks } from "../scheduled/ScheduledTasks.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { makeConnectLimits } from "./connectLimits.ts";
import type { ConnectToolDeps } from "./connectToolHandlers.ts";
import { OutsideAgentConnections } from "./OutsideAgentConnections.ts";
import { OutsideAgentRequests } from "./OutsideAgentRequests.ts";

/** Everything the handlers read and drive, with a door's own limits. */
export const makeConnectToolDeps = Effect.gen(function* () {
  const connections = yield* OutsideAgentConnections;
  const engine = yield* OrchestrationEngineService;
  const bootstrap = yield* ThreadBootstrap;
  const snapshots = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry;
  const settings = yield* ServerSettingsService;
  const git = yield* GitVcsDriver;
  const requests = yield* OutsideAgentRequests;
  const search = yield* Effect.serviceOption(ThreadSearch);
  // Scheduled tasks, when this server has them: their cards waiting for
  // the user count in a thread's status.
  const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks);
  // Each where this server has it: links need the computer's id, `inbox` the
  // assistants' record, `thread_changes` the pull request records.
  const environment = yield* Effect.serviceOption(ServerEnvironment);
  const record = yield* Effect.serviceOption(AssistantEvents);
  const pullRequests = yield* Effect.serviceOption(PullRequestService);
  const appOrigin = hostedAppOrigin(packageJson.version);
  return {
    connections,
    engine,
    bootstrap,
    projects: snapshots.getProjectCatalog().pipe(
      Effect.map((catalog) => catalog.projects.filter((project) => project.deletedAt === null)),
      Effect.orDie,
    ),
    listThreads: (input) => snapshots.listThreadShells(input).pipe(Effect.orDie),
    threadProject: (threadId) =>
      snapshots.listThreadShells({ threadIds: [threadId], includeArchived: true }).pipe(
        Effect.map((shells) => shells[0]?.projectId),
        Effect.orDie,
      ),
    readProject: (projectId) =>
      snapshots
        .getProjectShellById(projectId)
        .pipe(Effect.map(Option.getOrUndefined), Effect.orDie),
    readThread: (threadId) =>
      snapshots.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined), Effect.orDie),
    status: {
      subscribeEvents: engine.subscribeDomainEvents,
      readShell: (threadId) =>
        snapshots
          .getThreadShellById(threadId)
          .pipe(Effect.map(Option.getOrUndefined), Effect.orDie),
      scheduleAnswerWaiting: Option.isSome(scheduledTasks)
        ? scheduledTasks.value.waitingThreadIds
        : Effect.succeed(new Set<ThreadId>()),
      scheduleAnswerChanges: Option.isSome(scheduledTasks)
        ? scheduledTasks.value.changes.pipe(Stream.ignore)
        : Stream.empty,
    },
    providers: providers.getProviders,
    userDefaultModel: settings.getSettings.pipe(
      Effect.map((current) => current.newThreadModelSelection),
      Effect.orElseSucceed(() => null),
    ),
    git,
    ...(Option.isSome(search)
      ? {
          searchThreads: (input) =>
            search.value.search(input).pipe(
              Effect.map((result) => result.matches.map((match) => match.threadId)),
              Effect.orElseSucceed(() => []),
            ),
        }
      : {}),
    requests,
    limits: makeConnectLimits(),
    scheduleRequests: Option.isSome(scheduledTasks)
      ? scheduledTasks.value.snapshot.pipe(
          Effect.map((snapshot) => snapshot.requests),
          Effect.orElseSucceed((): ReadonlyArray<ScheduledTaskRequest> => []),
        )
      : Effect.succeed([]),
    threadLink: (threadId) =>
      Option.isSome(environment)
        ? environment.value.getEnvironmentId.pipe(
            Effect.map((environmentId) =>
              hostedThreadLink({ origin: appOrigin, environmentId, threadId }),
            ),
          )
        : Effect.succeed(null),
    ...(Option.isSome(record) ? { record: record.value } : {}),
    ...(Option.isSome(pullRequests) ? { pullRequests: pullRequests.value } : {}),
  } satisfies ConnectToolDeps;
});

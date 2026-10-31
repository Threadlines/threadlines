/**
 * What an outside agent's tools do (docs/design/outside-agents.md, "The MCP
 * server" and "Threads an outside agent starts"). The `/mcp/connect`
 * middleware names the connection (McpConnectInvocation); every handler
 * then:
 *
 * 1. counts the call against the connection's limit (`limit`);
 * 2. reads the connection's live grant again, so a Change or a Remove in
 *    Threadlines applies to this call whatever the tool list showed
 *    (`not_allowed`);
 * 3. sees only the projects in the grant: a thread anywhere else reads as
 *    not found, never as not allowed.
 *
 * Every decision is an outcome in a successful result, never an MCP error,
 * so the structured result always decodes.
 *
 * Starts go the way the app's own first send goes: one `thread.turn.start`
 * with a bootstrap, through ThreadBootstrap.runTurnStart, with the thread
 * labelled (`outsideOrigin`) and the turn carrying the connection's ceiling
 * (`fromOutside`). Sends are plain turn starts with `fromOutside`, refused
 * while the thread is busy, never queued. The decider is the authority on
 * both (orchestration/outsideTurns.ts); the checks here only answer early.
 *
 * Starts and sends are idempotent by the caller's `requestId`
 * (OutsideAgentRequests): a retry in flight joins the first call, one after
 * answers from its row, and the same id with other input is a `conflict`,
 * in flight or after. A claimed row keeps the fresh ids its call dispatches
 * with, so an id reused after its row was pruned is new work under new ids,
 * never a write over an old message. A replay answers only while the
 * thread it names is still in the connection's projects. Stops take a
 * request id too, and a retried stop answers from its row.
 *
 * The assistants door (docs/design/assistants.md, "Tools") runs the same
 * handlers with `door: "assistant"`, which changes three things:
 * - `requestId` is required on `thread_start`, `thread_send` and
 *   `thread_stop`;
 * - `thread_start` answers `starting` with the thread id at once, before the
 *   worktree is made: its request row is the durable record, with the thread
 *   id set before work begins, and the setup runs on after the answer, its
 *   outcome recorded on the row. Until the thread exists, `thread_read`,
 *   `thread_wait` and `threads_list` answer for it as `starting`, or
 *   `failed` with why;
 * - `thread_wait` holds at most ASSISTANT_THREAD_WAIT_MAX_SECONDS, under the
 *   relay's request timeout.
 */
import {
  ASSISTANT_THREAD_WAIT_MAX_SECONDS,
  CommandId,
  DEFAULT_NEW_THREAD_RUNTIME_MODE,
  MessageId,
  type ModelSelection,
  ORCHESTRATION_THREAD_SEARCH_MAX_LIMIT,
  ORCHESTRATION_THREAD_SEARCH_MAX_PROJECTS,
  ORCHESTRATION_THREAD_SEARCH_MAX_QUERY_CHARS,
  type OrchestrationCommand,
  type OrchestrationProjectCatalogEntry,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestrationThreadSearchInput,
  type OutsideAgentConnectionId,
  type ProjectId,
  PULL_REQUEST_LOOKUP_LIMIT,
  type PullRequestListEntry,
  type PullRequestLookupEntry,
  type ScheduledTaskRequest,
  type ServerProvider,
  ThreadId,
} from "@threadlines/contracts";
import { exceedsRuntimeMode, saferRuntimeMode } from "@threadlines/shared/runtimeMode";
import { changeRequestRepositoryName } from "@threadlines/shared/sourceControl";
import { truncate } from "@threadlines/shared/String";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import {
  type AssistantEventsShape,
  decodeEventCursor,
  encodeEventCursor,
} from "../assistants/AssistantEvents.ts";
import { childModelRefusal } from "../orchestration/childThreadAgents.ts";
import { childWorktreeBranch, derivedUuid } from "../orchestration/childRequestIds.ts";
import { makeSingleFlight } from "../orchestration/Layers/BootstrapTurnStartRuns.ts";
import { outsideCeilingDetail, outsideTurnBusy } from "../orchestration/outsideTurns.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type {
  ThreadBootstrapShape,
  ThreadTurnStartCommand,
} from "../orchestration/Services/ThreadBootstrap.ts";
import {
  clipText,
  defaultThreadAgent,
  listThreadAgents,
  modelLabel,
  readThreadPage,
  relatedThreadTitles,
  requestedAgent,
  summarizeThread,
  THREAD_PROMPT_CHAR_LIMIT,
  THREAD_READ_MESSAGE_CHAR_LIMIT,
  THREAD_TITLE_CHAR_LIMIT,
  threadLastTurn,
  threadStatus,
  type ThreadStatusFeed,
  watchThreadStatus,
} from "../threads/threadOperations.ts";
import { threadWaitingItems } from "../threads/threadWaiting.ts";
import type { PullRequestServiceShape } from "../pullRequest/PullRequestService.ts";
import { alertReasonText } from "../pushAlerts/pushAlertRules.ts";
import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import {
  type ConnectLimits,
  CONNECT_RUNNING_THREADS,
  CONNECT_STARTS_PER_DAY,
  countsAsRunning,
} from "./connectLimits.ts";
import {
  type AgentsResult,
  type AgentsTool,
  INBOX_EVENTS_LIMIT,
  type InboxEvent,
  type InboxNeedsYou,
  type InboxResult,
  type InboxTool,
  type OutsideThreadReadResult,
  type OutsideThreadReadTool,
  type OutsideThreadSendResult,
  type OutsideThreadSendTool,
  type OutsideThreadStartResult,
  type OutsideThreadStartTool,
  type OutsideStartingThread,
  type OutsideThreadStopResult,
  type OutsideThreadStopTool,
  type OutsideThreadSummary,
  type ProjectsResult,
  THREAD_WAIT_DEFAULT_SECONDS,
  THREAD_WAIT_MAX_SECONDS,
  type ThreadChangesPullRequest,
  type ThreadChangesResult,
  type ThreadChangesTool,
  type ThreadsListResult,
  type ThreadsListTool,
  type ThreadWaitResult,
  type ThreadWaitTool,
} from "./connectTools.ts";
import type {
  OutsideAgentCaller,
  OutsideAgentConnectionsShape,
  OutsideAgentLiveGrant,
} from "./OutsideAgentConnections.ts";
import {
  OUTSIDE_REQUEST_RETENTION_MS,
  type OutsideAgentRequestRow,
  type OutsideAgentRequestsShape,
  type OutsideAgentRequestTool,
} from "./OutsideAgentRequests.ts";

/** `threads_list` lists at most this many. */
const THREADS_LIST_LIMIT = 50;
/** A `requestId`, at most this long. */
const REQUEST_ID_CHAR_LIMIT = 200;
const GIT_TIMEOUT_MS = 15_000;
/** All of an assistant's thread_start git checks, under the relay's 30 s request timeout. */
const ASSISTANT_PLACE_DEADLINE = "10 seconds";
const DAY_MS = 24 * 60 * 60 * 1000;

const REMOVED =
  "This connection was removed in Threadlines. Sign in again from your agent to use it.";
const SEE_ONLY =
  "This connection can only see threads. The user can change that in Threadlines → Settings → Connections.";
const THREAD_NOT_FOUND = "No thread with that id is in your projects. threads_list shows them.";
const NOT_YOURS = "You can only send to or stop threads you started.";
const NO_STORE = "Threadlines couldn't keep track of this call. Try again.";
const CONFLICT = {
  outcome: "conflict" as const,
  detail: "That requestId was already used for a different call. Use a new requestId for new work.",
};
const REQUEST_ID_REQUIRED =
  "Send a requestId: any unique string with every thread_start, thread_send and thread_stop, and the same one when you retry the call. Then a retry never does the work twice.";
const SETTING_UP =
  "It's still being set up (its worktree and setup script). Follow it with thread_wait.";
const SET_UP_CUT_OFF =
  "Threadlines restarted while this thread was being set up, before it was made. Start again with a new requestId.";
/** How long a start whose setup failed before its thread existed stays in threads_list. */
const FAILED_START_KEPT = Duration.hours(1);
/** `inbox` reads at most this many threads that need the user, most recently active first. */
const INBOX_WAITING_THREADS = 50;
/** `thread_changes` lists at most this many files. */
const THREAD_CHANGES_FILES = 200;
/** All of `thread_changes`' asking the host and git, well under the relay's 30 s. */
const THREAD_CHANGES_DEADLINE = "6 seconds";
const BASE_BRANCH_GIT_TIMEOUT_MS = 3_000;
const RECORD_NOT_KEPT =
  "No assistant is connected to this computer, so it keeps no record of what finished or failed. needsYou is live.";
/** Recorded events the user dealt with in Threadlines: opened the thread, marked it done or archived it. */
const SEEN_IN_THREADLINES: ReadonlySet<string> = new Set(["seen", "wrapped", "archived"]);

/** Which door the calls come through (docs/design/assistants.md). */
export type ConnectToolDoor = "local" | "assistant";

/** An assistant's start that answered before its setup, while it has no thread yet. */
interface SettingUp {
  readonly connectionId: OutsideAgentConnectionId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly project: string;
  readonly title: string;
  /** The `starting` answer, for a retry under the same request id. */
  readonly answer: OutsideThreadStartResult;
  state: "starting" | "failed";
  detail: string | undefined;
  /** Done once the setup ended, either way. */
  readonly settled: Deferred.Deferred<void>;
}

export interface ConnectToolDeps {
  readonly connections: Pick<OutsideAgentConnectionsShape, "grant">;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch" | "getCommandReceipt">;
  readonly bootstrap: Pick<ThreadBootstrapShape, "runTurnStart">;
  /** The open projects, read without any thread (the project catalog). */
  readonly projects: Effect.Effect<ReadonlyArray<ConnectProject>>;
  /**
   * Thread shells by project or by the connection that started them
   * (ProjectionSnapshotQuery.listThreadShells): never the whole sidebar.
   */
  readonly listThreads: (input: {
    readonly projectIds?: ReadonlyArray<ProjectId>;
    readonly threadIds?: ReadonlyArray<ThreadId>;
    readonly outsideConnectionId?: OutsideAgentConnectionId;
    readonly includeArchived?: boolean;
  }) => Effect.Effect<ReadonlyArray<OrchestrationThreadShell>>;
  /** A thread's project, archived threads included; undefined once deleted. */
  readonly threadProject: (threadId: ThreadId) => Effect.Effect<ProjectId | undefined>;
  readonly readProject: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationProjectShell | undefined>;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  /** How threads are doing, and where that comes from (ThreadStatusFeed). */
  readonly status: ThreadStatusFeed;
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
  /** The user's default model for new threads (Settings); null: none set. */
  readonly userDefaultModel: Effect.Effect<ModelSelection | null>;
  readonly git: Pick<GitVcsDriverShape, "execute">;
  /** Threads whose messages match `query` (ThreadSearch); absent: titles only. */
  readonly searchThreads?: (
    input: OrchestrationThreadSearchInput,
  ) => Effect.Effect<ReadonlyArray<ThreadId>>;
  readonly requests: OutsideAgentRequestsShape;
  readonly limits: ConnectLimits;
  /** Agents' scheduled-task changes waiting for the user (ScheduledTasks); empty without them. */
  readonly scheduleRequests: Effect.Effect<ReadonlyArray<ScheduledTaskRequest>>;
  /** Where the user opens a thread (the hosted app's address for it); null when unknown. */
  readonly threadLink: (threadId: ThreadId) => Effect.Effect<string | null>;
  /** The assistants' event record (AssistantEvents): `inbox`'s finished and failed. Absent: none. */
  readonly record?: Pick<AssistantEventsShape, "position" | "since">;
  /** The pull request records the app keeps (PullRequestService). Absent: none. */
  readonly pullRequests?: Pick<PullRequestServiceShape, "list" | "lookup">;
}

/** A project as these tools see it. */
type ConnectProject = Pick<
  OrchestrationProjectCatalogEntry,
  "id" | "kind" | "title" | "workspaceRoot"
>;

type Refusal = {
  readonly outcome: "limit" | "not_allowed";
  readonly detail: string;
  readonly retryAfterSeconds?: number;
};

type StartInput = Tool.Parameters<typeof OutsideThreadStartTool>;
type SendInput = Tool.Parameters<typeof OutsideThreadSendTool>;
type StopInput = Tool.Parameters<typeof OutsideThreadStopTool>;

const nowMillis = Clock.currentTimeMillis;
const isoOf = (millis: number) => new Date(millis).toISOString();

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Fresh ids for one start or send, kept on its request row: never derived
 * from the caller's request id alone, which may come back once its row is
 * pruned, and new for each attempt, since a refused one leaves a rejected
 * receipt under its command id.
 */
const freshRequestIds = () => ({
  threadId: ThreadId.make(crypto.randomUUID()),
  messageId: MessageId.make(crypto.randomUUID()),
  commandId: CommandId.make(`server:outside:${crypto.randomUUID()}`),
});

/** What makes two calls under one request id the same call. */
const inputHashOf = (tool: OutsideAgentRequestTool, input: unknown) =>
  derivedUuid("outside-input", tool, JSON.stringify(input));

/** Whether the connection's grant lets it see `projectId`. */
const grantsProject = (grant: OutsideAgentLiveGrant, projectId: ProjectId) =>
  grant.projectIds === null || grant.projectIds.includes(projectId);

/**
 * The projects a connection sees: in its grant, and not General Chats (each
 * of those threads has a scratch folder of its own, and is the user's own
 * conversation, not a project's work).
 */
const projectsIn = <Project extends ConnectProject>(
  projects: ReadonlyArray<Project>,
  grant: OutsideAgentLiveGrant,
) =>
  projects.filter((project) => project.kind !== "general-chat" && grantsProject(grant, project.id));

/** The project a call names, by id or by name (case ignored), among the ones it sees. */
const findProject = <Project extends ConnectProject>(
  projects: ReadonlyArray<Project>,
  wanted: string,
): { readonly project: Project } | { readonly detail: string } => {
  const trimmed = wanted.trim();
  const byId = projects.find((project) => project.id === trimmed);
  if (byId !== undefined) return { project: byId };
  const byName = projects.filter(
    (project) => project.title.toLowerCase() === trimmed.toLowerCase(),
  );
  if (byName.length === 1) return { project: byName[0]! };
  return {
    detail:
      byName.length > 1
        ? `More than one project is called "${trimmed}". Use its id, from projects.`
        : `No project called "${trimmed}" is open to you. projects lists them.`,
  };
};

/** The newest reply in a thread, clipped; null when it has none. */
const newestReply = (thread: OrchestrationThread | undefined): string | null => {
  const reply = thread?.messages.findLast(
    (message) => message.role === "assistant" && message.text.trim().length > 0,
  );
  return reply === undefined
    ? null
    : clipText(reply.text.trim(), THREAD_READ_MESSAGE_CHAR_LIMIT).text;
};

/** Whether a thread has a turn Stop can end. */
const hasRunningTurn = (thread: OrchestrationThread) =>
  thread.latestTurn?.state === "running" ||
  (thread.session !== null &&
    (thread.session.activeTurnId !== null ||
      thread.session.status === "running" ||
      thread.session.status === "starting"));

export const makeConnectToolHandlers = (
  deps: ConnectToolDeps,
  options: { readonly door?: ConnectToolDoor } = {},
) =>
  Effect.gen(function* () {
    const door = options.door ?? "local";
    const assistant = door === "assistant";
    /** Where an assistant's setups run on after their answers: the handlers' own scope. */
    const scope = yield* Effect.scope;
    /** An assistant's starts still being set up (or failed before their thread existed), by thread id. */
    const settingUp = new Map<string, SettingUp>();
    const waitMaxSeconds = assistant ? ASSISTANT_THREAD_WAIT_MAX_SECONDS : THREAD_WAIT_MAX_SECONDS;
    const waitDefaultSeconds = Math.min(THREAD_WAIT_DEFAULT_SECONDS, waitMaxSeconds);
    /**
     * One start or send per (connection, request id): a retry while the
     * first runs joins it, and the run finishes even if the call that began
     * it goes away.
     */
    const runs = yield* makeSingleFlight<string, unknown, never>();
    /** What each call in flight is (its tool and input hash), by its key. */
    const flights = new Map<string, string>();
    const once = <A>(input: {
      readonly key: string;
      readonly signature: string;
      readonly run: Effect.Effect<A>;
      /** The answer to a call under the same key with other input. */
      readonly conflict: A;
    }): Effect.Effect<A> =>
      Effect.suspend(() => {
        const inFlight = flights.get(input.key);
        if (inFlight !== undefined && inFlight !== input.signature) {
          return Effect.succeed(input.conflict);
        }
        flights.set(input.key, input.signature);
        return runs.run(
          input.key,
          input.run.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (flights.get(input.key) === input.signature) flights.delete(input.key);
              }),
            ),
          ),
        ) as Effect.Effect<A>;
      });

    /** Steps 1 and 2 of every call: the limit, then the live grant. */
    const gate = (
      caller: OutsideAgentCaller,
      needs: "see" | "start",
    ): Effect.Effect<{ readonly refusal: Refusal } | { readonly grant: OutsideAgentLiveGrant }> =>
      Effect.gen(function* () {
        const retryAfterSeconds = yield* deps.limits.call(caller.connectionId);
        if (retryAfterSeconds !== null) {
          return {
            refusal: {
              outcome: "limit" as const,
              detail: `Too many calls this minute. Try again in ${plural(retryAfterSeconds, "second")}.`,
              retryAfterSeconds,
            },
          };
        }
        const grant = yield* deps.connections.grant(caller.connectionId);
        if (grant === null) {
          return { refusal: { outcome: "not_allowed" as const, detail: REMOVED } };
        }
        if (needs === "start" && grant.access !== "start") {
          return { refusal: { outcome: "not_allowed" as const, detail: SEE_ONLY } };
        }
        return { grant };
      });

    /** A thread the connection sees, or undefined: archived, deleted, or outside its projects. */
    const visibleThread = (grant: OutsideAgentLiveGrant, threadId: string) =>
      Effect.gen(function* () {
        const trimmed = threadId.trim();
        if (trimmed.length === 0) return undefined;
        const shell = yield* deps.status.readShell(ThreadId.make(trimmed));
        if (shell === undefined || !grantsProject(grant, shell.projectId)) return undefined;
        const project = yield* deps.readProject(shell.projectId);
        if (project === undefined || project.kind === "general-chat") return undefined;
        return { shell, project };
      });

    /**
     * An assistant's own start of `threadId` that has no thread yet: still
     * `starting`, or `failed` with why (from memory, else its request row,
     * which a restart left `failed`). Undefined for anything else, and on the
     * local door.
     */
    const pendingStart = (
      caller: OutsideAgentCaller,
      grant: OutsideAgentLiveGrant,
      threadId: string,
    ): Effect.Effect<
      | {
          readonly outcome: "starting" | "failed";
          readonly detail: string;
          readonly entry?: SettingUp;
        }
      | undefined
    > =>
      Effect.gen(function* () {
        if (!assistant) return undefined;
        const trimmed = threadId.trim();
        if (trimmed.length === 0) return undefined;
        const entry = settingUp.get(trimmed);
        if (entry !== undefined && entry.connectionId === caller.connectionId) {
          if (!grantsProject(grant, entry.projectId)) return undefined;
          return entry.state === "starting"
            ? { outcome: "starting" as const, detail: SETTING_UP, entry }
            : { outcome: "failed" as const, detail: entry.detail ?? SET_UP_CUT_OFF, entry };
        }
        const row = yield* deps.requests
          .findStart({ connectionId: caller.connectionId, threadId: ThreadId.make(trimmed) })
          .pipe(Effect.orElseSucceed(() => Option.none<OutsideAgentRequestRow>()));
        if (Option.isNone(row)) return undefined;
        if (row.value.state === "starting")
          return { outcome: "starting" as const, detail: SETTING_UP };
        if (row.value.state !== "failed") return undefined;
        const recorded =
          row.value.resultJson === null
            ? undefined
            : (JSON.parse(row.value.resultJson) as { readonly detail?: string }).detail;
        return { outcome: "failed" as const, detail: recorded ?? SET_UP_CUT_OFF };
      });

    /** One thread as the outside tools report it. */
    const outsideSummary = (
      caller: OutsideAgentCaller,
      shell: OrchestrationThreadShell,
      context: {
        readonly projectName: string;
        readonly providers: ReadonlyArray<ServerProvider>;
        readonly scheduleAnswerWaiting: ReadonlySet<ThreadId>;
        readonly titleOf: (threadId: ThreadId) => string | undefined;
      },
    ): OutsideThreadSummary => ({
      ...summarizeThread(shell, {
        outsideCaller: caller.connectionId,
        providers: context.providers,
        titleOf: context.titleOf,
        scheduleAnswerWaiting: context.scheduleAnswerWaiting,
      }),
      projectId: shell.projectId,
      project: context.projectName,
      access: shell.runtimeMode,
      lastTurn: threadLastTurn(shell),
    });

    /** What a thread that needs the user waits on, and each thing in detail, for a read or wait result. */
    const waitingOnOf = (
      shell: OrchestrationThreadShell,
      scheduleAnswerWaiting: boolean,
      thread: OrchestrationThread | undefined,
    ) =>
      Effect.gen(function* () {
        const status = threadStatus(shell, scheduleAnswerWaiting);
        if (status.waitingOn === null) return {};
        const waiting =
          thread === undefined
            ? []
            : threadWaitingItems(thread, { shell, scheduleRequests: yield* deps.scheduleRequests });
        return { waitingOn: status.waitingOn, ...(waiting.length > 0 ? { waiting } : {}) };
      });

    /**
     * The connection's threads running now: live state, archived threads
     * included, plus its starts and sends still in flight (`inFlight`). Each is
     * named only when its project is still in the grant (null otherwise), so
     * a limit answer can't show titles from projects the user took away.
     */
    const runningThreads = (
      caller: OutsideAgentCaller,
      grant: OutsideAgentLiveGrant,
      inFlight: ReadonlySet<ThreadId>,
    ) =>
      Effect.gen(function* () {
        // Archived ones too: archiving a thread doesn't stop its turn.
        const own = yield* deps.listThreads({
          outsideConnectionId: caller.connectionId,
          includeArchived: true,
        });
        const names = new Map<string, string | null>();
        for (const thread of own) {
          if (countsAsRunning(thread) || inFlight.has(thread.id)) {
            names.set(thread.id, grantsProject(grant, thread.projectId) ? thread.title : null);
          }
        }
        for (const threadId of inFlight) {
          if (!names.has(threadId)) names.set(threadId, "a thread still being set up");
        }
        return [...names.values()];
      });

    const runningLimit = (running: ReadonlyArray<string | null>) => {
      const named = running.filter((name): name is string => name !== null);
      const hidden = running.length - named.length;
      const listed = [
        ...named.map((title) => `"${title}"`),
        ...(hidden > 0 ? [`${plural(hidden, "thread")} in projects you can no longer see`] : []),
      ];
      return {
        outcome: "limit" as const,
        detail: `${plural(running.length, "thread")} you started ${running.length === 1 ? "is" : "are"} running (${listed.join(", ")}), the most at once is ${CONNECT_RUNNING_THREADS}. Wait for one with thread_wait, then try again.`,
      };
    };

    // -------------------------------------------------------------------------
    // projects, agents
    // -------------------------------------------------------------------------

    const projects = (caller: OutsideAgentCaller): Effect.Effect<ProjectsResult> =>
      Effect.gen(function* () {
        const gated = yield* gate(caller, "see");
        if ("refusal" in gated) return { ...gated.refusal, projects: [] };
        return {
          outcome: "ok",
          projects: projectsIn(yield* deps.projects, gated.grant).map((project) => ({
            projectId: project.id,
            name: project.title,
            folder: project.workspaceRoot,
          })),
        } satisfies ProjectsResult;
      });

    const agents = (
      caller: OutsideAgentCaller,
      input: Tool.Parameters<typeof AgentsTool>,
    ): Effect.Effect<AgentsResult> =>
      Effect.gen(function* () {
        const empty = { agents: [], unavailable: [], default: null };
        const gated = yield* gate(caller, "see");
        if ("refusal" in gated) return { ...gated.refusal, ...empty };
        const providers = yield* deps.providers;
        const only = input.instanceId?.trim() || undefined;
        const listed = listThreadAgents(providers, { interactionMode: "default", only });
        const fallback = defaultThreadAgent(providers, {
          userDefault: yield* deps.userDefaultModel,
          projectDefault: null,
          interactionMode: "default",
        });
        return {
          outcome: "ok",
          agents: listed.agents.map(({ driver: _driver, ...agent }) => agent),
          unavailable: listed.unavailable,
          default:
            fallback === null ? null : { instanceId: fallback.instanceId, model: fallback.model },
        } satisfies AgentsResult;
      });

    // -------------------------------------------------------------------------
    // threads_list, thread_read, thread_wait
    // -------------------------------------------------------------------------

    const threadsList = (
      caller: OutsideAgentCaller,
      input: Tool.Parameters<typeof ThreadsListTool>,
    ): Effect.Effect<ThreadsListResult> =>
      Effect.gen(function* () {
        const gated = yield* gate(caller, "see");
        if ("refusal" in gated) return { ...gated.refusal, threads: [] };
        let visible = projectsIn(yield* deps.projects, gated.grant);
        if (input.project !== undefined) {
          const found = findProject(visible, input.project);
          if ("detail" in found) {
            return { outcome: "not_found", detail: found.detail, threads: [] };
          }
          visible = [found.project];
        }
        const projectNames = new Map<string, string>(
          visible.map((project) => [project.id, project.title]),
        );
        const projectIds = visible.map((project) => project.id);
        const listed = yield* deps.listThreads({
          projectIds,
          ...(input.mine === true ? { outsideConnectionId: caller.connectionId } : {}),
        });
        const titles = new Map<string, string>(listed.map((thread) => [thread.id, thread.title]));
        const scheduleAnswerWaiting = yield* deps.status.scheduleAnswerWaiting;
        const query = input.query?.trim() ?? "";
        const matched =
          query.length > 0 && deps.searchThreads !== undefined && projectIds.length > 0
            ? new Set<string>(
                yield* deps.searchThreads({
                  query: query.slice(0, ORCHESTRATION_THREAD_SEARCH_MAX_QUERY_CHARS),
                  // Only the visible projects' threads compete for the limit.
                  ...(projectIds.length <= ORCHESTRATION_THREAD_SEARCH_MAX_PROJECTS
                    ? { projectIds }
                    : {}),
                  limit: ORCHESTRATION_THREAD_SEARCH_MAX_LIMIT,
                }),
              )
            : new Set<string>();
        const limit = Math.max(
          1,
          Math.min(THREADS_LIST_LIMIT, Math.floor(input.limit ?? THREADS_LIST_LIMIT) || 1),
        );
        const providers = yield* deps.providers;
        const threads = listed
          .filter(
            (thread) =>
              input.status === undefined ||
              threadStatus(thread, scheduleAnswerWaiting.has(thread.id)).word === input.status,
          )
          .filter(
            (thread) =>
              query.length === 0 ||
              thread.title.toLowerCase().includes(query.toLowerCase()) ||
              matched.has(thread.id),
          )
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, limit)
          .map((thread) =>
            outsideSummary(caller, thread, {
              projectName: projectNames.get(thread.projectId) ?? "",
              providers,
              scheduleAnswerWaiting,
              titleOf: (threadId) => titles.get(threadId),
            }),
          );
        if (!assistant) return { outcome: "ok", threads } satisfies ThreadsListResult;
        const starting = yield* startsWithoutThread(
          caller,
          projectIds,
          (entry) =>
            !titles.has(entry.threadId) &&
            (input.status === undefined ||
              (input.status === "failed" && entry.state === "failed")) &&
            (query.length === 0 || entry.title.toLowerCase().includes(query.toLowerCase())),
        );
        return { outcome: "ok", threads, starting } satisfies ThreadsListResult;
      });

    /**
     * An assistant's starts in `projectIds` that have no thread yet: still
     * being set up, or failed before the thread was made. Only the ones `keep`
     * takes.
     */
    const startsWithoutThread = (
      caller: OutsideAgentCaller,
      projectIds: ReadonlyArray<ProjectId>,
      keep: (entry: SettingUp) => boolean,
    ) =>
      Effect.gen(function* () {
        const starting: Array<OutsideStartingThread> = [];
        for (const entry of settingUp.values()) {
          if (
            entry.connectionId !== caller.connectionId ||
            !projectIds.includes(entry.projectId) ||
            !keep(entry) ||
            (yield* deps.status.readShell(entry.threadId)) !== undefined
          ) {
            continue;
          }
          starting.push({
            threadId: entry.threadId,
            title: entry.title,
            projectId: entry.projectId,
            project: entry.project,
            status: entry.state,
            ...(entry.state === "failed" && entry.detail !== undefined
              ? { detail: entry.detail }
              : {}),
          });
        }
        return starting;
      });

    const threadRead = (
      caller: OutsideAgentCaller,
      input: Tool.Parameters<typeof OutsideThreadReadTool>,
    ): Effect.Effect<OutsideThreadReadResult> =>
      Effect.gen(function* () {
        const none = { messages: [], next: null, more: false };
        const gated = yield* gate(caller, "see");
        if ("refusal" in gated) return { ...gated.refusal, ...none };
        const visible = yield* visibleThread(gated.grant, input.threadId);
        const target = visible === undefined ? undefined : yield* deps.readThread(visible.shell.id);
        if (visible === undefined || target === undefined) {
          const pending = yield* pendingStart(caller, gated.grant, input.threadId);
          if (pending !== undefined) {
            return { outcome: pending.outcome, detail: pending.detail, ...none };
          }
          return { outcome: "not_found", detail: THREAD_NOT_FOUND, ...none };
        }
        const providers = yield* deps.providers;
        const titles = yield* relatedThreadTitles(target, deps.status.readShell);
        const waiting = (yield* deps.status.scheduleAnswerWaiting).has(target.id);
        return {
          outcome: "ok",
          thread: outsideSummary(caller, visible.shell, {
            projectName: visible.project.title,
            providers,
            scheduleAnswerWaiting: waiting ? new Set([target.id]) : new Set(),
            titleOf: (threadId) => titles.get(threadId),
          }),
          ...(yield* waitingOnOf(visible.shell, waiting, target)),
          ...readThreadPage(target, { providers, titles, after: input.after, limit: input.limit }),
        } satisfies OutsideThreadReadResult;
      });

    const threadWait = (
      caller: OutsideAgentCaller,
      input: Tool.Parameters<typeof ThreadWaitTool>,
    ): Effect.Effect<ThreadWaitResult> =>
      Effect.gen(function* () {
        const gated = yield* gate(caller, "see");
        if ("refusal" in gated) return gated.refusal;
        const startedAt = yield* nowMillis;
        let seconds = Math.max(
          0,
          Math.min(
            waitMaxSeconds,
            input.seconds !== undefined && Number.isFinite(input.seconds)
              ? input.seconds
              : waitDefaultSeconds,
          ),
        );
        let visible = yield* visibleThread(gated.grant, input.threadId);
        if (visible === undefined) {
          // An assistant's start still being set up: wait for its thread first.
          const pending = yield* pendingStart(caller, gated.grant, input.threadId);
          if (pending === undefined) return { outcome: "not_found", detail: THREAD_NOT_FOUND };
          if (pending.outcome === "failed") return { outcome: "failed", detail: pending.detail };
          if (pending.entry === undefined) return { outcome: "still_working", detail: SETTING_UP };
          const ended = yield* Deferred.await(pending.entry.settled).pipe(
            Effect.timeoutOption(Duration.millis(seconds * 1000)),
          );
          if (Option.isNone(ended)) return { outcome: "still_working", detail: SETTING_UP };
          visible = yield* visibleThread(gated.grant, input.threadId);
          if (visible === undefined) {
            const after = yield* pendingStart(caller, gated.grant, input.threadId);
            return after?.outcome === "failed"
              ? { outcome: "failed", detail: after.detail }
              : { outcome: "not_found", detail: THREAD_NOT_FOUND };
          }
          seconds = Math.max(0, seconds - ((yield* nowMillis) - startedAt) / 1000);
        }
        const settled = yield* watchThreadStatus(deps.status, visible.shell.id).pipe(
          Stream.filter((reading) => reading.status?.word !== "working"),
          Stream.runHead,
          Effect.timeoutOption(Duration.millis(seconds * 1000)),
          Effect.map(Option.flatten),
        );
        // A Change can land while it waits: the thread must still be the caller's to see.
        const grant = yield* deps.connections.grant(caller.connectionId);
        const still = grant === null ? undefined : yield* visibleThread(grant, visible.shell.id);
        if (grant === null) return { outcome: "not_allowed", detail: REMOVED };
        if (still === undefined) return { outcome: "not_found", detail: THREAD_NOT_FOUND };
        const shell = Option.isSome(settled) ? (settled.value.shell ?? still.shell) : still.shell;
        const waiting = Option.isSome(settled)
          ? settled.value.scheduleAnswerWaiting
          : (yield* deps.status.scheduleAnswerWaiting).has(shell.id);
        const providers = yield* deps.providers;
        const thread = yield* deps.readThread(shell.id);
        return {
          outcome: Option.isSome(settled) ? "done" : "still_working",
          thread: outsideSummary(caller, shell, {
            projectName: still.project.title,
            providers,
            scheduleAnswerWaiting: waiting ? new Set([shell.id]) : new Set(),
            titleOf: () => undefined,
          }),
          ...(yield* waitingOnOf(shell, waiting, thread)),
          reply: newestReply(thread),
        } satisfies ThreadWaitResult;
      });

    // -------------------------------------------------------------------------
    // inbox, thread_changes
    // -------------------------------------------------------------------------

    /**
     * What needs the user, live: every open approval, question and plan in
     * the projects, from the threads whose status says so.
     */
    const needsYouIn = (
      projects: ReadonlyMap<string, string>,
      shells: ReadonlyArray<OrchestrationThreadShell>,
    ) =>
      Effect.gen(function* () {
        const scheduleRequests = yield* deps.scheduleRequests;
        const scheduleThreads = new Set<string>(scheduleRequests.map((entry) => entry.threadId));
        const waitingShells = shells
          .filter(
            (shell) => threadStatus(shell, scheduleThreads.has(shell.id)).word === "needs the user",
          )
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, INBOX_WAITING_THREADS);
        const perThread = yield* Effect.forEach(
          waitingShells,
          (shell) =>
            Effect.gen(function* () {
              const thread = yield* deps.readThread(shell.id);
              if (thread === undefined) return [];
              const link = yield* deps.threadLink(shell.id);
              return threadWaitingItems(thread, { shell, scheduleRequests }).map(
                (item): InboxNeedsYou => ({
                  threadId: shell.id,
                  title: shell.title,
                  projectId: shell.projectId,
                  project: projects.get(shell.projectId) ?? "",
                  kind: item.kind,
                  requestId: item.requestId,
                  summary: item.summary,
                  askedAt: item.askedAt,
                  link,
                }),
              );
            }),
          { concurrency: 4 },
        );
        return perThread
          .flat()
          .toSorted((left, right) => left.askedAt.localeCompare(right.askedAt));
      });

    const inbox = (
      caller: OutsideAgentCaller,
      input: Tool.Parameters<typeof InboxTool>,
    ): Effect.Effect<InboxResult> =>
      Effect.gen(function* () {
        const empty = { needsYou: [], finished: [], failed: [], more: false, recordKept: false };
        const gated = yield* gate(caller, "see");
        if ("refusal" in gated) return { ...gated.refusal, ...empty };
        let visible = projectsIn(yield* deps.projects, gated.grant);
        if (input.project !== undefined) {
          const found = findProject(visible, input.project);
          if ("detail" in found) return { outcome: "not_found", detail: found.detail, ...empty };
          visible = [found.project];
        }
        const projectNames = new Map<string, string>(
          visible.map((project) => [project.id, project.title]),
        );
        const projectIds = visible.map((project) => project.id);
        const shells = projectIds.length === 0 ? [] : yield* deps.listThreads({ projectIds });
        const needsYou = yield* needsYouIn(projectNames, shells);
        const starting = assistant
          ? { starting: yield* startsWithoutThread(caller, projectIds, () => true) }
          : {};

        const { record } = deps;
        // The record couldn't be read: say so, and keep the caller's place.
        const unread = {
          outcome: "ok",
          detail:
            "Threadlines couldn't read what finished or failed just now. needsYou is live; try again for the rest.",
          ...empty,
          needsYou,
          recordKept: true,
          ...(input.since !== undefined ? { cursor: input.since } : {}),
          ...starting,
        } satisfies InboxResult;
        const notKept = (cursor: string | undefined) =>
          ({
            outcome: "ok",
            detail: RECORD_NOT_KEPT,
            ...empty,
            needsYou,
            ...(cursor !== undefined ? { cursor } : {}),
            ...starting,
          }) satisfies InboxResult;
        if (record === undefined) return notKept(undefined);
        const position = yield* record.position.pipe(Effect.option);
        if (Option.isNone(position)) return unread;
        const { recordId, lastSeq, prunedThroughSeq, running } = position.value;
        // While no assistant is connected nothing is recorded; the cursor still marks now.
        if (!running) return notKept(encodeEventCursor(recordId, lastSeq));
        // A cursor from another computer (or a reset one), from beyond what
        // was recorded, or from before what is kept: start from the oldest kept.
        const decoded = input.since === undefined ? null : decodeEventCursor(input.since);
        const truncated =
          input.since !== undefined &&
          (decoded === null ||
            decoded.recordId !== recordId ||
            decoded.seq > lastSeq ||
            decoded.seq < prunedThroughSeq);
        const page = yield* record
          .since({
            after: decoded !== null && !truncated ? decoded.seq : 0,
            limit: INBOX_EVENTS_LIMIT,
            names: ["thread.finished", "thread.failed"],
            projectIds,
          })
          .pipe(Effect.option);
        if (Option.isNone(page)) return unread;
        // Titles as the threads are named now, read only within the projects
        // this connection sees now: a thread moved out of them since (or
        // deleted) is left out, so its new title never shows.
        const eventThreads = new Map(
          (page.value.events.length === 0
            ? []
            : yield* deps.listThreads({
                projectIds,
                threadIds: [...new Set(page.value.events.map((event) => event.threadId))],
                includeArchived: true,
              })
          ).map((shell) => [shell.id, shell] as const),
        );
        const finished: Array<InboxEvent> = [];
        const failed: Array<InboxEvent> = [];
        for (const event of page.value.events) {
          const shell = eventThreads.get(event.threadId);
          if (shell === undefined || !projectNames.has(shell.projectId)) continue;
          (event.name === "thread.finished" ? finished : failed).push({
            threadId: event.threadId,
            title: shell.title,
            projectId: shell.projectId,
            project: projectNames.get(shell.projectId) ?? "",
            reason: event.reason,
            summary: alertReasonText(event.reason),
            at: event.occurredAt,
            seenInThreadlines:
              event.resolvedReason !== null && SEEN_IN_THREADLINES.has(event.resolvedReason),
            link: yield* deps.threadLink(event.threadId),
          });
        }
        return {
          outcome: "ok",
          needsYou,
          finished,
          failed,
          cursor: encodeEventCursor(recordId, page.value.upTo),
          more: page.value.more,
          ...(truncated ? { truncated: true } : {}),
          recordKept: true,
          ...starting,
        } satisfies InboxResult;
      });

    /** The branch a thread's checkout would merge into, by git alone: its recorded merge base, else the remote's default. */
    const defaultBaseBranch = (cwd: string, branch: string | null) =>
      Effect.gen(function* () {
        const git = (args: ReadonlyArray<string>) =>
          deps.git
            .execute({
              operation: "ConnectTools.threadChanges",
              cwd,
              args,
              allowNonZeroExit: true,
              timeoutMs: BASE_BRANCH_GIT_TIMEOUT_MS,
              maxOutputBytes: 4_096,
            })
            .pipe(
              Effect.map((result) =>
                result.exitCode === 0 && result.stdout.trim().length > 0
                  ? result.stdout.trim()
                  : null,
              ),
              Effect.orElseSucceed(() => null),
            );
        const recorded =
          branch === null
            ? null
            : yield* git(["config", "--get", `branch.${branch}.gh-merge-base`]);
        if (recorded !== null) return recorded;
        const remoteHead = yield* git([
          "symbolic-ref",
          "--quiet",
          "--short",
          "refs/remotes/origin/HEAD",
        ]);
        return remoteHead === null ? null : remoteHead.replace(/^origin\//u, "");
      });

    /**
     * The thread's pull request from the records the app keeps
     * (PullRequestService, cached; it asks the host on a miss): the open one
     * from its branch, with checks, review and mergeability, else the newest
     * from its branch or one its agent opened elsewhere.
     */
    const threadPullRequest = (
      project: OrchestrationProjectShell,
      shell: OrchestrationThreadShell,
    ) =>
      Effect.gen(function* () {
        const repository = changeRequestRepositoryName(project.repositoryIdentity);
        const linked = shell.linkedPullRequests.map((entry) => entry.number);
        if (
          deps.pullRequests === undefined ||
          repository === null ||
          (shell.branch === null && linked.length === 0)
        ) {
          return null;
        }
        const sameRepository = (other: string) => other.toLowerCase() === repository.toLowerCase();
        // Both start at once; the open list (usually cached) answers alone
        // when it has the thread's own pull request, so a slow lookup can't
        // throw that away at the deadline.
        const lookup = yield* deps.pullRequests
          .lookup({
            projectId: project.id,
            repository,
            items: [
              ...(shell.branch !== null ? [{ branch: shell.branch }] : []),
              ...linked.slice(0, PULL_REQUEST_LOOKUP_LIMIT - 1).map((number) => ({ number })),
            ],
          })
          .pipe(Effect.option, Effect.forkChild);
        const listed = yield* deps.pullRequests
          .list({ state: "open", projectId: project.id, includeAuthored: false })
          .pipe(Effect.option);
        const open = Option.isSome(listed)
          ? listed.value.entries.filter(
              (entry) => entry.origin !== "authored" && sameRepository(entry.repository),
            )
          : [];
        const fromList = (entry: PullRequestListEntry): ThreadChangesPullRequest => ({
          number: entry.number,
          url: entry.url,
          title: entry.title,
          state: entry.state,
          isDraft: entry.isDraft,
          baseBranch: entry.baseBranch,
          checks: entry.checksState ?? null,
          reviewDecision: entry.reviewDecision ?? null,
          mergeability: entry.mergeability ?? null,
          additions: entry.additions,
          deletions: entry.deletions,
        });
        const fromLookup = (entry: PullRequestLookupEntry): ThreadChangesPullRequest => {
          const richer = open.find((candidate) => candidate.number === entry.number);
          return richer !== undefined
            ? fromList(richer)
            : {
                number: entry.number,
                url: entry.url,
                title: entry.title,
                state: entry.state,
                isDraft: entry.isDraft,
                baseBranch: null,
                checks: null,
                reviewDecision: null,
                mergeability: null,
                additions: entry.additions,
                deletions: entry.deletions,
              };
        };
        const ownOpen = open.find((entry) => entry.headBranch === shell.branch);
        if (ownOpen !== undefined) {
          yield* Fiber.interrupt(lookup);
          return fromList(ownOpen);
        }
        const looked = yield* Fiber.join(lookup);
        const answers = Option.isSome(looked) ? looked.value.answers : [];
        const byBranch = answers.find((answer) => "branch" in answer.item)?.pullRequest ?? null;
        if (byBranch !== null) return fromLookup(byBranch);
        const newestLinked = answers
          .flatMap((answer) =>
            "number" in answer.item && answer.pullRequest !== null ? [answer.pullRequest] : [],
          )
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        if (newestLinked !== undefined) return fromLookup(newestLinked);
        const linkedOpen = open
          .filter((entry) => linked.includes(entry.number))
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
        return linkedOpen === undefined ? null : fromList(linkedOpen);
      });

    const threadChanges = (
      caller: OutsideAgentCaller,
      input: Tool.Parameters<typeof ThreadChangesTool>,
    ): Effect.Effect<ThreadChangesResult> =>
      Effect.gen(function* () {
        const gated = yield* gate(caller, "see");
        if ("refusal" in gated) return gated.refusal;
        const visible = yield* visibleThread(gated.grant, input.threadId);
        const thread = visible === undefined ? undefined : yield* deps.readThread(visible.shell.id);
        if (visible === undefined || thread === undefined) {
          const pending = yield* pendingStart(caller, gated.grant, input.threadId);
          return pending !== undefined
            ? { outcome: pending.outcome, detail: pending.detail, threadId: input.threadId.trim() }
            : { outcome: "not_found", detail: THREAD_NOT_FOUND };
        }
        const { shell, project } = visible;
        // The turns the sidebar's count covers: those since the checkout was last clean.
        const baseline = shell.diffStatBaselineTurnCount;
        const byPath = new Map<string, { additions: number; deletions: number }>();
        for (const checkpoint of thread.checkpoints) {
          if (checkpoint.checkpointTurnCount <= baseline) continue;
          for (const file of checkpoint.files) {
            const entry = byPath.get(file.path) ?? { additions: 0, deletions: 0 };
            entry.additions += file.additions;
            entry.deletions += file.deletions;
            byPath.set(file.path, entry);
          }
        }
        const files = [...byPath]
          .map(([path, counts]) => ({ path, ...counts }))
          .toSorted(
            (left, right) =>
              right.additions + right.deletions - (left.additions + left.deletions) ||
              left.path.localeCompare(right.path),
          );
        const summed = files.reduce(
          (sum, file) => ({
            additions: sum.additions + file.additions,
            deletions: sum.deletions + file.deletions,
          }),
          { additions: 0, deletions: 0 },
        );
        const counted = shell.cumulativeDiffStat ?? summed;
        const cwd = resolveThreadWorkingCwd({
          projectCwd: project.workspaceRoot,
          worktreePath: shell.worktreePath,
          effectiveCwd: shell.effectiveCwd,
        });
        // The host and git each get a deadline; whatever doesn't answer in time reads as unknown.
        const [pullRequest, defaultBase] = yield* Effect.all(
          [
            threadPullRequest(project, shell).pipe(
              Effect.timeoutOption(THREAD_CHANGES_DEADLINE),
              Effect.map(Option.getOrNull),
            ),
            defaultBaseBranch(cwd, shell.branch).pipe(
              Effect.timeoutOption(THREAD_CHANGES_DEADLINE),
              Effect.map(Option.getOrNull),
            ),
          ],
          { concurrency: 2 },
        );
        return {
          outcome: "ok",
          threadId: shell.id,
          branch: shell.branch,
          base: pullRequest?.baseBranch ?? defaultBase,
          files: files.slice(0, THREAD_CHANGES_FILES),
          ...(files.length > THREAD_CHANGES_FILES
            ? { moreFiles: files.length - THREAD_CHANGES_FILES }
            : {}),
          totals: {
            files: files.length,
            additions: counted.additions,
            deletions: counted.deletions,
          },
          pullRequest,
        } satisfies ThreadChangesResult;
      });

    // -------------------------------------------------------------------------
    // Request ids
    // -------------------------------------------------------------------------

    /**
     * The caller's request id, or (on the local door) one made up, so a
     * retry is not recognized. An assistant must send one.
     */
    const requestIdOf = (requestId: string | undefined) => {
      const trimmed = requestId?.trim() ?? "";
      if (trimmed.length > REQUEST_ID_CHAR_LIMIT) {
        return { detail: `Keep requestId under ${REQUEST_ID_CHAR_LIMIT} characters.` };
      }
      if (trimmed.length === 0 && assistant) return { detail: REQUEST_ID_REQUIRED };
      return { requestId: trimmed.length > 0 ? trimmed : crypto.randomUUID() };
    };

    /**
     * The answer an earlier call under the same request id stands for: its
     * own when it finished; when a restart cut it off, what it left. Only
     * while its thread is still in the connection's projects: one the user
     * took out of the grant since reads as not found, like any other.
     */
    const earlierAnswer = (
      grant: OutsideAgentLiveGrant,
      row: OutsideAgentRequestRow,
      inputHash: string,
    ) =>
      Effect.gen(function* () {
        if (row.inputHash !== inputHash) return CONFLICT;
        if (row.threadId !== null) {
          const projectId = yield* deps.threadProject(row.threadId);
          const project = projectId === undefined ? undefined : yield* deps.readProject(projectId);
          if (
            projectId !== undefined &&
            (!grantsProject(grant, projectId) || project?.kind === "general-chat")
          ) {
            return {
              outcome: "not_found" as const,
              detail:
                row.tool === "thread_start"
                  ? "The thread that request started isn't in your projects any more."
                  : THREAD_NOT_FOUND,
            };
          }
        }
        // Answered, or (an assistant's start) failed after its answer went out.
        if ((row.state === "done" || row.state === "failed") && row.resultJson !== null) {
          return JSON.parse(row.resultJson) as { readonly outcome: string };
        }
        // An assistant's start whose setup is still running in this process
        // (a restart turns every `starting` row `failed`): the same answer.
        if (row.state === "starting" && assistant && row.tool === "thread_start") {
          const entry = row.threadId === null ? undefined : settingUp.get(row.threadId);
          return entry?.answer ?? { outcome: "starting" as const, detail: SETTING_UP };
        }
        // Cut off before it answered: never run again (a second bootstrap
        // would fail on the thread it made, or cut a second worktree).
        const receipt =
          row.commandId === null
            ? Option.none()
            : yield* deps.engine
                .getCommandReceipt(row.commandId)
                .pipe(Effect.orElseSucceed(() => Option.none()));
        const reached = Option.isSome(receipt) && receipt.value.status === "accepted";
        const shell =
          row.threadId === null ? undefined : yield* deps.status.readShell(row.threadId);
        if (row.tool === "thread_stop") {
          return reached
            ? {
                outcome: "stopped" as const,
                detail: "Stopped. A later thread_send starts it again.",
                ...(row.threadId !== null ? { threadId: row.threadId } : {}),
              }
            : {
                outcome: "failed" as const,
                detail:
                  "Threadlines restarted while stopping it, and it may not have stopped. Read the thread, then stop it again with a new requestId.",
                ...(row.threadId !== null ? { threadId: row.threadId } : {}),
              };
        }
        if (row.tool === "thread_send") {
          return reached
            ? { outcome: "sent" as const, detail: "Sent.", threadId: row.threadId ?? undefined }
            : {
                outcome: "failed" as const,
                detail:
                  "Threadlines restarted while this message was being sent, and it may not have arrived. Read the thread, then send again with a new requestId.",
                ...(row.threadId !== null ? { threadId: row.threadId } : {}),
              };
        }
        if (reached && shell !== undefined) {
          return {
            outcome: "started" as const,
            detail: "Started. Use thread_wait to follow it.",
            thread: {
              threadId: shell.id,
              title: shell.title,
              model: modelLabel(shell.modelSelection, yield* deps.providers),
              workspace:
                shell.worktreePath !== null ? ("worktree" as const) : ("project_folder" as const),
              access: shell.runtimeMode,
            },
          };
        }
        return {
          outcome: "failed" as const,
          detail:
            shell !== undefined
              ? `Threadlines restarted while this thread was being set up, so it never started its first turn. The half-made thread "${shell.title}" (${shell.id}) is still in Threadlines, where the user can delete it. Start again with a new requestId.`
              : "Threadlines restarted while this thread was being set up, before it was made. Start again with a new requestId.",
        };
      });

    /** Records a call's answer for its retries; a failed write only loses the replay. */
    const remember = <A extends { readonly outcome: string }>(
      caller: OutsideAgentCaller,
      requestId: string,
      result: A,
    ): Effect.Effect<A> =>
      deps.requests
        .finish({
          connectionId: caller.connectionId,
          requestId,
          resultJson: JSON.stringify(result),
        })
        .pipe(Effect.ignore({ log: true }), Effect.as(result));

    const forget = (caller: OutsideAgentCaller, requestId: string) =>
      deps.requests
        .release({ connectionId: caller.connectionId, requestId })
        .pipe(Effect.ignore({ log: true }));

    /**
     * Claims the request once nothing else stands in the way. Under the
     * connection's lock (ConnectLimits.admit), with the stale rows pruned.
     */
    const claim = (
      caller: OutsideAgentCaller,
      row: Omit<OutsideAgentRequestRow, "state" | "resultJson">,
    ) =>
      Effect.gen(function* () {
        yield* deps.requests
          .prune({
            before: isoOf(Date.parse(row.createdAt) - OUTSIDE_REQUEST_RETENTION_MS),
          })
          .pipe(Effect.ignore({ log: true }));
        const claimed = yield* deps.requests.claim(row).pipe(Effect.orElseSucceed(() => false));
        return claimed ? null : { outcome: "failed" as const, detail: NO_STORE };
      });

    // -------------------------------------------------------------------------
    // thread_start
    // -------------------------------------------------------------------------

    /** Where a new thread works: its own worktree off the project's branch, or the folder itself. */
    const placeThread = (
      project: OrchestrationProjectShell,
      requested: StartInput["workspace"],
    ): Effect.Effect<
      | { readonly kind: "worktree"; readonly baseBranch: string }
      | { readonly kind: "project_folder"; readonly branch: string | null }
      | { readonly failed: string }
    > =>
      Effect.gen(function* () {
        const git = (args: ReadonlyArray<string>) =>
          deps.git
            .execute({
              operation: "ConnectTools.placeThread",
              cwd: project.workspaceRoot,
              args,
              allowNonZeroExit: true,
              timeoutMs: GIT_TIMEOUT_MS,
              maxOutputBytes: 16_384,
            })
            .pipe(
              Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
              Effect.orElseSucceed(() => null),
            );
        if ((yield* git(["rev-parse", "--is-inside-work-tree"])) !== "true") {
          return requested === "worktree"
            ? {
                failed:
                  "This project isn't a git repository, so it can't have worktrees. Leave workspace out, or use project_folder.",
              }
            : { kind: "project_folder", branch: null };
        }
        const branch = yield* git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
        if (requested === "project_folder") {
          return { kind: "project_folder", branch: branch || null };
        }
        const commit = yield* git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
        if (branch === null || branch.length === 0 || commit === null) {
          return requested === "worktree"
            ? {
                failed:
                  "The project folder isn't on a branch with a commit, so a worktree has nothing to start from. Use project_folder.",
              }
            : { kind: "project_folder", branch: branch || null };
        }
        return { kind: "worktree", baseBranch: branch };
      });

    const threadStart = (
      caller: OutsideAgentCaller,
      input: StartInput,
    ): Effect.Effect<OutsideThreadStartResult> =>
      Effect.gen(function* () {
        const gated = yield* gate(caller, "start");
        if ("refusal" in gated) return gated.refusal;
        const prompt = input.prompt.trim();
        if (prompt.length === 0) {
          return { outcome: "failed", detail: "Give the thread a prompt: the work to do." };
        }
        if (prompt.length > THREAD_PROMPT_CHAR_LIMIT) {
          return {
            outcome: "failed",
            detail: `Keep the prompt under ${THREAD_PROMPT_CHAR_LIMIT.toLocaleString("en-US")} characters.`,
          };
        }
        const id = requestIdOf(input.requestId);
        if ("detail" in id) return { outcome: "failed", detail: id.detail };
        const title =
          input.title?.replace(/\s+/g, " ").trim().slice(0, THREAD_TITLE_CHAR_LIMIT).trim() ?? "";
        const normalized = {
          project: input.project.trim(),
          prompt,
          title,
          agent: input.agent ?? null,
          workspace: input.workspace ?? null,
          access: input.access ?? null,
        };
        const inputHash = inputHashOf("thread_start", normalized);
        return yield* once({
          key: `${caller.connectionId}\u0000${id.requestId}`,
          signature: inputHash,
          run: startOnce(caller, gated.grant, id.requestId, normalized, inputHash),
          conflict: CONFLICT,
        });
      });

    const startOnce = (
      caller: OutsideAgentCaller,
      grant: OutsideAgentLiveGrant,
      requestId: string,
      input: {
        readonly project: string;
        readonly prompt: string;
        readonly title: string;
        readonly agent: StartInput["agent"] | null;
        readonly workspace: StartInput["workspace"] | null;
        readonly access: StartInput["access"] | null;
      },
      inputHash: string,
    ): Effect.Effect<OutsideThreadStartResult> =>
      Effect.gen(function* () {
        const earlier = yield* deps.requests
          .get({ connectionId: caller.connectionId, requestId })
          .pipe(Effect.result);
        if (earlier._tag === "Failure") return { outcome: "failed", detail: NO_STORE };
        if (Option.isSome(earlier.success)) {
          return (yield* earlierAnswer(
            grant,
            earlier.success.value,
            inputHash,
          )) as OutsideThreadStartResult;
        }

        const found = findProject(projectsIn(yield* deps.projects, grant), input.project);
        const project = "detail" in found ? undefined : yield* deps.readProject(found.project.id);
        if ("detail" in found || project === undefined) {
          return {
            outcome: "not_found",
            detail: "detail" in found ? found.detail : "That project is gone.",
          };
        }
        const providers = yield* deps.providers;
        let modelSelection: ModelSelection;
        if (input.agent !== null && input.agent !== undefined) {
          const named = requestedAgent(input.agent, "agents");
          const refusal =
            "refused" in named
              ? named.refused
              : childModelRefusal({
                  selection: named,
                  providers,
                  interactionMode: "default",
                  knownModel: true,
                  listTool: "agents",
                });
          if (refusal !== null || "refused" in named) {
            return { outcome: "unavailable_agent", detail: refusal ?? "" };
          }
          modelSelection = named;
        } else {
          const fallback = defaultThreadAgent(providers, {
            userDefault: yield* deps.userDefaultModel,
            projectDefault: project.defaultModelSelection,
            interactionMode: "default",
          });
          if (fallback === null) {
            return {
              outcome: "unavailable_agent",
              detail:
                "No agent here can take a thread right now. The user can set one up in Threadlines → Settings.",
            };
          }
          modelSelection = fallback;
        }
        const access = saferRuntimeMode(
          input.access ?? DEFAULT_NEW_THREAD_RUNTIME_MODE,
          grant.maxRuntimeMode,
        );
        // An assistant's answer has to beat the relay's 30 s, so its git
        // checks get a deadline well under it; nothing is made before them.
        const placement = assistant
          ? Option.getOrElse(
              yield* Effect.timeoutOption(
                placeThread(project, input.workspace ?? undefined),
                ASSISTANT_PLACE_DEADLINE,
              ),
              () => ({
                failed:
                  "Checking the project's git state took too long. Nothing was started; try again with the same requestId.",
              }),
            )
          : yield* placeThread(project, input.workspace ?? undefined);
        if ("failed" in placement) return { outcome: "failed", detail: placement.failed };

        const ids = freshRequestIds();
        const { commandId } = ids;
        const now = yield* nowMillis;
        const createdAt = isoOf(now);
        const title = input.title.length > 0 ? input.title : truncate(input.prompt);
        const command: ThreadTurnStartCommand = {
          type: "thread.turn.start",
          commandId,
          threadId: ids.threadId,
          message: { messageId: ids.messageId, role: "user", text: input.prompt, attachments: [] },
          modelSelection,
          // A title it gave stays; one made from the prompt is replaced by a
          // generated one after the first turn, as in the app.
          ...(input.title.length === 0 ? { titleSeed: title } : {}),
          runtimeMode: access,
          interactionMode: "default",
          fromOutside: {
            connectionId: caller.connectionId,
            name: caller.name,
            maxRuntimeMode: grant.maxRuntimeMode,
          },
          bootstrap: {
            createThread: {
              projectId: project.id,
              title,
              modelSelection,
              runtimeMode: access,
              interactionMode: "default",
              branch: placement.kind === "worktree" ? placement.baseBranch : placement.branch,
              worktreePath: null,
              outsideOrigin: { connectionId: caller.connectionId, name: caller.name },
              createdAt,
            },
            ...(placement.kind === "worktree"
              ? {
                  prepareWorktree: {
                    projectCwd: project.workspaceRoot,
                    baseBranch: placement.baseBranch,
                    branch: childWorktreeBranch(ids.threadId),
                  },
                  runSetupScript: true,
                }
              : {}),
          },
          createdAt,
        };
        const started: OutsideThreadStartResult = {
          outcome: "started",
          detail:
            placement.kind === "worktree"
              ? "Started in its own worktree, with the project's setup script. Use thread_wait to follow it."
              : "Started in the project folder. Use thread_wait to follow it.",
          thread: {
            threadId: ids.threadId,
            title,
            model: modelLabel(modelSelection, providers),
            workspace: placement.kind,
            access,
          },
        };

        // The local door answers once the setup ran and the first turn started.
        const localStart: Effect.Effect<OutsideThreadStartResult> = deps.bootstrap
          .runTurnStart(command)
          .pipe(
            Effect.matchEffect({
              onSuccess: () => remember(caller, requestId, started),
              onFailure: (error) =>
                Effect.gen(function* () {
                  const made = yield* deps.status.readShell(ids.threadId);
                  if (made === undefined) {
                    // Nothing was made: the same request id may try again.
                    yield* forget(caller, requestId);
                    return error.refusal === "above_ceiling"
                      ? { outcome: "not_allowed" as const, detail: error.message }
                      : {
                          outcome: "failed" as const,
                          detail: `It couldn't be started: ${error.message}`,
                        };
                  }
                  return yield* remember(caller, requestId, {
                    outcome: "failed" as const,
                    detail: `The thread "${made.title}" (${made.id}) was made, but its first turn didn't start: ${error.message} The user can delete it in Threadlines. Start again with a new requestId.`,
                  });
                }),
            }),
          );

        // An assistant's start answers this at once; its setup runs on after the answer.
        const entry: SettingUp = {
          connectionId: caller.connectionId,
          threadId: ids.threadId,
          projectId: project.id,
          project: project.title,
          title,
          answer: {
            ...started,
            outcome: "starting",
            detail:
              placement.kind === "worktree"
                ? "It's being set up in its own worktree, with the project's setup script, and then starts on its own. Follow it with thread_wait."
                : "It's being set up in the project folder, and then starts on its own. Follow it with thread_wait.",
          },
          state: "starting",
          detail: undefined,
          settled: yield* Deferred.make<void>(),
        };
        /** Records how an assistant's setup ended, on its row and for its waiters. */
        const setupEnded = (
          result: OutsideThreadStartResult,
          outcome: "started" | "failed" | "made",
        ) =>
          Effect.gen(function* () {
            if (outcome === "started") {
              yield* remember(caller, requestId, result);
            } else {
              yield* deps.requests
                .fail({
                  connectionId: caller.connectionId,
                  requestId,
                  resultJson: JSON.stringify(result),
                })
                .pipe(Effect.ignore({ log: true }));
            }
            if (outcome === "failed") {
              // No thread: threads_list shows the failure for a while.
              entry.state = "failed";
              entry.detail = result.detail;
              yield* Effect.sleep(FAILED_START_KEPT).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    if (settingUp.get(ids.threadId) === entry) settingUp.delete(ids.threadId);
                  }),
                ),
                Effect.forkIn(scope),
              );
            } else {
              settingUp.delete(ids.threadId);
            }
            yield* Deferred.succeed(entry.settled, undefined);
          });
        const setUpLater = deps.bootstrap.runTurnStart(command).pipe(
          Effect.matchEffect({
            onSuccess: () => setupEnded(started, "started"),
            onFailure: (error) =>
              Effect.gen(function* () {
                const made = yield* deps.status.readShell(ids.threadId);
                if (made === undefined) {
                  return yield* setupEnded(
                    {
                      outcome: "failed",
                      detail:
                        error.refusal === "above_ceiling"
                          ? `${error.message} Start again with a new requestId.`
                          : `It couldn't be started: ${error.message} Start again with a new requestId.`,
                    },
                    "failed",
                  );
                }
                return yield* setupEnded(
                  {
                    outcome: "failed",
                    detail: `The thread "${made.title}" (${made.id}) was made, but its first turn didn't start: ${error.message} The user can delete it in Threadlines. Start again with a new requestId.`,
                  },
                  "made",
                );
              }),
          }),
          Effect.catchDefect((defect) =>
            Effect.logWarning("outside agents: an assistant's thread setup failed", {
              defect,
            }).pipe(
              Effect.andThen(
                setupEnded(
                  {
                    outcome: "failed",
                    detail:
                      "It couldn't be started: Threadlines hit an internal error. Start again with a new requestId.",
                  },
                  "failed",
                ),
              ),
            ),
          ),
        );

        const admitted = yield* deps.limits.admit({
          connectionId: caller.connectionId,
          threadId: ids.threadId,
          decide: (inFlight) =>
            Effect.gen(function* () {
              const running = yield* runningThreads(caller, grant, inFlight);
              if (running.length >= CONNECT_RUNNING_THREADS) return runningLimit(running);
              const starts = yield* deps.requests
                .countStartsSince({
                  connectionId: caller.connectionId,
                  since: isoOf(now - DAY_MS),
                })
                .pipe(Effect.orElseSucceed(() => 0));
              if (starts >= CONNECT_STARTS_PER_DAY) {
                return {
                  outcome: "limit" as const,
                  detail: `You started ${CONNECT_STARTS_PER_DAY} threads in the last day, the most allowed. Try again later.`,
                };
              }
              const refusal = yield* claim(caller, {
                connectionId: caller.connectionId,
                requestId,
                tool: "thread_start",
                inputHash,
                threadId: ids.threadId,
                commandId,
                createdAt,
              });
              // In place before the lock is let go, so a retry finds it.
              if (refusal === null && assistant) settingUp.set(ids.threadId, entry);
              return refusal;
            }),
          ...(assistant
            ? {
                work: Effect.succeed<OutsideThreadStartResult>(entry.answer),
                after: { run: setUpLater, scope },
              }
            : { work: localStart }),
        });
        return "refused" in admitted ? admitted.refused : admitted.done;
      });

    // -------------------------------------------------------------------------
    // thread_send, thread_stop
    // -------------------------------------------------------------------------

    /** A thread this connection started, or why the call can't use it. */
    const ownThread = (
      caller: OutsideAgentCaller,
      grant: OutsideAgentLiveGrant,
      threadId: string,
    ): Effect.Effect<
      | { readonly thread: OrchestrationThread }
      | {
          readonly refusal: {
            readonly outcome: "not_found" | "not_yours";
            readonly detail: string;
          };
        }
    > =>
      Effect.gen(function* () {
        const visible = yield* visibleThread(grant, threadId);
        const thread = visible === undefined ? undefined : yield* deps.readThread(visible.shell.id);
        if (thread === undefined) {
          return { refusal: { outcome: "not_found", detail: THREAD_NOT_FOUND } };
        }
        if (thread.outsideOrigin?.connectionId !== caller.connectionId) {
          return { refusal: { outcome: "not_yours", detail: NOT_YOURS } };
        }
        return { thread };
      });

    const threadSend = (
      caller: OutsideAgentCaller,
      input: SendInput,
    ): Effect.Effect<OutsideThreadSendResult> =>
      Effect.gen(function* () {
        const gated = yield* gate(caller, "start");
        if ("refusal" in gated) return gated.refusal;
        const text = input.message.trim();
        if (text.length === 0) {
          return { outcome: "failed", detail: "Say what you want from the thread." };
        }
        if (text.length > THREAD_PROMPT_CHAR_LIMIT) {
          return {
            outcome: "failed",
            detail: `Keep the message under ${THREAD_PROMPT_CHAR_LIMIT.toLocaleString("en-US")} characters.`,
          };
        }
        const id = requestIdOf(input.requestId);
        if ("detail" in id) return { outcome: "failed", detail: id.detail };
        const normalized = { threadId: input.threadId.trim(), text };
        const inputHash = inputHashOf("thread_send", normalized);
        return yield* once({
          key: `${caller.connectionId}\u0000${id.requestId}`,
          signature: inputHash,
          run: sendOnce(caller, gated.grant, id.requestId, normalized, inputHash),
          conflict: CONFLICT,
        });
      });

    const sendOnce = (
      caller: OutsideAgentCaller,
      grant: OutsideAgentLiveGrant,
      requestId: string,
      input: { readonly threadId: string; readonly text: string },
      inputHash: string,
    ): Effect.Effect<OutsideThreadSendResult> =>
      Effect.gen(function* () {
        const earlier = yield* deps.requests
          .get({ connectionId: caller.connectionId, requestId })
          .pipe(Effect.result);
        if (earlier._tag === "Failure") return { outcome: "failed", detail: NO_STORE };
        if (Option.isSome(earlier.success)) {
          return (yield* earlierAnswer(
            grant,
            earlier.success.value,
            inputHash,
          )) as OutsideThreadSendResult;
        }
        const owned = yield* ownThread(caller, grant, input.threadId);
        if ("refusal" in owned) {
          const pending = yield* pendingStart(caller, grant, input.threadId);
          if (pending?.outcome === "starting") {
            return { outcome: "busy", detail: SETTING_UP, threadId: input.threadId.trim() };
          }
          return owned.refusal;
        }
        const { thread } = owned;
        if (exceedsRuntimeMode(thread.runtimeMode, grant.maxRuntimeMode)) {
          return {
            outcome: "not_allowed",
            detail: outsideCeilingDetail(caller.name),
            threadId: thread.id,
          };
        }
        const busy = (inFlight: ReadonlySet<ThreadId>, current: OrchestrationThread) =>
          inFlight.has(current.id)
            ? "It's still being set up. Wait for it with thread_wait, then send again."
            : outsideTurnBusy(current);
        const early = busy(deps.limits.inFlight(caller.connectionId), thread);
        if (early !== null) return { outcome: "busy", detail: early, threadId: thread.id };
        // A start a restart cut off left it without its first turn, and maybe
        // without its worktree: it is the user's to delete, not to work in.
        if (!thread.messages.some((message) => message.role === "user")) {
          return {
            outcome: "failed",
            detail:
              "This thread never finished setting up, so it can't take messages. Start a new one.",
            threadId: thread.id,
          };
        }

        const ids = freshRequestIds();
        const { commandId } = ids;
        const now = yield* nowMillis;
        const createdAt = isoOf(now);
        const command: OrchestrationCommand = {
          type: "thread.turn.start",
          commandId,
          threadId: thread.id,
          message: { messageId: ids.messageId, role: "user", text: input.text, attachments: [] },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          fromOutside: {
            connectionId: caller.connectionId,
            name: caller.name,
            maxRuntimeMode: grant.maxRuntimeMode,
          },
          createdAt,
        };
        const admitted = yield* deps.limits.admit({
          connectionId: caller.connectionId,
          threadId: thread.id,
          decide: (inFlight) =>
            Effect.gen(function* () {
              const stillBusy = busy(inFlight, thread);
              if (stillBusy !== null) {
                return { outcome: "busy" as const, detail: stillBusy, threadId: thread.id };
              }
              const running = yield* runningThreads(caller, grant, inFlight);
              if (running.length >= CONNECT_RUNNING_THREADS) return runningLimit(running);
              return yield* claim(caller, {
                connectionId: caller.connectionId,
                requestId,
                tool: "thread_send",
                inputHash,
                threadId: thread.id,
                commandId,
                createdAt,
              });
            }),
          work: deps.engine.dispatch(command).pipe(
            Effect.matchEffect({
              onSuccess: () =>
                remember(caller, requestId, {
                  outcome: "sent" as const,
                  detail: "Sent. It's working on it; use thread_wait to follow it.",
                  threadId: thread.id,
                }),
              onFailure: (error) =>
                forget(caller, requestId).pipe(
                  Effect.as(
                    "refusal" in error && error.refusal === "thread_busy"
                      ? { outcome: "busy" as const, detail: error.detail, threadId: thread.id }
                      : "refusal" in error && error.refusal === "above_ceiling"
                        ? {
                            outcome: "not_allowed" as const,
                            detail: error.detail,
                            threadId: thread.id,
                          }
                        : {
                            outcome: "failed" as const,
                            detail: `It couldn't be sent: ${"detail" in error && typeof error.detail === "string" ? error.detail : error.message}`,
                            threadId: thread.id,
                          },
                  ),
                ),
            }),
          ),
        });
        return "refused" in admitted ? admitted.refused : admitted.done;
      });

    const threadStop = (
      caller: OutsideAgentCaller,
      input: StopInput,
    ): Effect.Effect<OutsideThreadStopResult> =>
      Effect.gen(function* () {
        const gated = yield* gate(caller, "start");
        if ("refusal" in gated) return gated.refusal;
        // Without a request id (the local door may leave it out), a stop is
        // just tried: stopping twice finds nothing running the second time.
        if ((input.requestId?.trim() ?? "") === "" && !assistant) {
          return yield* stopNow(caller, gated.grant, input.threadId, null);
        }
        const id = requestIdOf(input.requestId);
        if ("detail" in id) return { outcome: "failed", detail: id.detail };
        const normalized = { threadId: input.threadId.trim() };
        const inputHash = inputHashOf("thread_stop", normalized);
        return yield* once({
          key: `${caller.connectionId}\u0000${id.requestId}`,
          signature: inputHash,
          run: Effect.gen(function* () {
            const earlier = yield* deps.requests
              .get({ connectionId: caller.connectionId, requestId: id.requestId })
              .pipe(Effect.result);
            if (earlier._tag === "Failure") {
              return {
                outcome: "failed" as const,
                detail: NO_STORE,
              } satisfies OutsideThreadStopResult;
            }
            if (Option.isSome(earlier.success)) {
              return (yield* earlierAnswer(
                gated.grant,
                earlier.success.value,
                inputHash,
              )) as OutsideThreadStopResult;
            }
            return yield* stopNow(caller, gated.grant, normalized.threadId, {
              requestId: id.requestId,
              inputHash,
            });
          }),
          conflict: CONFLICT,
        });
      });

    /** Stops the thread's running turn; with a request id, recorded for its retries. */
    const stopNow = (
      caller: OutsideAgentCaller,
      grant: OutsideAgentLiveGrant,
      threadId: string,
      request: { readonly requestId: string; readonly inputHash: string } | null,
    ): Effect.Effect<OutsideThreadStopResult> =>
      Effect.gen(function* () {
        const owned = yield* ownThread(caller, grant, threadId);
        if ("refusal" in owned) {
          const pending = yield* pendingStart(caller, grant, threadId);
          if (pending?.outcome === "starting") {
            return {
              outcome: "not_running",
              detail: "It's still being set up; its first turn starts on its own.",
              threadId: threadId.trim(),
            };
          }
          return owned.refusal;
        }
        const { thread } = owned;
        const gated = { grant };
        // A thread the user raised above the ceiling is out of the agent's
        // reach, Stop included; the decider checks again, in order.
        if (exceedsRuntimeMode(thread.runtimeMode, gated.grant.maxRuntimeMode)) {
          return {
            outcome: "not_allowed",
            detail: outsideCeilingDetail(caller.name),
            threadId: thread.id,
          };
        }
        if (!hasRunningTurn(thread)) {
          return {
            outcome: "not_running",
            detail: "It isn't working on a turn.",
            threadId: thread.id,
          };
        }
        const turnId = thread.session?.activeTurnId ?? thread.latestTurn?.turnId ?? undefined;
        const commandId = CommandId.make(`server:outside-stop:${crypto.randomUUID()}`);
        if (request !== null) {
          const refused = yield* claim(caller, {
            connectionId: caller.connectionId,
            requestId: request.requestId,
            tool: "thread_stop",
            inputHash: request.inputHash,
            threadId: thread.id,
            commandId,
            createdAt: isoOf(yield* nowMillis),
          });
          if (refused !== null) return refused;
        }
        const answered = (result: OutsideThreadStopResult) =>
          request === null ? Effect.succeed(result) : remember(caller, request.requestId, result);
        const refusedBefore = (result: OutsideThreadStopResult) =>
          request === null
            ? Effect.succeed(result)
            : forget(caller, request.requestId).pipe(Effect.as(result));
        const stopped = yield* deps.engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId,
            threadId: thread.id,
            ...(turnId !== undefined ? { turnId } : {}),
            fromOutside: {
              connectionId: caller.connectionId,
              name: caller.name,
              maxRuntimeMode: gated.grant.maxRuntimeMode,
            },
            createdAt: isoOf(yield* nowMillis),
          })
          .pipe(Effect.result);
        if (stopped._tag === "Success") {
          return yield* answered({
            outcome: "stopped",
            detail: "Stopped. A later thread_send starts it again.",
            threadId: thread.id,
          });
        }
        const error = stopped.failure;
        return yield* refusedBefore(
          "refusal" in error && error.refusal === "above_ceiling"
            ? { outcome: "not_allowed", detail: error.detail, threadId: thread.id }
            : {
                outcome: "failed",
                detail: `It couldn't be stopped: ${error.message}`,
                threadId: thread.id,
              },
        );
      });

    return {
      projects,
      agents,
      threads_list: threadsList,
      thread_read: threadRead,
      thread_wait: threadWait,
      inbox,
      thread_changes: threadChanges,
      thread_start: threadStart,
      thread_send: threadSend,
      thread_stop: threadStop,
    };
  });

export type ConnectToolHandlers = Effect.Success<ReturnType<typeof makeConnectToolHandlers>>;

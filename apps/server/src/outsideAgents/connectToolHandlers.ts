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
 * thread it names is still in the connection's projects.
 */
import {
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
  type ServerProvider,
  ThreadId,
} from "@threadlines/contracts";
import { exceedsRuntimeMode, saferRuntimeMode } from "@threadlines/shared/runtimeMode";
import { truncate } from "@threadlines/shared/String";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

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
  type OutsideThreadReadResult,
  type OutsideThreadReadTool,
  type OutsideThreadSendResult,
  type OutsideThreadSendTool,
  type OutsideThreadStartResult,
  type OutsideThreadStartTool,
  type OutsideThreadStopResult,
  type OutsideThreadStopTool,
  type OutsideThreadSummary,
  type ProjectsResult,
  THREAD_WAIT_DEFAULT_SECONDS,
  THREAD_WAIT_MAX_SECONDS,
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

export const makeConnectToolHandlers = (deps: ConnectToolDeps) =>
  Effect.gen(function* () {
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

    /** What a thread that needs the user waits on, for a read or wait result. */
    const waitingOnOf = (shell: OrchestrationThreadShell, scheduleAnswerWaiting: boolean) => {
      const status = threadStatus(shell, scheduleAnswerWaiting);
      return status.waitingOn !== null ? { waitingOn: status.waitingOn } : {};
    };

    /**
     * The connection's threads running now, by name: live state, archived
     * threads included, plus its starts and sends still in flight (`inFlight`).
     */
    const runningThreads = (caller: OutsideAgentCaller, inFlight: ReadonlySet<ThreadId>) =>
      Effect.gen(function* () {
        // Archived ones too: archiving a thread doesn't stop its turn.
        const own = yield* deps.listThreads({
          outsideConnectionId: caller.connectionId,
          includeArchived: true,
        });
        const titles = new Map<string, string>();
        for (const thread of own) {
          if (countsAsRunning(thread) || inFlight.has(thread.id)) {
            titles.set(thread.id, thread.title);
          }
        }
        for (const threadId of inFlight) {
          if (!titles.has(threadId)) titles.set(threadId, "a thread still being set up");
        }
        return [...titles.values()];
      });

    const runningLimit = (running: ReadonlyArray<string>) => ({
      outcome: "limit" as const,
      detail: `${plural(running.length, "thread")} you started ${running.length === 1 ? "is" : "are"} running (${running.map((title) => `"${title}"`).join(", ")}), the most at once is ${CONNECT_RUNNING_THREADS}. Wait for one with thread_wait, then try again.`,
    });

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
        return { outcome: "ok", threads } satisfies ThreadsListResult;
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
          ...waitingOnOf(visible.shell, waiting),
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
        const visible = yield* visibleThread(gated.grant, input.threadId);
        if (visible === undefined) {
          return { outcome: "not_found", detail: THREAD_NOT_FOUND };
        }
        const seconds = Math.max(
          0,
          Math.min(
            THREAD_WAIT_MAX_SECONDS,
            input.seconds !== undefined && Number.isFinite(input.seconds)
              ? input.seconds
              : THREAD_WAIT_DEFAULT_SECONDS,
          ),
        );
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
          ...waitingOnOf(shell, waiting),
          reply: newestReply(thread),
        } satisfies ThreadWaitResult;
      });

    // -------------------------------------------------------------------------
    // Request ids
    // -------------------------------------------------------------------------

    /** The caller's request id, or one made up (then a retry is not recognized). */
    const requestIdOf = (requestId: string | undefined) => {
      const trimmed = requestId?.trim() ?? "";
      if (trimmed.length > REQUEST_ID_CHAR_LIMIT) {
        return { detail: `Keep requestId under ${REQUEST_ID_CHAR_LIMIT} characters.` };
      }
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
        if (row.state === "done" && row.resultJson !== null) {
          return JSON.parse(row.resultJson) as { readonly outcome: string };
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
        const placement = yield* placeThread(project, input.workspace ?? undefined);
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

        const admitted = yield* deps.limits.admit({
          connectionId: caller.connectionId,
          threadId: ids.threadId,
          decide: (inFlight) =>
            Effect.gen(function* () {
              const running = yield* runningThreads(caller, inFlight);
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
              return yield* claim(caller, {
                connectionId: caller.connectionId,
                requestId,
                tool: "thread_start",
                inputHash,
                threadId: ids.threadId,
                commandId,
                createdAt,
              });
            }),
          work: deps.bootstrap.runTurnStart(command).pipe(
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
          ),
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
        if ("refusal" in owned) return owned.refusal;
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
              const running = yield* runningThreads(caller, inFlight);
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
      input: Tool.Parameters<typeof OutsideThreadStopTool>,
    ): Effect.Effect<OutsideThreadStopResult> =>
      Effect.gen(function* () {
        const gated = yield* gate(caller, "start");
        if ("refusal" in gated) return gated.refusal;
        const owned = yield* ownThread(caller, gated.grant, input.threadId);
        if ("refusal" in owned) return owned.refusal;
        const { thread } = owned;
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
        const stopped = yield* deps.engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.make(`server:outside-stop:${crypto.randomUUID()}`),
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
          return {
            outcome: "stopped",
            detail: "Stopped. A later thread_send starts it again.",
            threadId: thread.id,
          };
        }
        const error = stopped.failure;
        return "refusal" in error && error.refusal === "above_ceiling"
          ? { outcome: "not_allowed", detail: error.detail, threadId: thread.id }
          : {
              outcome: "failed",
              detail: `It couldn't be stopped: ${error.message}`,
              threadId: thread.id,
            };
      });

    return {
      projects,
      agents,
      threads_list: threadsList,
      thread_read: threadRead,
      thread_wait: threadWait,
      thread_start: threadStart,
      thread_send: threadSend,
      thread_stop: threadStop,
    };
  });

export type ConnectToolHandlers = Effect.Success<ReturnType<typeof makeConnectToolHandlers>>;

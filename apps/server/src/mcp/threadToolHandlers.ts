/**
 * What the thread tools do (child threads, docs/design/child-threads.md).
 *
 * Every handler starts from the caller's credential (McpInvocationScope), so
 * the thread asking is never the model's to name, and re-reads the
 * `agentThreads` setting, so turning it off takes effect on the next call.
 * Side runtimes never get here (roomToolsFor) and are refused if they try.
 *
 * Starting and messaging go through the orchestration engine as
 * `thread.child.start` and `thread.child.send`, where the decider applies
 * the rules (the caller's turn, depth, Stop, the per-message limits). The
 * same rules are read here first (@threadlines/shared/childThreads) so a
 * refused call gets a precise outcome. Nothing here waits for a child:
 * `thread_start` returns once its requests are recorded, and the reactor
 * sets the children up (ThreadBootstrap.startChild).
 *
 * A provider may retry a call. Each one is keyed on the caller's thread and
 * turn, the tool and its normalized input; every id it uses derives from
 * that key (childRequestIds.ts), so a retry finds the requests and threads
 * the first call made and answers with the same ids instead of asking again.
 */
import {
  type AgentThreadsMode,
  CHILD_THREADS_PER_CALL,
  type EnvironmentId,
  type PeerDescriptor,
  ChildRequestBatchId,
  ChildRequestId,
  ChildThreadLaunch,
  type ChildThreadWorkspace,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProjectId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type RoomAgentRef,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import {
  type ChildRequestRefusal,
  childSendRefusal,
  childStartRefusal,
  isAttachedChild,
  ownChildRefusal,
  remoteChildOf,
} from "@threadlines/shared/childThreads";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { childRequestCommandId, derivedUuid } from "../orchestration/childRequestIds.ts";
import { linkMessageId, linkThreadId } from "../links/linkIds.ts";
import {
  childAgentProviderName,
  childAgentRefusal,
  childModelRefusal,
} from "../orchestration/childThreadAgents.ts";
import { inviteBilling } from "../orchestration/agentInvites.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { GitVcsDriverShape } from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { messageAuthor } from "@threadlines/shared/messageAuthor";
import { roomAgentEntries, roomAgentName } from "./roomAgents.ts";
import type { RoomRequestRegistry } from "./roomRequests.ts";
import type { RoomToolName } from "./roomToolAccess.ts";
import { roomCheckoutCwd } from "./roomToolHandlers.ts";
import type {
  ThreadAgentsResult,
  ThreadListResult,
  ThreadReadResult,
  ThreadSendResult,
  ThreadStartResult,
  ThreadStatusWord,
  ThreadStopResult,
  ThreadSummary,
} from "./threadTools.ts";

/** A thread's title, at most this long; a longer one is cut. */
export const THREAD_TITLE_CHAR_LIMIT = 80;
/** A prompt or message to a thread, at most this long. */
export const THREAD_PROMPT_CHAR_LIMIT = 50_000;
/** What `thread_read` returns of one message. */
export const THREAD_READ_MESSAGE_CHAR_LIMIT = 4_000;
const THREAD_READ_DEFAULT_LIMIT = 20;
const THREAD_READ_MAX_LIMIT = 50;
/** `thread_list` with `scope: "project"` lists at most this many. */
export const THREAD_LIST_PROJECT_LIMIT = 30;
const GIT_TIMEOUT_MS = 15_000;

export interface ThreadToolDeps {
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly readThread: (threadId: ThreadId) => Effect.Effect<OrchestrationThread | undefined>;
  /** The sidebar summary of an open thread: its status flags. */
  readonly readThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThreadShell | undefined>;
  /** A project's open (not archived) threads. */
  readonly listProjectThreads: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThreadShell>>;
  readonly readProject: (
    projectId: ProjectId,
  ) => Effect.Effect<Pick<OrchestrationProjectShell, "kind" | "workspaceRoot"> | undefined>;
  /** The provider snapshots: who a child could run on. */
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
  /** Whether agents may start threads, read live at every call. */
  readonly threadsMode: Effect.Effect<AgentThreadsMode>;
  readonly git: Pick<GitVcsDriverShape, "execute">;
  readonly requests: RoomRequestRegistry;
  /** Linked computers (docs/design/fleet.md); absent on a server without links. */
  readonly links?: ThreadToolLinks;
  /**
   * Threads whose agent's scheduled-task change waits for the user
   * (docs/design/fleet.md, Part 6); absent on a server without scheduled tasks.
   */
  readonly scheduleAnswerWaiting?: Effect.Effect<ReadonlySet<ThreadId>>;
}

/** A computer this one links to, as the thread tools see it. */
export interface ThreadToolComputer {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** This computer's device id there: the child ids derive from it. */
  readonly deviceId: string;
  readonly reachable: boolean;
  /** Its last description, however old; null if it was never reached. */
  readonly descriptor: PeerDescriptor | null;
}

export interface ThreadToolLinks {
  /** Linked computers, their descriptions refreshed when stale (five minutes). */
  readonly computers: Effect.Effect<ReadonlyArray<ThreadToolComputer>>;
  /** A computer's description, fresh enough to start on; why not, when it can't be had. */
  readonly describe: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<PeerDescriptor | { readonly unavailable: string }>;
  /** Reads a thread there that this computer's link started. */
  readonly read: (
    environmentId: EnvironmentId,
    input: {
      readonly threadId: ThreadId;
      readonly after?: number | undefined;
      readonly limit?: number | undefined;
    },
  ) => Effect.Effect<ThreadReadResult | { readonly unavailable: string }>;
  /** The repository's canonical key for a project folder, how another computer finds its copy. */
  readonly projectKey: (workspaceRoot: string) => Effect.Effect<string | null>;
}

const THREADS_OFF =
  "Starting threads is turned off in Settings, so the thread tools are off. Do the work in this thread.";
const SIDE_REFUSAL = "Only the agent working in this thread can use the thread tools.";
const GONE = "This thread is gone.";
const REMOTE_ORIGIN_REFUSAL =
  "This thread was started by an agent on another computer, so it has no thread tools. Do the work here; your final reply goes back to it.";
/** How many models thread_agents shows per provider before "and N more". */
const MODELS_LISTED_PER_PROVIDER = 12;
const NOT_FOUND = "No open thread with that id is in this project. thread_list shows them.";

/** A turn id no thread has: a caller outside its turn never matches it. */
const NO_TURN = TurnId.make("no-turn");

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const clipText = (text: string, limit: number) =>
  text.length > limit
    ? { text: `${text.slice(0, limit)}\n[clipped; read the rest in the thread]`, clipped: true }
    : { text, clipped: false };

/** The decider's own words for a refused command, or `failed` for anything else. */
const dispatchRefusal = (error: {
  readonly _tag: string;
  readonly message: string;
}): { readonly outcome: "refused" | "failed"; readonly detail: string } => {
  const detail =
    "detail" in error && typeof error.detail === "string" && error.detail.trim() !== ""
      ? error.detail
      : error.message;
  return error._tag === "OrchestrationCommandInvariantError" ||
    error._tag === "OrchestrationCommandPreviouslyRejectedError"
    ? { outcome: "refused", detail }
    : { outcome: "failed", detail: `It could not be recorded: ${detail}` };
};

/** A refusal from the shared rules, as a tool outcome. */
const ruleOutcome = (refusal: ChildRequestRefusal) => ({
  outcome: refusal.outcome,
  detail: refusal.detail,
});

/** The calling agent's model: in a room, the agent's own, not the thread's. */
export const callerModelSelection = (
  thread: OrchestrationThread,
  participantId: McpInvocationScope["participantId"],
): ModelSelection =>
  (participantId !== null
    ? thread.participants.find((participant) => participant.id === participantId)?.modelSelection
    : undefined) ?? thread.modelSelection;

/** A model's name as the model picker shows it. */
export const modelLabel = (selection: ModelSelection, providers: ReadonlyArray<ServerProvider>) => {
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  return model?.shortName ?? model?.name ?? selection.model;
};

/**
 * How a thread is doing, in the words the sidebar uses: blocked on the user
 * first, then running, then waiting on background or child work, then how
 * its last turn ended. `wrapped` is only the user's explicit Mark done; the
 * sidebar's automatic filing rules live in the client.
 */
export function threadStatusWord(
  thread: OrchestrationThreadShell,
  /** A card in it asks the user about its agent's scheduled-task change. */
  scheduleAnswerWaiting = false,
): ThreadStatusWord {
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingChildApproval ||
    scheduleAnswerWaiting
  ) {
    return "needs the user";
  }
  const session = thread.session;
  if (
    thread.latestTurn?.state === "running" ||
    (session !== null &&
      (session.activeTurnId !== null ||
        session.status === "running" ||
        session.status === "starting"))
  ) {
    return "working";
  }
  const awaitedTasks = session?.awaitedBackgroundTaskCount ?? session?.pendingBackgroundTaskCount;
  if ((awaitedTasks ?? 0) > 0 || thread.awaitedChildThreadCount > 0) {
    return "waiting";
  }
  if (thread.latestTurn?.state === "error" || session?.status === "error") {
    return "failed";
  }
  if (thread.doneOverride?.state === "done") {
    return "wrapped";
  }
  return "idle";
}

/** A child on a linked computer's last reported status, as a status word. */
const remoteStatusWord = (cachedStatus: string): ThreadStatusWord =>
  (["working", "needs the user", "waiting", "failed", "idle", "wrapped"] as const).find(
    (word) => word === cachedStatus,
  ) ?? "idle";

/** The name a parent last knew a linked computer by. */
const remoteLabel = (thread: OrchestrationThread, environmentId: string) =>
  (thread.childRequests.remoteChildren ?? []).find((entry) => entry.environmentId === environmentId)
    ?.label ??
  thread.childRequests.open.find((request) => request.remote?.environmentId === environmentId)
    ?.remote?.label ??
  "the other computer";

/** Whether a child has anything to stop: work in flight, or work its parent still waits on. */
const childHasWork = (child: OrchestrationThread, parent: OrchestrationThread) =>
  child.latestTurn?.state === "running" ||
  (child.session !== null &&
    (child.session.activeTurnId !== null ||
      child.session.status === "running" ||
      child.session.status === "starting" ||
      (child.session.pendingBackgroundTaskCount ?? 0) > 0)) ||
  (child.queuedFollowUps ?? []).some((entry) => entry.fromThread?.threadId === parent.id) ||
  parent.childRequests.open.some(
    (request) => request.childThreadId === child.id && request.status !== "awaiting_user",
  );

/** Whether a message sent now waits behind other work in the child. */
const childIsBusy = (child: OrchestrationThread, parent: OrchestrationThread) =>
  child.latestTurn?.state === "running" ||
  (child.session !== null &&
    (child.session.activeTurnId !== null ||
      child.session.status === "running" ||
      child.session.status === "starting")) ||
  (child.queuedFollowUps ?? []).length > 0 ||
  parent.childRequests.open.some(
    (request) =>
      request.childThreadId === child.id &&
      (request.status === "starting" || request.status === "queued"),
  );

/**
 * One thread as the list tools report it. `caller` is the asking thread here;
 * absent when another computer reads it (peer.thread.read), where a thread
 * its link started is "started by" that computer's thread.
 */
export const summarizeThread = (
  thread: OrchestrationThreadShell,
  input: {
    readonly caller?: Pick<OrchestrationThread, "id">;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly titleOf: (threadId: ThreadId) => string | undefined;
    /** Threads a scheduled-task card waits in (ThreadToolDeps.scheduleAnswerWaiting). */
    readonly scheduleAnswerWaiting?: ReadonlySet<ThreadId>;
  },
): ThreadSummary => {
  const remoteOrigin = thread.remoteOrigin ?? null;
  return {
    threadId: thread.id,
    title: thread.title,
    status: threadStatusWord(thread, input.scheduleAnswerWaiting?.has(thread.id) ?? false),
    branch: thread.branch,
    model: modelLabel(thread.modelSelection, input.providers),
    attached: (thread.parentThreadId !== null && thread.attachedToParent) || remoteOrigin !== null,
    startedBy:
      remoteOrigin !== null
        ? `${remoteOrigin.threadTitle} (on ${remoteOrigin.environmentLabel})`
        : thread.parentThreadId === null
          ? null
          : thread.parentThreadId === input.caller?.id
            ? "you"
            : (input.titleOf(thread.parentThreadId) ?? thread.parentThreadId),
    ...(input.caller !== undefined && thread.id === input.caller.id ? { you: true } : {}),
  };
};

/**
 * The agents a thread here can run on, as thread_agents and a linked
 * computer's peer.describe list them: ready providers that can honor the
 * caller's interaction mode, and the set-up ones that can't take a thread now.
 */
export function listThreadAgents(
  providers: ReadonlyArray<ServerProvider>,
  input: {
    readonly interactionMode: ProviderInteractionMode;
    /** List only this provider, with every model. */
    readonly only?: string | undefined;
  },
): {
  readonly agents: Array<ThreadAgentsResult["agents"][number] & { readonly driver: string }>;
  readonly unavailable: Array<ThreadAgentsResult["unavailable"][number]>;
} {
  const agents: Array<ThreadAgentsResult["agents"][number] & { readonly driver: string }> = [];
  const unavailable: Array<ThreadAgentsResult["unavailable"][number]> = [];
  for (const provider of providers) {
    // Providers the user never turned on are not worth a line.
    if (!provider.enabled || !provider.installed) continue;
    if (input.only !== undefined && provider.instanceId !== input.only) continue;
    const refusal = childAgentRefusal(provider, input.interactionMode);
    const name = childAgentProviderName(provider);
    if (refusal !== null) {
      unavailable.push({ instanceId: provider.instanceId, name, reason: refusal });
      continue;
    }
    const models = provider.models
      .filter((model) => model.isHidden !== true)
      .map((model) => ({ model: model.slug, name: model.shortName ?? model.name }));
    // A gateway can list a hundred models; the first ones, in the
    // provider's own order, are enough to choose from unless asked.
    const listed = input.only === undefined ? models.slice(0, MODELS_LISTED_PER_PROVIDER) : models;
    agents.push({
      instanceId: provider.instanceId,
      name,
      billing: inviteBilling(provider).label,
      models: listed,
      ...(listed.length < models.length ? { moreModels: models.length - listed.length } : {}),
      driver: provider.driver,
    });
  }
  return { agents, unavailable };
}

/**
 * A page of a thread's messages, oldest first, as thread_read returns it
 * here and peer.thread.read returns it to a linked computer.
 */
export function readThreadPage(
  target: OrchestrationThread,
  input: {
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly titles: ReadonlyMap<string, string>;
    readonly after?: number | undefined;
    readonly limit?: number | undefined;
  },
): Pick<ThreadReadResult, "messages" | "next" | "more"> {
  const entries = roomAgentEntries(target, modelLabel(target.modelSelection, input.providers));
  const remoteOrigin = target.remoteOrigin ?? null;
  const names = {
    agentName: (participantId: Parameters<typeof roomAgentName>[1]) =>
      roomAgentName(entries, participantId),
    threadTitle: (threadId: ThreadId) =>
      input.titles.get(threadId) ??
      (remoteOrigin !== null && remoteOrigin.threadId === threadId
        ? remoteOrigin.threadTitle
        : undefined),
  };
  const sequenceOf = (message: OrchestrationThread["messages"][number]) =>
    message.eventSequence ?? 0;
  const readable = target.messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0,
    )
    .toSorted(
      (left, right) =>
        sequenceOf(left) - sequenceOf(right) || left.createdAt.localeCompare(right.createdAt),
    );
  const limit = Math.max(
    1,
    Math.min(
      THREAD_READ_MAX_LIMIT,
      Math.floor(
        input.limit !== undefined && Number.isFinite(input.limit)
          ? input.limit
          : THREAD_READ_DEFAULT_LIMIT,
      ),
    ),
  );
  const after = input.after !== undefined && Number.isFinite(input.after) ? input.after : undefined;
  const newer =
    after !== undefined ? readable.filter((message) => sequenceOf(message) > after) : readable;
  const page = after !== undefined ? newer.slice(0, limit) : newer.slice(-limit);
  const last = page.at(-1);
  return {
    messages: page.map((message) => {
      const { author, origin } = messageAuthor(message, names);
      const clipped = clipText(message.text.trim(), THREAD_READ_MESSAGE_CHAR_LIMIT);
      return {
        messageId: message.id,
        sequence: sequenceOf(message),
        at: message.createdAt,
        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
        author,
        origin,
        text: clipped.text,
        ...(clipped.clipped ? { clipped: true } : {}),
        ...(message.streaming ? { streaming: true } : {}),
      };
    }),
    next: last !== undefined ? sequenceOf(last) : (after ?? null),
    more: after !== undefined && newer.length > page.length,
  };
}

interface StartSpec {
  readonly title: string;
  readonly prompt: string;
  readonly agent: ModelSelection | undefined;
  readonly runSetup: boolean;
}

interface StartInput {
  readonly threads: ReadonlyArray<{
    readonly title: string;
    readonly prompt: string;
    readonly agent?:
      | {
          readonly instanceId: string;
          readonly model: string;
          readonly options?:
            | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
            | undefined;
        }
      | undefined;
    readonly runSetup?: boolean | undefined;
  }>;
  readonly reportBack?: boolean | undefined;
  /** A linked computer's name or environment id: start them there. */
  readonly computer?: string | undefined;
}

/** An agent's requested model, trimmed and with unusable options dropped. */
const agentSelection = (
  agent: NonNullable<StartInput["threads"][number]["agent"]>,
): ModelSelection | { readonly refused: string } => {
  const instanceId = agent.instanceId.trim();
  const model = agent.model.trim();
  if (instanceId.length === 0 || model.length === 0) {
    return { refused: "Name the agent's instanceId and model, from thread_agents." };
  }
  const options = (agent.options ?? []).flatMap((option): ProviderOptionSelection[] => {
    const id = option.id.trim();
    const value = typeof option.value === "string" ? option.value.trim() : option.value;
    return id.length > 0 && value !== "" ? [{ id, value }] : [];
  });
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    model,
    ...(options.length > 0 ? { options } : {}),
  };
};

const isLaunch = Schema.is(ChildThreadLaunch);

export function makeThreadToolHandlers(deps: ThreadToolDeps) {
  const waitingOnScheduleAnswers: Effect.Effect<ReadonlySet<ThreadId>> =
    deps.scheduleAnswerWaiting ?? Effect.succeed(new Set());
  type Gate =
    | {
        readonly refusal: {
          readonly outcome: "off" | "not_allowed" | "refused";
          readonly detail: string;
        };
      }
    | { readonly mode: "ask" | "auto"; readonly thread: OrchestrationThread };

  /** Main runtime, setting on, thread still there. */
  const gate = (scope: McpInvocationScope, tool: RoomToolName): Effect.Effect<Gate> =>
    Effect.gen(function* () {
      if (!scope.roomTools.has(tool) || scope.side !== undefined) {
        return { refusal: { outcome: "not_allowed" as const, detail: SIDE_REFUSAL } };
      }
      const mode = yield* deps.threadsMode;
      if (mode === "off") {
        return { refusal: { outcome: "off" as const, detail: THREADS_OFF } };
      }
      const thread = yield* deps.readThread(scope.threadId);
      if (thread === undefined) {
        return { refusal: { outcome: "refused" as const, detail: GONE } };
      }
      // A thread another computer's agent started here never gets these
      // (docs/design/fleet.md, "Fence"); its runtime has no thread tools, so
      // this only guards a stale credential.
      if ((thread.remoteOrigin ?? null) !== null) {
        return { refusal: { outcome: "not_allowed" as const, detail: REMOTE_ORIGIN_REFUSAL } };
      }
      return { mode, thread };
    });

  const from = (scope: McpInvocationScope): RoomAgentRef => ({
    participantId: scope.participantId,
  });

  /** An attached child may not start, message or stop threads: families are one level deep. */
  const depthRefusal = (thread: OrchestrationThread, scope: McpInvocationScope) => ({
    outcome: "not_allowed" as const,
    detail:
      childStartRefusal(thread, { from: from(scope), callerTurnId: NO_TURN, count: 1 })?.detail ??
      "This thread was started by another thread, so it cannot start, message or stop threads itself.",
  });

  const dispatch = (command: Parameters<ThreadToolDeps["engine"]["dispatch"]>[0]) =>
    deps.engine.dispatch(command).pipe(
      Effect.as(undefined),
      Effect.catch((error) => Effect.succeed(dispatchRefusal(error))),
    );

  // ---------------------------------------------------------------------------
  // thread_agents
  // ---------------------------------------------------------------------------

  const threadAgents = (
    scope: McpInvocationScope,
    input: { readonly instanceId?: string | undefined } = {},
  ): Effect.Effect<ThreadAgentsResult> =>
    Effect.gen(function* () {
      const empty = { agents: [], unavailable: [] };
      const gated = yield* gate(scope, "thread_agents");
      if ("refusal" in gated) {
        return { ...gated.refusal, ...empty };
      }
      const { thread, mode } = gated;
      const providers = yield* deps.providers;
      const only = input.instanceId?.trim() || undefined;
      const listedAgents = listThreadAgents(providers, {
        interactionMode: thread.interactionMode,
        only,
      });
      const agents = listedAgents.agents.map(({ driver: _driver, ...agent }) => agent);
      const unavailable = listedAgents.unavailable;
      if (only !== undefined && agents.length === 0 && unavailable.length === 0) {
        return {
          outcome: "refused",
          detail: `No provider "${only}" is turned on here. Call thread_agents without an instanceId to see the ones that are.`,
          ...empty,
        } satisfies ThreadAgentsResult;
      }
      const yours = callerModelSelection(thread, scope.participantId);
      const computers =
        deps.links === undefined || only !== undefined ? [] : yield* deps.links.computers;
      return {
        outcome: "ok",
        approval: mode,
        yours: { instanceId: yours.instanceId, model: yours.model },
        agents,
        unavailable,
        ...(computers.length > 0
          ? {
              computers: computers.map((computer) => ({
                name: computer.label,
                environmentId: computer.environmentId,
                reachable: computer.reachable,
                agents: (computer.descriptor?.agents ?? []).map(
                  ({ driver: _driver, ...agent }) => agent,
                ),
              })),
            }
          : {}),
      } satisfies ThreadAgentsResult;
    });

  // ---------------------------------------------------------------------------
  // thread_start
  // ---------------------------------------------------------------------------

  /** A failed git read, as the call's answer. */
  const gitUnreadable = (detail: string) => ({
    refused: `Couldn't read this project's git state, so no worktrees could be made: ${detail.slice(0, 300)}`,
  });

  /**
   * Where the children work: in a git project, their own worktrees off the
   * caller's current commit, resolved now; otherwise the project folder,
   * shared with the caller unless it is a general chat (each of those gets a
   * scratch folder of its own).
   */
  const resolveWorkspace = (
    thread: OrchestrationThread,
  ): Effect.Effect<
    | { readonly workspace: ChildThreadWorkspace; readonly sharedFolder: boolean }
    | { readonly refused: string }
  > =>
    Effect.gen(function* () {
      const project = yield* deps.readProject(thread.projectId);
      if (project === undefined) {
        return { refused: "This thread's project is gone." };
      }
      // General chats each get their own scratch folder already.
      if (project.kind === "general-chat") {
        return { workspace: { kind: "project_folder" as const }, sharedFolder: false };
      }
      const projectCwd = project.workspaceRoot;
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        deps.git
          .execute({
            operation: "ThreadTools.resolveWorkspace",
            cwd,
            args,
            allowNonZeroExit: true,
            timeoutMs: GIT_TIMEOUT_MS,
            maxOutputBytes: 16_384,
          })
          .pipe(Effect.result);
      const repository = yield* git(projectCwd, ["rev-parse", "--is-inside-work-tree"]);
      if (repository._tag === "Failure") {
        return gitUnreadable(repository.failure.detail);
      }
      if (repository.success.exitCode !== 0 || repository.success.stdout.trim() !== "true") {
        return repository.success.exitCode === 0 ||
          /not a git repository/i.test(repository.success.stderr)
          ? { workspace: { kind: "project_folder" as const }, sharedFolder: true }
          : gitUnreadable(repository.success.stderr.trim());
      }
      const checkout = roomCheckoutCwd(thread, projectCwd) ?? projectCwd;
      const head = yield* git(checkout, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
      if (head._tag === "Failure") {
        return gitUnreadable(head.failure.detail);
      }
      const commit = head.success.stdout.trim();
      if (head.success.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
        return {
          refused:
            "Your checkout has no commit yet, so threads can't get worktrees of their own. Commit first, or do the work here.",
        };
      }
      if (checkout !== projectCwd) {
        const known = yield* git(projectCwd, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${commit}^{commit}`,
        ]);
        if (known._tag === "Failure") {
          return gitUnreadable(known.failure.detail);
        }
        if (known.success.exitCode !== 0) {
          return {
            refused:
              "Your checkout is not part of this project's repository, so threads can't branch off it.",
          };
        }
      }
      return {
        workspace: { kind: "worktree" as const, projectCwd, baseRef: commit },
        sharedFolder: false,
      };
    });

  interface StartIds {
    readonly batchId: ChildRequestBatchId;
    readonly children: ReadonlyArray<{
      readonly requestId: ChildRequestId;
      readonly childThreadId: ThreadId;
      readonly childMessageId: MessageId;
    }>;
  }

  const startIds = (key: string, count: number): StartIds => ({
    batchId: ChildRequestBatchId.make(derivedUuid(key, "batch")),
    children: Array.from({ length: count }, (_, index) => ({
      requestId: ChildRequestId.make(derivedUuid(key, "request", String(index))),
      childThreadId: ThreadId.make(derivedUuid(key, "thread", String(index))),
      childMessageId: MessageId.make(derivedUuid(key, "message", String(index))),
    })),
  });

  const startedDetail = (input: {
    readonly outcome: "started" | "asked_user";
    readonly count: number;
    readonly reportBack: boolean;
    readonly sharedFolder: boolean;
  }) => {
    const threads = plural(input.count, "thread");
    const these = input.count === 1 ? "it" : "them";
    const base =
      input.outcome === "started"
        ? input.reportBack
          ? `Started ${threads}. Each one's final reply comes back to you as a message when it finishes, and you pick up again then. Don't wait or poll: carry on with other work, or end your turn if you have nothing else to do.`
          : `Started ${threads} on ${input.count === 1 ? "its" : "their"} own. Nothing comes back from ${these}; read ${these} with thread_read if you need to.`
        : input.reportBack
          ? `The user decides whether to start ${threads}. If they agree, each one's final reply comes back to you as a message; if they say no, you'll hear at your next turn. Don't ask again, and end your turn if you have nothing else to do.`
          : `The user decides whether to start ${threads}. If started, ${input.count === 1 ? "it runs" : "they run"} on ${input.count === 1 ? "its" : "their"} own and nothing comes back. Don't ask again.`;
    return input.sharedFolder
      ? `${base} This project has no git repository, so ${input.count === 1 ? "it shares" : "they share"} its folder and can change the same files you do.`
      : base;
  };

  /**
   * What an earlier identical call already did, if anything: its requests
   * still open, or its threads already made.
   */
  const earlierStart = (
    thread: OrchestrationThread,
    ids: StartIds,
    providers: ReadonlyArray<ServerProvider>,
    reportBack: boolean,
  ): Effect.Effect<ThreadStartResult | undefined> =>
    Effect.gen(function* () {
      const requestIds = new Set<string>(ids.children.map((child) => child.requestId));
      const open = thread.childRequests.open.filter(
        (request) => request.kind === "start" && requestIds.has(request.requestId),
      );
      if (open.length > 0) {
        const outcome = open.some((request) => request.status === "awaiting_user")
          ? ("asked_user" as const)
          : ("started" as const);
        const sharedFolder = open.some(
          (request) => request.launch?.workspace.kind === "project_folder",
        );
        return {
          outcome,
          detail: startedDetail({ outcome, count: open.length, reportBack, sharedFolder }),
          threads: open.map((request) => ({
            threadId: request.childThreadId,
            title: request.launch?.title ?? request.childThreadId,
            model:
              request.launch !== undefined
                ? modelLabel(request.launch.modelSelection, providers)
                : "",
            workspace: request.launch?.workspace.kind ?? "worktree",
          })),
        } satisfies ThreadStartResult;
      }
      const made = (yield* Effect.forEach(ids.children, (child) =>
        deps.readThreadShell(child.childThreadId),
      )).filter((shell): shell is OrchestrationThreadShell => shell !== undefined);
      if (made.length === 0) {
        return undefined;
      }
      return {
        outcome: "started",
        detail: startedDetail({
          outcome: "started",
          count: made.length,
          reportBack,
          sharedFolder: false,
        }),
        threads: made.map((shell) => ({
          threadId: shell.id,
          title: shell.title,
          model: modelLabel(shell.modelSelection, providers),
          workspace: shell.worktreePath !== null ? "worktree" : "project_folder",
        })),
      } satisfies ThreadStartResult;
    });

  const threadStart = (
    scope: McpInvocationScope,
    input: StartInput,
  ): Effect.Effect<ThreadStartResult> =>
    Effect.gen(function* () {
      const gated = yield* gate(scope, "thread_start");
      if ("refusal" in gated) {
        return gated.refusal satisfies ThreadStartResult;
      }
      const { thread } = gated;
      if (isAttachedChild(thread)) {
        return depthRefusal(thread, scope) satisfies ThreadStartResult;
      }
      const reportBack = input.reportBack ?? true;
      if (input.threads.length < 1 || input.threads.length > CHILD_THREADS_PER_CALL) {
        return {
          outcome: "refused",
          detail: `Start between 1 and ${CHILD_THREADS_PER_CALL} threads at a time.`,
        } satisfies ThreadStartResult;
      }
      const specs: StartSpec[] = [];
      for (const entry of input.threads) {
        const title = entry.title
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, THREAD_TITLE_CHAR_LIMIT)
          .trim();
        const prompt = entry.prompt.trim();
        if (title.length === 0 || prompt.length === 0) {
          return {
            outcome: "refused",
            detail: "Give every thread a title and a prompt.",
          } satisfies ThreadStartResult;
        }
        if (prompt.length > THREAD_PROMPT_CHAR_LIMIT) {
          return {
            outcome: "refused",
            detail: `Keep each prompt under ${THREAD_PROMPT_CHAR_LIMIT.toLocaleString("en-US")} characters.`,
          } satisfies ThreadStartResult;
        }
        const agent = entry.agent !== undefined ? agentSelection(entry.agent) : undefined;
        if (agent !== undefined && "refused" in agent) {
          return {
            outcome: "unavailable_agent",
            detail: agent.refused,
          } satisfies ThreadStartResult;
        }
        specs.push({ title, prompt, agent, runSetup: entry.runSetup ?? true });
      }
      const callerTurnId = thread.session?.activeTurnId ?? null;
      if (callerTurnId === null) {
        return {
          outcome: "refused",
          detail: "Threads can only be started during your own turn.",
        } satisfies ThreadStartResult;
      }
      const computerName = input.computer?.trim() || undefined;
      const key = [
        scope.threadId,
        scope.participantId ?? "primary",
        callerTurnId,
        "thread_start",
        JSON.stringify({
          reportBack,
          threads: specs,
          ...(computerName !== undefined ? { computer: computerName } : {}),
        }),
      ].join("\u0000");
      if (computerName !== undefined) {
        return yield* remoteStart({
          scope,
          thread,
          specs,
          reportBack,
          callerTurnId,
          key,
          computerName,
        });
      }
      const ids = startIds(key, specs.length);

      return yield* deps.requests.join(key, () =>
        Effect.gen(function* () {
          const providers = yield* deps.providers;
          // Read again inside the request: an identical call that finished
          // before this one joined has left its requests or threads behind.
          const current = (yield* deps.readThread(scope.threadId)) ?? thread;
          const earlier = yield* earlierStart(current, ids, providers, reportBack);
          if (earlier !== undefined) {
            return earlier;
          }
          const refusal = childStartRefusal(current, {
            from: from(scope),
            callerTurnId,
            count: specs.length,
          });
          if (refusal !== null) {
            return ruleOutcome(refusal) satisfies ThreadStartResult;
          }
          const interactionMode: ProviderInteractionMode = current.interactionMode;
          const callerModel = callerModelSelection(current, scope.participantId);
          const selections: ModelSelection[] = [];
          for (const spec of specs) {
            const selection = spec.agent ?? callerModel;
            const modelRefusal = childModelRefusal({
              selection,
              providers,
              interactionMode,
              knownModel: spec.agent !== undefined,
            });
            if (modelRefusal !== null) {
              return {
                outcome: "unavailable_agent",
                detail:
                  spec.agent === undefined
                    ? `Threads use your own model unless you pick one, and ${modelRefusal.charAt(0).toLowerCase()}${modelRefusal.slice(1)}`
                    : modelRefusal,
              } satisfies ThreadStartResult;
            }
            selections.push(selection);
          }
          const placement = yield* resolveWorkspace(current);
          if ("refused" in placement) {
            return { outcome: "refused", detail: placement.refused } satisfies ThreadStartResult;
          }
          const { workspace, sharedFolder } = placement;
          const launches = specs.map((spec, index): ChildThreadLaunch => ({
            title: spec.title,
            prompt: spec.prompt,
            modelSelection: selections[index]!,
            runtimeMode: current.runtimeMode,
            interactionMode,
            reportBack,
            runSetup: spec.runSetup,
            workspace,
          }));
          if (!launches.every(isLaunch)) {
            return {
              outcome: "refused",
              detail:
                "Those threads could not be described in full. Check each title, prompt and agent.",
            } satisfies ThreadStartResult;
          }
          // The setting may have changed while git was read.
          const mode = yield* deps.threadsMode;
          if (mode === "off") {
            return { outcome: "off", detail: THREADS_OFF } satisfies ThreadStartResult;
          }
          const rejected = yield* dispatch({
            type: "thread.child.start",
            commandId: childRequestCommandId(ids.batchId, "start"),
            threadId: scope.threadId,
            batchId: ids.batchId,
            from: from(scope),
            callerTurnId,
            mode,
            children: ids.children.map((child, index) => ({ ...child, launch: launches[index]! })),
            createdAt: yield* nowIso,
          });
          if (rejected !== undefined) {
            return rejected satisfies ThreadStartResult;
          }
          const outcome = mode === "auto" ? ("started" as const) : ("asked_user" as const);
          return {
            outcome,
            detail: startedDetail({
              outcome,
              count: launches.length,
              reportBack,
              sharedFolder,
            }),
            threads: ids.children.map((child, index) => ({
              threadId: child.childThreadId,
              title: launches[index]!.title,
              model: modelLabel(launches[index]!.modelSelection, providers),
              workspace: workspace.kind,
            })),
          } satisfies ThreadStartResult;
        }),
      );
    });

  // ---------------------------------------------------------------------------
  // thread_start on a linked computer
  // ---------------------------------------------------------------------------

  /** The linked computer an agent named, by name or id, or why it can't be used. */
  const resolveComputer = (name: string) =>
    Effect.gen(function* () {
      const computers = deps.links === undefined ? [] : yield* deps.links.computers;
      const wanted = name.toLowerCase();
      const computer = computers.find(
        (entry) => entry.environmentId === name || entry.label.toLowerCase() === wanted,
      );
      if (computer !== undefined) return { computer };
      return {
        refused:
          computers.length === 0
            ? "This computer isn't linked to any other, so threads can only start here."
            : `No linked computer is called "${name}". Linked computers: ${computers.map((entry) => entry.label).join(", ")}.`,
      };
    });

  /**
   * Whether the caller's branch is pushed: then the other computer can fetch
   * it and start from the same commit. Returns the branch name there, or null.
   */
  const pushedBranch = (checkout: string) =>
    Effect.gen(function* () {
      const run = (args: ReadonlyArray<string>) =>
        deps.git
          .execute({
            operation: "ThreadTools.pushedBranch",
            cwd: checkout,
            args,
            allowNonZeroExit: true,
            timeoutMs: GIT_TIMEOUT_MS,
            maxOutputBytes: 16_384,
          })
          .pipe(
            Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
            Effect.orElseSucceed(() => null),
          );
      const upstream = yield* run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
      if (upstream === null || !upstream.includes("/")) return null;
      const ahead = yield* run(["rev-list", "--count", "@{u}..HEAD"]);
      if (ahead !== "0") return null;
      return upstream.slice(upstream.indexOf("/") + 1);
    });

  /**
   * The agent a thread there runs on: the one named (its instance id there),
   * or that computer's agent of the caller's own kind, its default, or its
   * first. The caller's own instance id means nothing there and is never sent.
   */
  const remoteAgent = (
    descriptor: PeerDescriptor,
    spec: StartSpec,
    caller: { readonly driver: string | undefined; readonly model: string },
  ): ModelSelection | { readonly refused: string } => {
    if (spec.agent !== undefined) {
      const agent = descriptor.agents.find((entry) => entry.instanceId === spec.agent!.instanceId);
      if (agent === undefined) {
        return {
          refused: `${descriptor.label} has no agent "${spec.agent.instanceId}". thread_agents lists its agents under computers.`,
        };
      }
      return spec.agent;
    }
    const sameKind =
      caller.driver === undefined
        ? undefined
        : descriptor.agents.find((entry) => entry.driver === caller.driver);
    const fallback =
      descriptor.defaultAgent !== null &&
      descriptor.agents.some((entry) => entry.instanceId === descriptor.defaultAgent!.instanceId)
        ? descriptor.defaultAgent
        : undefined;
    const agent =
      sameKind ??
      descriptor.agents.find((entry) => entry.instanceId === fallback?.instanceId) ??
      descriptor.agents[0];
    if (agent === undefined) {
      return { refused: `${descriptor.label} has no agent ready to take a thread.` };
    }
    const model =
      agent.models.find((entry) => entry.model === caller.model)?.model ??
      (fallback?.instanceId === agent.instanceId ? fallback.model : undefined) ??
      agent.models[0]?.model;
    if (model === undefined) {
      return { refused: `${descriptor.label}'s ${agent.name} has no model to run on.` };
    }
    return { instanceId: ProviderInstanceId.make(agent.instanceId), model };
  };

  const remoteStart = (input: {
    readonly scope: McpInvocationScope;
    readonly thread: OrchestrationThread;
    readonly specs: ReadonlyArray<StartSpec>;
    readonly reportBack: boolean;
    readonly callerTurnId: TurnId;
    readonly key: string;
    readonly computerName: string;
  }): Effect.Effect<ThreadStartResult> =>
    Effect.gen(function* () {
      const { scope, specs, reportBack, callerTurnId, key } = input;
      if (deps.links === undefined) {
        return {
          outcome: "refused",
          detail: "This computer can't link to other computers.",
        } satisfies ThreadStartResult;
      }
      const links = deps.links;
      const resolved = yield* resolveComputer(input.computerName);
      if ("refused" in resolved) {
        return { outcome: "refused", detail: resolved.refused } satisfies ThreadStartResult;
      }
      const { computer } = resolved;
      const batchId = ChildRequestBatchId.make(derivedUuid(key, "batch"));
      const children = specs.map((_, index) => {
        const requestId = ChildRequestId.make(derivedUuid(key, "request", String(index)));
        return {
          requestId,
          childThreadId: linkThreadId(computer.deviceId, requestId),
          childMessageId: linkMessageId(computer.deviceId, requestId),
        };
      });
      return yield* deps.requests.join(key, () =>
        Effect.gen(function* () {
          const current = (yield* deps.readThread(scope.threadId)) ?? input.thread;
          const requestIds = new Set<string>(children.map((child) => child.requestId));
          const earlier = current.childRequests.open.filter(
            (request) => request.kind === "start" && requestIds.has(request.requestId),
          );
          if (earlier.length > 0) {
            const outcome = earlier.some((request) => request.status === "awaiting_user")
              ? ("asked_user" as const)
              : ("started" as const);
            return {
              outcome,
              detail: startedDetail({
                outcome,
                count: earlier.length,
                reportBack,
                sharedFolder: false,
              }),
              threads: earlier.map((request) => ({
                threadId: request.childThreadId,
                title: request.launch?.title ?? request.childThreadId,
                model: request.launch?.modelSelection.model ?? "",
                workspace: "remote" as const,
                computer: computer.label,
              })),
            } satisfies ThreadStartResult;
          }
          const refusal = childStartRefusal(current, {
            from: from(scope),
            callerTurnId,
            count: specs.length,
          });
          if (refusal !== null) {
            return ruleOutcome(refusal) satisfies ThreadStartResult;
          }
          const descriptor = yield* links.describe(computer.environmentId);
          if ("unavailable" in descriptor) {
            return {
              outcome: "refused",
              detail: `${computer.label} can't be reached right now: ${descriptor.unavailable}`,
            } satisfies ThreadStartResult;
          }
          if (descriptor.access === "off") {
            return {
              outcome: "refused",
              detail: `${descriptor.label} doesn't take work from this computer (its link is set to off there).`,
            } satisfies ThreadStartResult;
          }
          const project = yield* deps.readProject(current.projectId);
          if (project === undefined || project.kind === "general-chat") {
            return {
              outcome: "refused",
              detail: "Only a project's threads can start threads on another computer.",
            } satisfies ThreadStartResult;
          }
          const projectKey = yield* links.projectKey(project.workspaceRoot);
          if (projectKey === null) {
            return {
              outcome: "refused",
              detail:
                "This project has no git remote, so another computer can't find its copy of it.",
            } satisfies ThreadStartResult;
          }
          if (!descriptor.projects.some((entry) => entry.canonicalKey === projectKey)) {
            return {
              outcome: "refused",
              detail: `${descriptor.label} doesn't have this project.`,
            } satisfies ThreadStartResult;
          }
          const providers = yield* deps.providers;
          const callerModel = callerModelSelection(current, scope.participantId);
          const callerDriver = providers.find(
            (provider) => provider.instanceId === callerModel.instanceId,
          )?.driver;
          const selections: ModelSelection[] = [];
          for (const spec of specs) {
            const selection = remoteAgent(descriptor, spec, {
              driver: callerDriver,
              model: callerModel.model,
            });
            if ("refused" in selection) {
              return {
                outcome: "unavailable_agent",
                detail: selection.refused,
              } satisfies ThreadStartResult;
            }
            selections.push(selection);
          }
          const checkout = roomCheckoutCwd(current, project.workspaceRoot) ?? project.workspaceRoot;
          const branch = yield* pushedBranch(checkout);
          const workspace: ChildThreadWorkspace = {
            kind: "remote",
            projectKey,
            checkout: "worktree",
            ...(branch !== null ? { branch } : {}),
          };
          const launches = specs.map((spec, index): ChildThreadLaunch => ({
            title: spec.title,
            prompt: spec.prompt,
            modelSelection: selections[index]!,
            runtimeMode: current.runtimeMode,
            interactionMode: current.interactionMode,
            reportBack,
            runSetup: spec.runSetup,
            workspace,
            target: { environmentId: computer.environmentId, label: descriptor.label },
          }));
          if (!launches.every(isLaunch)) {
            return {
              outcome: "refused",
              detail:
                "Those threads could not be described in full. Check each title, prompt and agent.",
            } satisfies ThreadStartResult;
          }
          const mode = yield* deps.threadsMode;
          if (mode === "off") {
            return { outcome: "off", detail: THREADS_OFF } satisfies ThreadStartResult;
          }
          const rejected = yield* dispatch({
            type: "thread.child.start",
            commandId: childRequestCommandId(batchId, "start"),
            threadId: scope.threadId,
            batchId,
            from: from(scope),
            callerTurnId,
            mode,
            children: children.map((child, index) => ({ ...child, launch: launches[index]! })),
            createdAt: yield* nowIso,
          });
          if (rejected !== undefined) {
            return rejected satisfies ThreadStartResult;
          }
          const outcome = mode === "auto" ? ("started" as const) : ("asked_user" as const);
          const where =
            branch !== null
              ? ` On ${descriptor.label} ${launches.length === 1 ? "it starts" : "they start"} from your pushed branch ${branch}.`
              : ` On ${descriptor.label} ${launches.length === 1 ? "it starts" : "they start"} from its default branch: your unpushed changes are not there.`;
          const asks =
            descriptor.access === "ask"
              ? ` ${descriptor.label} asks its user before starting ${launches.length === 1 ? "it" : "them"}.`
              : "";
          return {
            outcome,
            detail: `${startedDetail({ outcome, count: launches.length, reportBack, sharedFolder: false })}${where}${asks}`,
            threads: children.map((child, index) => ({
              threadId: child.childThreadId,
              title: launches[index]!.title,
              model: selections[index]!.model,
              workspace: "remote" as const,
              computer: descriptor.label,
            })),
          } satisfies ThreadStartResult;
        }),
      );
    });

  // ---------------------------------------------------------------------------
  // thread_list
  // ---------------------------------------------------------------------------

  const threadList = (
    scope: McpInvocationScope,
    input: { readonly scope?: "mine" | "project" | undefined },
  ): Effect.Effect<ThreadListResult> =>
    Effect.gen(function* () {
      const gated = yield* gate(scope, "thread_list");
      if ("refusal" in gated) {
        return { ...gated.refusal, threads: [] } satisfies ThreadListResult;
      }
      const { thread } = gated;
      const [shells, providers] = yield* Effect.all([
        deps.listProjectThreads(thread.projectId),
        deps.providers,
      ]);
      const titles = new Map<string, string>(shells.map((shell) => [shell.id, shell.title]));
      const listed =
        (input.scope ?? "mine") === "mine"
          ? shells
              .filter((shell) => shell.parentThreadId === thread.id)
              .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
          : shells
              .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
              .slice(0, THREAD_LIST_PROJECT_LIMIT);
      // Threads it started on linked computers, as last heard from them.
      const remote =
        (input.scope ?? "mine") === "mine"
          ? (thread.childRequests.remoteChildren ?? []).map((child): ThreadSummary => ({
              threadId: child.threadId,
              title: child.title,
              status: remoteStatusWord(child.cachedStatus),
              branch: null,
              model: "",
              attached: true,
              startedBy: "you",
              computer: remoteLabel(thread, child.environmentId),
            }))
          : [];
      const scheduleAnswerWaiting = yield* waitingOnScheduleAnswers;
      return {
        outcome: "ok",
        threads: [
          ...listed.map((shell) =>
            summarizeThread(shell, {
              caller: thread,
              providers,
              titleOf: (threadId) => titles.get(threadId),
              scheduleAnswerWaiting,
            }),
          ),
          ...remote,
        ],
      } satisfies ThreadListResult;
    });

  // ---------------------------------------------------------------------------
  // thread_read
  // ---------------------------------------------------------------------------

  const threadRead = (
    scope: McpInvocationScope,
    input: {
      readonly threadId: string;
      readonly after?: number | undefined;
      readonly limit?: number | undefined;
    },
  ): Effect.Effect<ThreadReadResult> =>
    Effect.gen(function* () {
      const none = { messages: [], next: null, more: false };
      const gated = yield* gate(scope, "thread_read");
      if ("refusal" in gated) {
        return { ...gated.refusal, ...none } satisfies ThreadReadResult;
      }
      const { thread: caller } = gated;
      const targetId = input.threadId.trim();
      const remoteChild =
        targetId.length > 0
          ? remoteChildOf(caller.childRequests, ThreadId.make(targetId))
          : undefined;
      if (remoteChild !== undefined) {
        const label = remoteLabel(caller, remoteChild.environmentId);
        const read =
          deps.links === undefined
            ? { unavailable: "this computer has no links" }
            : yield* deps.links.read(remoteChild.environmentId, {
                threadId: remoteChild.threadId,
                after: input.after,
                limit: input.limit,
              });
        if ("unavailable" in read) {
          return {
            outcome: "refused",
            detail: `${label} can't be reached right now, so that thread can't be read (${read.unavailable}). It was last ${remoteChild.cachedStatus}.`,
            ...none,
          } satisfies ThreadReadResult;
        }
        return {
          ...read,
          ...(read.thread !== undefined
            ? { thread: { ...read.thread, startedBy: "you", computer: label } }
            : {}),
        } satisfies ThreadReadResult;
      }
      const target =
        targetId.length > 0 ? yield* deps.readThread(ThreadId.make(targetId)) : undefined;
      if (target === undefined || target.projectId !== caller.projectId) {
        return { outcome: "refused", detail: NOT_FOUND, ...none } satisfies ThreadReadResult;
      }
      const providers = yield* deps.providers;
      // Titles for the author lines and "started by": the threads its
      // cross-thread messages came from, and its parent.
      const related = new Set<ThreadId>();
      for (const message of target.messages) {
        if (message.fromThread !== undefined) related.add(message.fromThread.threadId);
      }
      if (target.parentThreadId !== null) related.add(target.parentThreadId);
      const titles = new Map<string, string>([[caller.id, caller.title]]);
      yield* Effect.forEach(
        [...related].filter((threadId) => !titles.has(threadId)),
        (threadId) =>
          deps.readThreadShell(threadId).pipe(
            Effect.tap((shell) =>
              Effect.sync(() => {
                if (shell !== undefined) titles.set(threadId, shell.title);
              }),
            ),
          ),
        { discard: true },
      );
      const shell = yield* deps.readThreadShell(target.id);
      const scheduleAnswerWaiting = yield* waitingOnScheduleAnswers;
      return {
        outcome: "ok",
        ...(shell !== undefined
          ? {
              thread: summarizeThread(shell, {
                caller,
                providers,
                titleOf: (threadId) => titles.get(threadId),
                scheduleAnswerWaiting,
              }),
            }
          : {}),
        ...readThreadPage(target, { providers, titles, after: input.after, limit: input.limit }),
      } satisfies ThreadReadResult;
    });

  // ---------------------------------------------------------------------------
  // thread_send and thread_stop
  // ---------------------------------------------------------------------------

  /**
   * The child a send or stop names, if the caller may steer it: refused for
   * an attached child (depth), `not_yours` for anyone else's thread.
   */
  const ownChild = (
    caller: OrchestrationThread,
    scope: McpInvocationScope,
    threadId: string,
  ): Effect.Effect<
    | { readonly child: OrchestrationThread }
    | {
        readonly refusal: {
          readonly outcome: "not_allowed" | "not_yours" | "refused";
          readonly detail: string;
        };
      }
  > =>
    Effect.gen(function* () {
      if (isAttachedChild(caller)) {
        return { refusal: depthRefusal(caller, scope) };
      }
      const childId = threadId.trim();
      const child = childId.length > 0 ? yield* deps.readThread(ThreadId.make(childId)) : undefined;
      const own = ownChildRefusal(caller, child ?? null);
      if (own !== null || child === undefined) {
        return {
          refusal: {
            outcome: own?.outcome === "refused" ? ("refused" as const) : ("not_yours" as const),
            detail: own?.detail ?? NOT_FOUND,
          },
        };
      }
      return { child };
    });

  const threadSend = (
    scope: McpInvocationScope,
    input: { readonly threadId: string; readonly message: string },
  ): Effect.Effect<ThreadSendResult> =>
    Effect.gen(function* () {
      const gated = yield* gate(scope, "thread_send");
      if ("refusal" in gated) {
        return gated.refusal satisfies ThreadSendResult;
      }
      const { thread } = gated;
      const remoteChild = remoteChildOf(thread.childRequests, ThreadId.make(input.threadId.trim()));
      if (remoteChild !== undefined) {
        return yield* remoteSend(scope, thread, remoteChild, input.message);
      }
      const owned = yield* ownChild(thread, scope, input.threadId);
      if ("refusal" in owned) {
        return owned.refusal satisfies ThreadSendResult;
      }
      const childThreadId = owned.child.id;
      const text = input.message.trim();
      if (text.length === 0) {
        return { outcome: "refused", detail: "Say what you want from the thread." };
      }
      if (text.length > THREAD_PROMPT_CHAR_LIMIT) {
        return {
          outcome: "refused",
          detail: `Keep the message under ${THREAD_PROMPT_CHAR_LIMIT.toLocaleString("en-US")} characters.`,
        };
      }
      const callerTurnId = thread.session?.activeTurnId ?? NO_TURN;
      const key = [
        scope.threadId,
        scope.participantId ?? "primary",
        callerTurnId,
        "thread_send",
        childThreadId,
        text,
      ].join("\u0000");
      const requestId = ChildRequestId.make(derivedUuid(key, "request"));
      const childMessageId = MessageId.make(derivedUuid(key, "message"));
      const sentDetail = {
        sent: "Sent. Its reply comes back to you as a message when it finishes; end your turn if you have nothing else to do.",
        queued:
          "It's busy, so it takes your message after its current turn. Its reply comes back to you as a message; end your turn if you have nothing else to do.",
      } as const;

      return yield* deps.requests.join(key, () =>
        Effect.gen(function* () {
          const [caller, child] = yield* Effect.all([
            deps.readThread(scope.threadId),
            deps.readThread(childThreadId),
          ]);
          if (caller === undefined) {
            return { outcome: "refused", detail: GONE } satisfies ThreadSendResult;
          }
          // The same message, already sent in this turn: that one stands.
          const earlier = caller.childRequests.open.find(
            (request) => request.requestId === requestId,
          );
          if (earlier !== undefined || child?.messages.some((m) => m.id === childMessageId)) {
            const outcome = earlier?.status === "queued" ? "queued" : "sent";
            return {
              outcome,
              detail: sentDetail[outcome],
              threadId: childThreadId,
            } satisfies ThreadSendResult;
          }
          const refusal = childSendRefusal(caller, child ?? null, {
            from: from(scope),
            callerTurnId,
          });
          if (refusal !== null) {
            return {
              outcome:
                refusal.outcome === "not_allowed"
                  ? ("not_yours" as const)
                  : refusal.outcome === "limit"
                    ? ("limit" as const)
                    : ("refused" as const),
              detail: refusal.detail,
            } satisfies ThreadSendResult;
          }
          const outcome =
            child !== undefined && childIsBusy(child, caller)
              ? ("queued" as const)
              : ("sent" as const);
          const rejected = yield* dispatch({
            type: "thread.child.send",
            commandId: childRequestCommandId(requestId, "send"),
            threadId: scope.threadId,
            requestId,
            from: from(scope),
            callerTurnId,
            childThreadId,
            childMessageId,
            text,
            createdAt: yield* nowIso,
          });
          if (rejected !== undefined) {
            return rejected satisfies ThreadSendResult;
          }
          return {
            outcome,
            detail: sentDetail[outcome],
            threadId: childThreadId,
          } satisfies ThreadSendResult;
        }),
      );
    });

  const threadStop = (
    scope: McpInvocationScope,
    input: { readonly threadId: string },
  ): Effect.Effect<ThreadStopResult> =>
    Effect.gen(function* () {
      const gated = yield* gate(scope, "thread_stop");
      if ("refusal" in gated) {
        return gated.refusal satisfies ThreadStopResult;
      }
      const { thread } = gated;
      const remoteChild = remoteChildOf(thread.childRequests, ThreadId.make(input.threadId.trim()));
      if (remoteChild !== undefined) {
        return yield* remoteStop(scope, thread, remoteChild);
      }
      const owned = yield* ownChild(thread, scope, input.threadId);
      if ("refusal" in owned) {
        return owned.refusal satisfies ThreadStopResult;
      }
      const { child } = owned;
      if (!childHasWork(child, thread)) {
        return {
          outcome: "not_running",
          detail: "It isn't working on anything, and nothing you asked of it is waiting.",
          threadId: child.id,
        } satisfies ThreadStopResult;
      }
      // Keyed on what it is doing now, so a stop after it was messaged
      // again in the same turn is a new stop, not a retry of the first.
      const key = [
        scope.threadId,
        scope.participantId ?? "primary",
        thread.session?.activeTurnId ?? NO_TURN,
        "thread_stop",
        child.id,
        child.latestTurn?.turnId ?? "no-turn",
        ...thread.childRequests.open
          .filter((request) => request.childThreadId === child.id)
          .map((request) => request.requestId)
          .toSorted(),
      ].join("\u0000");
      return yield* deps.requests.join(key, () =>
        Effect.gen(function* () {
          const rejected = yield* dispatch({
            type: "thread.children.stop",
            commandId: CommandId.make(`server:child-stop:${derivedUuid(key)}`),
            threadId: scope.threadId,
            childThreadIds: [child.id],
            createdAt: yield* nowIso,
          });
          if (rejected !== undefined) {
            return rejected satisfies ThreadStopResult;
          }
          return {
            outcome: "stopped",
            detail:
              "Stopped. Nothing more comes back from it for what you asked; a later thread_send starts it again.",
            threadId: child.id,
          } satisfies ThreadStopResult;
        }),
      );
    });

  // ---------------------------------------------------------------------------
  // thread_send and thread_stop for a thread on a linked computer
  // ---------------------------------------------------------------------------

  type RemoteChild = NonNullable<ReturnType<typeof remoteChildOf>>;

  const remoteSend = (
    scope: McpInvocationScope,
    thread: OrchestrationThread,
    child: RemoteChild,
    message: string,
  ): Effect.Effect<ThreadSendResult> =>
    Effect.gen(function* () {
      if (isAttachedChild(thread)) {
        return depthRefusal(thread, scope) satisfies ThreadSendResult;
      }
      const text = message.trim();
      if (text.length === 0) {
        return { outcome: "refused", detail: "Say what you want from the thread." };
      }
      if (text.length > THREAD_PROMPT_CHAR_LIMIT) {
        return {
          outcome: "refused",
          detail: `Keep the message under ${THREAD_PROMPT_CHAR_LIMIT.toLocaleString("en-US")} characters.`,
        };
      }
      const computers = deps.links === undefined ? [] : yield* deps.links.computers;
      const computer = computers.find((entry) => entry.environmentId === child.environmentId);
      if (computer === undefined) {
        return {
          outcome: "refused",
          detail: `This computer is no longer linked to ${remoteLabel(thread, child.environmentId)}.`,
        } satisfies ThreadSendResult;
      }
      const callerTurnId = thread.session?.activeTurnId ?? NO_TURN;
      const key = [
        scope.threadId,
        scope.participantId ?? "primary",
        callerTurnId,
        "thread_send",
        child.threadId,
        text,
      ].join("\u0000");
      const requestId = ChildRequestId.make(derivedUuid(key, "request"));
      const busy = child.cachedStatus === "working" || child.cachedStatus === "needs the user";
      const outcome = busy ? ("queued" as const) : ("sent" as const);
      const detail = {
        sent: `Sent to ${computer.label}. Its reply comes back to you as a message when it finishes; end your turn if you have nothing else to do.`,
        queued: `Sent to ${computer.label}; it's busy, so it takes your message after its current turn. Its reply comes back to you as a message; end your turn if you have nothing else to do.`,
      } as const;
      return yield* deps.requests.join(key, () =>
        Effect.gen(function* () {
          const current = (yield* deps.readThread(scope.threadId)) ?? thread;
          if (current.childRequests.open.some((request) => request.requestId === requestId)) {
            return { outcome, detail: detail[outcome], threadId: child.threadId };
          }
          const rejected = yield* dispatch({
            type: "thread.child.send",
            commandId: childRequestCommandId(requestId, "send"),
            threadId: scope.threadId,
            requestId,
            from: from(scope),
            callerTurnId,
            childThreadId: child.threadId,
            childMessageId: linkMessageId(computer.deviceId, requestId),
            text,
            createdAt: yield* nowIso,
          });
          if (rejected !== undefined) {
            return rejected satisfies ThreadSendResult;
          }
          return {
            outcome,
            detail: detail[outcome],
            threadId: child.threadId,
          } satisfies ThreadSendResult;
        }),
      );
    });

  const remoteStop = (
    scope: McpInvocationScope,
    thread: OrchestrationThread,
    child: RemoteChild,
  ): Effect.Effect<ThreadStopResult> =>
    Effect.gen(function* () {
      if (isAttachedChild(thread)) {
        return depthRefusal(thread, scope) satisfies ThreadStopResult;
      }
      const open = thread.childRequests.open.filter(
        (request) => request.childThreadId === child.threadId,
      );
      if (
        open.length === 0 &&
        child.cachedStatus !== "working" &&
        child.cachedStatus !== "waiting"
      ) {
        return {
          outcome: "not_running",
          detail: "It isn't working on anything, and nothing you asked of it is waiting.",
          threadId: child.threadId,
        } satisfies ThreadStopResult;
      }
      const key = [
        scope.threadId,
        scope.participantId ?? "primary",
        thread.session?.activeTurnId ?? NO_TURN,
        "thread_stop",
        child.threadId,
        String(child.attachmentEpoch),
        ...open.map((request) => request.requestId).toSorted(),
      ].join("\u0000");
      return yield* deps.requests.join(key, () =>
        Effect.gen(function* () {
          const rejected = yield* dispatch({
            type: "thread.children.stop",
            commandId: CommandId.make(`server:child-stop:${derivedUuid(key)}`),
            threadId: scope.threadId,
            childThreadIds: [child.threadId],
            createdAt: yield* nowIso,
          });
          if (rejected !== undefined) {
            return rejected satisfies ThreadStopResult;
          }
          return {
            outcome: "stopped",
            detail: `Stopped. ${remoteLabel(thread, child.environmentId)} is told to stop it; nothing more comes back from it for what you asked. A later thread_send starts it again.`,
            threadId: child.threadId,
          } satisfies ThreadStopResult;
        }),
      );
    });

  return {
    thread_agents: threadAgents,
    thread_start: threadStart,
    thread_list: threadList,
    thread_read: threadRead,
    thread_send: threadSend,
    thread_stop: threadStop,
  };
}

export type ThreadToolHandlers = ReturnType<typeof makeThreadToolHandlers>;

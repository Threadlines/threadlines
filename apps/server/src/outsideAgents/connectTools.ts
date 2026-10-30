/**
 * The tools an outside agent gets on `/mcp/connect`, described to its model
 * (docs/design/outside-agents.md, "The MCP server"). The `threadlines`
 * command calls the same tools and decodes the same results.
 *
 * House rules, as for the thread tools Threadlines' own agents have
 * (mcp/threadTools.ts):
 * - every decision is an `outcome`, never an error;
 * - each call is checked against the connection's live grant, whatever the
 *   tool list showed.
 *
 * Unlike those agents, the caller is not in a thread, so nothing comes back
 * to it as a message: it reads and waits instead (`thread_wait`).
 */
import {
  AgentThreadAgent,
  AgentThreadReadResult,
  AgentThreadStatusWord,
  AgentThreadSummary,
  RuntimeMode,
} from "@threadlines/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { agentParameter, drivesThreads, readsThreads } from "../mcp/threadTools.ts";
import type { OutsideAgentCaller } from "./OutsideAgentConnections.ts";

/** The connection behind the call being handled (set by the `/mcp/connect` middleware). */
export class McpConnectInvocation extends Context.Service<
  McpConnectInvocation,
  OutsideAgentCaller
>()("@threadlines/server/outsideAgents/McpConnectInvocation") {}

/** Longest a `thread_wait` holds the call, under the tool timeouts agents use. */
export const THREAD_WAIT_MAX_SECONDS = 50;
export const THREAD_WAIT_DEFAULT_SECONDS = 45;

const Detail = Schema.optional(Schema.String);

/**
 * Every tool can answer `limit` when the connection made too many calls in
 * the last minute (or, for a start, has too many threads running or started
 * too many today); `retryAfterSeconds` says when to try again, when known.
 */
const RetryAfter = Schema.optional(Schema.Number);

/**
 * How the thread's newest turn ended, so a caller can tell a finished turn
 * from a stopped or failed one (the status word says `idle` for all three).
 */
export const OutsideLastTurn = Schema.Struct({
  turnId: Schema.String,
  state: Schema.Literals(["running", "completed", "interrupted", "error"]),
});
export type OutsideLastTurn = typeof OutsideLastTurn.Type;

export const OutsideThreadSummary = Schema.Struct({
  ...AgentThreadSummary.fields,
  projectId: Schema.String,
  project: Schema.String,
  /** The thread's access now (`approval-required` is Supervised). */
  access: RuntimeMode,
  /** Its newest turn; null before the first. */
  lastTurn: Schema.NullOr(OutsideLastTurn),
});
export type OutsideThreadSummary = typeof OutsideThreadSummary.Type;

/** What a thread waits on the user for, when its status is `needs the user`. */
export const OutsideWaitingOn = Schema.Literals(["approval", "question", "plan"]);
export type OutsideWaitingOn = typeof OutsideWaitingOn.Type;

export const ProjectsResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "not_allowed", "limit"]),
  detail: Detail,
  retryAfterSeconds: RetryAfter,
  projects: Schema.Array(
    Schema.Struct({ projectId: Schema.String, name: Schema.String, folder: Schema.String }),
  ),
});
export type ProjectsResult = typeof ProjectsResult.Type;

export const AgentsResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "not_allowed", "limit"]),
  detail: Detail,
  retryAfterSeconds: RetryAfter,
  agents: Schema.Array(AgentThreadAgent),
  /** What a thread runs on when thread_start's `agent` is left out: the user's default. */
  default: Schema.NullOr(Schema.Struct({ instanceId: Schema.String, model: Schema.String })),
  unavailable: Schema.Array(
    Schema.Struct({ instanceId: Schema.String, name: Schema.String, reason: Schema.String }),
  ),
});
export type AgentsResult = typeof AgentsResult.Type;

/**
 * A thread an assistant's `thread_start` answered for before its setup ran
 * (docs/design/assistants.md, "Tools"), while it doesn't exist yet: still
 * `starting`, or `failed` with why.
 */
export const OutsideStartingThread = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  project: Schema.String,
  status: Schema.Literals(["starting", "failed"]),
  detail: Detail,
});
export type OutsideStartingThread = typeof OutsideStartingThread.Type;

export const ThreadsListResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "not_allowed", "not_found", "limit"]),
  detail: Detail,
  retryAfterSeconds: RetryAfter,
  threads: Schema.Array(OutsideThreadSummary),
  /** Assistants: threads it started that are still being set up, or whose setup failed. */
  starting: Schema.optional(Schema.Array(OutsideStartingThread)),
});
export type ThreadsListResult = typeof ThreadsListResult.Type;

export const OutsideThreadReadResult = Schema.Struct({
  ...AgentThreadReadResult.fields,
  /** `starting` / `failed` (assistants): a thread it started that is still being set up, or never was. */
  outcome: Schema.Literals(["ok", "starting", "failed", "not_allowed", "not_found", "limit"]),
  retryAfterSeconds: RetryAfter,
  thread: Schema.optional(OutsideThreadSummary),
  waitingOn: Schema.optional(OutsideWaitingOn),
});
export type OutsideThreadReadResult = typeof OutsideThreadReadResult.Type;

export const ThreadWaitResult = Schema.Struct({
  /**
   * `done`: it left `working`. `still_working`: the wait ran out first (or,
   * for an assistant, it is still being set up); wait again. `failed`
   * (assistants): its setup failed before it existed.
   */
  outcome: Schema.Literals([
    "done",
    "still_working",
    "failed",
    "not_allowed",
    "not_found",
    "limit",
  ]),
  detail: Detail,
  retryAfterSeconds: RetryAfter,
  thread: Schema.optional(OutsideThreadSummary),
  waitingOn: Schema.optional(OutsideWaitingOn),
  /** Its newest reply, clipped at 4,000 characters; null when it has none. */
  reply: Schema.optional(Schema.NullOr(Schema.String)),
});
export type ThreadWaitResult = typeof ThreadWaitResult.Type;

export const OutsideThreadStartResult = Schema.Struct({
  /** `starting` (assistants): it answered before the setup; thread_wait follows it from here. */
  outcome: Schema.Literals([
    "started",
    "starting",
    "not_allowed",
    "not_found",
    "limit",
    "unavailable_agent",
    "conflict",
    "failed",
  ]),
  detail: Detail,
  retryAfterSeconds: RetryAfter,
  thread: Schema.optional(
    Schema.Struct({
      threadId: Schema.String,
      title: Schema.String,
      model: Schema.String,
      workspace: Schema.Literals(["worktree", "project_folder"]),
      access: RuntimeMode,
    }),
  ),
});
export type OutsideThreadStartResult = typeof OutsideThreadStartResult.Type;

export const OutsideThreadSendResult = Schema.Struct({
  /** `busy`: it has a turn running (or waiting on the user); wait, then send again. */
  outcome: Schema.Literals([
    "sent",
    "busy",
    "not_yours",
    "not_allowed",
    "not_found",
    "limit",
    "conflict",
    "failed",
  ]),
  detail: Detail,
  retryAfterSeconds: RetryAfter,
  threadId: Schema.optional(Schema.String),
});
export type OutsideThreadSendResult = typeof OutsideThreadSendResult.Type;

export const OutsideThreadStopResult = Schema.Struct({
  outcome: Schema.Literals([
    "stopped",
    "not_running",
    "not_yours",
    "conflict",
    "not_allowed",
    "not_found",
    "limit",
    "failed",
  ]),
  detail: Detail,
  retryAfterSeconds: RetryAfter,
  threadId: Schema.optional(Schema.String),
});
export type OutsideThreadStopResult = typeof OutsideThreadStopResult.Type;

const ThreadIdParameter = Schema.String.annotate({
  description: "The thread's id, from thread_start or threads_list.",
});

const ProjectParameter = Schema.String.annotate({
  description: "A project's id or name, from projects.",
});

export const RequestIdParameter = Schema.optional(
  Schema.String.annotate({
    description:
      "Any unique string. Sending the same call again with the same requestId returns the first result instead of doing it twice.",
  }),
);

export const ProjectsTool = readsThreads(
  Tool.make("projects", {
    description:
      "The Threadlines projects you may use on this computer: each one's id, name and folder.",
    success: ProjectsResult,
  }).annotate(Tool.Title, "List projects"),
);

export const AgentsTool = readsThreads(
  Tool.make("agents", {
    description:
      "The agents a Threadlines thread can run on: each ready provider and its models, and the user's default, which threads use when you don't pick one. Pass one as thread_start's `agent`.",
    parameters: Schema.Struct({
      instanceId: Schema.optional(
        Schema.String.annotate({ description: "List only this provider, with every model." }),
      ),
    }),
    success: AgentsResult,
  }).annotate(Tool.Title, "List agents"),
);

export const ThreadsListTool = readsThreads(
  Tool.make("threads_list", {
    description:
      "Threads in your projects, most recently active first (at most 50): each one's id, title, project, status (working, needs the user, waiting, failed, idle, wrapped), branch, model and access, and who started it (`you` for threads you started). Filter by project, status or words in the title, or `mine: true` for only the threads you started.",
    parameters: Schema.Struct({
      project: Schema.optional(ProjectParameter),
      status: Schema.optional(AgentThreadStatusWord),
      query: Schema.optional(Schema.String),
      mine: Schema.optional(Schema.Boolean),
      limit: Schema.optional(Schema.Number),
    }),
    success: ThreadsListResult,
  }).annotate(Tool.Title, "List threads"),
);

export const OutsideThreadReadTool = readsThreads(
  Tool.make("thread_read", {
    description:
      "Read a thread: its status, what it waits on when it needs the user, and its messages oldest first, each labelled with who wrote it. Messages are clipped at 4,000 characters. Pass the result's `next` as `after` later to read only newer messages. `limit` defaults to 20.",
    parameters: Schema.Struct({
      threadId: ThreadIdParameter,
      after: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
    }),
    success: OutsideThreadReadResult,
  }).annotate(Tool.Title, "Read a thread"),
);

export const ThreadWaitTool = readsThreads(
  Tool.make("thread_wait", {
    description: `Wait for a thread to stop working, for up to \`seconds\` (default ${THREAD_WAIT_DEFAULT_SECONDS}, at most ${THREAD_WAIT_MAX_SECONDS}). Returns at once if it isn't working. \`done\` comes with its status and newest reply; \`still_working\` means wait again. When it needs the user (an approval, a question or a plan), tell the user to answer it in Threadlines: you can't.`,
    parameters: Schema.Struct({
      threadId: ThreadIdParameter,
      seconds: Schema.optional(Schema.Number),
    }),
    success: ThreadWaitResult,
  }).annotate(Tool.Title, "Wait for a thread"),
);

export const OutsideThreadStartTool = drivesThreads(
  Tool.make("thread_start", {
    description:
      "Start a Threadlines thread in a project, as if the user started it in the app: its own agent session, by default in its own git worktree with the project's setup script. The thread sees only `prompt`, so make it self-contained. `agent` picks a model from agents; leave it out for the user's default. `access` asks for an access level; the thread gets at most what the user allowed you. Returns once the thread is set up and its first turn has started; use thread_wait to follow it.",
    parameters: Schema.Struct({
      project: ProjectParameter,
      prompt: Schema.String.annotate({
        description: "Everything the thread needs to do the work, as its first message.",
      }),
      title: Schema.optional(
        Schema.String.annotate({ description: "A few words naming the work." }),
      ),
      agent: Schema.optional(agentParameter("agents")),
      workspace: Schema.optional(
        Schema.Literals(["worktree", "project_folder"]).annotate({
          description:
            "`worktree`: its own new git worktree (the default in a git project). `project_folder`: works in the project folder itself.",
        }),
      ),
      access: Schema.optional(
        RuntimeMode.annotate({
          description:
            "`approval-required` (Supervised: the user approves its commands and edits), `auto-accept-edits`, `auto` or `full-access`. Left out: the user's default, capped by what you may use.",
        }),
      ),
      requestId: RequestIdParameter,
    }),
    success: OutsideThreadStartResult,
  }).annotate(Tool.Title, "Start a thread"),
);

export const OutsideThreadSendTool = drivesThreads(
  Tool.make("thread_send", {
    description:
      "Send a message to a thread you started: more work, a correction or a question. It starts a new turn, so the thread must not be working: `busy` means wait (thread_wait) and send again. Refused when the user raised the thread's access above what you may use.",
    parameters: Schema.Struct({
      threadId: ThreadIdParameter,
      message: Schema.String.annotate({ description: "What you want it to do or answer." }),
      requestId: RequestIdParameter,
    }),
    success: OutsideThreadSendResult,
  }).annotate(Tool.Title, "Message a thread"),
);

export const OutsideThreadStopTool = drivesThreads(
  Tool.make("thread_stop", {
    description:
      "Stop the running turn in a thread you started, as the Stop button does. A later thread_send starts it again.",
    parameters: Schema.Struct({ threadId: ThreadIdParameter, requestId: RequestIdParameter }),
    success: OutsideThreadStopResult,
  }).annotate(Tool.Title, "Stop a thread"),
);

/** What a `see` connection lists. */
export const SeeToolkit = Toolkit.make(
  ProjectsTool,
  AgentsTool,
  ThreadsListTool,
  OutsideThreadReadTool,
  ThreadWaitTool,
);

/** What a `start` connection lists: everything. */
export const ConnectToolkit = Toolkit.make(
  ProjectsTool,
  AgentsTool,
  ThreadsListTool,
  OutsideThreadReadTool,
  ThreadWaitTool,
  OutsideThreadStartTool,
  OutsideThreadSendTool,
  OutsideThreadStopTool,
);

/** Tools only a `start` connection may call. */
export const START_ONLY_TOOLS: ReadonlySet<string> = new Set([
  OutsideThreadStartTool.name,
  OutsideThreadSendTool.name,
  OutsideThreadStopTool.name,
]);

const SEE_TOOLS: ReadonlySet<string> = new Set(Object.keys(SeeToolkit.tools));
const ALL_TOOLS: ReadonlySet<string> = new Set([...SEE_TOOLS, ...START_ONLY_TOOLS]);
const NO_TOOLS: ReadonlySet<string> = new Set();

/** What a connection's `tools/list` shows, on either door: none once it is removed (null). */
export const listedToolsFor = (access: "see" | "start" | null): ReadonlySet<string> =>
  access === null ? NO_TOOLS : access === "start" ? ALL_TOOLS : SEE_TOOLS;

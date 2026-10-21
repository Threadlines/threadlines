/**
 * The thread tools, described to a model (child threads,
 * docs/design/child-threads.md, "Agent tools").
 *
 * They live on the room endpoint beside the room tools and follow the same
 * house rules (roomTools.ts): every decision is an `outcome`, never an
 * error, and no tool waits on another thread's work. A started or messaged
 * thread's answer comes back as a message after the caller's turn, so each
 * description that starts work says to end the turn rather than wait; a
 * model left to guess polls.
 */
import {
  AgentThreadAgent,
  AgentThreadReadResult,
  AgentThreadStatusWord,
  AgentThreadSummary,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { McpRoomInvocation } from "./roomTools.ts";

const dependencies = [McpRoomInvocation];

/** How a thread is doing, in one word an agent can act on (shared with linked computers). */
export const ThreadStatusWord = AgentThreadStatusWord;
export type ThreadStatusWord = typeof ThreadStatusWord.Type;

const ThreadSummary = AgentThreadSummary;
export type ThreadSummary = typeof ThreadSummary.Type;

export const ThreadAgentsResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "off", "not_allowed", "refused"]),
  detail: Schema.optional(Schema.String),
  /** `ask`: the user approves each start; `auto`: threads start at once. */
  approval: Schema.optional(Schema.Literals(["ask", "auto"])),
  /** What a thread runs on when `agent` is left out: your own model. */
  yours: Schema.optional(Schema.Struct({ instanceId: Schema.String, model: Schema.String })),
  agents: Schema.Array(AgentThreadAgent),
  /** Providers that are set up but can't take a thread now, and why. */
  unavailable: Schema.Array(
    Schema.Struct({ instanceId: Schema.String, name: Schema.String, reason: Schema.String }),
  ),
  /**
   * Linked computers a thread can be started on (thread_start's `computer`),
   * with their own agents. `reachable: false`: offline right now; its agents
   * are as last seen.
   */
  computers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        environmentId: Schema.String,
        reachable: Schema.Boolean,
        agents: Schema.Array(AgentThreadAgent),
      }),
    ),
  ),
});
export type ThreadAgentsResult = typeof ThreadAgentsResult.Type;

export const ThreadStartResult = Schema.Struct({
  /**
   * `started`: they are being set up now. `asked_user`: the user decides
   * first. `unavailable_agent`: a requested agent can't take a thread.
   */
  outcome: Schema.Literals([
    "started",
    "asked_user",
    "off",
    "limit",
    "not_allowed",
    "unavailable_agent",
    "refused",
    "failed",
  ]),
  detail: Schema.optional(Schema.String),
  threads: Schema.optional(
    Schema.Array(
      Schema.Struct({
        threadId: Schema.String,
        title: Schema.String,
        model: Schema.String,
        /**
         * `worktree`: its own new worktree. `project_folder`: shares the
         * project folder. `remote`: on a linked computer, in its own checkout.
         */
        workspace: Schema.Literals(["worktree", "project_folder", "remote"]),
        /** The linked computer it runs on; absent: this one. */
        computer: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type ThreadStartResult = typeof ThreadStartResult.Type;

export const ThreadListResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "off", "not_allowed", "refused"]),
  detail: Schema.optional(Schema.String),
  threads: Schema.Array(ThreadSummary),
});
export type ThreadListResult = typeof ThreadListResult.Type;

export const ThreadReadResult = AgentThreadReadResult;
export type ThreadReadResult = typeof ThreadReadResult.Type;

export const ThreadSendResult = Schema.Struct({
  /** `sent`: it started on it. `queued`: it is busy and takes it next. */
  outcome: Schema.Literals([
    "sent",
    "queued",
    "not_yours",
    "limit",
    "off",
    "not_allowed",
    "refused",
    "failed",
  ]),
  detail: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
});
export type ThreadSendResult = typeof ThreadSendResult.Type;

export const ThreadStopResult = Schema.Struct({
  outcome: Schema.Literals([
    "stopped",
    "not_running",
    "not_yours",
    "off",
    "not_allowed",
    "refused",
    "failed",
  ]),
  detail: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
});
export type ThreadStopResult = typeof ThreadStopResult.Type;

const ThreadIdParameter = Schema.String.annotate({
  description: "The thread's id, from thread_start or thread_list.",
});

const AgentParameter = Schema.Struct({
  instanceId: Schema.String.annotate({ description: "From thread_agents." }),
  model: Schema.String.annotate({ description: "From thread_agents." }),
  options: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        value: Schema.Union([Schema.String, Schema.Boolean]),
      }),
    ).annotate({ description: "Model options such as reasoning effort; usually left out." }),
  ),
});

const readsThreads = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false) as T;

const drivesThreads = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false) as T;

export const ThreadAgentsTool = readsThreads(
  Tool.make("thread_agents", {
    description:
      "The agents a thread you start can run on: each ready provider, how it is paid for, and its models, plus your own model, which threads use when you don't pick one. Pass one as thread_start's `agent`. A provider with a long model list shows its first ones and how many more it has; pass its `instanceId` to list them all. `computers` lists other computers linked to this one, each with its own agents: pass a computer's name as thread_start's `computer` and one of its agents as `agent`.",
    parameters: Schema.Struct({
      instanceId: Schema.optional(
        Schema.String.annotate({ description: "List only this provider, with every model." }),
      ),
    }),
    success: ThreadAgentsResult,
    dependencies,
  }).annotate(Tool.Title, "List agents threads can run on"),
);

export const ThreadStartTool = drivesThreads(
  Tool.make("thread_start", {
    description:
      "Start new threads in this project to work in parallel. Each gets its own agent session and its own git worktree off your current commit (in a project without git they share the project folder). Give each a short `title` and a self-contained `prompt`: the new thread sees none of this conversation, only its prompt. `agent` picks a model from thread_agents; leave it out to use your own. Threads get your current access and interaction modes, never more. `runSetup: false` skips the project's setup script, for quick research. `computer` starts them on another linked computer (a name or id from thread_agents' `computers`) in its copy of this project: from your branch when you pushed it, otherwise from that computer's default branch, without your unpushed changes. With `reportBack` (default true) each thread's final reply comes back to you as a message when it finishes; with false they run on their own and nothing comes back. Returns as soon as they are recorded and does not wait for them, so don't poll: carry on, or end your turn if you have nothing else to do. At most 5 threads per call and 5 per user message.",
    parameters: Schema.Struct({
      threads: Schema.Array(
        Schema.Struct({
          title: Schema.String.annotate({ description: "A few words naming the work." }),
          prompt: Schema.String.annotate({
            description: "Everything the thread needs to do the work, as its first message.",
          }),
          agent: Schema.optional(AgentParameter),
          runSetup: Schema.optional(Schema.Boolean),
        }),
      ),
      reportBack: Schema.optional(Schema.Boolean),
      computer: Schema.optional(
        Schema.String.annotate({
          description:
            "A linked computer's name or id, from thread_agents. Leave out for this one.",
        }),
      ),
    }),
    success: ThreadStartResult,
    dependencies,
  }).annotate(Tool.Title, "Start threads"),
);

export const ThreadListTool = readsThreads(
  Tool.make("thread_list", {
    description:
      'Threads you started (`scope: "mine"`, the default), including ones the user made their own and ones on linked computers (with `computer` set, status as last heard), or this project\'s open threads (`"project"`, most recently active first, at most 30). Each has its id, title, status (working, needs the user, waiting, failed, idle, wrapped), branch, model, whether its replies come back to the thread that started it, and who started it.',
    parameters: Schema.Struct({
      scope: Schema.optional(Schema.Literals(["mine", "project"])),
    }),
    success: ThreadListResult,
    dependencies,
  }).annotate(Tool.Title, "List threads"),
);

export const ThreadReadTool = readsThreads(
  Tool.make("thread_read", {
    description:
      "Read another thread in this project, or one you started on a linked computer: its status and its recent messages, oldest first, each labelled with who wrote it (the user, an agent, or a request or report between threads). Messages are clipped at 4,000 characters. Pass the result's `next` as `after` later to read only newer messages. `limit` defaults to 20.",
    parameters: Schema.Struct({
      threadId: ThreadIdParameter,
      after: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
    }),
    success: ThreadReadResult,
    dependencies,
  }).annotate(Tool.Title, "Read a thread"),
);

export const ThreadSendTool = drivesThreads(
  Tool.make("thread_send", {
    description:
      "Send one of your threads a message: more work, a correction or a question. If it is idle it starts on it now; if it is busy it takes it after its current turn. Its reply comes back to you as a message, like a start. Only threads you started whose replies still come back to you. Don't poll; end your turn if you have nothing else to do.",
    parameters: Schema.Struct({
      threadId: ThreadIdParameter,
      message: Schema.String.annotate({ description: "What you want it to do or answer." }),
    }),
    success: ThreadSendResult,
    dependencies,
  }).annotate(Tool.Title, "Message a thread"),
);

export const ThreadStopTool = drivesThreads(
  Tool.make("thread_stop", {
    description:
      "Stop one of your threads: its turn, its background work and its session. What you asked of it ends without an answer, and messages you queued for it are taken back. A later message starts it again. Only threads you started whose replies still come back to you.",
    parameters: Schema.Struct({ threadId: ThreadIdParameter }),
    success: ThreadStopResult,
    dependencies,
  }).annotate(Tool.Title, "Stop a thread"),
);

export const ThreadToolkit = Toolkit.make(
  ThreadAgentsTool,
  ThreadStartTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadSendTool,
  ThreadStopTool,
);

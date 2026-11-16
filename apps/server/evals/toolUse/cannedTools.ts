/**
 * Canned answers for the tools Threadlines gives agents, so an eval sees how a
 * model uses them without anything real happening: no thread starts, no
 * setting changes. Each call is logged for the graders. Answers are typed by
 * the real tools, so they stay valid when a tool's result changes.
 */
import * as Effect from "effect/Effect";
import type { Toolkit } from "effect/ai";

import type { RuntimeMode } from "@threadlines/contracts";

import { RoomEndpointToolkit } from "../../src/mcp/McpRoomServer.ts";
import { launchAccess, lowerAccessNote, startedDetail } from "../../src/mcp/threadToolHandlers.ts";
import { BrowserScreenshotToolkit, BrowserStandardToolkit } from "../../src/mcp/browserTools.ts";

export interface ToolCall {
  readonly tool: string;
  readonly input: Record<string, unknown>;
}

type RoomHandlers = Parameters<typeof RoomEndpointToolkit.toLayer>[0];
type HandlerOf<K extends keyof typeof RoomEndpointToolkit.tools> = Extract<
  RoomHandlers,
  Record<string, unknown>
>[K];
type ResultOf<K extends keyof typeof RoomEndpointToolkit.tools> = Effect.Success<
  ReturnType<HandlerOf<K>>
>;

/** A case's own answers, by tool; any tool left out answers with the default below. */
export type CannedAnswers = {
  readonly [K in keyof typeof RoomEndpointToolkit.tools]?: (
    input: Parameters<HandlerOf<K>>[0],
  ) => ResultOf<K>;
};

/** The other agent in the room, when a case sets one up. */
export const ROOM_PEER = { key: "peer", name: "GPT-6.1-Sol" } as const;

const AGENTS = [
  {
    instanceId: "claudeAgent",
    name: "Claude",
    billing: "Claude subscription",
    models: [
      { model: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: ["low", "medium", "high"] },
      { model: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: ["low", "medium", "high"] },
    ],
  },
  {
    instanceId: "codex",
    name: "Codex",
    billing: "ChatGPT plan",
    models: [
      { model: "gpt-6.1-sol", name: "GPT-6.1 Sol", reasoning: ["low", "medium", "high", "xhigh"] },
    ],
  },
];

/** Builds the room endpoint's handlers for one case, logging into `calls`. */
export function makeCannedRoomHandlers(
  calls: Array<ToolCall>,
  answers: CannedAnswers = {},
  caller: { readonly runtimeMode: RuntimeMode },
) {
  let started = 0;
  const startedThreads: Array<{ threadId: string; title: string }> = [];
  const answer = <K extends keyof typeof RoomEndpointToolkit.tools>(
    tool: K,
    fallback: (input: Parameters<HandlerOf<K>>[0]) => ResultOf<K>,
  ) =>
    ((input: Parameters<HandlerOf<K>>[0]) =>
      Effect.sync(() => {
        calls.push({ tool, input: input as Record<string, unknown> });
        return (answers[tool] as typeof fallback | undefined)?.(input) ?? fallback(input);
      })) as unknown as HandlerOf<K>;

  return RoomEndpointToolkit.toLayer({
    room_agents: answer("room_agents", () => ({
      outcome: "ok",
      agents: [
        {
          key: "primary",
          participantId: null,
          name: "You",
          model: "your model",
          status: "working",
          canAnswer: true,
          roomTools: "attached",
          you: true,
        },
        {
          key: ROOM_PEER.key,
          participantId: ROOM_PEER.key,
          name: ROOM_PEER.name,
          model: "gpt-6.1-sol",
          status: "idle",
          canAnswer: true,
          roomTools: "next_turn",
          you: false,
        },
      ],
    })),
    room_ask: answer("room_ask", () => ({
      outcome: "answered",
      agent: ROOM_PEER,
      answer: "Looks fine to me.",
    })),
    room_review: answer("room_review", () => ({
      outcome: "answered",
      agent: ROOM_PEER,
      answer: "No problems found.",
    })),
    room_hand_off: answer("room_hand_off", () => ({ outcome: "queued", agent: ROOM_PEER })),
    room_history: answer("room_history", () => ({ outcome: "ok", messages: [], before: null })),
    room_diff: answer("room_diff", () => ({ outcome: "ok", output: "" })),
    room_available_agents: answer("room_available_agents", () => ({
      outcome: "ok",
      providers: [],
    })),
    room_invite: answer("room_invite", () => ({ outcome: "asked_user" })),
    thread_agents: answer("thread_agents", () => ({
      outcome: "ok",
      approval: "auto",
      agents: AGENTS,
      unavailable: [],
    })),
    // As production answers: its own wording, and each thread's real access.
    thread_start: answer("thread_start", (input) => {
      const launches = input.threads.map((thread) => ({
        runtimeMode: launchAccess({ access: thread.access }, caller),
      }));
      return {
        outcome: "started",
        detail: `${startedDetail({
          outcome: "started",
          count: input.threads.length,
          reportBack: input.reportBack ?? true,
          sharedFolder: false,
        })}${lowerAccessNote(
          input.threads.map((thread) => ({ title: thread.title, access: thread.access })),
          launches,
        )}`,
        threads: input.threads.map((thread, index) => {
          started += 1;
          const threadId = `thread-eval-${started}`;
          startedThreads.push({ threadId, title: thread.title });
          return {
            threadId,
            title: thread.title,
            model: thread.agent?.model ?? "your model",
            workspace: "worktree" as const,
            access: launches[index]!.runtimeMode,
          };
        }),
      };
    }),
    thread_list: answer("thread_list", () => ({
      outcome: "ok",
      threads: startedThreads.map((thread) => ({
        ...thread,
        status: "working" as const,
        branch: null,
        model: "your model",
        attached: true,
        startedBy: "you",
      })),
    })),
    thread_read: answer("thread_read", () => ({
      outcome: "ok",
      messages: [],
      next: null,
      more: false,
    })),
    thread_send: answer("thread_send", (input) => ({ outcome: "sent", threadId: input.threadId })),
    thread_stop: answer("thread_stop", (input) => ({
      outcome: "stopped",
      threadId: input.threadId,
    })),
    thread_move: answer("thread_move", () => ({
      outcome: "queued",
      detail:
        "Queued: this thread moves to that computer when your turn ends. Finish your reply; don't start more work.",
    })),
    schedule_list: answer("schedule_list", () => ({ outcome: "ok", tasks: [] })),
    schedule_create: answer("schedule_create", () => ({
      outcome: "asked_user",
      detail: "A card asks the user to confirm the task.",
    })),
    schedule_update: answer("schedule_update", () => ({ outcome: "asked_user" })),
    scheduled_run_finish: answer("scheduled_run_finish", () => ({ outcome: "not_a_run" })),
    app_guide: answer("app_guide", () => ({
      outcome: "no_match",
      answer: "Nothing in the guide matches that.",
    })),
    settings_change: answer("settings_change", () => ({
      outcome: "asked_user",
      detail: "A card asks the user to accept the change.",
    })),
    alert_assistants: answer("alert_assistants", () => ({
      outcome: "no_receiver",
      detail: "No assistant is set up to receive alerts.",
    })),
  });
}

const notInEvals = (tool: string) => () =>
  Effect.die(new Error(`${tool} is not available in tool-use evals.`));

/** Browser tools are listed as in production; an eval that calls one gets an error. */
export const refusingBrowserHandlers = {
  standard: BrowserStandardToolkit.toLayer(
    Object.fromEntries(
      Object.keys(BrowserStandardToolkit.tools).map((tool) => [tool, notInEvals(tool)]),
    ) as unknown as Toolkit.HandlersFrom<typeof BrowserStandardToolkit.tools>,
  ),
  screenshot: BrowserScreenshotToolkit.toLayer(
    Object.fromEntries(
      Object.keys(BrowserScreenshotToolkit.tools).map((tool) => [tool, notInEvals(tool)]),
    ) as unknown as Toolkit.HandlersFrom<typeof BrowserScreenshotToolkit.tools>,
  ),
};

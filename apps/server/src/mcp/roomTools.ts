/**
 * The room tools, described to a model (docs/design/rooms-slice-2.md, Part B).
 *
 * As with the browser tools, these sentences are the whole interface. Each
 * says what the tool does and what the other agent sees, because that is the
 * part a model gets wrong: an independent review is independent only if the
 * model leaves its own conclusions out of the request, and a hand-off works
 * only if the model then ends its turn.
 *
 * Every tool answers with an `outcome`, never an error, for anything the room
 * decides (busy, the limit, a refusal): those are answers an agent can act
 * on. Agents are named by participant id, key, or an unambiguous name.
 */
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import type { McpInvocationScope } from "./McpSessionRegistry.ts";
import { ROOM_DIFF_VIEWS } from "./roomGit.ts";
import { ROOM_HISTORY_MAX_LIMIT } from "./roomHistory.ts";

/**
 * Who called a room tool, from the credential the request arrived with (see
 * McpSessionRegistry). Provided per request by the room endpoint.
 */
export class McpRoomInvocation extends Context.Service<McpRoomInvocation, McpInvocationScope>()(
  "@threadlines/server/mcp/McpRoomInvocation",
) {}

const dependencies = [McpRoomInvocation];

const AgentName = Schema.String.annotate({
  description:
    'The agent: its key or participant id from room_agents, or an unambiguous name ("GPT-6 Astra 2", "Reviewer").',
});

const AgentLabel = Schema.Struct({ key: Schema.String, name: Schema.String });

/** Outcomes a request can end with, as the calling agent sees them. */
const RequestOutcome = Schema.Literals([
  "answered",
  "failed",
  "stopped",
  "timeout",
  "busy",
  "limit",
  "refused",
]);

export const RoomAnswerResult = Schema.Struct({
  outcome: RequestOutcome,
  /** Why, for anything but `answered`. */
  detail: Schema.optional(Schema.String),
  agent: Schema.optional(AgentLabel),
  requestId: Schema.optional(Schema.String),
  sideTurnId: Schema.optional(Schema.String),
  /** The answer, bounded; the full text is in the chat. */
  answer: Schema.optional(Schema.String),
  answerClipped: Schema.optional(Schema.Boolean),
  answerMessageId: Schema.optional(Schema.String),
});
export type RoomAnswerResult = typeof RoomAnswerResult.Type;

export const RoomHandOffResult = Schema.Struct({
  outcome: Schema.Literals(["queued", "failed", "busy", "limit", "refused"]),
  detail: Schema.optional(Schema.String),
  agent: Schema.optional(AgentLabel),
  requestId: Schema.optional(Schema.String),
});
export type RoomHandOffResult = typeof RoomHandOffResult.Type;

export const RoomAgentsResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "refused"]),
  detail: Schema.optional(Schema.String),
  agents: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      participantId: Schema.NullOr(Schema.String),
      name: Schema.String,
      model: Schema.String,
      status: Schema.Literals(["working", "answering", "idle"]),
      /** Can answer an ask or a review on the side (Codex and Claude can). */
      canAnswer: Schema.Boolean,
      /**
       * Whether it can use the room tools itself: `attached`, `unavailable`
       * (its provider cannot reach them from where it runs), or `next_turn`
       * (it gets them the next time it works).
       */
      roomTools: Schema.Literals(["attached", "unavailable", "next_turn"]),
      you: Schema.Boolean,
    }),
  ),
});
export type RoomAgentsResult = typeof RoomAgentsResult.Type;

export const RoomHistoryResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "refused"]),
  detail: Schema.optional(Schema.String),
  messages: Schema.Array(
    Schema.Struct({
      messageId: Schema.String,
      sequence: Schema.Number,
      at: Schema.String,
      author: Schema.String,
      to: Schema.optional(Schema.String),
      origin: Schema.Literals(["user", "agent"]),
      requestKind: Schema.optional(Schema.String),
      onTheSide: Schema.optional(Schema.Boolean),
      text: Schema.String,
      clipped: Schema.optional(Schema.Boolean),
      streaming: Schema.optional(Schema.Boolean),
      attachments: Schema.optional(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            name: Schema.String,
            mimeType: Schema.String,
            sizeBytes: Schema.Number,
          }),
        ),
      ),
    }),
  ),
  /** Pass as `before` for older messages; null when there are none. */
  before: Schema.NullOr(Schema.Number),
});
export type RoomHistoryResult = typeof RoomHistoryResult.Type;

export const RoomDiffResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "refused", "failed"]),
  detail: Schema.optional(Schema.String),
  view: Schema.optional(Schema.String),
  base: Schema.optional(Schema.String),
  head: Schema.optional(Schema.String),
  output: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
});
export type RoomDiffResult = typeof RoomDiffResult.Type;

export const RoomAvailableAgentsResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "refused"]),
  detail: Schema.optional(Schema.String),
  /** `ask`: the user decides each invite; `auto`: invites start without asking. */
  invites: Schema.optional(Schema.Literals(["ask", "auto"])),
  providers: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      name: Schema.String,
      /** How it is paid for: "Codex · ChatGPT Pro Subscription". */
      billing: Schema.String,
      /** Billed per use (an API key) rather than by a plan's limits. */
      perUse: Schema.Boolean,
      models: Schema.Array(
        Schema.Struct({
          /** Pass as room_invite's `agent`. */
          key: Schema.String,
          name: Schema.String,
          /** Already in this thread: ask it with room_review instead. */
          inThread: Schema.Boolean,
        }),
      ),
    }),
  ),
});
export type RoomAvailableAgentsResult = typeof RoomAvailableAgentsResult.Type;

export const RoomInviteResult = Schema.Struct({
  /**
   * `asked_user`: the user decides; `started`: the review is running
   * (invites need no approval here). Either way its review comes back to you
   * as a message after your turn, if it runs.
   */
  outcome: Schema.Literals(["asked_user", "started", "failed", "busy", "limit", "refused"]),
  detail: Schema.optional(Schema.String),
  agent: Schema.optional(AgentLabel),
  requestId: Schema.optional(Schema.String),
});
export type RoomInviteResult = typeof RoomInviteResult.Type;

export const RoomReviewBasisParameter = Schema.Union([
  Schema.Literal("uncommitted"),
  Schema.Struct({
    base: Schema.String.annotate({
      description: "A branch, tag or commit: the review covers base..HEAD.",
    }),
  }),
]);

const readsRoom = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false) as T;

const asksAgent = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, false) as T;

export const RoomAgentsTool = readsRoom(
  Tool.make("room_agents", {
    description:
      "Who is in this room: each agent's key, name, model, whether it is working, answering on the side or idle, whether it can answer on the side, and which one is you.",
    success: RoomAgentsResult,
    dependencies,
  }).annotate(Tool.Title, "List the room's agents"),
);

export const RoomAskTool = asksAgent(
  Tool.make("room_ask", {
    description:
      "Ask another agent in this room a question. It sees the room conversation and answers read-only. Its answer comes back to you here. Only while you are working in this room; one side answer runs at a time.",
    parameters: Schema.Struct({
      agent: AgentName,
      question: Schema.String.annotate({ description: "The question, as you would ask it." }),
    }),
    success: RoomAnswerResult,
    dependencies,
  }).annotate(Tool.Title, "Ask another agent"),
);

export const RoomReviewTool = asksAgent(
  Tool.make("room_review", {
    description:
      "Get an independent review from another agent. It starts fresh: it sees none of this room's conversation, only your request and the code. Put the goal, the user's requirements and what to check in the request. Leave out your own conclusions. `basis` is what it reviews: the uncommitted changes (default) or { base } for base..HEAD, captured now. Its review comes back to you here.",
    parameters: Schema.Struct({
      agent: AgentName,
      request: Schema.String.annotate({
        description: "The goal, the user's requirements, and what to check.",
      }),
      basis: Schema.optional(RoomReviewBasisParameter),
    }),
    success: RoomAnswerResult,
    dependencies,
  }).annotate(Tool.Title, "Get an independent review"),
);

export const RoomHandOffTool = asksAgent(
  Tool.make("room_hand_off", {
    description:
      "Hand the next working turn to another agent. It sees the room conversation and can edit. End your turn after calling this; its reply will come back to you as a message.",
    parameters: Schema.Struct({
      agent: AgentName,
      message: Schema.String.annotate({ description: "What you want it to do." }),
    }),
    success: RoomHandOffResult,
    dependencies,
  }).annotate(Tool.Title, "Hand off to another agent"),
);

export const RoomHistoryTool = readsRoom(
  Tool.make("room_history", {
    description: `Earlier messages in this room, oldest first, each with its author, who it was for, and whether the user or an agent wrote it. Side exchanges are included. Returns the newest page; pass the result's \`before\` for older ones. \`limit\` is at most ${ROOM_HISTORY_MAX_LIMIT}; \`query\` keeps messages containing that text. Long messages are clipped; attachments are listed, not shown.`,
    parameters: Schema.Struct({
      before: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
      query: Schema.optional(Schema.String),
    }),
    success: RoomHistoryResult,
    dependencies,
  }).annotate(Tool.Title, "Read earlier room messages"),
);

export const RoomDiffTool = readsRoom(
  Tool.make("room_diff", {
    description:
      "Read-only git views of this room's checkout. `status`: changed and untracked files. `diff`: the uncommitted changes, untracked files included, or with `base`, base..HEAD. `diff_stat`: the same as a summary. `log`: the last 20 commits, or with `base`, base..HEAD. `show`: one commit (`base`, default HEAD). `path` narrows any view to a file or folder, relative to the checkout. Output is bounded.",
    parameters: Schema.Struct({
      view: Schema.Literals(ROOM_DIFF_VIEWS),
      base: Schema.optional(Schema.String),
      path: Schema.optional(Schema.String),
    }),
    success: RoomDiffResult,
    dependencies,
  }).annotate(Tool.Title, "Read the checkout's changes"),
);

export const RoomAvailableAgentsTool = readsRoom(
  Tool.make("room_available_agents", {
    description:
      "Other agents the user could bring into this thread, for room_invite: each signed-in Codex and Claude provider, how it is paid for, and its models, with the ones already in this thread marked.",
    success: RoomAvailableAgentsResult,
    dependencies,
  }).annotate(Tool.Title, "List agents that could be brought in"),
);

export const RoomInviteTool = asksAgent(
  Tool.make("room_invite", {
    description:
      "Ask the user to bring another agent into this thread for an independent review of your work, a second opinion from a different model. Use it when a review would really help (a risky change, a hard bug, a call the user should not take on one model's word), not for routine work. The reviewer starts fresh: it sees none of this conversation, only your request and the code. Put the goal, the user's requirements and what to check in `request`; leave out your own conclusions. `reason` is one short sentence the user sees when deciding. `suggestion`: `review` (default) for a one-off review, or `teammate` to suggest it joins the thread for good. `basis` is what it reviews: the uncommitted changes (default) or { base } for base..HEAD, captured now. Returns at once. Keep working or end your turn; do not wait. If the review runs, it comes back to you as a message. If the user says no, you will not hear back; do not ask again unless the user asks you to.",
    parameters: Schema.Struct({
      agent: Schema.String.annotate({
        description:
          'The model: its key from room_available_agents, or an unambiguous name ("GPT-6 Astra").',
      }),
      request: Schema.String.annotate({
        description: "The goal, the user's requirements, and what to check.",
      }),
      reason: Schema.String.annotate({
        description: "Why a second opinion helps here, in one short sentence, for the user.",
      }),
      suggestion: Schema.optional(Schema.Literals(["review", "teammate"])),
      basis: Schema.optional(RoomReviewBasisParameter),
    }),
    success: RoomInviteResult,
    dependencies,
  }).annotate(Tool.Title, "Ask the user to bring in another agent"),
);

export const RoomToolkit = Toolkit.make(
  RoomAgentsTool,
  RoomAskTool,
  RoomReviewTool,
  RoomHandOffTool,
  RoomHistoryTool,
  RoomDiffTool,
  RoomAvailableAgentsTool,
  RoomInviteTool,
);

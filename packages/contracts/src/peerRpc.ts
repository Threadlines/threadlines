import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import {
  ChildRequestId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OutsideAgentConnectionId,
  PositiveInt,
  ThreadId,
  ThreadMoveFamilyId,
  ThreadMoveId,
  ThreadParticipantId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ComputerLinkAccess } from "./links.ts";
import { OutsideAgentConnectionKind } from "./outsideAgents.ts";
import { ProviderOptionSelections } from "./model.ts";
import {
  ChatAttachment,
  ChatSkillReferenceList,
  KnownAssistant,
  MessageComposer,
  MessageSentFrom,
  ModelSelection,
  OrchestrationOutsideWork,
  OrchestrationProposedPlan,
  OrchestrationThreadActivity,
  OutsideAgentAccess,
  OrchestrationThreadDoneOverride,
  ProviderInteractionMode,
  RemoteThreadFiling,
  RoomAgentRole,
  RuntimeMode,
  ThreadGoalStatus,
  ThreadImportMessage,
} from "./orchestration.ts";
import { PullRequestMergeMethod } from "./pullRequest.ts";

/**
 * What one linked computer's server may ask of another (docs/design/fleet.md,
 * "PeerRpcGroup"). Served only on the loopback `/peer` WebSocket, and only to
 * sessions with the `peer` role: the allowlist is this group, by
 * construction. Every mutating method is idempotent by the caller's link and
 * `requestId`.
 */

// ----- shapes shared with the agent thread tools -----------------------------------

/** How a thread is doing, in one word an agent can act on. */
export const AgentThreadStatusWord = Schema.Literals([
  "working",
  "needs the user",
  "waiting",
  "failed",
  "idle",
  "wrapped",
]);
export type AgentThreadStatusWord = typeof AgentThreadStatusWord.Type;

export const AgentThreadSummary = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  status: AgentThreadStatusWord,
  branch: Schema.NullOr(Schema.String),
  model: Schema.String,
  /** Its final replies come back to the thread that started it. */
  attached: Schema.Boolean,
  /** The thread that started it: "you", a title, or null when nobody did. */
  startedBy: Schema.NullOr(Schema.String),
  /** The calling thread itself. */
  you: Schema.optional(Schema.Boolean),
  /** The linked computer it runs on; absent: this one. */
  computer: Schema.optional(Schema.String),
  /** Its project's lead chat (docs/design/lead-chat.md). */
  lead: Schema.optional(Schema.Boolean),
  /** When its work last moved: its latest turn, else its last change. */
  lastActivityAt: Schema.optional(Schema.String),
  /**
   * Its pull requests, as this computer already knows them (no call to the
   * host): `state` where a read has said.
   */
  pullRequests: Schema.optional(
    Schema.Array(
      Schema.Struct({
        number: Schema.Number,
        url: Schema.String,
        state: Schema.optional(Schema.Literals(["open", "merged", "closed"])),
      }),
    ),
  ),
});
export type AgentThreadSummary = typeof AgentThreadSummary.Type;

export const AgentThreadReadResult = Schema.Struct({
  outcome: Schema.Literals(["ok", "off", "not_allowed", "refused"]),
  detail: Schema.optional(Schema.String),
  thread: Schema.optional(AgentThreadSummary),
  messages: Schema.Array(
    Schema.Struct({
      messageId: Schema.String,
      sequence: Schema.Number,
      at: Schema.String,
      role: Schema.Literals(["user", "assistant"]),
      author: Schema.String,
      /**
       * `user`: the user wrote it. `agent`: an agent in that thread did.
       * `thread_request` / `thread_report`: another thread's agent did.
       */
      origin: Schema.Literals(["user", "agent", "thread_request", "thread_report"]),
      text: Schema.String,
      /** `text` is only part of the message. */
      clipped: Schema.optional(Schema.Boolean),
      /** The whole message's length in characters, when `text` is only part of it. */
      length: Schema.optional(Schema.Number),
      /** Read by `messageId`: where `text` starts in the message. */
      offset: Schema.optional(Schema.Number),
      /** Read by `messageId`: pass as `offset` to read on. Absent: `text` reaches the end. */
      nextOffset: Schema.optional(Schema.Number),
      streaming: Schema.optional(Schema.Boolean),
      /** It never reached that thread's agent (OrchestrationMessage.notSent): shown, never acted on. */
      notSent: Schema.optional(Schema.Boolean),
    }),
  ),
  /** Pass as `after` later for only newer messages; null when there are none. */
  next: Schema.NullOr(Schema.Number),
  /** More messages follow this page; read again with `after: next`. */
  more: Schema.Boolean,
});
export type AgentThreadReadResult = typeof AgentThreadReadResult.Type;

/** One agent a thread can run on, as thread_agents lists it. */
export const AgentThreadAgent = Schema.Struct({
  /** Pass as thread_start's `agent.instanceId`. */
  instanceId: Schema.String,
  name: Schema.String,
  /** How it is paid for: "Codex · ChatGPT Pro Subscription". */
  billing: Schema.String,
  models: Schema.Array(
    Schema.Struct({
      /** Pass as thread_start's `agent.model`. */
      model: Schema.String,
      name: Schema.String,
      /** Its reasoning levels, for thread_start's `agent.reasoning`. Absent: none to choose. */
      reasoning: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  /** Models left off a long list; thread_agents with this `instanceId` lists them all. */
  moreModels: Schema.optional(Schema.Number),
});
export type AgentThreadAgent = typeof AgentThreadAgent.Type;

/**
 * A model's reasoning setting as another computer needs it to name a level:
 * the option the level goes in ("reasoningEffort") and the levels, with the
 * names the model picker shows ("Extra High").
 */
export const PeerModelReasoning = Schema.Struct({
  option: Schema.String,
  levels: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
});
export type PeerModelReasoning = typeof PeerModelReasoning.Type;

// ----- peer.describe ----------------------------------------------------------------

/** The asking computer, as it introduces itself (shown to the user; never trusted for access). */
export const PeerCaller = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
});
export type PeerCaller = typeof PeerCaller.Type;

export const PeerAgent = Schema.Struct({
  ...AgentThreadAgent.fields,
  models: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      name: Schema.String,
      /** Absent: no levels to choose, or an older server that doesn't say. */
      reasoningSetting: Schema.optional(PeerModelReasoning),
    }),
  ),
  /** The provider kind (`codex`, `claudeAgent`, ...), to pick the caller's kind by default. */
  driver: Schema.String,
  /**
   * It keeps a thread's goal (docs/design/fleet.md, Part 3e); with
   * `goalBudget` false, not a goal's token budget. Absent: it doesn't, or an
   * older server that doesn't say.
   */
  threadGoals: Schema.optional(Schema.Boolean),
  goalBudget: Schema.optional(Schema.Boolean),
  /** It sets itself times to come back (check-backs). Absent: it doesn't, or an older server. */
  checkBacks: Schema.optional(Schema.Boolean),
});
export type PeerAgent = typeof PeerAgent.Type;

export const PeerProject = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** RepositoryIdentity.canonicalKey; the caller names the project by it. */
  canonicalKey: TrimmedNonEmptyString,
  /**
   * The project's folder from the repository root ("" at the root), so a
   * monorepo's projects tell apart. Absent: an older server; match the key alone.
   */
  subdirectory: Schema.optional(Schema.String),
});
export type PeerProject = typeof PeerProject.Type;

export const PeerDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: Schema.String,
  serverVersion: Schema.String,
  /** Where the caller's device can reach this server without the relay, right now. */
  directRoutes: Schema.Array(TrimmedNonEmptyString),
  /** What the caller's link may do here. */
  access: ComputerLinkAccess,
  maxRuntimeMode: RuntimeMode,
  /** Ready agents, with this computer's own instance ids. */
  agents: Schema.Array(PeerAgent),
  /** The agent new threads here use when none is named. */
  defaultAgent: Schema.NullOr(Schema.Struct({ instanceId: Schema.String, model: Schema.String })),
  projects: Schema.Array(PeerProject),
  /** Takes threads moved here (`peer.move.*`). Absent: an older server that can't. */
  moves: Schema.optional(Schema.Boolean),
  /**
   * Under Ask first, takes a moved thread's bytes before its user allows it
   * (docs/design/fleet.md, Part 3c), for a caller that asks so at
   * `peer.move.prepare` (`stagedApproval`). Absent: an older server that
   * holds the bytes back until Allow.
   */
  moveStagedApproval: Schema.optional(Schema.Boolean),
  /**
   * Takes a moved thread's agent session (`session` parts and
   * PeerMoveManifest.session, docs/design/fleet.md, Part 3d). Absent: an older
   * server, which refuses a manifest with them, so it is never sent one.
   */
  moveNativeSession: Schema.optional(Schema.Boolean),
  /**
   * Takes what a moved thread had going (docs/design/fleet.md, Part 3e): its
   * goal, check-backs, pull request switches, queued messages and plans
   * (PeerMoveManifest's `thread.state`), runs its arrival, and answers
   * `peer.move.readiness`. Absent: an older server, which would drop that
   * state without a word, so a thread with any is never sent to it.
   */
  moveThreadState: Schema.optional(Schema.Boolean),
  /**
   * Takes a General Chats thread and its folder (PeerMoveScratchManifest).
   * Absent: an older server, which can't read one, so it is never sent one.
   */
  moveGeneralChats: Schema.optional(Schema.Boolean),
  /**
   * Takes a thread with more than one agent (docs/design/fleet.md, Part 3f,
   * (i)): its agents' records and sessions (PeerMoveManifest's `thread.room`,
   * `session` parts naming a `participantId`) and the room fields of its
   * messages. Absent: an older server, which would take the parts as the
   * thread's own agent's, so a room is never sent to it.
   */
  moveRooms: Schema.optional(Schema.Boolean),
  /**
   * Takes the marks outside work left on a thread's agents
   * (PeerMoveManifest's `thread.outsideWork`), so an agent whose tools are
   * limited here arrives limited. Absent: an older server, which would drop
   * them, so a thread with any is never sent to it.
   */
  moveOutsideWork: Schema.optional(Schema.Boolean),
  /**
   * Takes a thread that started threads, and its children with it
   * (docs/design/fleet.md, Part 3f, (g)): PeerMoveManifest's `family`, the
   * parent landed first, children under it, members sharing one folder.
   * Absent: an older server, which would land each as its own thread, so a
   * family is never sent to it.
   */
  moveFamilies: Schema.optional(Schema.Boolean),
  /**
   * Takes a thread across the link it was started over (docs/design/fleet.md,
   * Part 3f, (h)): a child moving without its parent stays that parent's
   * child here (PeerMoveManifest's `linkLineage.remoteParent`), and a thread
   * this computer's agent started there comes back home as its child again
   * (`linkLineage.home`); `keptParent` on the committed answer. Absent: an
   * older server, which would land either as a plain thread, so neither is
   * ever sent to it.
   */
  moveLinkLineage: Schema.optional(Schema.Boolean),
  /**
   * Takes back the threads a moving thread's agent started here over this
   * link as that thread's children (docs/design/fleet.md, Part 3f, (g)):
   * PeerMoveManifest's `startedThere`, and `adopted` on the committed answer.
   * Absent: an older server, which keeps them apart, so it is never sent the
   * list.
   */
  moveAdoptsChildren: Schema.optional(Schema.Boolean),
  /**
   * Says how the caller's threads here are filed (`filing` on `thread` watch
   * events) and takes `peer.thread.wrap`. Absent: an older server that can't.
   */
  threadFiling: Schema.optional(Schema.Boolean),
  /**
   * Takes the caller's outside agents (`peer.outside.*`, docs/design/assistants.md,
   * "Other computers"). Absent: an older server that can't.
   */
  outsideAgents: Schema.optional(Schema.Boolean),
});
export type PeerDescriptor = typeof PeerDescriptor.Type;

// ----- requests -------------------------------------------------------------------------

/** The thread that asked, on the calling computer. */
export const PeerRequestParent = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: TrimmedNonEmptyString,
  threadId: ThreadId,
  threadTitle: TrimmedNonEmptyString,
  /** The asking agent's name ("Codex"). */
  handle: TrimmedNonEmptyString,
});
export type PeerRequestParent = typeof PeerRequestParent.Type;

export const PeerStartInput = Schema.Struct({
  requestId: ChildRequestId,
  parent: PeerRequestParent,
  projectKey: TrimmedNonEmptyString,
  /** The project's folder in the repository; absent: an older caller, the key alone decides. */
  projectSubdirectory: Schema.optional(Schema.String),
  workspace: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("worktree"),
      /** A branch the caller pushed; absent: this computer's default branch. */
      branch: Schema.optional(TrimmedNonEmptyString),
    }),
    Schema.Struct({ kind: Schema.Literal("local") }),
  ]),
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  agent: Schema.Struct({
    instanceId: TrimmedNonEmptyString,
    model: Schema.optional(TrimmedNonEmptyString),
    options: Schema.optional(ProviderOptionSelections),
  }),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  reportBack: Schema.Boolean,
  runSetup: Schema.optional(Schema.Boolean),
});
export type PeerStartInput = typeof PeerStartInput.Type;

export const PeerStartResult = Schema.Struct({
  status: Schema.Literals(["started", "awaiting_approval", "refused", "cancelled"]),
  threadId: Schema.optional(ThreadId),
  reason: Schema.optional(Schema.String),
  /** Where it works, in words for the caller's agent ("started from main; your unpushed changes are not there"). */
  workspaceNote: Schema.optional(Schema.String),
});
export type PeerStartResult = typeof PeerStartResult.Type;

export const PeerSendInput = Schema.Struct({
  requestId: ChildRequestId,
  threadId: ThreadId,
  text: TrimmedNonEmptyString,
});
export type PeerSendInput = typeof PeerSendInput.Type;

export const PeerSendResult = Schema.Struct({
  status: Schema.Literals(["queued", "refused", "cancelled"]),
  reason: Schema.optional(Schema.String),
});
export type PeerSendResult = typeof PeerSendResult.Type;

/**
 * Take a request back. With `stopThread`, the thread it started (or the one
 * a send went to) is stopped too if it is still working: the asking computer
 * may never have heard that thread's id, so this computer finds it from the
 * request. Answered only once both are durably done.
 */
export const PeerCancelInput = Schema.Struct({
  requestId: ChildRequestId,
  stopThread: Schema.optional(Schema.Boolean),
});
export type PeerCancelInput = typeof PeerCancelInput.Type;

export const PeerCancelResult = Schema.Struct({
  status: Schema.Literals(["cancelled", "already_settled"]),
});
export type PeerCancelResult = typeof PeerCancelResult.Type;

export const PeerThreadInput = Schema.Struct({ threadId: ThreadId });
export type PeerThreadInput = typeof PeerThreadInput.Type;

export const PeerThreadStopResult = Schema.Struct({
  status: Schema.Literals(["stopped", "not_running", "not_yours"]),
});
export type PeerThreadStopResult = typeof PeerThreadStopResult.Type;

/**
 * The caller's user wrapped up or reopened a thread its link started here,
 * from the caller's sidebar. Stored with the caller's stamp, so both
 * computers weigh the same word.
 */
export const PeerThreadWrapInput = Schema.Struct({
  threadId: ThreadId,
  override: OrchestrationThreadDoneOverride,
});
export type PeerThreadWrapInput = typeof PeerThreadWrapInput.Type;

export const PeerThreadWrapResult = Schema.Struct({
  status: Schema.Literals(["ok", "not_yours"]),
});
export type PeerThreadWrapResult = typeof PeerThreadWrapResult.Type;

export const PeerThreadReadInput = Schema.Struct({
  threadId: ThreadId,
  after: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  /** Read this one message from `offset` (thread_read's `messageId`). An older server ignores both. */
  messageId: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.Number),
});
export type PeerThreadReadInput = typeof PeerThreadReadInput.Type;

export const PeerThreadListResult = Schema.Struct({
  threads: Schema.Array(AgentThreadSummary),
});
export type PeerThreadListResult = typeof PeerThreadListResult.Type;

// ----- watch ------------------------------------------------------------------------------

/** A request's place in the child computer's ledger. */
export const PeerRequestStatus = Schema.Literals([
  "received",
  "awaiting_approval",
  "queued",
  "running",
  "awaiting_background",
  "answered",
  "failed",
  "stopped",
  "cancelled",
  "denied",
  "expired",
]);
export type PeerRequestStatus = typeof PeerRequestStatus.Type;

/**
 * How a request ended there: answered, failed, `stopped` (that computer's
 * user stopped the thread), cancelled (the asking computer took it back),
 * `denied` (its user said no, or the link is off) or `expired` (nobody
 * answered for a day).
 */
export const PeerRequestOutcome = Schema.Literals([
  "answered",
  "failed",
  "stopped",
  "cancelled",
  "denied",
  "expired",
]);
export type PeerRequestOutcome = typeof PeerRequestOutcome.Type;

/**
 * What `peer.watch` streams: a request moved on (`status`), a request ended
 * (`report`, kept and replayed on every connect until `peer.report.ack`), or
 * a thread the caller started changed (`thread`). On connect it first sends
 * every open request's status and every unacked report, then the state of
 * each thread the caller asked about (`PeerWatchInput.threads`), then `synced`.
 */
export const PeerWatchEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("status"),
    requestId: ChildRequestId,
    threadId: Schema.NullOr(ThreadId),
    status: PeerRequestStatus,
    updatedAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("report"),
    reportId: TrimmedNonEmptyString,
    requestId: ChildRequestId,
    /** The thread the request ran in, only when that thread exists there. */
    threadId: Schema.NullOr(ThreadId),
    outcome: PeerRequestOutcome,
    /** The answer, or what went wrong, for the asking agent. */
    text: Schema.String,
    turnId: Schema.NullOr(TrimmedNonEmptyString),
    error: Schema.optional(TrimmedNonEmptyString),
    settledAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("thread"),
    threadId: ThreadId,
    title: TrimmedNonEmptyString,
    status: AgentThreadStatusWord,
    updatedAt: IsoDateTime,
    /** How it is filed here. Absent: an older server. */
    filing: Schema.optional(RemoteThreadFiling),
  }),
  Schema.Struct({ type: Schema.Literal("synced") }),
]);
export type PeerWatchEvent = typeof PeerWatchEvent.Type;

/**
 * What the caller holds of this computer's threads it started: their state now
 * is sent on connect, after the reports and before `synced`. Absent: an older
 * caller, which hears only changes.
 */
export const PeerWatchInput = Schema.Struct({
  threads: Schema.optional(Schema.Array(ThreadId)),
});
export type PeerWatchInput = typeof PeerWatchInput.Type;

export const PeerReportAckInput = Schema.Struct({
  reportId: TrimmedNonEmptyString,
  /**
   * The answer was written into the parent for its agent, not dropped (by
   * Stop, a wrap, an archive, or an agent that left): the thread here records
   * its answering turn as handed back. Absent: an older caller; nothing is
   * recorded.
   */
  delivered: Schema.optional(Schema.Boolean),
});
export type PeerReportAckInput = typeof PeerReportAckInput.Type;

// ----- moving a thread here (docs/design/fleet.md, Part 3) ---------------------------------

/**
 * One piece of a move's payload: a slice of one byte stream, described by
 * where it sits and its hash. `bundle` is the git bundle of the commits the
 * remote doesn't have, `diff` the tracked changes (`git diff --binary`),
 * `file` one untracked file, `attachment` one message attachment, `session`
 * one file of the agent's own session (PeerMoveManifest.session; only to a
 * computer that says `moveNativeSession`).
 */
export const PeerMovePart = Schema.Struct({
  kind: Schema.Literals(["bundle", "diff", "file", "attachment", "session"]),
  offset: NonNegativeInt,
  length: NonNegativeInt,
  sha256: TrimmedNonEmptyString,
  /**
   * `file`: its path from the repository root, `/`-separated. `session`: its
   * path in the agent's home on the sending computer, `/`-separated; the
   * receiving computer only reads it to tell the files apart, and names
   * every file it writes itself.
   */
  path: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.optional(Schema.Literals(["file", "executable", "symlink"])),
  /** `attachment`: the id the moved messages use for it on the sending computer. */
  attachmentId: Schema.optional(TrimmedNonEmptyString),
  /**
   * `session`: a room agent's session (PeerMoveRoom), by its id in the
   * manifest. Absent: the thread's own agent's. Only to a computer that
   * says `moveRooms`.
   */
  participantId: Schema.optional(ThreadParticipantId),
});
export type PeerMovePart = typeof PeerMovePart.Type;

/**
 * A moved thread's agent session: which driver wrote it (`claudeAgent`,
 * `codex`, `pi`), the CLI version when known, and the driver's own resume
 * cursor as the sending computer had it. Only a receiving agent of the same
 * driver takes it; the driver checks the cursor's shape and computes every
 * path from it.
 */
export const PeerMoveSession = Schema.Struct({
  driver: TrimmedNonEmptyString,
  cliVersion: Schema.optional(TrimmedNonEmptyString),
  cursor: Schema.Unknown,
});
export type PeerMoveSession = typeof PeerMoveSession.Type;

/** At most this much of a moved thread's state, encoded (PeerMoveThreadState). */
export const PEER_MOVE_STATE_MAX_BYTES = 2 * 1024 * 1024;
/** At most this many of each kind of thing a moved thread's state carries. */
export const PEER_MOVE_STATE_MAX_QUEUED = 50;
export const PEER_MOVE_STATE_MAX_CHECK_BACKS = 50;
export const PEER_MOVE_STATE_MAX_PLANS = 100;
export const PEER_MOVE_STATE_MAX_PULL_REQUESTS = 50;
/** At most this many agents in a moved room, those who left and guests included. */
export const PEER_MOVE_ROOM_MAX_PARTICIPANTS = 16;

/**
 * What a moved thread had going (docs/design/fleet.md, Part 3e), with the
 * sending computer's ids: only to a computer that says `moveThreadState`.
 * `goal.pickUp`: it was working when the move stopped its agent, so it is
 * picked up there. Check-backs travel as what the agent is told to set again.
 * Queued messages are the user's own; their attachments are `attachment`
 * parts. `plansLeftBehind`: older plans past the limit that stayed.
 */
export const PeerMoveThreadState = Schema.Struct({
  goal: Schema.optional(
    Schema.Struct({
      objective: TrimmedNonEmptyString,
      status: ThreadGoalStatus,
      tokenBudget: Schema.NullOr(NonNegativeInt),
      tokensUsed: NonNegativeInt,
      timeUsedSeconds: NonNegativeInt,
      createdAt: IsoDateTime,
      updatedAt: IsoDateTime,
      checks: Schema.optional(NonNegativeInt),
      lastCheck: Schema.optional(TrimmedNonEmptyString),
      pickUp: Schema.Boolean,
      /** A room's: the agent that held the goal (a room agent's id in the manifest). Absent: the thread's own. */
      participantId: Schema.optional(ThreadParticipantId),
    }),
  ),
  checkBacks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        scheduledFor: IsoDateTime,
        recurring: Schema.Boolean,
        exact: Schema.Boolean,
        schedule: Schema.optional(TrimmedNonEmptyString),
        cron: Schema.optional(TrimmedNonEmptyString),
        description: Schema.optional(TrimmedNonEmptyString),
        prompt: Schema.optional(TrimmedNonEmptyString),
        durable: Schema.Boolean,
        /** A room agent's (its id in the manifest). Absent: the thread's own agent's. */
        participantId: Schema.optional(ThreadParticipantId),
      }),
    ),
  ),
  pullRequests: Schema.optional(
    Schema.Struct({
      autoFix: Schema.Boolean,
      autoMerge: Schema.NullOr(PullRequestMergeMethod),
      linked: Schema.Array(
        Schema.Struct({
          number: PositiveInt,
          url: TrimmedNonEmptyString,
          autoFix: Schema.Boolean,
          autoMerge: Schema.NullOr(PullRequestMergeMethod),
        }),
      ),
    }),
  ),
  queuedFollowUps: Schema.optional(
    Schema.Array(
      Schema.Struct({
        messageId: MessageId,
        text: Schema.String,
        attachments: Schema.Array(ChatAttachment),
        skills: Schema.optional(ChatSkillReferenceList),
        composer: Schema.optional(MessageComposer),
        sentFrom: Schema.optional(MessageSentFrom),
        interactionMode: ProviderInteractionMode,
        createdAt: IsoDateTime,
        /** For a room agent (its id in the manifest). Absent: the thread's own agent. */
        participantId: Schema.optional(ThreadParticipantId),
      }),
    ),
  ),
  proposedPlans: Schema.optional(Schema.Array(OrchestrationProposedPlan)),
  plansLeftBehind: Schema.optional(NonNegativeInt),
});
export type PeerMoveThreadState = typeof PeerMoveThreadState.Type;

/** Where a moved thread came from, as both kinds of manifest say it. */
const PeerMoveSource = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: TrimmedNonEmptyString,
  threadId: ThreadId,
});

/**
 * One agent of a moved room (docs/design/fleet.md, Part 3f, (i)), with the
 * sending computer's id: its record (those who left and guests included, so
 * old messages keep their author), the driver and model it ran there, and
 * the receiving computer's agent it moves as. Absent `agent`: it doesn't come
 * (left out, or no match there), so it arrives as having left. `session`:
 * its own carried session, whose files are the `session` parts naming it.
 */
export const PeerMoveRoomParticipant = Schema.Struct({
  id: ThreadParticipantId,
  handle: TrimmedNonEmptyString,
  role: Schema.optional(RoomAgentRole),
  joinedAt: IsoDateTime,
  leftAt: Schema.NullOr(IsoDateTime),
  guest: Schema.optional(Schema.Boolean),
  source: Schema.Struct({ driver: Schema.String, model: Schema.String }),
  agent: Schema.optional(ModelSelection),
  session: Schema.optional(PeerMoveSession),
  sessionOmitted: Schema.optional(Schema.Literal("too_large")),
  /**
   * The last of the moved messages its own session saw (the sender's id), so
   * a carried session is caught up on the rest. Absent: not known.
   */
  seenThroughMessageId: Schema.optional(MessageId),
});
export type PeerMoveRoomParticipant = typeof PeerMoveRoomParticipant.Type;

/** A moved room: its agents, and the user's name for the thread's own agent. */
export const PeerMoveRoom = Schema.Struct({
  agentRole: Schema.optional(RoomAgentRole),
  participants: Schema.Array(PeerMoveRoomParticipant),
  /** See PeerMoveRoomParticipant.seenThroughMessageId, for the thread's own agent. */
  ownAgentSeenThroughMessageId: Schema.optional(MessageId),
});
export type PeerMoveRoom = typeof PeerMoveRoom.Type;

/** A moved thread's own history, as both kinds of manifest carry it. */
const PeerMoveThread = Schema.Struct({
  title: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  messages: Schema.Array(ThreadImportMessage),
  activities: Schema.Array(OrchestrationThreadActivity),
  /** What it had going: see PeerMoveThreadState. Absent: nothing, or an older sender. */
  state: Schema.optional(PeerMoveThreadState),
  /** A room: see PeerMoveRoom. Only to a computer that says `moveRooms`. */
  room: Schema.optional(PeerMoveRoom),
  /**
   * Its agents outside work still limits (OrchestrationOutsideWork; null
   * `participantId`: its own agent). Only to a computer that says `moveOutsideWork`.
   */
  outsideWork: Schema.optional(Schema.Array(OrchestrationOutsideWork)),
});

/** At most this many threads a moved family's manifest names as staying behind. */
export const PEER_MOVE_FAMILY_MAX_STAYED = 100;

/**
 * A thread that moves with its family (docs/design/fleet.md, Part 3f, (g)),
 * with the sending computer's ids. Only to a computer that says
 * `moveFamilies`. The receiving computer names every id from its own link and
 * `id`, never from these alone: `parentThreadId` lands the thread under the
 * parent that came in the same family, `sharesCheckoutOf` puts it in the
 * folder that member's move makes (it carries no files of its own). On a
 * parent: the children that stayed on the sending computer, the ones its
 * agent started on other computers (they stay there), and how many of its
 * waits "Stop and move now" ended.
 */
export const PeerMoveFamily = Schema.Struct({
  id: ThreadMoveFamilyId,
  parentThreadId: Schema.optional(ThreadId),
  /** The parent's turn that started it there. */
  parentTurnId: Schema.optional(TurnId),
  sharesCheckoutOf: Schema.optional(ThreadId),
  stayed: Schema.optional(Schema.Array(Schema.Struct({ title: TrimmedNonEmptyString }))),
  remoteStayed: Schema.optional(
    Schema.Array(Schema.Struct({ label: TrimmedNonEmptyString, title: TrimmedNonEmptyString })),
  ),
  childRequestsStopped: Schema.optional(PositiveInt),
});
export type PeerMoveFamily = typeof PeerMoveFamily.Type;

/**
 * The threads a parent moving without its family (docs/design/fleet.md, Part
 * 3f, (g)) had its agent start on computers other than the receiving one: they
 * stay there, and the "Moved here" line says so. A family move carries them
 * in `PeerMoveFamily.remoteStayed` instead. Words only; the receiving computer
 * acts on none of it. At most PEER_MOVE_FAMILY_MAX_STAYED.
 */
export const PeerMoveStartedElsewhere = Schema.Struct({
  label: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
});
export type PeerMoveStartedElsewhere = typeof PeerMoveStartedElsewhere.Type;

/** At most this many threads a manifest names as started on the receiving computer. */
export const PEER_MOVE_MAX_STARTED_THERE = 50;

/**
 * A thread the moving thread's agent started on the receiving computer
 * (docs/design/fleet.md, Part 3f, (g), "Also when the child's computer is
 * the target"), by the receiving computer's own id, as the sending
 * computer's records hold it (RemoteChildThread), with the user's Wrap up or
 * Reopen given on the sending computer. Only to a computer that says
 * `moveAdoptsChildren`. The receiving computer takes back only the threads
 * its own records also name as started over this link by this thread.
 */
export const PeerMoveStartedThere = Schema.Struct({
  threadId: ThreadId,
  override: Schema.optional(OrchestrationThreadDoneOverride),
});
export type PeerMoveStartedThere = typeof PeerMoveStartedThere.Type;

/**
 * A thread moving across the link its work came over (docs/design/fleet.md,
 * Part 3f, (h)), with the sending computer's ids. Only to a computer that
 * says `moveLinkLineage`, and never with `family`. Exactly one of:
 *
 * - `remoteParent`: a child moving without its parent, which stays on the
 *   sending computer. The receiving computer may land it as that parent's
 *   child across the link: it writes the link and the computer itself
 *   (`remoteOrigin`), from the link the move came over and only when that
 *   link's computer is pinned; the sender names only its own thread.
 * - `home`: a thread an agent on the receiving computer started on the
 *   sending one, coming back. The receiving computer lands it under
 *   `parentThreadId` only when its own records already hold this very
 *   thread, on the sending computer, as that parent's child. `fromThreadId`
 *   names the receiving computer's thread it moved over from, when it did:
 *   one whose move to the sending computer is still waiting for its answer
 *   there (it came back before that computer heard) lands under its parent
 *   too, and that move completes.
 *
 * Neither is ever trusted beyond that: anything else lands as a thread of
 * its own.
 */
export const PeerMoveLinkLineage = Schema.Struct({
  remoteParent: Schema.optional(
    Schema.Struct({ threadId: ThreadId, title: TrimmedNonEmptyString }),
  ),
  home: Schema.optional(
    Schema.Struct({ parentThreadId: ThreadId, fromThreadId: Schema.optional(ThreadId) }),
  ),
});
export type PeerMoveLinkLineage = typeof PeerMoveLinkLineage.Type;

/**
 * A General Chats thread moving here (docs/design/fleet.md, Part 3e, (d)):
 * no project to match and no git; its folder's files are the `file` parts,
 * by their paths in the folder. Only to a computer that says
 * `moveGeneralChats`: an older one can't decode it.
 */
export const PeerMoveScratchManifest = Schema.Struct({
  workspace: Schema.Literal("scratch"),
  totalBytes: NonNegativeInt,
  sha256: TrimmedNonEmptyString,
  parts: Schema.Array(PeerMovePart),
  source: PeerMoveSource,
  project: Schema.Struct({ title: TrimmedNonEmptyString }),
  thread: PeerMoveThread,
  agent: ModelSelection,
  summary: Schema.Struct({
    messageCount: NonNegativeInt,
    files: NonNegativeInt,
  }),
  session: Schema.optional(PeerMoveSession),
  sessionOmitted: Schema.optional(Schema.Literal("too_large")),
  /** It moves with its family: see PeerMoveFamily. */
  family: Schema.optional(PeerMoveFamily),
  /** It moves across the link its work came over: see PeerMoveLinkLineage. */
  linkLineage: Schema.optional(PeerMoveLinkLineage),
  /** The threads its agent started there: see PeerMoveStartedThere. */
  startedThere: Schema.optional(Schema.Array(PeerMoveStartedThere)),
  /** The threads its agent started on other computers: see PeerMoveStartedElsewhere. */
  startedElsewhere: Schema.optional(Schema.Array(PeerMoveStartedElsewhere)),
});
export type PeerMoveScratchManifest = typeof PeerMoveScratchManifest.Type;

/** What a moved thread in a git checkout brings and how to rebuild it here. */
export const PeerMoveGitManifest = Schema.Struct({
  totalBytes: NonNegativeInt,
  sha256: TrimmedNonEmptyString,
  parts: Schema.Array(PeerMovePart),
  source: PeerMoveSource,
  project: Schema.Struct({
    canonicalKey: TrimmedNonEmptyString,
    /** The project's folder in the repository ("" at the root); absent from older senders. */
    subdirectory: Schema.optional(Schema.String),
    title: TrimmedNonEmptyString,
  }),
  git: Schema.Struct({
    headSha: TrimmedNonEmptyString,
    /** Null: a detached head. */
    branch: Schema.NullOr(TrimmedNonEmptyString),
    /** The commit the bundle starts after; null when there is no bundle (nothing unpushed). */
    baseSha: Schema.NullOr(TrimmedNonEmptyString),
    /**
     * The branch on the project's remote that `branch` tracks there, so the
     * branch made here tracks it too. Absent: it tracks none, or an older sender.
     */
    upstreamBranch: Schema.optional(TrimmedNonEmptyString),
  }),
  thread: PeerMoveThread,
  /** The agent to run it with here, by this computer's instance id. */
  agent: ModelSelection,
  summary: Schema.Struct({
    messageCount: NonNegativeInt,
    trackedFiles: NonNegativeInt,
    untrackedFiles: NonNegativeInt,
    unpushedCommits: NonNegativeInt,
  }),
  /**
   * The agent's own session, carried so it resumes where it was
   * (docs/design/fleet.md, Part 3d): its files are the `session` parts.
   * Absent: the agent gets a summary of the conversation.
   */
  session: Schema.optional(PeerMoveSession),
  /** Why no session came although one could have: it was too large to send. */
  sessionOmitted: Schema.optional(Schema.Literal("too_large")),
  /**
   * It moves with its family: see PeerMoveFamily. With `sharesCheckoutOf` it
   * has no bundle, diff or files, and `git` says where that folder stands.
   */
  family: Schema.optional(PeerMoveFamily),
  /** It moves across the link its work came over: see PeerMoveLinkLineage. */
  linkLineage: Schema.optional(PeerMoveLinkLineage),
  /** The threads its agent started there: see PeerMoveStartedThere. */
  startedThere: Schema.optional(Schema.Array(PeerMoveStartedThere)),
  /** The threads its agent started on other computers: see PeerMoveStartedElsewhere. */
  startedElsewhere: Schema.optional(Schema.Array(PeerMoveStartedElsewhere)),
});
export type PeerMoveGitManifest = typeof PeerMoveGitManifest.Type;

/**
 * What a moved thread brings and how to rebuild it here: from a git
 * checkout, or (only to a computer that says `moveGeneralChats`) a General
 * Chats folder. Every manifest an older computer sends, or stored, is the
 * first.
 */
export const PeerMoveManifest = Schema.Union([PeerMoveGitManifest, PeerMoveScratchManifest]);
export type PeerMoveManifest = typeof PeerMoveManifest.Type;

/** Whether a manifest is a General Chats thread's (no git). */
export const isScratchMoveManifest = (
  manifest: PeerMoveManifest,
): manifest is PeerMoveScratchManifest => "workspace" in manifest;

/**
 * Asked before a thread with pull request switches moves here: whether
 * GitHub is signed in for the project, so the dialog can warn
 * (docs/design/fleet.md, Part 3e, (c)). Only of a computer that says
 * `moveThreadState`.
 */
export const PeerMoveReadinessInput = Schema.Struct({ canonicalKey: TrimmedNonEmptyString });
export type PeerMoveReadinessInput = typeof PeerMoveReadinessInput.Type;
export const PeerMoveReadinessResult = Schema.Struct({
  /** Absent: it couldn't tell. */
  gitHubReady: Schema.optional(Schema.Boolean),
});
export type PeerMoveReadinessResult = typeof PeerMoveReadinessResult.Type;

/**
 * `staged_awaiting_approval` (docs/design/fleet.md, Part 3c): every byte is
 * here and the import waits for this computer's user. Only a caller that
 * asked for `stagedApproval` at prepare is ever answered with it; its bytes
 * flow (as `receiving`) while the user hasn't answered yet.
 */
export const PeerMoveStatus = Schema.Literals([
  "awaiting_approval",
  "receiving",
  "staged_awaiting_approval",
  "importing",
  "committed",
  "aborted",
]);
export type PeerMoveStatus = typeof PeerMoveStatus.Type;

/**
 * Why a move was refused at prepare, beside its `reason`. `busy`: this
 * computer is taking as many moves as it takes at once; nothing was
 * recorded, so offering it again later is welcome. `staging_full`: this
 * computer holds as many moves waiting for its user's Allow as it holds; a
 * final answer. Callers that don't know a code read the refusal as v1 did.
 */
export const PeerMoveRefusalCode = Schema.Literals(["busy", "staging_full"]);
export type PeerMoveRefusalCode = typeof PeerMoveRefusalCode.Type;

/** Why a move held for this computer's user was dropped (PeerMoveState.abortCode). */
export const PeerMoveAbortCode = Schema.Literals(["denied", "expired"]);
export type PeerMoveAbortCode = typeof PeerMoveAbortCode.Type;

/** Where a move stands here: every `peer.move.*` call answers with it. */
export const PeerMoveState = Schema.Struct({
  status: PeerMoveStatus,
  bytesReceived: NonNegativeInt,
  /** `committed`: the thread it became here. */
  threadId: Schema.optional(ThreadId),
  /** `aborted`: why, for the user on the sending computer. */
  reason: Schema.optional(TrimmedNonEmptyString),
  /** `aborted` at prepare: what kind of refusal it is (PeerMoveRefusalCode). */
  refusalCode: Schema.optional(PeerMoveRefusalCode),
  /**
   * `aborted` while it waited for this computer's user: `denied` (Don't
   * allow) or `expired` (nobody allowed it in time). Absent: dropped for
   * another reason, or an older server.
   */
  abortCode: Schema.optional(PeerMoveAbortCode),
  /**
   * `committed`: it landed as the child of the thread that started it on the
   * calling computer, across this link (PeerMoveLinkLineage `remoteParent`),
   * so that thread can still reach it here. Absent: it is a thread of its
   * own here, or an older server.
   */
  keptParent: Schema.optional(Schema.Literal(true)),
  /**
   * `committed`: the threads named in `startedThere` that became its
   * children here, by their ids here (the calling computer's
   * RemoteChildThread ids). Read from this computer's threads, so a retried
   * call answers the same. Absent: none, or an older server.
   */
  adopted: Schema.optional(Schema.Array(ThreadId)),
});
export type PeerMoveState = typeof PeerMoveState.Type;

export const PeerMovePrepareInput = Schema.Struct({
  transferId: ThreadMoveId,
  manifest: PeerMoveManifest,
  /**
   * The caller reads `staged_awaiting_approval` and `refusalCode`: under Ask
   * first, send the bytes now and let the import wait for Allow. Absent: an
   * older caller, answered exactly as before.
   */
  stagedApproval: Schema.optional(Schema.Boolean),
});
export type PeerMovePrepareInput = typeof PeerMovePrepareInput.Type;

/** At most this much decoded data per chunk. */
export const PEER_MOVE_CHUNK_MAX_BYTES = 1024 * 1024;

export const PeerMoveChunkInput = Schema.Struct({
  transferId: ThreadMoveId,
  offset: NonNegativeInt,
  /** Base64. */
  data: Schema.String,
});
export type PeerMoveChunkInput = typeof PeerMoveChunkInput.Type;

export const PeerMoveInput = Schema.Struct({ transferId: ThreadMoveId });
export type PeerMoveInput = typeof PeerMoveInput.Type;

// ----- outside agents across computers (docs/design/assistants.md, "Other computers") -----

/**
 * An agent connected on the asking computer, as that computer names it and
 * what it may do there now. Shown to this computer's user when it asks; on
 * every call, this computer never lets it do more than this.
 */
export const PeerOutsideAgent = Schema.Struct({
  connectionId: OutsideAgentConnectionId,
  name: TrimmedNonEmptyString,
  givenName: Schema.NullOr(TrimmedNonEmptyString),
  assistant: Schema.NullOr(KnownAssistant),
  kind: OutsideAgentConnectionKind,
  access: OutsideAgentAccess,
  maxRuntimeMode: RuntimeMode,
});
export type PeerOutsideAgent = typeof PeerOutsideAgent.Type;

/** `allowed`: it may use this computer already; `asked`: this computer's user was asked. */
export const PeerOutsideAskResult = Schema.Struct({
  status: Schema.Literals(["allowed", "asked"]),
});
export type PeerOutsideAskResult = typeof PeerOutsideAskResult.Type;

export const PeerOutsideStatusInput = Schema.Struct({
  connectionIds: Schema.Array(OutsideAgentConnectionId),
});
export type PeerOutsideStatusInput = typeof PeerOutsideStatusInput.Type;

/** Each asked-about agent this computer let in or was asked about; one it never heard of is left out. */
export const PeerOutsideStatusResult = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      connectionId: OutsideAgentConnectionId,
      state: Schema.Literals(["allowed", "asked"]),
      access: Schema.optional(OutsideAgentAccess),
      maxRuntimeMode: Schema.optional(RuntimeMode),
      /** Null: all projects here. */
      projectCount: Schema.optional(Schema.NullOr(NonNegativeInt)),
    }),
  ),
});
export type PeerOutsideStatusResult = typeof PeerOutsideStatusResult.Type;

export const PeerOutsideForgetInput = Schema.Struct({ connectionId: OutsideAgentConnectionId });
export type PeerOutsideForgetInput = typeof PeerOutsideForgetInput.Type;

/**
 * One of the outside agents' tools, run here for an agent connected on the
 * asking computer. `input` is the tool's parameters and `result` its answer,
 * both as the tool's own schema encodes them; this computer decodes `input`
 * with that schema and never takes a `computer` in it (no hops).
 */
export const PeerOutsideCallInput = Schema.Struct({
  agent: PeerOutsideAgent,
  tool: TrimmedNonEmptyString,
  input: Schema.Unknown,
});
export type PeerOutsideCallInput = typeof PeerOutsideCallInput.Type;

/** `refused`: this computer doesn't let that agent in (or not that tool); `detail` says why. */
export const PeerOutsideCallResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("ok"), result: Schema.Unknown }),
  Schema.Struct({ outcome: Schema.Literal("refused"), detail: TrimmedNonEmptyString }),
]);
export type PeerOutsideCallResult = typeof PeerOutsideCallResult.Type;

export class PeerRpcError extends Schema.TaggedError<PeerRpcError>()("PeerRpcError", {
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const PEER_METHODS = {
  describe: "peer.describe",
  requestStart: "peer.request.start",
  requestSend: "peer.request.send",
  requestCancel: "peer.request.cancel",
  threadStop: "peer.thread.stop",
  threadWrap: "peer.thread.wrap",
  threadRead: "peer.thread.read",
  threadList: "peer.thread.list",
  watch: "peer.watch",
  reportAck: "peer.report.ack",
  unlink: "peer.unlink",
  movePrepare: "peer.move.prepare",
  moveChunk: "peer.move.chunk",
  moveFinish: "peer.move.finish",
  moveStatus: "peer.move.status",
  moveAbort: "peer.move.abort",
  moveReadiness: "peer.move.readiness",
  outsideAsk: "peer.outside.ask",
  outsideStatus: "peer.outside.status",
  outsideForget: "peer.outside.forget",
  outsideCall: "peer.outside.call",
} as const;

/** Ask this computer's user to let an agent connected on the asking computer use this one too. */
export const PeerOutsideAskRpc = Rpc.make(PEER_METHODS.outsideAsk, {
  payload: PeerOutsideAgent,
  success: PeerOutsideAskResult,
  error: PeerRpcError,
});

export const PeerOutsideStatusRpc = Rpc.make(PEER_METHODS.outsideStatus, {
  payload: PeerOutsideStatusInput,
  success: PeerOutsideStatusResult,
  error: PeerRpcError,
});

/** The agent was removed on the asking computer, or its user took this computer away from it. */
export const PeerOutsideForgetRpc = Rpc.make(PEER_METHODS.outsideForget, {
  payload: PeerOutsideForgetInput,
  error: PeerRpcError,
});

export const PeerOutsideCallRpc = Rpc.make(PEER_METHODS.outsideCall, {
  payload: PeerOutsideCallInput,
  success: PeerOutsideCallResult,
  error: PeerRpcError,
});

export const PeerDescribeRpc = Rpc.make(PEER_METHODS.describe, {
  payload: Schema.Struct({ caller: PeerCaller }),
  success: PeerDescriptor,
  error: PeerRpcError,
});

export const PeerRequestStartRpc = Rpc.make(PEER_METHODS.requestStart, {
  payload: PeerStartInput,
  success: PeerStartResult,
  error: PeerRpcError,
});

export const PeerRequestSendRpc = Rpc.make(PEER_METHODS.requestSend, {
  payload: PeerSendInput,
  success: PeerSendResult,
  error: PeerRpcError,
});

export const PeerRequestCancelRpc = Rpc.make(PEER_METHODS.requestCancel, {
  payload: PeerCancelInput,
  success: PeerCancelResult,
  error: PeerRpcError,
});

export const PeerThreadStopRpc = Rpc.make(PEER_METHODS.threadStop, {
  payload: PeerThreadInput,
  success: PeerThreadStopResult,
  error: PeerRpcError,
});

export const PeerThreadWrapRpc = Rpc.make(PEER_METHODS.threadWrap, {
  payload: PeerThreadWrapInput,
  success: PeerThreadWrapResult,
  error: PeerRpcError,
});

export const PeerThreadReadRpc = Rpc.make(PEER_METHODS.threadRead, {
  payload: PeerThreadReadInput,
  success: AgentThreadReadResult,
  error: PeerRpcError,
});

export const PeerThreadListRpc = Rpc.make(PEER_METHODS.threadList, {
  payload: Schema.Struct({}),
  success: PeerThreadListResult,
  error: PeerRpcError,
});

export const PeerWatchRpc = Rpc.make(PEER_METHODS.watch, {
  payload: PeerWatchInput,
  success: PeerWatchEvent,
  error: PeerRpcError,
  stream: true,
});

export const PeerReportAckRpc = Rpc.make(PEER_METHODS.reportAck, {
  payload: PeerReportAckInput,
  error: PeerRpcError,
});

/**
 * The asking computer removed its link. `stopRunning`: the threads it started
 * here that still run are stopped too. `reverse`: an unlink of both
 * directions, so this computer also forgets its own link back to the asking
 * one (whose access there goes in the same unlink). Older callers send neither.
 */
export const PeerUnlinkInput = Schema.Struct({
  stopRunning: Schema.optional(Schema.Boolean),
  reverse: Schema.optional(Schema.Boolean),
});
export type PeerUnlinkInput = typeof PeerUnlinkInput.Type;

export const PeerUnlinkRpc = Rpc.make(PEER_METHODS.unlink, {
  payload: PeerUnlinkInput,
  error: PeerRpcError,
});

/** Offer a thread to move here. Ask first holds it for this computer's user. */
export const PeerMovePrepareRpc = Rpc.make(PEER_METHODS.movePrepare, {
  payload: PeerMovePrepareInput,
  success: PeerMoveState,
  error: PeerRpcError,
});

/** The next slice of the payload; only `offset == bytesReceived` is written. */
export const PeerMoveChunkRpc = Rpc.make(PEER_METHODS.moveChunk, {
  payload: PeerMoveChunkInput,
  success: PeerMoveState,
  error: PeerRpcError,
});

/** Every byte is here: check it and start the import. */
export const PeerMoveFinishRpc = Rpc.make(PEER_METHODS.moveFinish, {
  payload: PeerMoveInput,
  success: PeerMoveState,
  error: PeerRpcError,
});

export const PeerMoveStatusRpc = Rpc.make(PEER_METHODS.moveStatus, {
  payload: PeerMoveInput,
  success: PeerMoveState,
  error: PeerRpcError,
});

/** Drop the move: answers `aborted`, or `committed` when it already landed. */
export const PeerMoveAbortRpc = Rpc.make(PEER_METHODS.moveAbort, {
  payload: PeerMoveInput,
  success: PeerMoveState,
  error: PeerRpcError,
});

/** Whether the project's pull requests can be watched here (docs/design/fleet.md, Part 3e). */
export const PeerMoveReadinessRpc = Rpc.make(PEER_METHODS.moveReadiness, {
  payload: PeerMoveReadinessInput,
  success: PeerMoveReadinessResult,
  error: PeerRpcError,
});

export const PeerRpcGroup = RpcGroup.make(
  PeerDescribeRpc,
  PeerRequestStartRpc,
  PeerRequestSendRpc,
  PeerRequestCancelRpc,
  PeerThreadStopRpc,
  PeerThreadWrapRpc,
  PeerThreadReadRpc,
  PeerThreadListRpc,
  PeerWatchRpc,
  PeerReportAckRpc,
  PeerUnlinkRpc,
  PeerMovePrepareRpc,
  PeerMoveChunkRpc,
  PeerMoveFinishRpc,
  PeerMoveStatusRpc,
  PeerMoveAbortRpc,
  PeerMoveReadinessRpc,
  PeerOutsideAskRpc,
  PeerOutsideStatusRpc,
  PeerOutsideForgetRpc,
  PeerOutsideCallRpc,
);

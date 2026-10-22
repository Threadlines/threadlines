import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  ChildRequestId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  ThreadMoveId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ComputerLinkAccess } from "./links.ts";
import { ProviderOptionSelections } from "./model.ts";
import {
  ModelSelection,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadImportMessage,
} from "./orchestration.ts";

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
      clipped: Schema.optional(Schema.Boolean),
      streaming: Schema.optional(Schema.Boolean),
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
    }),
  ),
  /** Models left off a long list; thread_agents with this `instanceId` lists them all. */
  moreModels: Schema.optional(Schema.Number),
});
export type AgentThreadAgent = typeof AgentThreadAgent.Type;

// ----- peer.describe ----------------------------------------------------------------

/** The asking computer, as it introduces itself (shown to the user; never trusted for access). */
export const PeerCaller = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
});
export type PeerCaller = typeof PeerCaller.Type;

export const PeerAgent = Schema.Struct({
  ...AgentThreadAgent.fields,
  /** The provider kind (`codex`, `claudeAgent`, ...), to pick the caller's kind by default. */
  driver: Schema.String,
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

export const PeerThreadReadInput = Schema.Struct({
  threadId: ThreadId,
  after: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
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
 * every open request's status and every unacked report, then `synced`.
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
  }),
  Schema.Struct({ type: Schema.Literal("synced") }),
]);
export type PeerWatchEvent = typeof PeerWatchEvent.Type;

export const PeerReportAckInput = Schema.Struct({ reportId: TrimmedNonEmptyString });
export type PeerReportAckInput = typeof PeerReportAckInput.Type;

// ----- moving a thread here (docs/design/fleet.md, Part 3) ---------------------------------

/**
 * One piece of a move's payload: a slice of one byte stream, described by
 * where it sits and its hash. `bundle` is the git bundle of the commits the
 * remote doesn't have, `diff` the tracked changes (`git diff --binary`),
 * `file` one untracked file, `attachment` one message attachment.
 */
export const PeerMovePart = Schema.Struct({
  kind: Schema.Literals(["bundle", "diff", "file", "attachment"]),
  offset: NonNegativeInt,
  length: NonNegativeInt,
  sha256: TrimmedNonEmptyString,
  /** `file`: its path from the repository root, `/`-separated. */
  path: Schema.optional(TrimmedNonEmptyString),
  mode: Schema.optional(Schema.Literals(["file", "executable", "symlink"])),
  /** `attachment`: the id the moved messages use for it on the sending computer. */
  attachmentId: Schema.optional(TrimmedNonEmptyString),
});
export type PeerMovePart = typeof PeerMovePart.Type;

/** What a moved thread brings and how to rebuild it here. */
export const PeerMoveManifest = Schema.Struct({
  totalBytes: NonNegativeInt,
  sha256: TrimmedNonEmptyString,
  parts: Schema.Array(PeerMovePart),
  source: Schema.Struct({
    environmentId: EnvironmentId,
    environmentLabel: TrimmedNonEmptyString,
    threadId: ThreadId,
  }),
  project: Schema.Struct({
    canonicalKey: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
  }),
  git: Schema.Struct({
    headSha: TrimmedNonEmptyString,
    /** Null: a detached head. */
    branch: Schema.NullOr(TrimmedNonEmptyString),
    /** The commit the bundle starts after; null when there is no bundle (nothing unpushed). */
    baseSha: Schema.NullOr(TrimmedNonEmptyString),
  }),
  thread: Schema.Struct({
    title: TrimmedNonEmptyString,
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    messages: Schema.Array(ThreadImportMessage),
    activities: Schema.Array(OrchestrationThreadActivity),
  }),
  /** The agent to run it with here, by this computer's instance id. */
  agent: ModelSelection,
  summary: Schema.Struct({
    messageCount: NonNegativeInt,
    trackedFiles: NonNegativeInt,
    untrackedFiles: NonNegativeInt,
    unpushedCommits: NonNegativeInt,
  }),
});
export type PeerMoveManifest = typeof PeerMoveManifest.Type;

export const PeerMoveStatus = Schema.Literals([
  "awaiting_approval",
  "receiving",
  "importing",
  "committed",
  "aborted",
]);
export type PeerMoveStatus = typeof PeerMoveStatus.Type;

/** Where a move stands here: every `peer.move.*` call answers with it. */
export const PeerMoveState = Schema.Struct({
  status: PeerMoveStatus,
  bytesReceived: NonNegativeInt,
  /** `committed`: the thread it became here. */
  threadId: Schema.optional(ThreadId),
  /** `aborted`: why, for the user on the sending computer. */
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type PeerMoveState = typeof PeerMoveState.Type;

export const PeerMovePrepareInput = Schema.Struct({
  transferId: ThreadMoveId,
  manifest: PeerMoveManifest,
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
} as const;

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
  payload: Schema.Struct({}),
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

export const PeerRpcGroup = RpcGroup.make(
  PeerDescribeRpc,
  PeerRequestStartRpc,
  PeerRequestSendRpc,
  PeerRequestCancelRpc,
  PeerThreadStopRpc,
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
);

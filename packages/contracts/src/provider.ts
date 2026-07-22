import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
  ChatSkillReferenceList,
  ModelSelection,
  OrchestrationMessageRole,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
  ThreadBootstrapCreateThread,
} from "./orchestration.ts";
import { ProviderInstanceId, ProviderDriverKind } from "./providerInstance.ts";

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderSession = Schema.Struct({
  provider: ProviderDriverKind,
  // Optional during the driver/instance migration. Once every producer
  // populates it (post-slice-4), routing flips to instance-id-only and the
  // legacy `provider` field is removed.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

/**
 * One entry in a {@link ThreadContextSeed} — either a verbatim conversation
 * message or a compact tool-action summary. Carried oldest-first.
 */
export const ThreadContextSeedEntry = Schema.Struct({
  kind: Schema.Literals(["message", "tool"]),
  // Present for `kind === "message"`; identifies the speaker.
  role: Schema.optional(OrchestrationMessageRole),
  // Verbatim message text, or the tool activity's summary line. May be empty
  // on decode (the builder filters empties); kept permissive so partial seeds
  // round-trip without validation churn.
  text: Schema.String,
});
export type ThreadContextSeedEntry = typeof ThreadContextSeedEntry.Type;

/**
 * `ThreadContextSeed` — provider-agnostic conversation rehydration payload.
 *
 * Built from the orchestration transcript (not from any adapter-owned
 * `resumeCursor`) so a thread can hand off to a *different* driver mid-thread.
 * The new adapter renders this into a priming preamble when it starts a fresh
 * session without native resume.
 *
 * Fidelity is tiered: recent turns are verbatim in `entries`, older history is
 * optionally compacted into `olderSummary`, and the shared working tree is
 * referenced (not embedded) via `workspacePointer`.
 */
export const ThreadContextSeed = Schema.Struct({
  version: Schema.Literal(1),
  // Driver the conversation is being handed off *from*, for orientation copy.
  fromProvider: ProviderDriverKind,
  // LLM-compacted (or truncation-marked) summary of older history elided from
  // `entries`. Absent when the full recent history fit the budget.
  olderSummary: Schema.optional(TrimmedNonEmptyString),
  // Recent verbatim entries (messages + tool summaries), oldest-first.
  entries: Schema.Array(ThreadContextSeedEntry),
  // One-line orientation pointing the new provider at the shared working tree.
  workspacePointer: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadContextSeed = typeof ThreadContextSeed.Type;

/**
 * `ProviderSessionForkFrom` — same-driver native fork request.
 *
 * Opens the new session as a provider-side fork of another thread's persisted
 * history instead of seeding a fresh session from the transcript. Requires the
 * source thread to live in the same provider instance (same provider home).
 */
export const ProviderSessionForkFrom = Schema.Struct({
  providerThreadId: TrimmedNonEmptyString,
  // Preferred exact boundary for replacing a user prompt: exclude this turn
  // and everything after it. Never sent together with `lastTurnId`.
  beforeTurnId: Schema.optional(TrimmedNonEmptyString),
  // Stable fallback boundary: copy history through this turn, inclusive.
  // Absent boundaries mean fork the full history.
  lastTurnId: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSessionForkFrom = typeof ProviderSessionForkFrom.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  /** External imports require the selected native thread to resume exactly;
   *  normal recovery keeps the historical fallback-to-fresh behavior. */
  resumePolicy: Schema.optional(Schema.Literals(["fallback", "required"])),
  // Cross-driver handoff: provider-agnostic conversation rehydration used when
  // there is no native `resumeCursor` for the target driver. Adapters inject it
  // as a priming preamble on the first turn.
  contextSeed: Schema.optional(ThreadContextSeed),
  // Same-driver native fork of another thread's provider history. Mutually
  // exclusive with `resumeCursor`; callers fall back to `contextSeed` seeding
  // when the fork cannot be honored.
  forkFrom: Schema.optional(ProviderSessionForkFrom),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  messageId: Schema.optional(MessageId),
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  skills: Schema.optional(ChatSkillReferenceList),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
  telemetryContext: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal("thread_fork"),
      // How the forked session was seeded: provider-side history fork or
      // budgeted transcript preamble.
      seedMode: Schema.optional(Schema.Literals(["provider-native", "context-seed"])),
      sourceModelSelection: Schema.optional(ModelSelection),
      includedMessageCount: NonNegativeInt,
      includedToolSummaryCount: NonNegativeInt,
      includedAttachmentCount: NonNegativeInt,
      omittedAttachmentCount: NonNegativeInt,
    }),
  ),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderSteerTurnInput = Schema.Struct({
  threadId: ThreadId,
  expectedTurnId: TurnId,
  messageId: Schema.optional(MessageId),
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  skills: Schema.optional(ChatSkillReferenceList),
});
export type ProviderSteerTurnInput = typeof ProviderSteerTurnInput.Type;

export const ProviderReviewDelivery = Schema.Literals(["inline", "detached"]);
export type ProviderReviewDelivery = typeof ProviderReviewDelivery.Type;

export const ProviderReviewTarget = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("uncommittedChanges"),
  }),
  Schema.Struct({
    type: Schema.Literal("baseBranch"),
    branch: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("commit"),
    sha: TrimmedNonEmptyString,
    title: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  }),
  Schema.Struct({
    type: Schema.Literal("custom"),
    instructions: TrimmedNonEmptyString,
  }),
]);
export type ProviderReviewTarget = typeof ProviderReviewTarget.Type;

export const ProviderStartReviewInput = Schema.Struct({
  threadId: ThreadId,
  target: ProviderReviewTarget,
  delivery: Schema.optional(ProviderReviewDelivery),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  bootstrap: Schema.optional(ThreadBootstrapCreateThread),
});
export type ProviderStartReviewInput = typeof ProviderStartReviewInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderStartReviewResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
  reviewThreadId: TrimmedNonEmptyString,
  delivery: ProviderReviewDelivery,
});
export type ProviderStartReviewResult = typeof ProviderStartReviewResult.Type;

export class ProviderStartReviewError extends Schema.TaggedErrorClass<ProviderStartReviewError>()(
  "ProviderStartReviewError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProviderExternalThreadSource = Schema.Literals([
  "cli",
  "vscode",
  "exec",
  "appServer",
  "unknown",
]);
export type ProviderExternalThreadSource = typeof ProviderExternalThreadSource.Type;

export const ProviderExternalThreadStatus = Schema.Literals([
  "notLoaded",
  "idle",
  "active",
  "systemError",
]);
export type ProviderExternalThreadStatus = typeof ProviderExternalThreadStatus.Type;

/** One root Codex conversation discovered in a provider instance's own home. */
export const ProviderExternalThreadCandidate = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerThreadId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  source: ProviderExternalThreadSource,
  name: Schema.NullOr(TrimmedNonEmptyString),
  preview: Schema.String,
  cwd: TrimmedNonEmptyString,
  cliVersion: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  status: ProviderExternalThreadStatus,
  canImport: Schema.Boolean,
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  /** Present when this native session is already attached to a Threadlines thread. */
  linkedThreadId: Schema.optional(ThreadId),
});
export type ProviderExternalThreadCandidate = typeof ProviderExternalThreadCandidate.Type;

export const ProviderExternalThreadListInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
  cursor: Schema.optional(TrimmedNonEmptyString),
  searchTerm: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(NonNegativeInt),
});
export type ProviderExternalThreadListInput = typeof ProviderExternalThreadListInput.Type;

export const ProviderExternalThreadListResult = Schema.Struct({
  data: Schema.Array(ProviderExternalThreadCandidate),
  nextCursor: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderExternalThreadListResult = typeof ProviderExternalThreadListResult.Type;

export const ProviderExternalThreadTranscriptMessage = Schema.Struct({
  providerItemId: TrimmedNonEmptyString,
  providerTurnId: TrimmedNonEmptyString,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type ProviderExternalThreadTranscriptMessage =
  typeof ProviderExternalThreadTranscriptMessage.Type;

/** Server-internal compatibility/read result used to backfill an import. */
export const ProviderExternalThreadSnapshot = Schema.Struct({
  candidate: ProviderExternalThreadCandidate,
  messages: Schema.Array(ProviderExternalThreadTranscriptMessage),
});
export type ProviderExternalThreadSnapshot = typeof ProviderExternalThreadSnapshot.Type;

export const ProviderExternalThreadImportInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  providerThreadId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
});
export type ProviderExternalThreadImportInput = typeof ProviderExternalThreadImportInput.Type;

export const ProviderExternalThreadImportResult = Schema.Struct({
  threadId: ThreadId,
  importedMessageCount: NonNegativeInt,
});
export type ProviderExternalThreadImportResult = typeof ProviderExternalThreadImportResult.Type;

export class ProviderExternalThreadError extends Schema.TaggedErrorClass<ProviderExternalThreadError>()(
  "ProviderExternalThreadError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProviderSubagentTranscriptInput = Schema.Struct({
  threadId: ThreadId,
  /** Provider-side subagent id — for Claude this is the task id backing the
   *  spawned agent's transcript file. */
  agentId: TrimmedNonEmptyString,
  limit: Schema.optional(NonNegativeInt),
});
export type ProviderSubagentTranscriptInput = typeof ProviderSubagentTranscriptInput.Type;

/** One renderable step of a subagent's nested conversation, mapped
 *  provider-side from the raw transcript. */
export const ProviderSubagentTranscriptEntry = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "system", "thinking"]),
  text: Schema.String,
  toolUses: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      summary: Schema.String,
    }),
  ),
  outputPreview: Schema.optional(Schema.String),
});
export type ProviderSubagentTranscriptEntry = typeof ProviderSubagentTranscriptEntry.Type;

export const ProviderSubagentTranscriptResult = Schema.Struct({
  entries: Schema.Array(ProviderSubagentTranscriptEntry),
  truncated: Schema.Boolean,
});
export type ProviderSubagentTranscriptResult = typeof ProviderSubagentTranscriptResult.Type;

export class ProviderSubagentTranscriptError extends Schema.TaggedErrorClass<ProviderSubagentTranscriptError>()(
  "ProviderSubagentTranscriptError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderRealtimeAudioChunk = Schema.Struct({
  data: Schema.String,
  sampleRate: NonNegativeInt,
  numChannels: NonNegativeInt,
  samplesPerChannel: Schema.optional(NonNegativeInt),
  itemId: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderRealtimeAudioChunk = typeof ProviderRealtimeAudioChunk.Type;

export const ProviderRealtimeOutputModality = Schema.Literals(["audio", "text"]);
export type ProviderRealtimeOutputModality = typeof ProviderRealtimeOutputModality.Type;

export const ProviderRealtimeStartInput = Schema.Struct({
  threadId: ThreadId,
  outputModality: Schema.optional(ProviderRealtimeOutputModality),
});
export type ProviderRealtimeStartInput = typeof ProviderRealtimeStartInput.Type;

export const ProviderRealtimeStopInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderRealtimeStopInput = typeof ProviderRealtimeStopInput.Type;

export const ProviderRealtimeAppendAudioInput = Schema.Struct({
  threadId: ThreadId,
  audio: ProviderRealtimeAudioChunk,
});
export type ProviderRealtimeAppendAudioInput = typeof ProviderRealtimeAppendAudioInput.Type;

export const ProviderRealtimeListVoicesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderRealtimeListVoicesInput = typeof ProviderRealtimeListVoicesInput.Type;

export const ProviderRealtimeVoicesList = Schema.Struct({
  v1: Schema.Array(TrimmedNonEmptyString),
  v2: Schema.Array(TrimmedNonEmptyString),
  defaultV1: TrimmedNonEmptyString,
  defaultV2: TrimmedNonEmptyString,
});
export type ProviderRealtimeVoicesList = typeof ProviderRealtimeVoicesList.Type;

export const ProviderRealtimeListVoicesResult = Schema.Struct({
  voices: ProviderRealtimeVoicesList,
});
export type ProviderRealtimeListVoicesResult = typeof ProviderRealtimeListVoicesResult.Type;

export class ProviderRealtimeError extends Schema.TaggedErrorClass<ProviderRealtimeError>()(
  "ProviderRealtimeError",
  {
    message: TrimmedNonEmptyString,
  },
) {}

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderDriverKind,
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  providerThreadId: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;

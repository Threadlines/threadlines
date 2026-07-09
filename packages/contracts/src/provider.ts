import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  ChatAttachment,
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

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderDriverKind),
  // See ProviderSession for the migration story.
  providerInstanceId: Schema.optional(ProviderInstanceId),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  resumeCursor: Schema.optional(Schema.Unknown),
  // Cross-driver handoff: provider-agnostic conversation rehydration used when
  // there is no native `resumeCursor` for the target driver. Adapters inject it
  // as a priming preamble on the first turn.
  contextSeed: Schema.optional(ThreadContextSeed),
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
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
  telemetryContext: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal("thread_fork"),
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
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

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

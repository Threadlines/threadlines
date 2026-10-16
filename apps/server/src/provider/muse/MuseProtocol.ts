/**
 * The Muse Session Protocol payloads the driver acts on, decoded at the wire
 * boundary, and the pure mappings from Muse's vocabulary to Threadlines'.
 *
 * Muse's enums are open (new values arrive as plain strings) and unknown
 * fields are ignored, so these schemas are permissive: they hold only what the
 * adapter reads.
 *
 * @module provider/muse/MuseProtocol
 */
import type { CanonicalRequestType, ProviderApprovalDecision } from "@threadlines/contracts";
import * as Schema from "effect/Schema";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));
const Count = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

export const MuseTokenUsage = Schema.Struct({
  inputTokens: Schema.optional(Count),
  outputTokens: Schema.optional(Count),
  cachedTokens: Schema.optional(Count),
  reasoningTokens: Schema.optional(Count),
  cacheReadTokens: Schema.optional(Count),
  cacheWriteTokens: Schema.optional(Count),
});
export type MuseTokenUsage = typeof MuseTokenUsage.Type;

export const MuseOutputRef = Schema.Struct({
  id: NonEmptyString,
  availability: Schema.optional(Schema.String),
  byteLen: Schema.optional(Count),
  kind: Schema.optional(Schema.String),
  mediaType: Schema.optional(Schema.String),
});
export type MuseOutputRef = typeof MuseOutputRef.Type;

export const MuseWorkflowChild = Schema.Struct({
  childId: NonEmptyString,
  attempt: Schema.optional(Schema.Number),
  status: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  terminal: Schema.optional(Schema.String),
  failureKind: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.String),
});
export type MuseWorkflowChild = typeof MuseWorkflowChild.Type;

/** One transcript item at one revision (`item/started|updated|completed`). */
export const MuseItem = Schema.Struct({
  itemId: NonEmptyString,
  kind: NonEmptyString,
  revision: Schema.Number,
  status: NonEmptyString,
  turnId: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.Array(Schema.String)),
  messagePhase: Schema.optional(Schema.String),
  cutOff: Schema.optional(Schema.Boolean),
  tool: Schema.optional(Schema.String),
  args: Schema.optional(Schema.String),
  callId: Schema.optional(Schema.String),
  visibleOutput: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
  outputRef: Schema.optional(MuseOutputRef),
  patchRef: Schema.optional(MuseOutputRef),
  patchSummary: Schema.optional(Schema.Struct({ files: Count, added: Count, removed: Count })),
  displayLabel: Schema.optional(
    Schema.Struct({ active: Schema.String, done: Schema.String, neutral: Schema.String }),
  ),
  background: Schema.optional(Schema.Boolean),
  failureKind: Schema.optional(Schema.String),
  failureReason: Schema.optional(Schema.String),
  fallbackText: Schema.optional(Schema.String),
  commandText: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
  // subagent
  subagentId: Schema.optional(Schema.String),
  childSessionId: Schema.optional(Schema.String),
  objective: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  agentPath: Schema.optional(Schema.String),
  depth: Schema.optional(Schema.Number),
  controlStatus: Schema.optional(Schema.String),
  result: Schema.optional(
    Schema.Struct({
      summary: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
    }),
  ),
  usage: Schema.optional(MuseTokenUsage),
  // workflow
  workflowRunId: Schema.optional(Schema.String),
  entryId: Schema.optional(Schema.String),
  children: Schema.optional(Schema.Array(MuseWorkflowChild)),
  finalSummary: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  // compaction
  outcome: Schema.optional(Schema.String),
  trigger: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
export type MuseItem = typeof MuseItem.Type;

export const MuseItemEvent = Schema.Struct({ sessionId: NonEmptyString, item: MuseItem });

export const MuseItemDelta = Schema.Struct({
  sessionId: NonEmptyString,
  itemId: NonEmptyString,
  delta: Schema.String,
  field: Schema.optional(Schema.String),
});

export const MuseApprovalChoice = Schema.Struct({
  choiceId: NonEmptyString,
  decision: NonEmptyString,
  label: Schema.String,
  scope: Schema.String,
  acceptsFeedback: Schema.optional(Schema.Boolean),
});
export type MuseApprovalChoice = typeof MuseApprovalChoice.Type;

export const MuseRequirementRef = Schema.Struct({
  approvalId: NonEmptyString,
  sourceIndex: Schema.Number,
});
export type MuseRequirementRef = typeof MuseRequirementRef.Type;

/** One part of a compound shell command; Muse asks about each part in turn. */
export const MuseApprovalStage = Schema.Struct({
  requirementId: MuseRequirementRef,
  position: Schema.optional(Schema.Number),
  totalStages: Schema.optional(Schema.Number),
  argv: Schema.optional(Schema.Array(Schema.String)),
});

export const MuseApprovalSubject = Schema.Struct({
  kind: Schema.String,
  access: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  host: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Number),
  target: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  workspaceRoot: Schema.optional(Schema.String),
  stages: Schema.optional(Schema.Array(MuseApprovalStage)),
});
export type MuseApprovalSubject = typeof MuseApprovalSubject.Type;

/** `approval/request` and `approval/requested` carry the same full payload. */
export const MuseApproval = Schema.Struct({
  approvalId: NonEmptyString,
  sessionId: NonEmptyString,
  turnId: Schema.optional(Schema.String),
  itemId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  rawArgs: Schema.optional(Schema.String),
  protectedWrite: Schema.optional(Schema.Boolean),
  judgeEscalated: Schema.optional(Schema.Boolean),
  subagentOrigin: Schema.optional(
    Schema.Struct({
      subagentId: Schema.optional(Schema.String),
      childSessionId: Schema.optional(Schema.String),
      childRunId: Schema.optional(Schema.String),
    }),
  ),
  currentRequirementId: MuseRequirementRef,
  availableChoices: Schema.Array(MuseApprovalChoice),
  subject: MuseApprovalSubject,
});
export type MuseApproval = typeof MuseApproval.Type;

/** `approval/updated`: the refreshed pending view (a new stage brings a new requirement). */
export const MuseApprovalUpdate = Schema.Struct({
  approvalId: NonEmptyString,
  sessionId: NonEmptyString,
  currentRequirementId: MuseRequirementRef,
  availableChoices: Schema.Array(MuseApprovalChoice),
  subject: MuseApprovalSubject,
});

export const MuseApprovalResolved = Schema.Struct({
  approvalId: NonEmptyString,
  sessionId: NonEmptyString,
  decision: Schema.String,
  resolvedBy: Schema.optional(Schema.String),
});

export const MuseUserInputQuestion = Schema.Struct({
  id: NonEmptyString,
  header: Schema.String,
  question: Schema.String,
  options: Schema.Array(
    Schema.Struct({ label: Schema.String, description: Schema.optional(Schema.String) }),
  ),
  selection: Schema.Struct({
    mode: Schema.String,
    minSelections: Schema.optional(Schema.Number),
    maxSelections: Schema.optional(Schema.Number),
  }),
});
export type MuseUserInputQuestion = typeof MuseUserInputQuestion.Type;

export const MuseUserInput = Schema.Struct({
  userInputId: NonEmptyString,
  sessionId: NonEmptyString,
  turnId: Schema.optional(Schema.String),
  questions: Schema.Array(MuseUserInputQuestion),
});
export type MuseUserInput = typeof MuseUserInput.Type;

export const MuseUserInputSettled = Schema.Struct({
  userInputId: NonEmptyString,
  sessionId: NonEmptyString,
  outcome: Schema.optional(Schema.String),
});

export const MuseTurnStarted = Schema.Struct({
  sessionId: NonEmptyString,
  turnId: NonEmptyString,
  commandId: Schema.optional(Schema.String),
});

export const MuseTurnError = Schema.Struct({
  kind: Schema.String,
  message: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
  quota: Schema.optional(
    Schema.Struct({ limitKind: Schema.optional(Schema.String), resetsAtMs: Schema.Number }),
  ),
});
export type MuseTurnError = typeof MuseTurnError.Type;

export const MuseTurnCompleted = Schema.Struct({
  sessionId: NonEmptyString,
  turnId: NonEmptyString,
  terminal: NonEmptyString,
  reason: Schema.optional(Schema.String),
  error: Schema.optional(MuseTurnError),
  usage: Schema.optional(MuseTokenUsage),
});
export type MuseTurnCompleted = typeof MuseTurnCompleted.Type;

export const MuseTurnUnqueued = Schema.Struct({
  sessionId: NonEmptyString,
  turnId: NonEmptyString,
});

/**
 * `turn/foregroundCompleted`: the turn's visible work is done, but background
 * reminder checks hold it open until `turn/completed`.
 */
export const MuseTurnForegroundCompleted = Schema.Struct({
  sessionId: NonEmptyString,
  turnId: NonEmptyString,
});

export const MuseTurnRetry = Schema.Struct({
  sessionId: NonEmptyString,
  turnId: NonEmptyString,
  nextAttempt: Schema.optional(Schema.Number),
  maxAttempts: Schema.optional(Schema.Number),
  reason: Schema.optional(Schema.String),
  errorKind: Schema.optional(Schema.String),
  httpStatus: Schema.optional(Schema.Number),
});

export const MuseTokenUsageEvent = Schema.Struct({
  sessionId: NonEmptyString,
  turnId: Schema.optional(Schema.String),
  modelId: Schema.optional(Schema.NullOr(Schema.String)),
  promptTokens: Schema.optional(Count),
  totalTokens: Schema.optional(Count),
  durationMs: Schema.optional(Count),
  usage: MuseTokenUsage,
});

export const MuseContextUsage = Schema.Struct({
  sessionId: NonEmptyString,
  usedTokens: Count,
  windowTokens: Schema.optional(Count),
});

export const MuseTodoList = Schema.Struct({
  sessionId: NonEmptyString,
  items: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      status: Schema.String,
      activeForm: Schema.optional(Schema.String),
    }),
  ),
});

export const MuseViewGap = Schema.Struct({
  sessionId: NonEmptyString,
  after: NonEmptyString,
  next: NonEmptyString,
});

export const MuseSessionClosed = Schema.Struct({
  sessionId: NonEmptyString,
  reason: Schema.optional(Schema.String),
});

export const MuseViewHealth = Schema.Struct({
  sessionId: NonEmptyString,
  health: Schema.String,
  noneReason: Schema.optional(Schema.String),
});

export const MuseModelChanged = Schema.Struct({
  sessionId: NonEmptyString,
  modelId: Schema.optional(Schema.NullOr(Schema.String)),
});

/** The session object lifecycle methods return. */
export const MuseSession = Schema.Struct({
  sessionId: NonEmptyString,
  modelId: Schema.optional(Schema.NullOr(Schema.String)),
  activeTurnId: Schema.optional(Schema.NullOr(Schema.String)),
  approvalMode: Schema.optional(Schema.Struct({ mode: Schema.String })),
  permissionState: Schema.optional(
    Schema.Struct({
      profileId: Schema.optional(Schema.String),
      axes: Schema.optional(Schema.Struct({ approval: Schema.optional(Schema.String) })),
    }),
  ),
});
export type MuseSession = typeof MuseSession.Type;

/** `session/start`, `session/resume`, `session/fork` and `session/read` results. */
export const MuseSessionResult = Schema.Struct({
  session: MuseSession,
  viewCursor: Schema.optional(Schema.NullOr(Schema.String)),
  history: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.String),
      noneReason: Schema.optional(Schema.String),
      items: Schema.optional(Schema.NullOr(Schema.Array(MuseItem))),
    }),
  ),
  lastTurn: Schema.optional(
    Schema.Struct({
      turnId: NonEmptyString,
      terminal: Schema.String,
      reason: Schema.optional(Schema.String),
      error: Schema.optional(MuseTurnError),
    }),
  ),
  pendingRequests: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        approvalId: Schema.optional(Schema.String),
        userInputId: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type MuseSessionResult = typeof MuseSessionResult.Type;

export const MuseTurnStartResult = Schema.Struct({
  turnId: NonEmptyString,
  disposition: Schema.optional(Schema.String),
});

export const MuseCompactResult = Schema.Struct({
  status: Schema.String,
  reason: Schema.optional(Schema.String),
});

export const MuseReadOutputResult = Schema.Struct({
  byteLen: Count,
  content: Schema.String,
  encoding: Schema.String,
  eof: Schema.Boolean,
  offsetBytes: Count,
});

/** `usage/read` result member and `usage/changed` params. */
export const MuseSubscriptionUsage = Schema.Struct({
  observedAtMs: Schema.optional(Schema.Number),
  tier: Schema.optional(Schema.String),
  window: Schema.optional(
    Schema.Struct({
      usedPercent: Schema.Number,
      resetsAtMs: Schema.optional(Schema.Number),
      windowDurationMins: Schema.optional(Schema.Number),
    }),
  ),
  weekly: Schema.optional(
    Schema.Struct({ usedPercent: Schema.Number, resetsAtMs: Schema.optional(Schema.Number) }),
  ),
});
export type MuseSubscriptionUsage = typeof MuseSubscriptionUsage.Type;

/** Experimental `account/read` / `account/changed`. */
export const MuseAccountState = Schema.Struct({
  state: Schema.String,
  label: Schema.optional(Schema.String),
  credentialRequired: Schema.optional(Schema.Boolean),
});
export type MuseAccountState = typeof MuseAccountState.Type;

export const MuseModelCatalogEntry = Schema.Struct({
  modelId: NonEmptyString,
  displayLabel: Schema.optional(Schema.String),
  providerId: Schema.optional(Schema.String),
  isDefault: Schema.optional(Schema.Boolean),
  contextLimit: Schema.optional(Schema.NullOr(Schema.Number)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  variants: Schema.optional(Schema.Union([Schema.Array(Schema.String), Schema.String])),
  defaultReasoningEffort: Schema.optional(Schema.String),
  reasoningEffortVariants: Schema.optional(
    Schema.Array(
      Schema.Struct({ tier: Schema.String, description: Schema.optional(Schema.String) }),
    ),
  ),
});
export type MuseModelCatalogEntry = typeof MuseModelCatalogEntry.Type;

export const MuseModelList = Schema.Struct({
  providerId: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  models: Schema.Array(MuseModelCatalogEntry),
});

// ── Mappings ────────────────────────────────────────────────────────────

/** The Threadlines decision one Muse approval choice stands for, if any. */
export function museChoiceDecision(
  choice: Pick<MuseApprovalChoice, "decision" | "scope">,
): ProviderApprovalDecision | undefined {
  switch (choice.decision) {
    case "approved":
      return "accept";
    case "approvedForSession":
      return "acceptForSession";
    case "approvedPolicyAmendment":
      // A saved rule outlives the conversation; only its session-scoped form
      // matches "for this session".
      return choice.scope === "session" ? "acceptForSession" : undefined;
    case "denied":
    case "deniedPolicyAmendment":
      return "decline";
    case "abort":
      return "cancel";
    default:
      return undefined;
  }
}

/**
 * One Muse choice per Threadlines decision, the narrowest scope winning.
 * Muse's shell approvals offer no `denied`, only `abort` ("Reject"), so
 * decline falls back to it.
 */
export function museChoicesByDecision(
  choices: ReadonlyArray<MuseApprovalChoice>,
): ReadonlyMap<ProviderApprovalDecision, MuseApprovalChoice> {
  const byDecision = new Map<ProviderApprovalDecision, MuseApprovalChoice>();
  const rank = (choice: MuseApprovalChoice) =>
    (choice.scope === "once" ? 0 : choice.scope === "session" ? 2 : 4) +
    (choice.decision.endsWith("PolicyAmendment") ? 1 : 0);
  for (const choice of choices) {
    const decision = museChoiceDecision(choice);
    if (!decision) continue;
    const previous = byDecision.get(decision);
    if (!previous || rank(choice) < rank(previous)) byDecision.set(decision, choice);
  }
  const abort = byDecision.get("cancel");
  if (!byDecision.has("decline") && abort) byDecision.set("decline", abort);
  return byDecision;
}

/** The decisions to offer for an approval, in Threadlines' order. */
export function museAvailableDecisions(
  choices: ReadonlyArray<MuseApprovalChoice>,
): ReadonlyArray<ProviderApprovalDecision> {
  const byDecision = museChoicesByDecision(choices);
  return (["accept", "acceptForSession", "decline", "cancel"] as const).filter((decision) =>
    byDecision.has(decision),
  );
}

/** What kind of request an approval subject is. */
export function museRequestType(subject: MuseApprovalSubject): CanonicalRequestType {
  switch (subject.kind) {
    case "shell":
    case "process":
      return "exec_command_approval";
    case "fileAccess":
      return subject.access === "read" ? "file_read_approval" : "file_change_approval";
    case "tool":
      return "dynamic_tool_call";
    default:
      return "permissions_approval";
  }
}

/** The approval's one-line summary, for the card. */
export function museApprovalDetail(approval: MuseApproval): string | undefined {
  const subject = approval.subject;
  // A compound command is asked about part by part: name the part.
  const stages = subject.stages ?? [];
  const stage = stages.find(
    (entry) => entry.requirementId.sourceIndex === approval.currentRequirementId.sourceIndex,
  );
  if (stages.length > 1 && stage?.argv && stage.argv.length > 0) {
    const position = stage.position ?? stages.indexOf(stage) + 1;
    const total = stage.totalStages ?? stages.length;
    return `Step ${position} of ${total}: ${stage.argv.join(" ")}`;
  }
  const detail =
    subject.command ??
    subject.path ??
    (subject.host ? `${subject.host}${subject.port ? `:${subject.port}` : ""}` : undefined) ??
    subject.target ??
    subject.toolName ??
    approval.toolName;
  return detail?.trim() || undefined;
}

/** Item statuses Muse ends an item with that are not success. */
export function museItemFailed(
  item: Pick<MuseItem, "kind" | "status" | "failureKind" | "outcome">,
) {
  if (item.status === "inProgress") return false;
  if (item.status === "completed") {
    if (item.failureKind !== undefined) return true;
    return item.kind === "compaction" && item.outcome !== undefined && item.outcome !== "compacted";
  }
  return true;
}

/** Whether an item's status is a declined approval rather than a failure. */
export function museItemDeclined(item: Pick<MuseItem, "status">) {
  return item.status === "rejected";
}

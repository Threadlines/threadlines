/**
 * Workflow runs: a script an agent wrote that runs many agents in the
 * background, in steps ("phases"). Claude's dynamic workflows are the first
 * provider feature of this shape; nothing here is Claude-specific, so another
 * provider with scripted multi-agent runs reports through the same schemas.
 *
 * A run is reported as a stream of updates. Each update carries only what
 * changed: header fields that are set replace the stored ones, and phases and
 * agents replace the stored entry with the same `index`. The merge lives in
 * `@threadlines/shared/workflowRuns`, so the server's projections and the web
 * store fold updates the same way.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  ThreadParticipantId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * `lost`: the runtime that ran it went away (the server or the provider
 * restarted, the session was replaced) before it reported an end.
 */
export const WorkflowRunStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "stopped",
  "lost",
]);
export type WorkflowRunStatus = typeof WorkflowRunStatus.Type;

/**
 * `queued`: the script asked for the agent but it has not started (the run is
 * at its concurrency limit, or the agent waits for a cache-sharing sibling).
 * `skipped`: stopped on its own, which the script sees as a failure.
 */
export const WorkflowAgentState = Schema.Literals([
  "queued",
  "running",
  "done",
  "failed",
  "skipped",
]);
export type WorkflowAgentState = typeof WorkflowAgentState.Type;

/** A step of the run, in the order the script reached it. */
export const WorkflowPhase = Schema.Struct({
  index: NonNegativeInt,
  title: TrimmedNonEmptyString,
});
export type WorkflowPhase = typeof WorkflowPhase.Type;

/**
 * One agent the script started. Times are epoch milliseconds, as the provider
 * reports them; text fields are previews, clipped by the driver.
 */
export const WorkflowAgent = Schema.Struct({
  /** Stable within the run: the order the script asked for agents in. */
  index: NonNegativeInt,
  /** The script's own name for the agent, e.g. `verify:t3` or a file path. */
  label: TrimmedNonEmptyString,
  /** The phase it belongs to. Absent: the script used no phases. */
  phaseIndex: Schema.optional(NonNegativeInt),
  /** The provider's id for the agent, which names its transcript. Absent
   *  until it starts. */
  agentId: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  state: WorkflowAgentState,
  /** 2 and up after the provider restarted a stalled agent. */
  attempt: Schema.optional(PositiveInt),
  /** Why the last restart happened (`stalled`, `throttled`, ...). */
  retryReason: Schema.optional(TrimmedNonEmptyString),
  queuedAt: Schema.optional(NonNegativeInt),
  startedAt: Schema.optional(NonNegativeInt),
  /** Run time so far, or in total once it ended. */
  durationMs: Schema.optional(NonNegativeInt),
  tokens: Schema.optional(NonNegativeInt),
  toolCalls: Schema.optional(NonNegativeInt),
  /** The newest thing it did: the tool, and a one-line summary of the call. */
  lastToolName: Schema.optional(TrimmedNonEmptyString),
  lastStep: Schema.optional(TrimmedNonEmptyString),
  /** The start of its instructions. Absent when the provider withholds them. */
  instructionsPreview: Schema.optional(TrimmedNonEmptyString),
  /** The start of its answer, once it has one. */
  resultPreview: Schema.optional(TrimmedNonEmptyString),
  error: Schema.optional(TrimmedNonEmptyString),
  /** It ran in its own copy of the repository (`worktree`) or remotely. */
  isolation: Schema.optional(TrimmedNonEmptyString),
});
export type WorkflowAgent = typeof WorkflowAgent.Type;

/**
 * What a driver reports about a run. Every field but `taskId` is optional:
 * absent means unchanged.
 */
export const WorkflowRunUpdate = Schema.Struct({
  /** The provider's background-task id for the run; unique within a thread. */
  taskId: TrimmedNonEmptyString,
  /** The provider's own id for the run's saved state (Claude: `wf_…`). */
  runId: Schema.optional(TrimmedNonEmptyString),
  /** The tool call that launched it. */
  toolCallId: Schema.optional(TrimmedNonEmptyString),
  /** The script's own name, e.g. `grok-build-provider-research`. */
  name: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  status: Schema.optional(WorkflowRunStatus),
  /** Why it ended the way it did, when it was not an ordinary end. */
  statusReason: Schema.optional(TrimmedNonEmptyString),
  /** The provider withholds the script, the agents' instructions and error
   *  text (Claude's built-in workflows): phases read "phase N". */
  hiddenScript: Schema.optional(Schema.Boolean),
  startedAt: Schema.optional(IsoDateTime),
  endedAt: Schema.optional(IsoDateTime),
  totalTokens: Schema.optional(NonNegativeInt),
  totalToolCalls: Schema.optional(NonNegativeInt),
  /** Folder holding the agents' transcripts, as the provider announced it. */
  transcriptDir: Schema.optional(TrimmedNonEmptyString),
  /** The script file the run executes, as the provider announced it. */
  scriptPath: Schema.optional(TrimmedNonEmptyString),
  /** The provider's closing line: its summary, or the error it failed with. */
  summary: Schema.optional(TrimmedNonEmptyString),
  phases: Schema.optional(Schema.Array(WorkflowPhase)),
  agents: Schema.optional(Schema.Array(WorkflowAgent)),
});
export type WorkflowRunUpdate = typeof WorkflowRunUpdate.Type;

/**
 * Who runs it: the agent (in a room) and the provider session it lives in.
 * Stop and transcript reads go to this owner, never to whichever agent holds
 * the thread now.
 */
export const WorkflowRunOwner = Schema.Struct({
  /** Null: the thread's own agent. */
  participantId: Schema.NullOr(ThreadParticipantId),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  /** The provider's conversation id when the run started. */
  providerThreadId: Schema.optional(TrimmedNonEmptyString),
});
export type WorkflowRunOwner = typeof WorkflowRunOwner.Type;

/** An update as orchestration records it: the driver's report plus where it
 *  came from. The owner and turn are only taken from the first update. */
export const OrchestrationWorkflowRunPatch = Schema.Struct({
  ...WorkflowRunUpdate.fields,
  turnId: Schema.optional(Schema.NullOr(TurnId)),
  owner: Schema.optional(WorkflowRunOwner),
});
export type OrchestrationWorkflowRunPatch = typeof OrchestrationWorkflowRunPatch.Type;

/** A run as the thread keeps it. Never capped, like the subagent roster. */
export const OrchestrationWorkflowRun = Schema.Struct({
  taskId: TrimmedNonEmptyString,
  runId: Schema.NullOr(TrimmedNonEmptyString),
  turnId: Schema.NullOr(TurnId),
  toolCallId: Schema.NullOr(TrimmedNonEmptyString),
  owner: WorkflowRunOwner,
  name: Schema.NullOr(TrimmedNonEmptyString),
  description: Schema.NullOr(TrimmedNonEmptyString),
  status: WorkflowRunStatus,
  statusReason: Schema.NullOr(TrimmedNonEmptyString),
  hiddenScript: Schema.Boolean,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  totalTokens: NonNegativeInt,
  totalToolCalls: NonNegativeInt,
  transcriptDir: Schema.NullOr(TrimmedNonEmptyString),
  scriptPath: Schema.NullOr(TrimmedNonEmptyString),
  summary: Schema.NullOr(TrimmedNonEmptyString),
  phases: Schema.Array(WorkflowPhase),
  agents: Schema.Array(WorkflowAgent),
  updatedAt: IsoDateTime,
  /** The event that first recorded the run: where it sits in the transcript
   *  when the call that launched it is gone. */
  eventSequence: Schema.optional(NonNegativeInt),
});
export type OrchestrationWorkflowRun = typeof OrchestrationWorkflowRun.Type;

/**
 * The few facts the sidebar and other thread-list surfaces show about a
 * running workflow, carried on the session's awaited background tasks so they
 * need no thread detail.
 */
export const AwaitedWorkflowProgress = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString),
  /** The phase it is in now. */
  phaseTitle: Schema.optional(TrimmedNonEmptyString),
  /** That phase's agents that ended, of all its agents. Absent without a phase. */
  phaseDoneAgents: Schema.optional(NonNegativeInt),
  phaseTotalAgents: Schema.optional(NonNegativeInt),
  /** The whole run's agents that ended, of all its agents. */
  doneAgents: NonNegativeInt,
  totalAgents: NonNegativeInt,
});
export type AwaitedWorkflowProgress = typeof AwaitedWorkflowProgress.Type;

/**
 * Reading a run's files: its script, or its result once it ended. Only the
 * files the run itself announced are read, from the provider's own folders.
 */
export const WorkflowRunFileKind = Schema.Literals(["script", "result"]);
export type WorkflowRunFileKind = typeof WorkflowRunFileKind.Type;

export const WorkflowReadRunFileInput = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  file: WorkflowRunFileKind,
});
export type WorkflowReadRunFileInput = typeof WorkflowReadRunFileInput.Type;

export const WorkflowReadRunFileResult = Schema.Struct({
  /** Null when there is nothing to show; `unavailableReason` says why. */
  text: Schema.NullOr(Schema.String),
  /** `javascript` for a script; `json`, `markdown` or `text` for a result. */
  format: Schema.Literals(["javascript", "json", "markdown", "text"]),
  truncated: Schema.Boolean,
  /** `no-result`: the run ended (stopped, or in an error) before it had one. */
  unavailableReason: Schema.optional(
    Schema.Literals(["hidden", "missing", "not-ended", "too-large", "unreadable", "no-result"]),
  ),
  /** For `no-result`: the error the run ended in, its message only. */
  error: Schema.optional(Schema.String),
  /** Messages the script logged, for the result. */
  logs: Schema.optional(Schema.Array(Schema.String)),
});
export type WorkflowReadRunFileResult = typeof WorkflowReadRunFileResult.Type;

/** One agent's transcript, read from the run's own folder: it works after a
 *  restart or a provider switch, when no session holds the run any more. */
export const WorkflowReadAgentTranscriptInput = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  agentId: TrimmedNonEmptyString,
  /** Paging, as on ProviderSubagentTranscriptInput. */
  limit: Schema.optional(NonNegativeInt),
  offset: Schema.optional(NonNegativeInt),
  fromEnd: Schema.optional(Schema.Boolean),
});
export type WorkflowReadAgentTranscriptInput = typeof WorkflowReadAgentTranscriptInput.Type;

/**
 * Saving a run's script as a command the provider runs by name in later
 * sessions. `project`: the repository's own workflows folder, shared with
 * everyone who clones it. `personal`: the user's folder, in every project.
 */
export const WorkflowCommandLocation = Schema.Literals(["project", "personal"]);
export type WorkflowCommandLocation = typeof WorkflowCommandLocation.Type;

export const WorkflowSaveCommandInput = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  location: WorkflowCommandLocation,
  /** Replace a saved command of the same name. */
  overwrite: Schema.Boolean,
  /** Only report where it would go, write nothing. */
  dryRun: Schema.optional(Schema.Boolean),
});
export type WorkflowSaveCommandInput = typeof WorkflowSaveCommandInput.Type;

export const WorkflowSaveCommandResult = Schema.Struct({
  /** The command's name: what the user types after `/`. */
  name: TrimmedNonEmptyString,
  /** The file it was (or would be) written to. */
  path: TrimmedNonEmptyString,
  /** `exists`: a command of that name is already there and `overwrite` was off. */
  outcome: Schema.Literals(["saved", "exists", "would-save"]),
});
export type WorkflowSaveCommandResult = typeof WorkflowSaveCommandResult.Type;

export class WorkflowRequestError extends Schema.TaggedError<WorkflowRequestError>()(
  "WorkflowRequestError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

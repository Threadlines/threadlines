import { DEFAULT_NEW_THREAD_RUNTIME_MODE } from "@threadlines/contracts";
import type {
  PullRequestMergeMethod,
  ChatFileAttachmentKind,
  ChatSkillReference,
  EnvironmentId,
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationProposedPlanId,
  RepositoryIdentity,
  OrchestrationSessionStatus,
  OrchestrationThreadActivity,
  OrchestrationSubagent,
  OrchestrationThreadDiffStat,
  OrchestrationThreadDoneOverride,
  OrchestrationQueuedFollowUp,
  OrchestrationThreadLinkedPullRequest,
  OrchestrationThreadGoal,
  OrchestrationSideTurn,
  OrchestrationThreadParticipant,
  ProjectKind,
  ProjectScript as ContractProjectScript,
  ThreadId,
  SideTurnId,
  ThreadParticipantId,
  ProjectId,
  TurnId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  CheckpointRef,
  ProviderInteractionMode,
  RuntimeMode,
} from "@threadlines/contracts";

export type SessionPhase = "disconnected" | "connecting" | "ready" | "running";
/** Composer default; historical wire payloads keep their contract-level fallback. */
export const DEFAULT_COMPOSER_RUNTIME_MODE: RuntimeMode = DEFAULT_NEW_THREAD_RUNTIME_MODE;

export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 180;
export const DEFAULT_THREAD_TERMINAL_ID = "default";
export const MAX_TERMINALS_PER_GROUP = 4;
export type ProjectScript = ContractProjectScript;

export interface ThreadTerminalGroup {
  id: string;
  terminalIds: string[];
}

export interface ChatImageAttachment {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export interface ChatFileAttachment {
  type: "file";
  kind: ChatFileAttachmentKind;
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export type ChatAttachment = ChatImageAttachment | ChatFileAttachment;

export interface ChatMessage {
  id: MessageId;
  eventSequence?: number | undefined;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ChatAttachment[];
  skills?: ChatSkillReference[];
  /** See OrchestrationMessage.participantId. Absent: the thread's own agent. */
  participantId?: ThreadParticipantId | undefined;
  /** See OrchestrationMessage.sideTurnId: part of a side answer. */
  sideTurnId?: SideTurnId | undefined;
  turnId?: TurnId | null;
  createdAt: string;
  completedAt?: string | undefined;
  streaming: boolean;
}

export interface ProposedPlan {
  id: OrchestrationProposedPlanId;
  eventSequence?: number | undefined;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnDiffFileChange {
  path: string;
  kind?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface TurnDiffSummary {
  turnId: TurnId;
  completedAt: string;
  status?: string | undefined;
  files: TurnDiffFileChange[];
  checkpointRef?: CheckpointRef | undefined;
  assistantMessageId?: MessageId | undefined;
  checkpointTurnCount?: number | undefined;
  /** See OrchestrationCheckpointSummary.threadDiffStat. */
  threadDiffStat?: OrchestrationThreadDiffStat | undefined;
}

export interface Project {
  id: ProjectId;
  environmentId: EnvironmentId;
  kind: ProjectKind;
  name: string;
  cwd: string;
  repositoryIdentity?: RepositoryIdentity | null;
  defaultModelSelection: ModelSelection | null;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  scripts: ProjectScript[];
}

export interface Thread {
  id: ThreadId;
  environmentId: EnvironmentId;
  codexThreadId: string | null;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  messages: ChatMessage[];
  proposedPlans: ProposedPlan[];
  error: string | null;
  createdAt: string;
  archivedAt: string | null;
  pinnedAt: string | null;
  /** See ThreadShell.pullRequestAutoFix. */
  pullRequestAutoFix?: boolean;
  /** See ThreadShell.pullRequestAutoMerge. */
  pullRequestAutoMerge?: PullRequestMergeMethod | null;
  /** See ThreadShell.linkedPullRequests. */
  linkedPullRequests?: readonly OrchestrationThreadLinkedPullRequest[];
  /** See ThreadShell.queuedFollowUps. */
  queuedFollowUps?: readonly OrchestrationQueuedFollowUp[];
  /** See ThreadShell.participants. */
  participants?: readonly OrchestrationThreadParticipant[];
  /** See OrchestrationThreadShell.sideTurn: the side answer in progress, if any. */
  sideTurn?: OrchestrationSideTurn | null;
  /** See OrchestrationThreadShell.agentRole: the user's name for the thread's own agent. */
  agentRole?: string | undefined;
  /** See ThreadShell.doneOverride. */
  doneOverride: OrchestrationThreadDoneOverride | null;
  /** See ThreadShell.lastSeenAt. */
  lastSeenAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  pendingSourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
  branch: string | null;
  worktreePath: string | null;
  /**
   * The provider session's observed working directory when it differs from
   * the configured checkout (agent entered a worktree mid-session); null
   * while the session works where the thread was configured to.
   */
  effectiveCwd: string | null;
  /** Long-horizon provider goal attached to this thread (Codex goal mode). */
  goal: OrchestrationThreadGoal | null;
  /** Projected Codex realtime voice-session state. */
  voiceActive?: boolean;
  /**
   * Turn count this thread's cumulative diff starts *after*. Advanced when its
   * checkout is seen with nothing uncommitted, so `turnDiffSummaries` at or
   * below it are already committed away and must not be summed. Absent means 0
   * (count everything).
   */
  diffStatBaselineTurnCount?: number;
  turnDiffSummaries: TurnDiffSummary[];
  activities: OrchestrationThreadActivity[];
  /** Durable identity/settings roster, independent of the rolling activity window. */
  subagents?: OrchestrationSubagent[];
}

export interface ThreadShell {
  id: ThreadId;
  environmentId: EnvironmentId;
  codexThreadId: string | null;
  projectId: ProjectId;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  error: string | null;
  createdAt: string;
  archivedAt: string | null;
  pinnedAt: string | null;
  /**
   * While on, the server watches this thread's pull request and starts a turn
   * when a check fails or a review comment arrives. Absent means off.
   */
  pullRequestAutoFix?: boolean;
  /**
   * How the server merges this thread's pull request once its checks pass,
   * where the host cannot arm that itself. Absent or null means off.
   */
  pullRequestAutoMerge?: PullRequestMergeMethod | null;
  /**
   * Pull requests the agent opened on other branches and linked in this
   * thread, each with its own merge switch. Absent means none.
   */
  linkedPullRequests?: readonly OrchestrationThreadLinkedPullRequest[];
  /**
   * Messages waiting for the running turn to finish, oldest first. The
   * server sends them one turn at a time. Absent means none.
   */
  queuedFollowUps?: readonly OrchestrationQueuedFollowUp[];
  /**
   * Agents added next to the thread's own agent; one or more makes the thread
   * a room. Absent means none.
   */
  participants?: readonly OrchestrationThreadParticipant[];
  /** See OrchestrationThreadShell.sideTurn: the side answer in progress, if any. */
  sideTurn?: OrchestrationSideTurn | null;
  /** See OrchestrationThreadShell.agentRole: the user's name for the thread's own agent. */
  agentRole?: string | undefined;
  /**
   * The user's last explicit Mark done / Reopen, held on the server so every
   * device agrees on the inbox's Active/Wrapped split. Null when never filed.
   */
  doneOverride: OrchestrationThreadDoneOverride | null;
  /** When the user last saw this thread, server-held. Null until first seen. */
  lastSeenAt: string | null;
  updatedAt?: string | undefined;
  branch: string | null;
  worktreePath: string | null;
  /** See Thread.effectiveCwd. */
  effectiveCwd: string | null;
  /** See Thread.goal. */
  goal: OrchestrationThreadGoal | null;
  /** See Thread.voiceActive. */
  voiceActive?: boolean;
  /** See Thread.diffStatBaselineTurnCount. */
  diffStatBaselineTurnCount?: number;
}

export interface ThreadTurnState {
  latestTurn: OrchestrationLatestTurn | null;
  pendingSourceProposedPlan?: OrchestrationLatestTurn["sourceProposedPlan"];
}

export interface SidebarThreadSummary {
  id: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title: string;
  interactionMode: ProviderInteractionMode;
  session: ThreadSession | null;
  createdAt: string;
  archivedAt: string | null;
  pinnedAt: string | null;
  /** See ThreadShell.doneOverride. */
  doneOverride: OrchestrationThreadDoneOverride | null;
  /** See ThreadShell.lastSeenAt. */
  lastSeenAt: string | null;
  updatedAt?: string | undefined;
  latestTurn: OrchestrationLatestTurn | null;
  branch: string | null;
  worktreePath: string | null;
  /** See Thread.effectiveCwd. */
  effectiveCwd: string | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasBlockingUserInput?: boolean;
  hasActionableProposedPlan: boolean;
  /**
   * What this thread changed, summed over its own turns. Null until a turn has
   * reported files. Not the checkout's working tree: threads sharing a checkout
   * each get their own number.
   */
  cumulativeDiffStat: OrchestrationThreadDiffStat | null;
  /** See ThreadShell.linkedPullRequests; wrap-up waits on these too. */
  linkedPullRequests?: readonly OrchestrationThreadLinkedPullRequest[];
  /** See ThreadShell.participants; the inbox marks rooms and names who is working. */
  participants?: readonly OrchestrationThreadParticipant[];
  /** See OrchestrationThreadShell.sideTurn: the side answer in progress, if any. */
  sideTurn?: OrchestrationSideTurn | null;
  /** See OrchestrationThreadShell.agentRole: the user's name for the thread's own agent. */
  agentRole?: string | undefined;
  /** In a room, the model of the agent working or last at work; null otherwise. */
  roomSlotModelSelection?: ModelSelection | null;
  /** The user's name for that agent, if any. */
  roomSlotRole?: string | null;
  /** The model of the agent answering on the side; null when nobody is. */
  roomSideModelSelection?: ModelSelection | null;
  /** The user's name for the agent answering on the side, if any. */
  roomSideRole?: string | null;
}

export interface ThreadSession {
  provider: ProviderDriverKind;
  providerInstanceId?: ProviderInstanceId | undefined;
  providerSessionId?: string | undefined;
  providerThreadId?: string | undefined;
  status: SessionPhase | "error" | "closed";
  /**
   * Checkout the live runtime was started in. Differs from the thread's
   * `worktreePath` while a checkout switch is queued for the next turn; unlike
   * `Thread.effectiveCwd` it never reflects a cwd the agent moved itself to.
   */
  checkoutCwd?: string | undefined;
  /** In a room, the agent holding the session slot. Absent: the thread's own agent. */
  participantId?: ThreadParticipantId | undefined;
  activeTurnId?: TurnId | undefined;
  /** Background tasks still running, dev servers included. */
  pendingBackgroundTaskCount?: number | undefined;
  /** The pending tasks the agent will wake up for. What the UI shows as waiting. */
  awaitedBackgroundTaskCount?: number | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
}

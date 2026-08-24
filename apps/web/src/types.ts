import { DEFAULT_NEW_THREAD_RUNTIME_MODE } from "@threadlines/contracts";
import type {
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
  OrchestrationThreadGoal,
  ProjectKind,
  ProjectScript as ContractProjectScript,
  ThreadId,
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
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: ChatAttachment[];
  skills?: ChatSkillReference[];
  turnId?: TurnId | null;
  createdAt: string;
  completedAt?: string | undefined;
  streaming: boolean;
}

export interface ProposedPlan {
  id: OrchestrationProposedPlanId;
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
  hasActionableProposedPlan: boolean;
  /**
   * What this thread changed, summed over its own turns. Null until a turn has
   * reported files. Not the checkout's working tree: threads sharing a checkout
   * each get their own number.
   */
  cumulativeDiffStat: OrchestrationThreadDiffStat | null;
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
  activeTurnId?: TurnId | undefined;
  pendingBackgroundTaskCount?: number | undefined;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  orchestrationStatus: OrchestrationSessionStatus;
}

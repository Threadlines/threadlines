import {
  type OrchestrationAgentPage,
  type OrchestrationCheckBack,
  type OrchestrationWorkflowRun,
  type OrchestrationCommandRequest,
  type ApprovalRequestId,
  type ChatSkillReference,
  DEFAULT_MODEL,
  MAX_TERMINAL_REUSE_IDS,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type MessageId,
  type MessageComposer,
  type ModelSelection,
  type ProjectScript,
  type ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  type ServerProvider,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  SideTurnId,
  type ThreadId,
  type ThreadParticipantId,
  type TurnId,
  type KeybindingCommand,
  type OrchestrationQueuedFollowUp,
  type OrchestrationThreadGoal,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  ProviderDriverKind,
  RuntimeMode,
  RuntimeTaskId,
  TerminalOpenInput,
} from "@threadlines/contracts";
import { composerForTypedMessage } from "@threadlines/shared/workflowRuns";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import { isAcpRegistryInstanceId } from "@threadlines/shared/acpRegistry";
import { createModelSelection, normalizeModelSlug } from "@threadlines/shared/model";
import { normalizeTerminalActivityCommand } from "@threadlines/shared/terminalCommandTracker";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@threadlines/shared/projectScripts";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import { formatForkSourceExcerpt, truncate } from "@threadlines/shared/String";
import { isAgentOrigin } from "@threadlines/shared/roomAgentRequests";
import { Debouncer } from "@tanstack/react-pacer";
import * as Option from "effect/Option";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useGitStatus } from "~/lib/gitStatusState";
import { isProviderAuthErrorChatMessage } from "~/lib/providerAuthMessages";
import { shouldShowCheckoutPicker } from "~/lib/checkoutRecovery";
import { useCheckoutRecovery } from "../hooks/useCheckoutRecovery";
import { buildCheckoutMissingNotice } from "./chat/checkoutMissingNotice";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { readEnvironmentApi } from "../environmentApi";
import { getPickerModelName } from "./chat/providerIconUtils";
import { workflowRunsAsShown } from "./chat/workflowRunView";
import {
  buildOwnAgentLabels,
  buildRoomAgentLabels,
  createAgentModelLabeler,
  hasRoomHistory,
  isRoom,
  isRoomWaitChosen,
  ownAgentSession,
  resolveRoomDelivery,
  resolveRoomSend,
  roomAgentKey,
  useRoomAgentNames,
  useRoomRecipientStore,
} from "../rooms";
import { ELECTRON_HEADER_HEIGHT_CLASS } from "../desktopChrome";
import { isElectron } from "../env";
import { ensureLocalApi, readLocalApi } from "../localApi";
import { parseDiffRouteSearch } from "../diffRouteSearch";
import {
  availableRightPanelTabs,
  focusRightPanelTab,
  hideRightPanel,
  retargetRightPanelDiff,
  rightPanelTabSearchParams,
  showRightPanel,
  useRightPanelTabs,
  type RightPanelDiffTarget,
  type RightPanelTab,
} from "../rightPanelTabs";
import {
  collapseExpandedComposerCursor,
  parseComposerGoalCommand,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import {
  approvalDeclineDecision,
  derivePendingApprovals,
  derivePendingUserInputs,
  isBlockingUserInput,
  derivePhase,
  deriveActiveStatusLabel,
  deriveThreadComputerName,
  describeLaunchingAgent,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveTurnDispatchedModelSelections,
  hasActionableProposedPlan,
  isLatestTurnSettled,
  describedAwaitedTasks,
  isWaitingOnBackgroundTasks,
  type McpAuthReconnectAction,
  type PendingApproval,
  type ProviderAuthReconnectAction,
  type SubagentProgressItem,
} from "../session-logic";
import { type LegendListRef } from "@legendapp/list/react";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import {
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectThreadDetailLoaded,
  selectThreadExistsByRef,
  selectThreadListedByRef,
  selectWorkspaceProjectsAcrossEnvironments,
  useStore,
} from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_COMPOSER_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type ProposedPlan,
  type SessionPhase,
  type Thread,
  type ChatAttachment,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useIsMobile, useMediaQuery } from "../hooks/useMediaQuery";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useChatFindStore } from "../chatFindStore";
import { installFindRegionTracking, resolveFindShortcutOwner } from "../lib/findShortcutOwner";
import { selectedChatText } from "./chat/chatFind/ChatFind";
import {
  RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY,
  draftRightPanelStateKey,
  useChatHeaderBottomVarRef,
} from "../rightPanelLayout";
import {
  publishAgentsPanelActivitySource,
  publishAgentsPanelSource,
  selectAgentsPanelAgent,
  selectAgentsPanelWorkflow,
} from "../agentsPanelStore";
import { getModelSelectionBooleanOptionValue } from "@threadlines/shared/model";
import type { WorkflowRunActions, WorkflowRunViewTab } from "./chat/WorkflowRunCard";
import { summarizeLiveAgents } from "./chat/agentsPanel.logic";
import { buildTemporaryWorktreeBranchName } from "@threadlines/shared/git";
import { BranchToolbar } from "./BranchToolbar";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { ChevronDownIcon } from "lucide-react";
import { ComposerFollowUpQueue } from "./chat/ComposerFollowUpQueue";
import { loadChatAttachmentBlob } from "~/lib/attachmentPreviewQuery";
import { cn, randomUUID } from "~/lib/utils";
import { CommandRunActionsContext } from "./chat/CommandRuns";
import { useCommandRunActions } from "./chat/useCommandRunActions";
import { markThreadSeen, selectThreadLastSeenAt } from "~/lib/threadInboxSync";
import { isPageAttended, onPageAttentionChange } from "~/lib/pageAttention";
import { mergeTurnStepHistory, turnsWithCutSteps, useTurnStepHistory } from "~/lib/turnStepHistory";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
} from "~/projectScripts";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { formatProviderDriverKindLabel } from "../providerModels";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { roomsEnabledFor } from "../hooks/useRoomsEnabled";
import {
  applyMovedDraftDefaults,
  buildNewThreadParticipants,
  moveDraftToSetUpProject,
  canRunOnComputer,
  resolveNewThreadDefaults,
} from "../newThreadDefaults";
import {
  type AppModelOption,
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "../modelSelection";
import { useScheduledRunLabel } from "../lib/scheduledTasksState";
import { isTerminalFocused } from "../lib/terminalFocus";
import { stopThreadSession } from "../lib/threadSessionCommands";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  reconnectSavedEnvironment,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../threadRoutes";
import {
  type ComposerAttachment,
  type DraftThreadEnvMode,
  hydrateAttachmentsFromPersisted,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import {
  appendTerminalContextsToPrompt,
  deriveDisplayedUserMessageState,
  formatTerminalContextLabel,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import {
  appendTranscriptHighlightContextsToPrompt,
  formatTranscriptHighlightContextLabel,
  type TranscriptHighlightContextDraft,
  type TranscriptHighlightContextSelection,
} from "../lib/transcriptHighlightContext";
import {
  appendFileSelectionContextsToPrompt,
  type FileSelectionContextDraft,
} from "../lib/fileSelectionContext";
import {
  selectTerminalActivityCommand,
  selectTerminalActivityStartedAt,
  selectTerminalTabs,
  noteTerminalMadeOnServer,
  terminalKey,
  terminalLineRecentlyEntered,
  terminalTabNumbers,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "../terminalStateStore";
import { dropTerminalBuffer, useTerminalThreadStream } from "../terminalStreams";
import { type TerminalCommandKind, useTerminalCommandsStore } from "../terminalCommands";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { McpAppSidePanel } from "./chat/McpAppCard";
import { NO_COMPOSER_PULL_REQUESTS, type ComposerPullRequest } from "./chat/ComposerPullRequestRow";
import { type ComposerGoalSetInput, threadGoalControls } from "./chat/ComposerGoalBar";
import { getComposerProviderState } from "./chat/composerProviderState";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import {
  MessagesTimeline,
  type TimelineProposedPlanState,
  type TimelineTurnAgentsState,
} from "./chat/MessagesTimeline";
import { DraftEmptyState, DraftRecentThreads } from "./chat/DraftEmptyState";
import { useDraftHeroCapable, useDraftHeroComposerSlide } from "./chat/useDraftHero";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import {
  ChatHeader,
  type ForkHeaderContext,
  type ParentThreadHeaderContext,
} from "./chat/ChatHeader";
import { useThreadTitle } from "../childThreads";
import type { DesktopPreviewPickedElement } from "@threadlines/contracts";
import { appendDrawingContextsToPrompt } from "../lib/drawingContext";
import {
  appendPickedElementContextsToPrompt,
  pickedElementFromPreview,
  type PickedElementContextDraft,
} from "../lib/pickedElementContext";
import { processStartedAt, type ThreadBackgroundRunItem } from "./chat/threadActivity";
import { currentWorkLine } from "./chat/activitySteps";
import { closeExpandedImagePreview, openExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { FilePreviewDialog, type FilePreviewRequest } from "./chat/FilePreviewDialog";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { resolveEffectiveEnvMode, resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import {
  shouldShowProviderStatusNotice,
  useProviderStatusNotice,
} from "./chat/providerStatusNotice";
import { useSessionStartupNotice } from "./chat/sessionStartupNotice";
import { buildProviderSendPreflightNotice } from "./chat/providerReadinessNotice";
import { useNoAgentReady } from "./setup/firstRunGateState";
import { useThreadProviderSignIn } from "./chat/useThreadProviderSignIn";
import { buildThreadErrorNotice } from "./chat/threadErrorNotice";
import { type ComposerNotice, selectComposerNotices } from "./chat/composerNotices";
import { useThreadMoveNotice } from "./chat/threadMoveNotice";
import { openProjectSetupDialog } from "./ProjectSetupDialog";
import { useProjectSetupTargets } from "../environments/projectSetups/projectSetupTargets";
import { useComputerLabel } from "./sidebar/linkedComputers";
import { threadMoveLockReason } from "../threadMove";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  DEFAULT_SCROLL_END_TOLERANCE_PX,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveDetectedBackgroundRunLabel,
  matchDetectedProviderRun,
  deriveFailedTurnRetryMessageId,
  deriveComposerSendState,
  deriveProviderAuthReconnectPrompt,
  deriveProviderSendPreflight,
  type ProviderSendPreflightPrompt,
  filterUnresolvedProviderBackgroundRuns,
  type ProviderBackgroundRunState,
  hasServerAcknowledgedLocalDispatch,
  isRetryableThreadError,
  isScrollMetricsAtEnd,
  shouldShowThreadErrorNotice,
  scrollMetricsDistanceFromEnd,
  deriveTimelineScrolledFarFromEnd,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LEGACY_LAST_INVOKED_SCRIPT_BY_PROJECT_KEYS,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  PullRequestDialogState,
  buildModelHandoffConfirmCopy,
  classifyModelSwitch,
  threadHasStarted,
  cloneComposerAttachmentForRetry,
  deriveLockedProvider,
  appendRestoredFollowUpText,
  readFileAsDataUrl,
  reconcileSteeringHandoffStatuses,
  reconcileMountedTerminalThreadIds,
  resolveSendEnvMode,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  shouldRefreshThreadDetailAfterEventLoopStall,
  shouldConfirmTerminalKill,
  shouldOfferFailedTurnRetry,
  shouldWriteThreadErrorToCurrentServerThread,
  THREAD_DETAIL_STALL_PROBE_INTERVAL_MS,
  waitForStartedServerThread,
  mergeLocalDraftThreadWithServerThread,
  buildRevertConfirmView,
  resolveRemoteBehindCount,
  resolveWorkingTreeChanges,
  type RevertConfirmView,
  resolveThreadBranchToRecord,
  deriveOwnThreadActivities,
  deriveSubagentSpawnCallIds,
  deriveThreadForkContextEntries,
  deriveThreadMovedInEntries,
  deriveThreadProviderBackgroundRuns,
  deriveThreadSideAnswers,
  deriveThreadSubagentActivityState,
  deriveThreadTimelineEntries,
  deriveThreadWorkLogEntries,
  deriveThreadRevertTurnCountByUserMessageId,
  deriveTurnDiffSummaryByAssistantMessageId,
  deriveThreadContextCompactionInProgress,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { selectThreadBrowserState, useBrowserPanelStore } from "../browserPanelStore";
import { BrowserPanel } from "./browser/BrowserPanel";
import { BrowserSplitHandle } from "./browser/BrowserSplitHandle";
import { useComposerHandleContext } from "../composerHandleContext";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindings,
} from "~/rpc/serverState";
import { isAppBackendEnvironment } from "../environments/providerComputer";
import { refreshProviderStatus } from "../environments/providerStatusRefresh";
import {
  selectOptimisticThreadMessages,
  useOptimisticThreadMessagesStore,
} from "../optimisticThreadMessages";
import { describeDispatchFailure, sanitizeThreadErrorMessage } from "~/rpc/transportError";
import {
  refreshThreadDetailSubscription,
  retainThreadDetailSubscription,
} from "../environments/runtime/service";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Checkbox } from "./ui/checkbox";
import { HeaderEdgeFade } from "./HeaderEdgeFade";
import { TitleBarContent } from "./sidebar/titleBarSlot";
import {
  canRequestProviderRateLimitResetCredit,
  isProviderUsageLimitErrorMessage,
  useProviderRateLimitResetCredit,
} from "./ProviderRateLimitResetCredit";
import { providerExternalResetsLink } from "~/lib/providerUsage";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
} from "../versionSkew";
import { derivePlanTaskBadge, useThreadPlanCatalog } from "../planPanelState";
import {
  deriveDisplayProviderInstanceEntries,
  getProviderInstanceEntry,
  type ProviderInstanceEntry,
  resolveComposerProviderSelection,
} from "../providerInstances";

// Lazy so @xterm/xterm (and the drawer's terminal machinery) stays out of
// the entry chunk; the drawer only mounts once a terminal is opened.
const ThreadTerminalDrawer = lazy(() => import("./ThreadTerminalDrawer"));

const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and the attached file(s).]";
const EMPTY_WORKFLOW_RUNS: ReadonlyArray<OrchestrationWorkflowRun> = [];
const EMPTY_AGENT_PAGES: ReadonlyArray<OrchestrationAgentPage> = [];
const EMPTY_COMMAND_REQUESTS: ReadonlyArray<OrchestrationCommandRequest> = [];
const EMPTY_PROPOSED_PLANS: ProposedPlan[] = [];
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const NO_THREAD_DERIVATION_KEY = "";
const EMPTY_TURN_IDS: ReadonlyArray<TurnId> = [];
const NO_SEEN_TURNS = { threadId: null, turnIds: EMPTY_TURN_IDS } as const;
const EMPTY_QUEUED_FOLLOW_UPS: ReadonlyArray<OrchestrationQueuedFollowUp> = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const EMPTY_SUBAGENT_ITEMS: ReadonlyArray<SubagentProgressItem> = [];
/** A provider-tracked run as the run list renders it. The provider never gives
 *  us a pid or a terminal for one, so stopping it goes through the agent when
 *  its driver can stop the task, else the command and URL hints — which is
 *  also what decides whether it can be stopped at all. */
function toThreadBackgroundRunItem<Run extends ProviderBackgroundRunState>(
  run: Run,
): Run & {
  terminalId: null;
  pid: null;
  port: null;
  elapsed: null;
  canStop: boolean;
  cwd: null;
} {
  return {
    ...run,
    terminalId: null,
    pid: null,
    port: null,
    elapsed: null,
    canStop:
      run.providerTaskId !== undefined ||
      run.command !== null ||
      run.commandHints.length > 0 ||
      run.urls.length > 0 ||
      run.pids.length > 0,
    cwd: null,
  };
}
const CODEX_PROVIDER_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_PROVIDER_DRIVER = ProviderDriverKind.make("claudeAgent");
const LAYOUT_STICK_TO_BOTTOM_FRAME_COUNT = 4;
const PROGRAMMATIC_STICK_TO_BOTTOM_SUPPRESS_MS = 600;
const INTERRUPT_RETRY_DELAY_MS = 12_000;
type McpAuthReconnectStatus = "running" | "completed";

function finiteScrollMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scrollableNodeMetrics(node: unknown): {
  readonly scrollOffset: number;
  readonly viewportLength: number;
  readonly contentLength: number;
} | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  const metrics = node as {
    readonly scrollTop?: number | null;
    readonly scrollHeight?: number | null;
    readonly clientHeight?: number | null;
  };
  const viewportLength = finiteScrollMetric(metrics.clientHeight);
  const contentLength = finiteScrollMetric(metrics.scrollHeight);
  if (viewportLength === null || contentLength === null) {
    return null;
  }

  return {
    scrollOffset: finiteScrollMetric(metrics.scrollTop) ?? 0,
    viewportLength,
    contentLength,
  };
}

function isScrollableNodeAtEnd(node: unknown): boolean | null {
  const metrics = scrollableNodeMetrics(node);
  if (metrics === null) {
    return null;
  }

  return isScrollMetricsAtEnd({
    ...metrics,
    tolerancePx: DEFAULT_SCROLL_END_TOLERANCE_PX,
  });
}

function legendListDistanceFromEnd(list: LegendListRef | null): number | null {
  const metrics = scrollableNodeMetrics(list?.getScrollableNode());
  return metrics === null ? null : scrollMetricsDistanceFromEnd(metrics);
}

// Collapsing the questions panel frees (expanded height − collapsed bar height) of
// timeline space. Auto-collapse is only safe once the user has scrolled past that
// amount plus the at-end tolerance — any earlier and the reveal shifts their view
// or flips the at-end signal back on (see deriveTimelineScrolledFarFromEnd).
const QUESTIONS_COLLAPSED_BAR_PX = 44;
const QUESTIONS_COLLAPSE_GUARD_PX = 36;

function questionsPanelCollapseThresholdPx(): number | null {
  const node = document.querySelector('[data-composer-questions-expanded="true"]');
  if (!(node instanceof HTMLElement)) {
    return null;
  }
  return Math.max(
    QUESTIONS_COLLAPSE_GUARD_PX + DEFAULT_SCROLL_END_TOLERANCE_PX,
    node.offsetHeight -
      QUESTIONS_COLLAPSED_BAR_PX +
      DEFAULT_SCROLL_END_TOLERANCE_PX +
      QUESTIONS_COLLAPSE_GUARD_PX,
  );
}

function isLegendListVisiblyAtEnd(list: LegendListRef | null): boolean {
  if (!list) {
    return false;
  }
  const scrollableNode = list.getScrollableNode();
  const physicallyAtEnd = isScrollableNodeAtEnd(scrollableNode);
  if (physicallyAtEnd !== null) {
    return physicallyAtEnd;
  }
  return list.getState().isAtEnd;
}

function providerSupportsManualContextCompaction(
  provider: ServerProvider | null,
  driver: ProviderDriverKind,
): boolean {
  if (driver === CODEX_PROVIDER_DRIVER) {
    return true;
  }
  if (driver !== CLAUDE_PROVIDER_DRIVER) {
    return false;
  }
  return (
    provider?.slashCommands.some((command) => command.name.trim().toLowerCase() === "compact") ??
    false
  );
}

function mcpAuthReconnectStateKey(providerInstanceId: ProviderInstanceId, serverName: string) {
  return `${providerInstanceId}\u001f${serverName}`;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

const BACKGROUND_RUN_DETECTION_RETRY_DELAYS_MS = [250, 750, 2_000, 4_000] as const;

function backgroundRunCommandFingerprint(command: string | null | undefined): string | null {
  if (!command) return null;
  const normalized =
    normalizeTerminalActivityCommand(command) ?? command.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized.toLowerCase() : null;
}

type EnvironmentUnavailableState = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: "connecting" | "disconnected" | "error";
};

type SteeringMessageHandoff = {
  readonly id: MessageId;
  readonly threadKey: string;
  readonly text: string;
  readonly createdAt: string;
  readonly status: "queued" | "read";
};

function formatOutgoingPrompt(text: string): string {
  return text.trim();
}

const FORK_SOURCE_EXCERPT_CHARS = 1_200;
const DEFAULT_FORK_THREAD_INSTRUCTION =
  "Continue from this fork point. Use the carried context for background, inspect the current files for ground truth, and take the next best step.";
const DEFAULT_CONTINUE_IN_PROJECT_INSTRUCTION =
  "Continue this conversation in the project. Use the carried context for background and apply it to this repository.";

type ForkThreadDialogState = {
  readonly sourceMessageId: MessageId;
  readonly sourceMessageRole: ChatMessage["role"];
  readonly sourceMessageText: string;
  readonly sourceAttachmentCount: number;
  readonly instruction: string;
  readonly preservedInstructionSuffix: string;
  readonly replacementAttachments: ReadonlyArray<ChatAttachment>;
  readonly replacementSkills: ReadonlyArray<ChatSkillReference>;
  readonly modelSelection: ModelSelection;
  /** Present for "Continue in project" from a General Chat. */
  readonly targetProject?: { readonly projectId: ProjectId; readonly name: string };
};

function buildForkSourceExcerpt(message: ChatMessage): string {
  return formatForkSourceExcerpt(message.text, FORK_SOURCE_EXCERPT_CHARS);
}

/** A message an agent wrote (another room agent, another thread) is an agent's words, not the user's. */
const forkSourceRole = (
  message: Pick<ChatMessage, "role" | "fromAgent" | "fromThread">,
): ChatMessage["role"] => (isAgentOrigin(message) ? "assistant" : message.role);

function roleLabelForForkSource(role: ChatMessage["role"]): string {
  switch (role) {
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "user":
    default:
      return "User";
  }
}

function ForkThreadDialog(props: {
  readonly state: ForkThreadDialogState | null;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly keybindings?: ResolvedKeybindingsConfig;
  readonly terminalOpen: boolean;
  /** Settings shows the computer the thread runs on. */
  readonly providerSettingsShown: boolean;
  readonly disabled: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onInstructionChange: (instruction: string) => void;
  readonly onModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  readonly onConfirm: () => void;
}) {
  const state = props.state;
  if (!state) {
    return null;
  }

  const sourceRoleLabel = roleLabelForForkSource(state.sourceMessageRole);
  const editsUserPrompt = state.sourceMessageRole === "user" && !state.targetProject;
  const instruction = state.instruction.trim();
  const sourceText =
    state.sourceMessageText.length > 0 ? state.sourceMessageText : "No text in the source message.";

  return (
    <AlertDialog open onOpenChange={props.onOpenChange}>
      <AlertDialogPopup className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {state.targetProject
              ? `Continue in ${state.targetProject.name}?`
              : editsUserPrompt
                ? "Edit this prompt in a new thread?"
                : "Continue in a new thread?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {state.targetProject
              ? `This starts a new thread in ${state.targetProject.name} immediately, seeded with a context snapshot of this chat up to the selected message. This chat stays unchanged.`
              : editsUserPrompt
                ? "This branches immediately before the selected prompt and sends your edited version. The original thread and current files stay unchanged."
                : "This starts a separate thread immediately. It uses your current files, does not checkout or revert the worktree, and carries a server-built context snapshot up to the selected message."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-5">
          <div className="rounded-lg border border-border/70 bg-muted/35 px-3 py-2.5">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55">
              Source {sourceRoleLabel} message
            </div>
            <p className="line-clamp-4 text-sm text-muted-foreground/85">{sourceText}</p>
          </div>

          <div className="grid gap-2 rounded-lg border border-border/70 bg-background/50 px-3 py-2.5 text-xs text-muted-foreground/80 sm:grid-cols-3">
            <p>
              <span className="font-medium text-foreground/80">Files:</span>{" "}
              {state.targetProject ? `${state.targetProject.name} workspace` : "current worktree"}
            </p>
            <p>
              <span className="font-medium text-foreground/80">Revert:</span> none
            </p>
            <p>
              <span className="font-medium text-foreground/80">Images:</span>{" "}
              {state.sourceAttachmentCount > 0
                ? editsUserPrompt
                  ? "preserved with edited prompt"
                  : "copied only if carried in context"
                : "none on source message"}
            </p>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {editsUserPrompt ? "Edited prompt" : "First message"}
            </span>
            <Textarea
              value={state.instruction}
              onChange={(event) => props.onInstructionChange(event.currentTarget.value)}
              placeholder={DEFAULT_FORK_THREAD_INSTRUCTION}
              size="lg"
            />
          </label>

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Model for the fork</span>
            <ProviderModelPicker
              activeInstanceId={state.modelSelection.instanceId}
              model={state.modelSelection.model}
              lockedProvider={null}
              lockedContinuationGroupKey={null}
              instanceEntries={props.providerInstanceEntries}
              {...(props.keybindings ? { keybindings: props.keybindings } : {})}
              modelOptionsByInstance={props.modelOptionsByInstance}
              terminalOpen={props.terminalOpen}
              providerSettingsShown={props.providerSettingsShown}
              side="top"
              triggerVariant="outline"
              triggerClassName="w-full max-w-none"
              disabled={props.disabled}
              onInstanceModelChange={props.onModelChange}
            />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={props.disabled} />}>
            Cancel
          </AlertDialogClose>
          <Button disabled={props.disabled || instruction.length === 0} onClick={props.onConfirm}>
            {state.targetProject ? "Continue in project" : "Start branch"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
interface RevertThreadDialogState {
  readonly turnCount: number;
  readonly revertedMessageText: string | undefined;
  readonly view: RevertConfirmView;
}

function RevertThreadDialog(props: {
  readonly state: RevertThreadDialogState | null;
  readonly disabled: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  const state = props.state;
  if (!state) {
    return null;
  }

  const view = state.view;
  return (
    <AlertDialog open onOpenChange={props.onOpenChange}>
      <AlertDialogPopup className="max-w-lg">
        <AlertDialogHeader className="pb-3">
          <AlertDialogTitle>{view.title}</AlertDialogTitle>
          <AlertDialogDescription>{view.summary}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="min-h-0 space-y-2.5 overflow-y-auto px-6 pb-5 text-sm text-muted-foreground/85">
          {view.revertPaths.length > 0 && (
            <ul className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1.5 rounded-lg border border-border/70 bg-muted/35 px-3 py-2.5">
              {view.revertPaths.map((revertPath) => (
                <li key={revertPath} className="min-w-0">
                  <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono text-xs break-all text-foreground/90">
                    {revertPath}
                  </code>
                </li>
              ))}
              {view.revertPathOverflowCount > 0 && (
                <li className="text-xs whitespace-nowrap text-muted-foreground/70">
                  and {view.revertPathOverflowCount} more
                </li>
              )}
            </ul>
          )}
          {view.conflictsLabel !== null && <p>{view.conflictsLabel}</p>}
          {view.conflicts.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-border/70 bg-muted/35 px-3 py-2.5">
              {view.conflicts.map((conflict) => (
                <li key={conflict.path} className="flex min-w-0 items-baseline gap-2">
                  <code className="shrink-0 rounded bg-background/60 px-1 py-0.5 font-mono text-xs text-foreground/90">
                    {conflict.path}
                  </code>
                  <span className="truncate text-xs text-muted-foreground/70">
                    {conflict.reason}
                  </span>
                </li>
              ))}
              {view.conflictOverflowCount > 0 && (
                <li className="text-xs text-muted-foreground/70">
                  and {view.conflictOverflowCount} more
                </li>
              )}
            </ul>
          )}
          {view.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" disabled={props.disabled} />}>
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" disabled={props.disabled} onClick={props.onConfirm}>
            Revert
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

const SCRIPT_TERMINAL_COLS = 120;

const SCRIPT_TERMINAL_ROWS = 30;

const LOCAL_DISPATCH_RECONCILIATION_DELAY_MS = 2_000;

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      composerFocusRequest?: number;
      /**
       * The thread's pull requests, resolved by the route that owns the Pull
       * request tab. The composer docks a row for each; a draft has none.
       */
      composerPullRequests?: ReadonlyArray<ComposerPullRequest>;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      composerFocusRequest?: number;
      routeKind: "draft";
      draftId: DraftId;
    };

/** The same items in the same order: a draft list nobody touched. */
function sameItems<T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);
  const [acceptedLocalDispatch, setAcceptedLocalDispatch] = useState<{
    readonly threadRef: ScopedThreadRef;
    readonly acceptedAt: number;
  } | null>(null);

  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) => {
      setAcceptedLocalDispatch(null);
      const preparingWorktree = Boolean(options?.preparingWorktree);
      setLocalDispatch((current) => {
        if (current) {
          return current.preparingWorktree === preparingWorktree
            ? current
            : { ...current, preparingWorktree };
        }
        return createLocalDispatchSnapshot(input.activeThread, options);
      });
    },
    [input.activeThread],
  );

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
    setAcceptedLocalDispatch(null);
  }, []);

  const markLocalDispatchAccepted = useCallback((threadRef: ScopedThreadRef) => {
    setAcceptedLocalDispatch({ threadRef, acceptedAt: Date.now() });
  }, []);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: input.phase,
        latestTurn: input.activeLatestTurn,
        session: input.activeThread?.session ?? null,
        hasPendingApproval: input.activePendingApproval !== null,
        hasPendingUserInput: input.activePendingUserInput !== null,
        threadError: input.threadError,
      }),
    [
      input.activeLatestTurn,
      input.activePendingApproval,
      input.activePendingUserInput,
      input.activeThread?.session,
      input.phase,
      input.threadError,
      localDispatch,
    ],
  );

  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch) {
      return;
    }
    resetLocalDispatch();
  }, [resetLocalDispatch, serverAcknowledgedLocalDispatch]);

  useEffect(() => {
    if (!localDispatch || !acceptedLocalDispatch || serverAcknowledgedLocalDispatch) {
      return;
    }

    const timeoutId = globalThis.setTimeout(() => {
      refreshThreadDetailSubscription(
        acceptedLocalDispatch.threadRef.environmentId,
        acceptedLocalDispatch.threadRef.threadId,
      );
    }, LOCAL_DISPATCH_RECONCILIATION_DELAY_MS);
    return () => {
      globalThis.clearTimeout(timeoutId);
    };
  }, [acceptedLocalDispatch, localDispatch, serverAcknowledgedLocalDispatch]);

  return {
    beginLocalDispatch,
    markLocalDispatchAccepted,
    resetLocalDispatch,
    localDispatchStartedAt: localDispatch?.startedAt ?? null,
    isPreparingWorktree: localDispatch?.preparingWorktree ?? false,
    isSendBusy: localDispatch !== null && !serverAcknowledgedLocalDispatch,
  };
}

interface PersistentThreadTerminalDrawerProps {
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  threadId: ThreadId;
  visible: boolean;
  focusRequestId: number;
  findRequested: boolean;
  onFindRequestHandled: () => void;
  splitShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  hideShortcutLabel: string | undefined;
  findShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onCloseTerminal: (
    threadRef: { environmentId: EnvironmentId; threadId: ThreadId },
    threadId: ThreadId,
    terminalId: string,
    options?: { sessionExited?: boolean },
  ) => void;
  onRestartTerminal: (
    threadRef: { environmentId: EnvironmentId; threadId: ThreadId },
    threadId: ThreadId,
    terminalId: string,
  ) => void;
  onHideTerminal: () => void;
}

const EMPTY_TERMINAL_COMMANDS: ReadonlyMap<string, string> = new Map();

const PersistentThreadTerminalDrawer = memo(function PersistentThreadTerminalDrawer({
  threadRef,
  threadId,
  visible,
  focusRequestId,
  findRequested,
  onFindRequestHandled,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  hideShortcutLabel,
  findShortcutLabel,
  keybindings,
  onAddTerminalContext,
  onCloseTerminal,
  onRestartTerminal,
  onHideTerminal,
}: PersistentThreadTerminalDrawerProps) {
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useStore(useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]));
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, threadRef),
  );
  const terminalTabs = useTerminalStateStore((state) =>
    selectTerminalTabs(state.terminalTabsByThreadKey, threadRef),
  );
  const terminalActivityCommandByKey = useTerminalStateStore(
    (state) => state.terminalActivityCommandByKey,
  );
  const storeSetTerminalHeight = useTerminalStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((state) => state.closeTerminal);
  const terminalFontSize = useSettings((settings) => settings.terminalFontSize);
  const terminalScreenReaderMode = useSettings((settings) => settings.terminalScreenReaderMode);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const threadEffectiveCwd = serverThread?.effectiveCwd ?? null;
  // Where a new tab starts: the thread's folder now. A tab that exists stays
  // in the folder its shell started in (docs/terminal.md).
  const cwd = useMemo(
    () =>
      project
        ? resolveThreadWorkingCwd({
            projectCwd: project.cwd,
            worktreePath,
            effectiveCwd: threadEffectiveCwd,
          })
        : null,
    [project, threadEffectiveCwd, worktreePath],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.cwd },
            worktreePath,
          })
        : {},
    [project, worktreePath],
  );
  const drawerShown = Boolean(project && terminalState.terminalOpen && cwd);
  // This thread's output comes only while its drawer is mounted.
  const stream = useTerminalThreadStream(threadRef.environmentId, threadId, drawerShown);
  const commandByTerminalId = useMemo(() => {
    if (Object.keys(terminalActivityCommandByKey).length === 0) return EMPTY_TERMINAL_COMMANDS;
    const commands = new Map<string, string>();
    for (const terminalId of terminalState.terminalIds) {
      const command = terminalActivityCommandByKey[terminalKey(threadRef, terminalId)];
      if (command) commands.set(terminalId, command);
    }
    return commands;
  }, [terminalActivityCommandByKey, terminalState.terminalIds, threadRef]);

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) {
      return;
    }
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(threadRef, height);
    },
    [storeSetTerminalHeight, threadRef],
  );

  const splitTerminal = useCallback(() => {
    storeSplitTerminal(threadRef, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeSplitTerminal, threadRef]);

  const createNewTerminal = useCallback(() => {
    storeNewTerminal(threadRef, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeNewTerminal, threadRef]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string, options?: { sessionExited?: boolean }) => {
      onCloseTerminal(threadRef, threadId, terminalId, options);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, onCloseTerminal, threadId, threadRef],
  );

  const forgetTerminal = useCallback(
    (terminalId: string) => {
      storeCloseTerminal(threadRef, terminalId);
      dropTerminalBuffer(threadRef.environmentId, threadId, terminalId);
    },
    [storeCloseTerminal, threadId, threadRef],
  );

  const restartTerminal = useCallback(
    (terminalId: string) => onRestartTerminal(threadRef, threadId, terminalId),
    [onRestartTerminal, threadId, threadRef],
  );

  const clearTerminal = useCallback(
    (terminalId: string) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      void api?.terminal.clear({ threadId, terminalId }).catch(() => undefined);
    },
    [threadId, threadRef],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!project || !terminalState.terminalOpen || !cwd) {
    return null;
  }

  return (
    <div className={visible ? undefined : "hidden"}>
      <Suspense fallback={null}>
        <ThreadTerminalDrawer
          threadRef={threadRef}
          threadId={threadId}
          cwd={cwd}
          worktreePath={worktreePath}
          runtimeEnv={runtimeEnv}
          visible={visible}
          height={terminalState.terminalHeight}
          terminalIds={terminalState.terminalIds}
          activeTerminalId={terminalState.activeTerminalId}
          terminalGroups={terminalState.terminalGroups}
          activeTerminalGroupId={terminalState.activeTerminalGroupId}
          tabs={terminalTabs}
          runningTerminalIds={terminalState.runningTerminalIds}
          commandByTerminalId={commandByTerminalId}
          stream={stream}
          focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
          findRequested={findRequested}
          onFindRequestHandled={onFindRequestHandled}
          fontSize={terminalFontSize}
          screenReaderMode={terminalScreenReaderMode}
          onSplitTerminal={splitTerminal}
          onNewTerminal={createNewTerminal}
          onHideTerminal={onHideTerminal}
          splitShortcutLabel={visible ? splitShortcutLabel : undefined}
          newShortcutLabel={visible ? newShortcutLabel : undefined}
          closeShortcutLabel={visible ? closeShortcutLabel : undefined}
          hideShortcutLabel={visible ? hideShortcutLabel : undefined}
          findShortcutLabel={visible ? findShortcutLabel : undefined}
          keybindings={keybindings}
          onActiveTerminalChange={activateTerminal}
          onCloseTerminal={closeTerminal}
          onForgetTerminal={forgetTerminal}
          onRestartTerminal={restartTerminal}
          onClearTerminal={clearTerminal}
          onHeightChange={setTerminalHeight}
          onAddTerminalContext={handleAddTerminalContext}
        />
      </Suspense>
    </div>
  );
});

export default function ChatView(props: ChatViewProps) {
  const { environmentId, threadId, routeKind, onDiffPanelOpen, composerFocusRequest = 0 } = props;
  const composerPullRequests =
    routeKind === "server"
      ? (props.composerPullRequests ?? NO_COMPOSER_PULL_REQUESTS)
      : NO_COMPOSER_PULL_REQUESTS;
  const draftId = routeKind === "draft" ? props.draftId : null;
  const routeThreadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const routeThreadKey = useMemo(() => scopedThreadKey(routeThreadRef), [routeThreadRef]);
  const composerDraftTarget: ScopedThreadRef | DraftId =
    routeKind === "server" ? routeThreadRef : props.draftId;
  const serverThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const setStoreThreadError = useStore((store) => store.setError);
  const activeThreadLastVisitedAt = useUiStateStore((store) =>
    routeKind === "server"
      ? selectThreadLastSeenAt(store, routeThreadKey, serverThread?.lastSeenAt)
      : undefined,
  );
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const suppressCrossProviderWarning = settings.suppressCrossProviderSwitchWarning ?? false;
  // Kept after closing (`open: false`) so the dialog's text holds while it
  // animates out.
  const [pendingModelHandoff, setPendingModelHandoff] = useState<{
    open: boolean;
    instanceId: ProviderInstanceId;
    model: string;
    copy: ReturnType<typeof buildModelHandoffConfirmCopy>;
  } | null>(null);
  const closeModelHandoffDialog = useCallback(
    () => setPendingModelHandoff((current) => (current ? { ...current, open: false } : null)),
    [],
  );
  const [crossProviderDontAskAgain, setCrossProviderDontAskAgain] = useState(false);
  const [forkDialogState, setForkDialogState] = useState<ForkThreadDialogState | null>(null);
  const [revertDialogState, setRevertDialogState] = useState<RevertThreadDialogState | null>(null);
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const { handleNewThread } = useNewThreadHandler();
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const timelineSearchTarget = useMemo(
    () =>
      rawSearch.focusMessageId
        ? {
            messageId: rawSearch.focusMessageId,
            query: rawSearch.focusQuery ?? "",
            requestKey: rawSearch.focusRequest ?? "initial",
          }
        : null,
    [rawSearch.focusMessageId, rawSearch.focusQuery, rawSearch.focusRequest],
  );
  const timelineSearchTargetRef = useRef(timelineSearchTarget);
  timelineSearchTargetRef.current = timelineSearchTarget;
  const shouldUseRightPanelSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  // Auto-focusing the composer on touch devices pops the on-screen keyboard
  // over the conversation, so thread-entry focus is desktop-only.
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const { resolvedTheme } = useTheme();
  // Granular store selectors — avoid subscribing to prompt changes.
  const composerRuntimeMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.runtimeMode ?? null,
  );
  const composerInteractionMode = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.interactionMode ?? null,
  );
  const composerActiveProvider = useComposerDraftStore(
    (store) => store.getComposerDraft(composerDraftTarget)?.activeProvider ?? null,
  );
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const prefillComposerDraftPrompt = useComposerDraftStore((store) => store.prefillEmptyPrompt);
  const addComposerDraftAttachments = useComposerDraftStore((store) => store.addAttachments);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftTranscriptHighlightContexts = useComposerDraftStore(
    (store) => store.setTranscriptHighlightContexts,
  );
  const addComposerDraftFileSelectionContext = useComposerDraftStore(
    (store) => store.addFileSelectionContext,
  );
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const promptRef = useRef("");
  const composerAttachmentsRef = useRef<ComposerAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const composerTranscriptHighlightContextsRef = useRef<TranscriptHighlightContextDraft[]>([]);
  const composerFileSelectionContextsRef = useRef<FileSelectionContextDraft[]>([]);
  const composerPickedElementContextsRef = useRef<PickedElementContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  // "Send as plain text" for a message holding Claude's workflow keyword.
  // Belongs to the message being written: cleared as it is sent and when the
  // thread changes.
  const [workflowKeywordSuppressed, setWorkflowKeywordSuppressed] = useState(false);
  const toggleWorkflowKeyword = useCallback(
    () => setWorkflowKeywordSuppressed((current) => !current),
    [],
  );
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  // Hysteresis-gated "far from bottom" signal for the composer questions panel —
  // see deriveTimelineScrolledFarFromEnd for why plain at-end would oscillate.
  const [isTimelineScrolledFarFromEnd, setIsTimelineScrolledFarFromEnd] = useState(false);
  const [stickToBottomRequestKey, setStickToBottomRequestKey] = useState(0);
  const [previewedFile, setPreviewedFile] = useState<FilePreviewRequest | null>(null);
  const [steeringMessagesById, setSteeringMessagesById] = useState<
    Record<string, SteeringMessageHandoff>
  >({});
  const [localDraftErrorsByDraftId, setLocalDraftErrorsByDraftId] = useState<
    Record<string, string | null>
  >({});
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [contextCompactDispatchingThreadId, setContextCompactDispatchingThreadId] =
    useState<ThreadId | null>(null);
  const [turnRetryDispatchingThreadId, setTurnRetryDispatchingThreadId] = useState<ThreadId | null>(
    null,
  );
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const interruptInFlightTurnByThreadRef = useRef(new Map<ThreadId, TurnId | null>());
  const backgroundWorkStopInFlightRef = useRef(new Set<ThreadId>());
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  // Find in the terminal was asked for; the drawer opens it in the active tab.
  const [terminalFindRequested, setTerminalFindRequested] = useState(false);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [pendingServerThreadEnvMode, setPendingServerThreadEnvMode] =
    useState<DraftThreadEnvMode | null>(null);
  // The base an empty server thread's new worktree starts from, before it is
  // sent; `fromSetting` while it is the one "New worktrees from" gave.
  const [pendingServerThreadBase, setPendingServerThreadBase] = useState<{
    readonly branch: string | null;
    readonly fromSetting: boolean;
  }>();
  const onPendingServerThreadBaseChange = useCallback(
    (branch: string | null, options?: { readonly fromSetting?: boolean }) =>
      setPendingServerThreadBase({ branch, fromSetting: options?.fromSetting === true }),
    [],
  );
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
    { legacyKeys: LEGACY_LAST_INVOKED_SCRIPT_BY_PROJECT_KEYS },
  );
  const legendListRef = useRef<LegendListRef | null>(null);
  const isAtEndRef = useRef(true);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewPromotionInFlightByMessageIdRef = useRef<Record<string, true>>({});
  const sendInFlightRef = useRef(false);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const timelineStickFrameIdsRef = useRef<number[]>([]);
  const layoutStickThreadIdRef = useRef<ThreadId | null>(null);
  const programmaticStickToBottomSuppressUntilRef = useRef(0);

  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef),
  );
  const terminalCommandPendingByKey = useTerminalStateStore(
    (state) => state.terminalCommandPendingByKey,
  );
  const activeTerminalTabs = useTerminalStateStore((state) =>
    selectTerminalTabs(state.terminalTabsByThreadKey, routeThreadRef),
  );
  const terminalActivityStartedAtByKey = useTerminalStateStore(
    (state) => state.terminalActivityStartedAtByKey,
  );
  const terminalActivityCommandByKey = useTerminalStateStore(
    (state) => state.terminalActivityCommandByKey,
  );
  const openTerminalThreadKeys = useTerminalStateStore(
    useShallow((state) =>
      Object.entries(state.terminalStateByThreadKey).flatMap(
        ([nextThreadKey, nextTerminalState]) =>
          nextTerminalState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);
  const removeComposerDraftTerminalContextsForTerminal = useComposerDraftStore(
    (store) => store.removeTerminalContextsForTerminal,
  );
  // Of the threads with a terminal open, the ones the store still lists. Only
  // those few keys are looked up, so a store update (every streamed delta)
  // never builds the whole thread list.
  const openTerminalServerThreadKeys = useStore(
    useShallow((state) =>
      openTerminalThreadKeys.filter((nextThreadKey) =>
        selectThreadListedByRef(state, parseScopedThreadKey(nextThreadKey)),
      ),
    ),
  );
  const draftThreadsByThreadKey = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const optimisticUserMessages = useOptimisticThreadMessagesStore(
    useShallow((store) => selectOptimisticThreadMessages(store, routeThreadRef)),
  );
  const addOptimisticThreadMessage = useOptimisticThreadMessagesStore((store) => store.addMessage);
  const removeOptimisticThreadMessages = useOptimisticThreadMessagesStore(
    (store) => store.removeMessages,
  );
  const draftThreadKeys = useMemo(
    () =>
      Object.values(draftThreadsByThreadKey).map((draftThread) =>
        scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
      ),
    [draftThreadsByThreadKey],
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const mountedTerminalThreadRefs = useMemo(
    () =>
      mountedTerminalThreadKeys.flatMap((mountedThreadKey) => {
        const mountedThreadRef = parseScopedThreadKey(mountedThreadKey);
        return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
      }),
    [mountedTerminalThreadKeys],
  );

  const localDraftError =
    routeKind === "server" && serverThread
      ? null
      : ((draftId ? localDraftErrorsByDraftId[draftId] : null) ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            // Deliberately not the project's persisted `defaultModelSelection`:
            // nothing writes that field anymore, so old projects carry pins
            // from whenever they were created (e.g. a long-retired model). A
            // draft with no selection of its own follows the sticky last-used
            // state, with this offline fallback beneath it.
            {
              instanceId: ProviderInstanceId.make("codex"),
              model: DEFAULT_MODEL,
            },
            localDraftError,
          )
        : undefined,
    [draftThread, localDraftError, threadId],
  );
  const isServerThread = routeKind === "server" && serverThread !== undefined;
  const activeThread = isServerThread
    ? serverThread
    : mergeLocalDraftThreadWithServerThread(localDraftThread, serverThread);
  // A scheduled task's run thread: its first message folds to this line.
  const scheduledRunLabel = useScheduledRunLabel(
    activeThread?.environmentId,
    activeThread?.scheduledRun,
  );
  const runtimeMode =
    composerRuntimeMode ?? activeThread?.runtimeMode ?? DEFAULT_COMPOSER_RUNTIME_MODE;
  const interactionMode =
    composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const rightPanelStateKey =
    routeKind === "draft" && draftId ? draftRightPanelStateKey(draftId) : routeThreadKey;
  // The sidebar's tab strip is owned by the route that renders it; the header
  // reads the same store so its panel button agrees with what is on screen.
  // The button reflects the sidebar as a whole: it stays pressed on any tab,
  // and on the launcher.
  const rightPanelTabs = useRightPanelTabs(rightPanelStateKey);
  const rightPanelEngaged = rightPanelTabs.visible;
  // A hidden sidebar keeps its active tab for when it comes back, so the
  // Agents tab only counts as open while the sidebar is showing.
  const agentsPanelOpen = rightPanelTabs.visible && rightPanelTabs.activeTab === "agents";
  const activeThreadId = activeThread?.id ?? null;
  const activeThreadRef = useMemo(
    () => (activeThread ? scopeThreadRef(activeThread.environmentId, activeThread.id) : null),
    [activeThread],
  );
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  // Lets async work started on one thread tell whether the user is still on it.
  const activeThreadKeyRef = useRef(activeThreadKey);
  useEffect(() => {
    setWorkflowKeywordSuppressed(false);
  }, [activeThreadKey]);
  activeThreadKeyRef.current = activeThreadKey;
  const existingOpenTerminalThreadKeys = useMemo(() => {
    const existingThreadKeys = new Set<string>([
      ...openTerminalServerThreadKeys,
      ...draftThreadKeys,
    ]);
    return openTerminalThreadKeys.filter((nextThreadKey) => existingThreadKeys.has(nextThreadKey));
  }, [draftThreadKeys, openTerminalServerThreadKeys, openTerminalThreadKeys]);
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const threadPlanCatalog = useThreadPlanCatalog(
    useMemo(() => {
      const threadIds: ThreadId[] = [];
      if (activeThread?.id) {
        threadIds.push(activeThread.id);
      }
      const sourceThreadId = activeLatestTurn?.sourceProposedPlan?.threadId;
      if (sourceThreadId && sourceThreadId !== activeThread?.id) {
        threadIds.push(sourceThreadId);
      }
      return threadIds;
    }, [activeLatestTurn?.sourceProposedPlan?.threadId, activeThread?.id]),
  );
  useEffect(() => {
    setMountedTerminalThreadKeys((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadKeys,
        activeThreadId: activeThreadKey,
        activeThreadTerminalOpen: Boolean(activeThreadKey && terminalState.terminalOpen),
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((nextThreadId, index) => nextThreadId === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [activeThreadKey, existingOpenTerminalThreadKeys, terminalState.terminalOpen]);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  // Same rule as the sidebar's "Waiting" pill: settled, but a provider
  // task will start the thread back up on its own.
  const waitingOnBackgroundTasks = isWaitingOnBackgroundTasks(
    activeLatestTurn,
    activeThread?.session ?? null,
  );
  // What it waits on, for the timeline's anchor. Memoized on the session so
  // the timeline's rows only rebuild when the wait itself changes.
  const activeSession = activeThread?.session ?? null;
  const awaitedTasks = useMemo(
    () => (waitingOnBackgroundTasks ? describedAwaitedTasks(activeSession) : null),
    [activeSession, waitingOnBackgroundTasks],
  );
  const activeProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : null;
  const activeProject = useStore(
    useMemo(() => createProjectSelectorByRef(activeProjectRef), [activeProjectRef]),
  );
  // General Chat threads run in a hidden scratch workspace: source-control,
  // scripts, and open-in affordances stay hidden even though a project exists.
  const isGeneralChatThread = activeProject?.kind === "general-chat";
  // Which surfaces this thread's sidebar offers. Resolved from the same inputs
  // the route uses, so the header's entry points can never land on a tab the
  // strip would refuse to show.
  const rightPanelAvailableTabs = useMemo(
    () =>
      availableRightPanelTabs({
        isGeneralChat: isGeneralChatThread,
        isDraft: routeKind === "draft" || !isServerThread,
      }),
    [isGeneralChatThread, isServerThread, routeKind],
  );
  /**
   * A picked element becomes a context attached to the message, not text in it.
   * It is the same shape as a terminal excerpt or a highlighted quote: evidence
   * carried alongside what you are asking, removable before you send, and left
   * out of the prompt you are still writing.
   */
  const appendPickedElementToComposer = useCallback(
    (element: DesktopPreviewPickedElement, groupId: string | null) => {
      composerRef.current?.addPickedElementContext(
        pickedElementFromPreview(element, groupId ?? undefined),
      );
    },
    [composerRef],
  );

  // The preview's reported errors travel as a small text attachment: a chip
  // like any other file, rather than a wall of pasted text.
  const appendPageErrorsToComposer = useCallback(
    (attachment: { name: string; text: string }) => {
      composerRef.current?.addTextFileAttachment(attachment);
    },
    [composerRef],
  );

  // The new-thread hero: the composer in the middle of the column, sliding to
  // the bottom on the first send. Held as elements rather than refs so the
  // hooks start measuring when the column mounts, not only when props change.
  const [chatColumnElement, setChatColumnElement] = useState<HTMLDivElement | null>(null);
  const [inputBarElement, setInputBarElement] = useState<HTMLDivElement | null>(null);
  const draftHeroCapable = useDraftHeroCapable(chatColumnElement, isLocalDraftThread);
  useDraftHeroComposerSlide({
    column: chatColumnElement,
    inputBar: inputBarElement,
    threadKey: `${environmentId}:${threadId}`,
    isLocalDraft: isLocalDraftThread,
    heroCapable: draftHeroCapable,
  });

  const draftTimelineEmptyState = useMemo(
    () =>
      isLocalDraftThread && draftThread ? (
        <DraftEmptyState
          currentProjectRef={scopeProjectRef(draftThread.environmentId, draftThread.projectId)}
          currentProjectName={activeProject?.name ?? null}
          isGeneralChat={isGeneralChatThread}
          layout={draftHeroCapable ? "hero" : "stacked"}
        />
      ) : undefined,
    [
      activeProject?.name,
      draftHeroCapable,
      draftThread?.environmentId,
      draftThread?.projectId,
      isGeneralChatThread,
      isLocalDraftThread,
    ],
  );

  const shouldRetainThreadDetailSubscription = routeKind === "server" || serverThread !== undefined;
  useEffect(() => {
    if (!shouldRetainThreadDetailSubscription) {
      return;
    }
    return retainThreadDetailSubscription(environmentId, threadId);
  }, [environmentId, shouldRetainThreadDetailSubscription, threadId]);

  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedEnvironmentRegistry = useSavedEnvironmentRegistryStore((s) => s.byId);
  const savedEnvironmentRuntimeById = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const activeSavedEnvironmentRecord =
    activeThread && activeThread.environmentId !== primaryEnvironmentId
      ? (savedEnvironmentRegistry[activeThread.environmentId] ?? null)
      : null;
  const activeSavedEnvironmentRuntime = activeSavedEnvironmentRecord
    ? (savedEnvironmentRuntimeById[activeSavedEnvironmentRecord.environmentId] ?? null)
    : null;
  const activeSavedEnvironmentConnectionState = activeSavedEnvironmentRecord
    ? (activeSavedEnvironmentRuntime?.connectionState ?? "disconnected")
    : "connected";
  const activeEnvironmentUnavailable =
    activeSavedEnvironmentRecord !== null && activeSavedEnvironmentConnectionState !== "connected";
  const activeSavedEnvironmentId = activeSavedEnvironmentRecord?.environmentId ?? null;
  const activeEnvironmentUnavailableLabel = activeSavedEnvironmentRecord
    ? resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId: activeSavedEnvironmentRecord.environmentId,
        runtimeLabel: activeSavedEnvironmentRuntime?.descriptor?.label ?? null,
        savedLabel: activeSavedEnvironmentRecord.label,
      })
    : null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (
      !activeEnvironmentUnavailable ||
      !activeEnvironmentUnavailableLabel ||
      !activeSavedEnvironmentId
    ) {
      return null;
    }

    return {
      environmentId: activeSavedEnvironmentId,
      label: activeEnvironmentUnavailableLabel,
      connectionState:
        activeSavedEnvironmentConnectionState === "connecting" ||
        activeSavedEnvironmentConnectionState === "error"
          ? activeSavedEnvironmentConnectionState
          : "disconnected",
    };
  }, [
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    activeSavedEnvironmentConnectionState,
    activeSavedEnvironmentId,
  ]);
  const [reconnectingEnvironmentId, setReconnectingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId, label: string) => {
      setReconnectingEnvironmentId(environmentId);
      try {
        await reconnectSavedEnvironment(environmentId);
        toastManager.add({
          type: "success",
          title: "Environment reconnected",
          description: `${label} is ready.`,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reconnect environment",
            description: error instanceof Error ? error.message : "Failed to reconnect.",
          }),
        );
      } finally {
        setReconnectingEnvironmentId(null);
      }
    },
    [],
  );
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const logicalProjectEnvironments = useMemo(() => {
    if (!activeProject) return [];
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const memberProjects = allProjects.filter(
      (p) => deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) === logicalKey,
    );
    const seen = new Set<string>();
    const envs: Array<{
      environmentId: EnvironmentId;
      projectId: ProjectId;
      label: string;
      isPrimary: boolean;
    }> = [];
    for (const p of memberProjects) {
      if (seen.has(p.environmentId)) continue;
      seen.add(p.environmentId);
      const isPrimary = p.environmentId === primaryEnvironmentId;
      const savedRecord = savedEnvironmentRegistry[p.environmentId];
      const runtimeState = savedEnvironmentRuntimeById[p.environmentId];
      const label = resolveEnvironmentOptionLabel({
        isPrimary,
        environmentId: p.environmentId,
        runtimeLabel: runtimeState?.descriptor?.label ?? null,
        savedLabel: savedRecord?.label ?? null,
      });
      envs.push({
        environmentId: p.environmentId,
        projectId: p.id,
        label,
        isPrimary,
      });
    }
    // Sort: primary first, then alphabetical
    envs.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return envs;
  }, [
    activeProject,
    allProjects,
    projectGroupingSettings,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
  ]);
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
        threadId: newThreadId(),
      });
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      if (!activeProject || !pullRequestDialogState) {
        throw new Error("No active project is available for this pull request.");
      }
      await handleNewThread(scopeProjectRef(activeProject.environmentId, activeProject.id), {
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
        threadId: pullRequestDialogState.threadId,
      });
    },
    [activeProject, handleNewThread, pullRequestDialogState],
  );

  useEffect(() => {
    if (!serverThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    // Open is not seen: a turn that finishes while the user is in another app
    // stays unread, so the Dock and taskbar count it, until they come back.
    const threadRef = scopeThreadRef(serverThread.environmentId, serverThread.id);
    const completedAt = activeLatestTurn.completedAt;
    const markSeenWhenAttended = () => {
      if (isPageAttended()) markThreadSeen(threadRef, completedAt);
    };
    markSeenWhenAttended();
    return onPageAttentionChange(markSeenWhenAttended);
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    latestTurnSettled,
    serverThread?.environmentId,
    serverThread?.id,
  ]);

  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider = activeThread?.modelSelection.instanceId ?? null;
  const primaryServerConfig = useServerConfig();
  const activeEnvRuntimeState = useSavedEnvironmentRuntimeStore((s) =>
    activeThread?.environmentId ? s.byId[activeThread.environmentId] : null,
  );
  // Use the server config for the thread's environment.  For the primary
  // environment fall back to the global atom; for remote environments use
  // the runtime state stored by the environment manager.
  const serverConfig =
    primaryEnvironmentId && activeThread?.environmentId === primaryEnvironmentId
      ? primaryServerConfig
      : (activeEnvRuntimeState?.serverConfig ?? primaryServerConfig);
  // The computer the thread runs on, which a provider refresh asks, also
  // while its config hasn't arrived and the one above stands in; null is the
  // app's own backend.
  const threadComputerEnvironmentId =
    activeThread !== undefined && activeThread.environmentId !== primaryEnvironmentId
      ? activeThread.environmentId
      : null;
  // Rooms follows the computer the thread lives on.
  const roomsEnabled = roomsEnabledFor(serverConfig?.settings);
  // Agents added before the first message: the thread is created with them.
  const draftRoom = draftThread?.room;
  const computerProviders = serverConfig?.providers;
  const draftRoomCreateFields = useMemo(() => {
    if (!roomsEnabled || !draftRoom) return {};
    // An agent whose provider is gone or turned off would join for good and
    // never answer: it is left out.
    const agents = draftRoom.agents.filter((agent) =>
      canRunOnComputer(computerProviders ?? [], agent.modelSelection.instanceId),
    );
    return {
      ...(agents.length > 0 ? { participants: agents } : {}),
      ...(draftRoom.agentRole !== undefined ? { agentRole: draftRoom.agentRole } : {}),
    };
  }, [computerProviders, draftRoom, roomsEnabled]);
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchDismissKey =
    versionMismatch && activeThread
      ? buildVersionMismatchDismissalKey(activeThread.environmentId, versionMismatch)
      : null;
  const [dismissedVersionMismatchKey, setDismissedVersionMismatchKey] = useState<string | null>(
    null,
  );
  const versionMismatchDismissed =
    versionMismatchDismissKey === dismissedVersionMismatchKey ||
    isVersionMismatchDismissed(versionMismatchDismissKey);
  const showVersionMismatchBanner =
    versionMismatch !== null && versionMismatchDismissKey !== null && !versionMismatchDismissed;
  const hasMultipleRegisteredEnvironments = Object.keys(savedEnvironmentRegistry).length > 0;
  const versionMismatchServerLabel = useMemo(() => {
    if (!hasMultipleRegisteredEnvironments || !activeThread) {
      return "server";
    }

    const isPrimary = activeThread.environmentId === primaryEnvironmentId;
    const savedRecord = savedEnvironmentRegistry[activeThread.environmentId];
    const runtimeState = savedEnvironmentRuntimeById[activeThread.environmentId];
    return `${resolveEnvironmentOptionLabel({
      isPrimary,
      environmentId: activeThread.environmentId,
      runtimeLabel: runtimeState?.descriptor?.label ?? serverConfig?.environment.label ?? null,
      savedLabel: savedRecord?.label ?? null,
    })} server`;
  }, [
    activeThread,
    hasMultipleRegisteredEnvironments,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
    serverConfig?.environment.label,
  ]);
  const infrastructureComposerNotices = useMemo<ComposerNotice[]>(() => {
    const items: ComposerNotice[] = [];
    if (activeEnvironmentUnavailableState) {
      const isConnecting = activeEnvironmentUnavailableState.connectionState === "connecting";
      const isReconnecting =
        isConnecting ||
        reconnectingEnvironmentId === activeEnvironmentUnavailableState.environmentId;
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        severity:
          activeEnvironmentUnavailableState.connectionState === "error" ? "error" : "warning",
        lead: `${activeEnvironmentUnavailableState.label} is ${isConnecting ? "connecting" : "disconnected"}.`,
        detail: "Reconnect this environment before sending messages or running actions.",
        actions: (
          <Button
            size="xs"
            disabled={isReconnecting}
            onClick={() =>
              void handleReconnectActiveEnvironment(
                activeEnvironmentUnavailableState.environmentId,
                activeEnvironmentUnavailableState.label,
              )
            }
          >
            {isReconnecting ? "Reconnecting..." : "Reconnect"}
          </Button>
        ),
      });
    }
    if (showVersionMismatchBanner && versionMismatch && versionMismatchDismissKey) {
      items.push({
        id: `version-mismatch:${versionMismatchDismissKey}`,
        severity: "info",
        lead: "Client and server versions differ.",
        detail: (
          <>
            Client {versionMismatch.clientVersion} is connected to {versionMismatchServerLabel}{" "}
            {versionMismatch.serverVersion}. Sync them if RPC calls or reconnects fail.
          </>
        ),
        dismissLabel: "Dismiss version mismatch warning",
        onDismiss: () => {
          dismissVersionMismatch(versionMismatchDismissKey);
          setDismissedVersionMismatchKey(versionMismatchDismissKey);
        },
      });
    }
    return items;
  }, [
    activeEnvironmentUnavailableState,
    handleReconnectActiveEnvironment,
    reconnectingEnvironmentId,
    showVersionMismatchBanner,
    versionMismatch,
    versionMismatchDismissKey,
    versionMismatchServerLabel,
  ]);
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  // A send preflight has to read the freshest snapshot we hold, including one
  // a recheck wrote moments ago inside the same event, before React has
  // re-rendered with it.
  const providerStatusesRef = useRef(providerStatuses);
  providerStatusesRef.current = providerStatuses;
  const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () => deriveDisplayProviderInstanceEntries(providerStatuses),
    [providerStatuses],
  );
  const roomAgentLabels = useMemo(
    () =>
      activeThread
        ? buildRoomAgentLabels(activeThread, providerInstanceEntries, (model, entry) =>
            getPickerModelName(model, entry.driverKind),
          )
        : null,
    [activeThread, providerInstanceEntries],
  );
  const roomAgentNames = useRoomAgentNames(roomAgentLabels);
  // Names each agent on a message the way the message recorded it. Kept across
  // streamed words: only the agents' names and the providers change it.
  const labelParticipants = activeThread?.participants;
  const labelAgentRole = activeThread?.agentRole;
  const agentModelLabeler = useMemo(
    () =>
      createAgentModelLabeler(
        { participants: labelParticipants, agentRole: labelAgentRole },
        providerInstanceEntries,
        (model, entry) => getPickerModelName(model, entry.driverKind),
      ),
    [labelAgentRole, labelParticipants, providerInstanceEntries],
  );
  const modelOptionsByInstance = useMemo(() => {
    const out = new Map<ProviderInstanceId, ReturnType<typeof getAppModelOptionsForInstance>>();
    for (const entry of providerInstanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [providerInstanceEntries, settings]);
  const selectedProviderDriver =
    providerStatuses.find((status) => status.instanceId === selectedProviderByThreadId)?.driver ??
    null;
  const threadProviderDriver =
    providerStatuses.find((status) => status.instanceId === threadProvider)?.driver ?? null;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderDriver,
    threadProvider: threadProviderDriver,
  });
  // The agent the next message goes to, by the composer's own rule and
  // inputs, so the goal command and the composer agree. Like the composer it
  // takes no lock: the lock above only decides when switching agents needs
  // the handoff confirmation (classifyModelSwitch).
  const ownSessionInstanceId = ownAgentSession(activeThread)?.providerInstanceId;
  const ownSessionProvider = ownAgentSession(activeThread)?.provider;
  const selectedProvider: ProviderDriverKind = useMemo(
    () =>
      resolveComposerProviderSelection({
        entries: providerInstanceEntries,
        candidates: [selectedProviderByThreadId, ownSessionInstanceId, threadProvider],
        lockedProvider: null,
        fallbackDriverKind: ownSessionProvider ?? ProviderDriverKind.make("codex"),
      }).driverKind,
    [
      ownSessionInstanceId,
      ownSessionProvider,
      providerInstanceEntries,
      selectedProviderByThreadId,
      threadProvider,
    ],
  );
  // A goal goes to whoever holds the thread's session: in a room, the agent
  // that worked last; otherwise the thread's own agent, as the next message
  // would. Its provider decides what the goal bar offers.
  const goalHolderId = activeThread?.session?.participantId ?? null;
  const goalHolderModelSelection =
    goalHolderId === null
      ? undefined
      : activeThread?.participants?.find((entry) => entry.id === goalHolderId)?.modelSelection;
  const goalControls = threadGoalControls(
    goalHolderId === null
      ? selectedProvider
      : providerInstanceEntries.find(
          (entry) => entry.instanceId === goalHolderModelSelection?.instanceId,
        )?.driverKind,
  );
  const phase = derivePhase(activeThread?.session ?? null);
  useEffect(() => {
    if (!shouldRetainThreadDetailSubscription || phase !== "running") {
      return;
    }

    let expectedProbeAt = performance.now() + THREAD_DETAIL_STALL_PROBE_INTERVAL_MS;
    let lastRefreshAt = Number.NEGATIVE_INFINITY;
    const intervalId = globalThis.setInterval(() => {
      const observedAt = performance.now();
      const eventLoopDelayMs = Math.max(0, observedAt - expectedProbeAt);
      expectedProbeAt = observedAt + THREAD_DETAIL_STALL_PROBE_INTERVAL_MS;
      if (
        !shouldRefreshThreadDetailAfterEventLoopStall({
          eventLoopDelayMs,
          elapsedSinceRefreshMs: observedAt - lastRefreshAt,
          isDocumentVisible: document.visibilityState === "visible",
        })
      ) {
        return;
      }

      lastRefreshAt = observedAt;
      refreshThreadDetailSubscription(environmentId, threadId);
    }, THREAD_DETAIL_STALL_PROBE_INTERVAL_MS);

    return () => {
      globalThis.clearInterval(intervalId);
    };
  }, [environmentId, phase, shouldRetainThreadDetailSubscription, threadId]);
  const isSessionStarting = activeThread?.session?.orchestrationStatus === "starting";
  // Which thread's remembered derivations (ChatView.logic, threadMemo) to use.
  const derivationThreadKey = activeThreadKey ?? NO_THREAD_DERIVATION_KEY;
  const allThreadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  // A side answer's steps are its own: only its block reads them. Everything
  // else here (the working turn's steps, prompts, plans, the context meter)
  // describes the agent at work.
  const threadActivities = useMemo(
    () => deriveOwnThreadActivities(derivationThreadKey, allThreadActivities),
    [allThreadActivities, derivationThreadKey],
  );
  // What the chat calls the thread's own agent, turn by turn: the model each
  // turn was sent with.
  const activeModelSelection = activeThread?.modelSelection;
  const activeAgentRole = activeThread?.agentRole;
  const ownAgentLabels = useMemo(
    () =>
      activeModelSelection
        ? buildOwnAgentLabels(
            { modelSelection: activeModelSelection, agentRole: activeAgentRole },
            deriveTurnDispatchedModelSelections(threadActivities),
            providerInstanceEntries,
            (model, entry) => getPickerModelName(model, entry.driverKind),
          )
        : null,
    [activeAgentRole, activeModelSelection, providerInstanceEntries, threadActivities],
  );
  const activeTurnId = activeThread?.session?.activeTurnId ?? null;
  const workLogEntries = useMemo(
    () => deriveThreadWorkLogEntries(derivationThreadKey, threadActivities, activeTurnId),
    [activeTurnId, derivationThreadKey, threadActivities],
  );
  const forkContextEntries = useMemo(
    () => deriveThreadForkContextEntries(derivationThreadKey, threadActivities),
    [derivationThreadKey, threadActivities],
  );
  const movedInEntries = useMemo(
    () => deriveThreadMovedInEntries(derivationThreadKey, threadActivities),
    [derivationThreadKey, threadActivities],
  );
  const forkHeaderContext = useMemo<ForkHeaderContext | null>(() => {
    const payload = forkContextEntries[0]?.payload;
    if (!payload) {
      return null;
    }
    return {
      sourceThreadId: payload.sourceThreadId,
      sourceThreadTitle: payload.sourceThreadTitle,
    };
  }, [forkContextEntries]);
  // Child threads: the thread whose agent started this one, while this
  // device knows it. "Started by" stays true after the thread is separated.
  // One an agent on another computer started names that computer, from what
  // the thread was told when it started, and opens its parent only while the
  // app has that computer's threads.
  const remoteOrigin = activeThread?.remoteOrigin ?? null;
  const parentEnvironmentId = remoteOrigin?.environmentId ?? environmentId;
  const parentThreadId = remoteOrigin?.threadId ?? activeThread?.parentThreadId ?? null;
  const knownParentTitle = useThreadTitle(parentEnvironmentId, parentThreadId);
  const parentHeaderContext = useMemo<ParentThreadHeaderContext | null>(() => {
    if (parentThreadId === null) return null;
    const parentThreadRef = scopeThreadRef(parentEnvironmentId, parentThreadId);
    if (remoteOrigin === null) {
      return knownParentTitle === null
        ? null
        : {
            parentThreadRef,
            parentThreadTitle: knownParentTitle,
            parentComputer: null,
            canOpen: true,
          };
    }
    return {
      parentThreadRef,
      parentThreadTitle: knownParentTitle ?? remoteOrigin.threadTitle,
      parentComputer: {
        environmentId: remoteOrigin.environmentId,
        lastKnownLabel: remoteOrigin.environmentLabel,
      },
      canOpen: knownParentTitle !== null,
    };
  }, [knownParentTitle, parentEnvironmentId, parentThreadId, remoteOrigin]);
  const onOpenParentThread = useCallback(
    (parentThreadRef: ScopedThreadRef) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: parentThreadRef.environmentId,
          threadId: parentThreadRef.threadId,
        },
      });
    },
    [navigate],
  );
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );

  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: threadPlanCatalog,
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThread?.id ?? null,
      }),
    [activeLatestTurn, activeThread?.id, latestTurnSettled, threadPlanCatalog],
  );
  const activePlan = useMemo(
    () => deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
  );
  const taskProgressProposedPlan = hasActionableProposedPlan(sidebarProposedPlan)
    ? sidebarProposedPlan
    : null;
  const taskProgressLabel =
    taskProgressProposedPlan || interactionMode === "plan" ? "Plan" : "Tasks";
  const taskProgressBadge = useMemo(
    () => derivePlanTaskBadge({ activePlan, activeProposedPlan: taskProgressProposedPlan }),
    [activePlan, taskProgressProposedPlan],
  );
  const sessionStopped = activeThread?.session?.orchestrationStatus === "stopped";
  const subagentActivityState = useMemo(
    () =>
      deriveThreadSubagentActivityState(
        derivationThreadKey,
        threadActivities,
        activeThread?.subagents,
        activeLatestTurn?.turnId ?? null,
        latestTurnSettled,
        sessionStopped,
      ),
    [
      activeLatestTurn?.turnId,
      activeThread?.subagents,
      derivationThreadKey,
      latestTurnSettled,
      sessionStopped,
      threadActivities,
    ],
  );
  const subagentProgress = subagentActivityState.progress;
  // The turn-scoped progress above empties when the turn settles. The panel's
  // history section and the conversation's receipts both need the thread's whole
  // roster, which the same activities answer without the turn filter.
  const subagentHistory = subagentActivityState.history;
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  // What a send that awaited a decline reads afterwards: the requests now.
  const pendingApprovalsRef = useRef(pendingApprovals);
  pendingApprovalsRef.current = pendingApprovals;
  const pendingUserInputsRef = useRef(pendingUserInputs);
  pendingUserInputsRef.current = pendingUserInputs;
  const {
    beginLocalDispatch,
    markLocalDispatchAccepted,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree: isPreparingWorktreeDispatch,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: pendingUserInputs.find(isBlockingUserInput)?.requestId ?? null,
    threadError: activeThread?.error,
  });
  // Raised for the whole bootstrap request; dropped as soon as the thread
  // reports its worktree so the label never outlives the work it describes.
  const isPreparingWorktree = isPreparingWorktreeDispatch && !activeThread?.worktreePath;
  const isWorking =
    phase === "running" ||
    phase === "connecting" ||
    isSessionStarting ||
    isSendBusy ||
    isConnecting ||
    isRevertingCheckpoint;
  const activeTurnInProgress = isWorking || (activeLatestTurn !== null && !latestTurnSettled);
  const continueInProjectDisabledReason = useMemo(() => {
    if (activeEnvironmentUnavailable) {
      return "Reconnect this environment before continuing into a project.";
    }
    if (phase === "connecting" || isSessionStarting || isConnecting) {
      return "Wait for this thread to reconnect before continuing into a project.";
    }
    if (isRevertingCheckpoint) {
      return "Wait for the checkpoint revert to finish before continuing into a project.";
    }
    if (phase === "running" || isSendBusy || (activeLatestTurn !== null && !latestTurnSettled)) {
      return "Wait for the current response to finish before continuing into a project.";
    }
    return null;
  }, [
    activeEnvironmentUnavailable,
    activeLatestTurn,
    isConnecting,
    isRevertingCheckpoint,
    isSendBusy,
    isSessionStarting,
    latestTurnSettled,
    phase,
  ]);
  // While the agent's own program starts, the working row and the slow-start
  // notice name it, and its computer when the app is connected to more than
  // one. During a hand-over the instance starting is not yet the session's.
  const launchingInstanceId = isSessionStarting
    ? (activeThread?.session?.launchingInstanceId ?? null)
    : null;
  const launchingAgentName = useMemo(
    () =>
      launchingInstanceId === null
        ? null
        : (getProviderInstanceEntry(providerStatuses, launchingInstanceId)?.displayName ?? null),
    [launchingInstanceId, providerStatuses],
  );
  const launchingComputerName = useMemo(() => {
    if (launchingInstanceId === null || !activeThread) return null;
    const environmentId = activeThread.environmentId;
    return deriveThreadComputerName({
      threadEnvironmentId: environmentId,
      primaryEnvironmentId,
      connectedEnvironmentIds: Object.entries(savedEnvironmentRuntimeById).flatMap(
        ([savedEnvironmentId, runtime]) =>
          runtime?.connectionState === "connected" ? [savedEnvironmentId] : [],
      ),
      computerLabel:
        savedEnvironmentRuntimeById[environmentId]?.descriptor?.label ??
        savedEnvironmentRegistry[environmentId]?.label ??
        serverConfig?.environment.label,
    });
  }, [
    activeThread,
    launchingInstanceId,
    primaryEnvironmentId,
    savedEnvironmentRegistry,
    savedEnvironmentRuntimeById,
    serverConfig?.environment.label,
  ]);
  // A new object only when the name changes, so the notice keeps its memo.
  const launchingStartupNotice = useMemo(
    () => (launchingInstanceId === null ? null : { agentName: launchingAgentName }),
    [launchingAgentName, launchingInstanceId],
  );
  const activeStatusLabel = deriveActiveStatusLabel({
    phase,
    workLogEntries,
    latestTurnId: activeLatestTurn?.turnId ?? null,
    isConnecting,
    isSendBusy,
    isPreparingWorktree,
    isSessionStarting,
    launchingAgent:
      launchingInstanceId === null
        ? null
        : describeLaunchingAgent({
            agentName: launchingAgentName,
            computerName: launchingComputerName,
          }),
    isRevertingCheckpoint,
    pendingApprovalCount: pendingApprovals.length,
    // A non-blocking question does not hold the turn, so it must not read as
    // "Waiting for input" while the agent is still working.
    pendingUserInputCount: pendingUserInputs.filter(isBlockingUserInput).length,
  });
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThread?.session ?? null,
    localDispatchStartedAt,
  );
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoff = useCallback(
    (messageId: MessageId, previewUrls?: ReadonlyArray<string>) => {
      delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
      const currentPreviewUrls =
        previewUrls ?? attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) {
          return existing;
        }
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      for (const previewUrl of currentPreviewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    },
    [],
  );
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    attachmentPreviewPromotionInFlightByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });
  }, []);
  const serverMessages = activeThread?.messages;
  const activeThreadSteeringMessages = useMemo(
    () =>
      Object.values(steeringMessagesById).filter(
        (message) => message.threadKey === activeThreadKey,
      ),
    [activeThreadKey, steeringMessagesById],
  );
  const queuedSteeringMessages = useMemo(
    () => activeThreadSteeringMessages.filter((message) => message.status === "queued"),
    [activeThreadSteeringMessages],
  );
  const queuedSteeringMessageIds = useMemo(
    () => new Set(queuedSteeringMessages.map((message) => message.id)),
    [queuedSteeringMessages],
  );
  const failedSteeringMessageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const activity of threadActivities) {
      if (activity.kind !== "provider.follow-up.failed") {
        continue;
      }
      const payload = activity.payload;
      if (
        typeof payload === "object" &&
        payload !== null &&
        "requestId" in payload &&
        typeof payload.requestId === "string"
      ) {
        ids.add(payload.requestId);
      }
    }
    return ids;
  }, [threadActivities]);

  const queuedFollowUps = activeThread?.queuedFollowUps ?? EMPTY_QUEUED_FOLLOW_UPS;
  const queuedFollowUpIds = useMemo(
    () => new Set<string>(queuedFollowUps.map((followUp) => followUp.messageId)),
    [queuedFollowUps],
  );
  useEffect(() => {
    if (!activeThreadKey) {
      return;
    }

    const serverMessageIds = new Set((serverMessages ?? []).map((message) => message.id));
    setSteeringMessagesById((existing) => {
      return reconcileSteeringHandoffStatuses({
        messagesById: existing,
        activeThreadKey,
        latestTurn: activeThread?.latestTurn,
        serverMessageIds,
        failedMessageIds: failedSteeringMessageIds,
        queuedMessageIds: queuedFollowUpIds,
      });
    });
  }, [
    activeThread?.latestTurn,
    activeThreadKey,
    failedSteeringMessageIds,
    queuedFollowUpIds,
    serverMessages,
  ]);
  // A steer the provider refused outright (one that merely missed its turn is
  // queued by the server instead) must not take the typed text with it.
  const restoredFailedSteerIdsRef = useRef(new Set<string>());
  useEffect(() => {
    for (const message of activeThreadSteeringMessages) {
      if (
        message.status !== "queued" ||
        !failedSteeringMessageIds.has(message.id) ||
        restoredFailedSteerIdsRef.current.has(message.id)
      ) {
        continue;
      }
      restoredFailedSteerIdsRef.current.add(message.id);
      const nextPrompt = appendRestoredFollowUpText(promptRef.current, [message.text]);
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      composerRef.current?.resetCursorState({
        cursor: collapseExpandedComposerCursor(nextPrompt, nextPrompt.length),
        prompt: nextPrompt,
      });
    }
  }, [
    activeThreadSteeringMessages,
    composerDraftTarget,
    composerRef,
    failedSteeringMessageIds,
    setComposerDraftPrompt,
  ]);
  useEffect(() => {
    if (typeof Image === "undefined" || !serverMessages || serverMessages.length === 0) {
      return;
    }

    const cleanups: Array<() => void> = [];

    for (const [messageId, handoffPreviewUrls] of Object.entries(
      attachmentPreviewHandoffByMessageId,
    )) {
      if (attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId]) {
        continue;
      }

      const serverMessage = serverMessages.find(
        (message) => message.id === messageId && message.role === "user",
      );
      if (!serverMessage?.attachments || serverMessage.attachments.length === 0) {
        continue;
      }

      const serverPreviewUrls = serverMessage.attachments.flatMap((attachment) =>
        attachment.type === "image" && attachment.previewUrl ? [attachment.previewUrl] : [],
      );
      if (
        serverPreviewUrls.length === 0 ||
        serverPreviewUrls.length !== handoffPreviewUrls.length ||
        serverPreviewUrls.some((previewUrl) => previewUrl.startsWith("blob:"))
      ) {
        continue;
      }

      attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId] = true;

      let cancelled = false;
      const imageInstances: HTMLImageElement[] = [];

      const preloadServerPreviews = Promise.all(
        serverPreviewUrls.map(
          (previewUrl) =>
            new Promise<void>((resolve, reject) => {
              const image = new Image();
              imageInstances.push(image);
              const handleLoad = () => resolve();
              const handleError = () =>
                reject(new Error(`Failed to load server preview for ${messageId}.`));
              image.addEventListener("load", handleLoad, { once: true });
              image.addEventListener("error", handleError, { once: true });
              image.src = previewUrl;
            }),
        ),
      );

      void preloadServerPreviews
        .then(() => {
          if (cancelled) {
            return;
          }
          clearAttachmentPreviewHandoff(messageId as MessageId, handoffPreviewUrls);
        })
        .catch(() => {
          if (!cancelled) {
            delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
          }
        });

      cleanups.push(() => {
        cancelled = true;
        delete attachmentPreviewPromotionInFlightByMessageIdRef.current[messageId];
        for (const image of imageInstances) {
          image.src = "";
        }
      });
    }

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [attachmentPreviewHandoffByMessageId, clearAttachmentPreviewHandoff, serverMessages]);
  const timelineMessages = useMemo(() => {
    const messages =
      queuedSteeringMessageIds.size === 0
        ? (serverMessages ?? [])
        : (serverMessages ?? []).filter((message) => !queuedSteeringMessageIds.has(message.id));
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    // Pending rows have no server event yet. Keep their submission order at
    // the end until the server replaces them with acknowledged messages.
    return [
      ...serverMessagesWithPreviewHandoff,
      ...pendingMessages.map((message, index) => ({
        ...message,
        eventSequence: Number.MAX_SAFE_INTEGER - pendingMessages.length + index,
      })),
    ];
  }, [
    serverMessages,
    queuedSteeringMessageIds,
    attachmentPreviewHandoffByMessageId,
    optimisticUserMessages,
  ]);
  const sideAnswers = useMemo(
    () =>
      deriveThreadSideAnswers(
        derivationThreadKey,
        timelineMessages,
        allThreadActivities,
        activeThread?.sideTurn,
      ),
    [activeThread?.sideTurn, allThreadActivities, derivationThreadKey, timelineMessages],
  );
  // Every turn that has come near the screen in this thread. Those whose steps
  // the live feed cut are fetched, and stay fetched while the thread is open.
  const [seenTurns, setSeenTurns] = useState<{
    readonly threadId: ThreadId | null;
    readonly turnIds: ReadonlyArray<TurnId>;
  }>(NO_SEEN_TURNS);
  const handleVisibleTurnIdsChange = useCallback(
    (turnIds: ReadonlyArray<TurnId>) => {
      setSeenTurns((current) => {
        const seen = current.threadId === activeThreadId ? current.turnIds : EMPTY_TURN_IDS;
        const added = turnIds.filter((turnId) => !seen.includes(turnId));
        if (added.length === 0 && current.threadId === activeThreadId) {
          return current;
        }
        return { threadId: activeThreadId, turnIds: [...seen, ...added] };
      });
    },
    [activeThreadId],
  );
  const cutTurnIds = useMemo(
    () =>
      turnsWithCutSteps({
        activities: allThreadActivities,
        messages: timelineMessages,
        activeTurnId,
      }),
    [activeTurnId, allThreadActivities, timelineMessages],
  );
  const historyTurnIds = useMemo(
    () =>
      seenTurns.threadId === activeThreadId && cutTurnIds.size > 0
        ? seenTurns.turnIds.filter((turnId) => cutTurnIds.has(turnId))
        : EMPTY_TURN_IDS,
    [activeThreadId, cutTurnIds, seenTurns],
  );
  const turnStepHistory = useTurnStepHistory({
    environmentId,
    threadId: activeThreadId,
    turnIds: historyTurnIds,
  });
  const timelineWorkEntries = useMemo(
    () => mergeTurnStepHistory(workLogEntries, turnStepHistory),
    [turnStepHistory, workLogEntries],
  );
  const timelineEntries = useMemo(
    () =>
      deriveThreadTimelineEntries(
        derivationThreadKey,
        timelineMessages,
        activeThread?.proposedPlans ?? EMPTY_PROPOSED_PLANS,
        timelineWorkEntries,
        subagentActivityState.resultEntries,
        forkContextEntries,
        subagentActivityState.liveEntries,
        activeThread?.pages ?? EMPTY_AGENT_PAGES,
        activeThread?.commandRequests ?? EMPTY_COMMAND_REQUESTS,
        workflowRunsAsShown(activeThread?.workflowRuns ?? EMPTY_WORKFLOW_RUNS),
        movedInEntries,
      ),
    [
      activeThread?.commandRequests,
      activeThread?.pages,
      activeThread?.workflowRuns,
      activeThread?.proposedPlans,
      forkContextEntries,
      movedInEntries,
      subagentActivityState.liveEntries,
      subagentActivityState.resultEntries,
      timelineMessages,
      timelineWorkEntries,
      derivationThreadKey,
    ],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(
    () =>
      deriveTurnDiffSummaryByAssistantMessageId(
        derivationThreadKey,
        activeThread?.messages ?? EMPTY_MESSAGES,
        turnDiffSummaries,
      ),
    [activeThread?.messages, derivationThreadKey, turnDiffSummaries],
  );
  const threadHasRoomHistory = hasRoomHistory(activeThread);
  // An agent's invite still open, or its review on the way back, would land
  // after a revert and talk about work that is gone; the server refuses it.
  // The same holds for threads it started (their answers would land on a
  // rewound chat) and for a parent's request waiting in this thread.
  const agentRequestsInFlight =
    (activeThread?.agentRequests?.open.length ?? 0) > 0 ||
    (activeThread?.childRequests?.open.length ?? 0) > 0 ||
    (activeThread?.queuedFollowUps ?? []).some(isAgentOrigin);
  // Moving or moved to another computer: read-only here, so nothing to revert.
  const activeThreadMove = activeThread?.move ?? null;
  const threadMoveLocked = activeThreadMove !== null;
  const threadMoveLockText = activeThreadMove ? threadMoveLockReason(activeThreadMove) : null;
  const threadMoveComposerLock = useMemo(
    () => (threadMoveLockText === null ? null : { reason: threadMoveLockText }),
    [threadMoveLockText],
  );
  const revertTurnCountByUserMessageId = useMemo(
    () =>
      deriveThreadRevertTurnCountByUserMessageId(
        derivationThreadKey,
        timelineEntries,
        turnDiffSummaryByAssistantMessageId,
        inferredCheckpointTurnCountByTurnId,
        threadHasRoomHistory || agentRequestsInFlight || threadMoveLocked,
      ),
    [
      inferredCheckpointTurnCountByTurnId,
      timelineEntries,
      turnDiffSummaryByAssistantMessageId,
      threadHasRoomHistory,
      agentRequestsInFlight,
      threadMoveLocked,
      derivationThreadKey,
    ],
  );

  const gitCwd = activeProject
    ? resolveThreadWorkingCwd({
        projectCwd: activeProject.cwd,
        worktreePath: activeThread?.worktreePath ?? null,
        effectiveCwd: activeThread?.effectiveCwd ?? null,
      })
    : null;
  const gitStatusQuery = useGitStatus({ environmentId, cwd: gitCwd });
  // A thread that owns its worktree follows the branch that worktree is on: a
  // checkout switched from the shell or by the agent must not leave the record,
  // and with it the pull request badge, on the branch the thread began with.
  const branchToRecord = resolveThreadBranchToRecord({
    thread: isServerThread ? serverThread : undefined,
    cwd: gitCwd,
    checkoutRef: gitStatusQuery.data?.refName ?? null,
  });
  const recordedBranchKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (branchToRecord === null || !serverThread) return;
    const key = `${routeThreadKey}:${branchToRecord}`;
    if (recordedBranchKeyRef.current === key) return;
    recordedBranchKeyRef.current = key;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    api.orchestration
      .dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: serverThread.id,
        branch: branchToRecord,
      })
      .catch((error: unknown) => {
        console.warn("[chat] failed to record the worktree branch", error);
      });
  }, [branchToRecord, environmentId, routeThreadKey, serverThread]);
  // Watched separately from the thread's own checkout: when that checkout is
  // gone, the project root's status is what tells us whether there is still a
  // repository to fall back to. Same key as every other subscriber of this
  // path, so it costs a ref-count rather than a second subscription.
  const projectRootStatusQuery = useGitStatus({
    environmentId,
    cwd: activeProject?.cwd ?? null,
  });
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  // Prefer an instance-id match so a custom Codex instance (e.g.
  // `codex_personal`) surfaces its own status/message in the banner rather
  // than the default Codex's. Falls back to first-match-by-kind when no
  // saved instance id is available or the instance no longer exists.
  const activeProviderInstanceId =
    activeThread?.session?.providerInstanceId ?? activeThread?.modelSelection.instanceId ?? null;
  const activeProviderStatus = useMemo(() => {
    if (activeProviderInstanceId) {
      return (
        providerStatuses.find((status) => status.instanceId === activeProviderInstanceId) ?? null
      );
    }
    const defaultInstanceId = defaultInstanceIdForDriver(selectedProvider);
    return providerStatuses.find((status) => status.instanceId === defaultInstanceId) ?? null;
  }, [activeProviderInstanceId, providerStatuses, selectedProvider]);
  const activeProviderDriver =
    activeProviderStatus?.driver ?? activeThread?.session?.provider ?? selectedProvider;
  const activeProviderLabel =
    activeProviderStatus?.displayName?.trim() ||
    formatProviderDriverKindLabel(activeProviderDriver);
  const {
    isConsumingRateLimitResetCredit: isConsumingThreadErrorRateLimitResetCredit,
    requestRateLimitResetCredit: requestThreadErrorRateLimitResetCredit,
    rateLimitResetCreditDialog: threadErrorRateLimitResetCreditDialog,
  } = useProviderRateLimitResetCredit();
  const activeProviderResetCredits =
    activeProviderStatus?.accountUsage?.rateLimitResetCredits ?? null;
  const canResetActiveProviderUsage = canRequestProviderRateLimitResetCredit(
    activeProviderStatus,
    activeProviderResetCredits?.availableCount,
  );
  const requestActiveProviderUsageReset = useCallback(() => {
    if (!canResetActiveProviderUsage || !activeProviderStatus || !activeProviderResetCredits) {
      return;
    }
    requestThreadErrorRateLimitResetCredit({
      instanceId: activeProviderStatus.instanceId,
      providerLabel: activeProviderLabel,
      resetCredits: activeProviderResetCredits,
    });
  }, [
    activeProviderLabel,
    activeProviderResetCredits,
    activeProviderStatus,
    canResetActiveProviderUsage,
    requestThreadErrorRateLimitResetCredit,
  ]);
  const threadErrorUsageResetAction = useMemo(() => {
    if (
      !canResetActiveProviderUsage ||
      !activeProviderResetCredits ||
      !isProviderUsageLimitErrorMessage(activeThread?.error)
    ) {
      return null;
    }
    return {
      availableCount: activeProviderResetCredits.availableCount,
      isResetting: isConsumingThreadErrorRateLimitResetCredit,
      onReset: requestActiveProviderUsageReset,
    };
  }, [
    activeProviderResetCredits,
    activeThread?.error,
    canResetActiveProviderUsage,
    isConsumingThreadErrorRateLimitResetCredit,
    requestActiveProviderUsageReset,
  ]);
  const threadErrorUsageResetLink = useMemo(
    () =>
      isProviderUsageLimitErrorMessage(activeThread?.error)
        ? (providerExternalResetsLink(activeProviderStatus?.accountUsage) ?? null)
        : null,
    [activeProviderStatus?.accountUsage, activeThread?.error],
  );
  const activeProviderSupportsManualContextCompaction = providerSupportsManualContextCompaction(
    activeProviderStatus,
    activeProviderDriver,
  );
  const contextCompactActivityInProgress = useMemo(
    () => deriveThreadContextCompactionInProgress(derivationThreadKey, threadActivities),
    [derivationThreadKey, threadActivities],
  );
  const contextCompactInFlight =
    contextCompactActivityInProgress || contextCompactDispatchingThreadId === activeThread?.id;
  const contextCompactDisabledReason =
    activeThread === undefined || !isServerThread
      ? "Open a saved thread before compacting context."
      : !activeProviderSupportsManualContextCompaction
        ? `${activeProviderLabel} does not expose manual context compaction.`
        : phase === "running"
          ? "Context cannot be compacted while a response is running."
          : contextCompactInFlight
            ? "Context compaction is already running."
            : null;
  const contextCompactDisabled = contextCompactDisabledReason !== null;
  const contextCompactControlVisible = activeThread !== undefined && isServerThread;
  const providerAuthReconnectPrompt = useMemo(
    () =>
      deriveProviderAuthReconnectPrompt({
        provider: activeProviderDriver,
        providerStatus: activeProviderStatus,
        threadError: activeThread?.error ?? activeThread?.session?.lastError ?? null,
        activities: threadActivities,
        messages: timelineMessages,
      }),
    [
      activeProviderDriver,
      activeProviderStatus,
      activeThread?.error,
      activeThread?.session?.lastError,
      threadActivities,
      timelineMessages,
    ],
  );
  // The in-chat card runs the provider's terminal sign-in. A provider
  // Threadlines signs in itself has none: the composer notice's Sign in is its way.
  const providerAuthReconnectAction = useMemo<ProviderAuthReconnectAction | null>(
    () =>
      providerAuthReconnectPrompt?.command
        ? {
            provider: providerAuthReconnectPrompt.provider,
            command: providerAuthReconnectPrompt.command,
            message: providerAuthReconnectPrompt.message,
          }
        : null,
    [providerAuthReconnectPrompt],
  );
  // Set when a send was held back because the selected provider instance is
  // already known to be unusable. Cleared by dismissing the notice, by a clean
  // recheck, and by any later send that preflights clean.
  const [providerSendPreflight, setProviderSendPreflight] =
    useState<ProviderSendPreflightPrompt | null>(null);
  const [providerSendPreflightRecheckFailed, setProviderSendPreflightRecheckFailed] =
    useState(false);
  const [isRecheckingProviderSendPreflight, setIsRecheckingProviderSendPreflight] = useState(false);
  // The recheck runs the ordinary send path, which is rebuilt every render.
  // Holding it behind a ref keeps the notice itself stable.
  const confirmProviderSignedInRef = useRef<() => void>(() => {});
  // One sign-in flow serves every composer notice: the held-send row and the
  // provider-status row are mutually suppressed, and both speak about the
  // instance the composer would send to.
  const composerSignInInstanceId =
    providerSendPreflight?.instanceId ?? activeProviderStatus?.instanceId ?? null;
  const hasHeldSendRef = useRef(false);
  hasHeldSendRef.current = providerSendPreflight !== null;
  const composerSignInView = useThreadProviderSignIn({
    instanceId: composerSignInInstanceId,
    // The thread's agent signs in on the computer the thread runs on.
    environmentId: threadComputerEnvironmentId,
    providerLabel: providerSendPreflight?.providerLabel ?? activeProviderLabel,
    // A held message is waiting on exactly this: re-probe and, if the provider
    // agrees, send it. Without this the user would sign in and then still have
    // to click "I've signed in".
    onSucceeded: () => {
      if (hasHeldSendRef.current) {
        confirmProviderSignedInRef.current();
      }
    },
  });
  useEffect(() => {
    // The notice belongs to the send it interrupted, so it must not follow the
    // user into another thread.
    setProviderSendPreflight(null);
    setProviderSendPreflightRecheckFailed(false);
  }, [activeThreadKey]);
  const providerStatusNoticeVisible = shouldShowProviderStatusNotice(activeProviderStatus, {
    activeTurnInProgress,
  });
  const hasInlineProviderAuthError = useMemo(
    () =>
      providerAuthReconnectAction !== null &&
      (workLogEntries.some((entry) => entry.authReconnect !== undefined) ||
        timelineMessages.some(
          (message) => message.role === "assistant" && isProviderAuthErrorChatMessage(message),
        )),
    [providerAuthReconnectAction, timelineMessages, workLogEntries],
  );
  const threadErrorNoticeVisible = shouldShowThreadErrorNotice({
    threadError: activeThread?.error,
    hasInlineProviderAuthError,
  });
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot =
    activeThread?.effectiveCwd ?? activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
  // A plan is live while the turn that wrote it is still running: only then do
  // its clocks tick and its current step say what the agent is on.
  const taskPlanLive =
    phase === "running" &&
    activePlan !== null &&
    activeTurnId !== null &&
    activePlan.turnId === activeTurnId;
  const taskCurrentStepStartedAt = taskPlanLive
    ? (activePlan?.steps.find((step) => step.status === "inProgress")?.startedAt ?? null)
    : null;
  const taskCurrentWork = useMemo(
    () =>
      taskPlanLive
        ? currentWorkLine(workLogEntries, {
            workspaceRoot: activeWorkspaceRoot,
            roomAgentNames,
            sinceMs: taskCurrentStepStartedAt ? Date.parse(taskCurrentStepStartedAt) : null,
          })
        : null,
    [activeWorkspaceRoot, roomAgentNames, taskCurrentStepStartedAt, taskPlanLive, workLogEntries],
  );
  const taskProgress = useMemo(
    () =>
      activePlan || taskProgressProposedPlan || taskProgressBadge
        ? {
            activePlan,
            activeProposedPlan: taskProgressProposedPlan,
            badge: taskProgressBadge,
            label: taskProgressLabel,
            live: taskPlanLive,
            currentWork: taskCurrentWork,
          }
        : null,
    [
      activePlan,
      taskCurrentWork,
      taskPlanLive,
      taskProgressBadge,
      taskProgressLabel,
      taskProgressProposedPlan,
    ],
  );
  const activeMcpAuthProviderInstanceId =
    activeProviderInstanceId ??
    (activeProviderDriver === CODEX_PROVIDER_DRIVER
      ? defaultInstanceIdForDriver(CODEX_PROVIDER_DRIVER)
      : null);
  const [mcpAuthReconnectStatusByKey, setMcpAuthReconnectStatusByKey] = useState<
    Record<string, McpAuthReconnectStatus>
  >({});
  const activeMcpAuthReconnectStatusByServerName = useMemo(() => {
    const statuses = new Map<string, McpAuthReconnectStatus>();
    if (!activeMcpAuthProviderInstanceId) {
      return statuses;
    }
    const keyPrefix = `${activeMcpAuthProviderInstanceId}\u001f`;
    for (const [key, status] of Object.entries(mcpAuthReconnectStatusByKey)) {
      if (key.startsWith(keyPrefix)) {
        statuses.set(key.slice(keyPrefix.length), status);
      }
    }
    return statuses;
  }, [activeMcpAuthProviderInstanceId, mcpAuthReconnectStatusByKey]);
  // Stays true for a checkout that was deleted, as long as the project root is
  // still a repository: hiding the picker there would remove the only way back
  // to a working checkout at exactly the moment the user needs it.
  const isGitRepo = shouldShowCheckoutPicker({
    selectedStatus: gitStatusQuery.data,
    projectRootStatus: projectRootStatusQuery.data,
  });
  const browserPanelState = useBrowserPanelStore((store) =>
    selectThreadBrowserState(store.browserStateByThreadKey, routeThreadRef),
  );
  const toggleBrowserOpen = useBrowserPanelStore((store) => store.toggleBrowserOpen);
  const setBrowserOpen = useBrowserPanelStore((store) => store.setBrowserOpen);

  /**
   * Showing a picked element again is a request, not a call: the panel may be
   * closed, in which case it has to open and mount a webview before anything
   * can be highlighted. Handing it a pending request lets it act when it is
   * ready rather than making the caller guess at the timing.
   */
  const [pendingElementReveal, setPendingElementReveal] =
    useState<PickedElementContextDraft | null>(null);
  const revealPickedElement = useCallback(
    (context: PickedElementContextDraft) => {
      setBrowserOpen(routeThreadRef, true);
      setPendingElementReveal(context);
    },
    [routeThreadRef, setBrowserOpen],
  );
  const splitChatFraction = useBrowserPanelStore((store) => store.splitChatFraction);
  const setSplitChatFraction = useBrowserPanelStore((store) => store.setSplitChatFraction);
  const browserExpanded = useBrowserPanelStore((store) => store.expanded);
  // The preview is a Chromium webview, which only the desktop app can host: a
  // web build has no browser to toggle, so it gets no button and no panel.
  // General chats have no project and therefore no dev server to look at.
  const browserAvailable = isElectron && !isGeneralChatThread;
  const browserOpen = browserAvailable && browserPanelState.open;
  // Find in chat opens for a saved chat whose column is on screen, on any
  // screen but a phone's (a small touch screen); narrow desktop windows keep it.
  const isPhoneLayout = useIsMobile() && isCoarsePointer;
  const canFindInChat = isServerThread && !(browserOpen && browserExpanded) && !isPhoneLayout;
  useEffect(() => {
    useChatFindStore.getState().setAvailable(canFindInChat);
  }, [canFindInChat]);
  useEffect(() => () => useChatFindStore.getState().setAvailable(false), []);
  useEffect(() => installFindRegionTracking(), []);

  const handleToggleBrowser = useCallback(() => {
    if (routeThreadRef !== null) {
      toggleBrowserOpen(routeThreadRef);
    }
  }, [routeThreadRef, toggleBrowserOpen]);
  const handleCloseBrowser = useCallback(() => {
    if (routeThreadRef !== null) {
      setBrowserOpen(routeThreadRef, false);
    }
  }, [routeThreadRef, setBrowserOpen]);
  const workingTreeChanges = useMemo(
    () => resolveWorkingTreeChanges(gitStatusQuery.data ?? null),
    [gitStatusQuery.data],
  );
  const remoteBehindCount = useMemo(
    () => resolveRemoteBehindCount(gitStatusQuery.data ?? null),
    [gitStatusQuery.data],
  );
  const terminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: true,
        terminalOpen: Boolean(terminalState.terminalOpen),
      },
    }),
    [terminalState.terminalOpen],
  );
  const nonTerminalShortcutLabelOptions = useMemo(
    () => ({
      context: {
        terminalFocus: false,
        terminalOpen: Boolean(terminalState.terminalOpen),
      },
    }),
    [terminalState.terminalOpen],
  );
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
  );
  const splitTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.split", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const findTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.find", terminalShortcutLabelOptions),
    [keybindings, terminalShortcutLabelOptions],
  );
  const sourceControlPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  /**
   * Writes the sidebar's active tab into the URL for whichever route this chat
   * column is rendered by. A null tab is the sidebar hidden or sitting on the
   * launcher; the strip state itself lives in the shared tab store, which the
   * route reads back on the next render.
   */
  const navigateToRightPanelTab = useCallback(
    (tab: RightPanelTab | null, diffTarget?: RightPanelDiffTarget | null) => {
      if (!activeThread) {
        return;
      }
      const nextSearch = (previous: Record<string, unknown>) =>
        rightPanelTabSearchParams(previous, tab, diffTarget);
      if (routeKind === "draft" && draftId) {
        void navigate({
          to: "/draft/$draftId",
          params: buildDraftThreadRouteParams(draftId),
          replace: true,
          search: nextSearch,
        });
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId,
          threadId,
        },
        replace: true,
        search: nextSearch,
      });
    },
    [activeThread, draftId, environmentId, navigate, routeKind, threadId],
  );

  const openRightPanelTab = useCallback(
    (tab: RightPanelTab, diffTarget?: RightPanelDiffTarget | null) => {
      if (!activeThread || !rightPanelAvailableTabs.includes(tab)) {
        return;
      }
      focusRightPanelTab(rightPanelStateKey, tab);
      navigateToRightPanelTab(tab, diffTarget);
    },
    [activeThread, navigateToRightPanelTab, rightPanelAvailableTabs, rightPanelStateKey],
  );

  /**
   * The header's one sidebar entry point: it shows and hides the sidebar
   * itself. Showing lands on the tab this thread was left on, and on the
   * launcher when nothing is open — never on a bare panel.
   */
  const onToggleRail = useCallback(() => {
    if (!activeThread) {
      return;
    }
    if (rightPanelEngaged) {
      hideRightPanel(rightPanelStateKey);
      navigateToRightPanelTab(null);
      return;
    }
    const { activeTab, diffTarget } = showRightPanel(rightPanelStateKey, rightPanelAvailableTabs);
    if (activeTab !== null) {
      navigateToRightPanelTab(activeTab, activeTab === "diff" ? diffTarget : null);
    }
  }, [
    activeThread,
    navigateToRightPanelTab,
    rightPanelAvailableTabs,
    rightPanelEngaged,
    rightPanelStateKey,
  ]);

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );

  // Handle environment change for draft threads.  When the user picks a
  // different environment we update the draft context to point at the physical
  // project in that environment while keeping the same logical project.
  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      if (envLocked || !draftId) return;
      const target = logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      );
      if (!target) return;
      setDraftThreadContext(draftId, {
        projectRef: scopeProjectRef(target.environmentId, target.projectId),
      });
      // The move drops the draft's agents: they were the old computer's.
      void applyMovedDraftDefaults(draftId, target.environmentId);
    },
    [draftId, envLocked, logicalProjectEnvironments, setDraftThreadContext],
  );

  // A new thread can also go to a computer that hasn't got the project yet:
  // the picker offers to set it up there, and once that's done the draft
  // moves to the new copy if it is still on this project.
  const setupTargets = useProjectSetupTargets(
    !envLocked && draftId && activeProject
      ? scopeProjectRef(activeProject.environmentId, activeProject.id)
      : null,
  );
  // Which draft is on screen now: a setup that ends later moves only that one.
  const openDraftIdRef = useRef(draftId);
  openDraftIdRef.current = draftId;
  useEffect(
    () => () => {
      openDraftIdRef.current = null;
    },
    [],
  );
  const onSetUpElsewhere = useCallback(() => {
    if (!draftId || !activeProject) return;
    if (!useComposerDraftStore.getState().getDraftSession(draftId)) return;
    const from = scopeProjectRef(activeProject.environmentId, activeProject.id);
    openProjectSetupDialog({
      project: from,
      onDone: (result) =>
        void moveDraftToSetUpProject({
          draftId,
          from,
          to: scopeProjectRef(result.environmentId, result.projectId),
          isOpen: () => openDraftIdRef.current === draftId,
        }),
    });
  }, [activeProject, draftId]);

  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      group.terminalIds.includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup?.terminalIds.length ?? 0) >= MAX_TERMINALS_PER_GROUP;
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      const nextError = sanitizeThreadErrorMessage(error);
      const isCurrentServerThread = shouldWriteThreadErrorToCurrentServerThread({
        serverThread,
        routeThreadRef,
        targetThreadId,
      });
      if (isCurrentServerThread) {
        setStoreThreadError(targetThreadId, nextError);
        return;
      }
      const localDraftErrorKey = draftId ?? targetThreadId;
      setLocalDraftErrorsByDraftId((existing) => {
        if ((existing[localDraftErrorKey] ?? null) === nextError) {
          return existing;
        }
        return {
          ...existing,
          [localDraftErrorKey]: nextError,
        };
      });
    },
    [draftId, routeThreadRef, serverThread, setStoreThreadError],
  );

  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, []);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
  useEffect(() => {
    if (composerFocusRequest > 0) {
      scheduleComposerFocus();
    }
  }, [composerFocusRequest, scheduleComposerFocus]);
  const addTerminalContextToDraft = useCallback((selection: TerminalContextSelection) => {
    composerRef.current?.addTerminalContext(selection);
  }, []);
  const addTranscriptHighlightContextToDraft = useCallback(
    (selection: TranscriptHighlightContextSelection) => {
      composerRef.current?.addTranscriptHighlightContext(selection);
    },
    [],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadRef) return;
      storeSetTerminalOpen(activeThreadRef, open);
    },
    [activeThreadRef, storeSetTerminalOpen],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadRef) return;
    const opening = !terminalState.terminalOpen;
    // In sheet mode the right panel covers the chat column the drawer lives
    // in, so a terminal opened behind it would be invisible — close the
    // panel and let the drawer take the stage.
    if (opening && shouldUseRightPanelSheet && rightPanelEngaged) {
      hideRightPanel(rightPanelStateKey);
      navigateToRightPanelTab(null);
    }
    setTerminalOpen(opening);
  }, [
    activeThreadRef,
    navigateToRightPanelTab,
    rightPanelEngaged,
    rightPanelStateKey,
    setTerminalOpen,
    shouldUseRightPanelSheet,
    terminalState.terminalOpen,
  ]);
  const splitTerminal = useCallback(() => {
    if (!activeThreadRef || hasReachedSplitLimit) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadRef, hasReachedSplitLimit, storeSplitTerminal]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadRef) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadRef, storeNewTerminal]);
  // A tab the server picked for a suggested command or a script
  // (docs/terminal-command-runs.md), brought forward with the keyboard in it.
  // A tab it just opened may not have reached the tab list yet: it is added
  // here, and kept until the server's list has it.
  const showTerminalTab = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef) return;
      if (terminalState.terminalIds.includes(terminalId)) {
        storeSetActiveTerminal(activeThreadRef, terminalId);
      } else {
        noteTerminalMadeOnServer(activeThreadRef, terminalId);
        storeNewTerminal(activeThreadRef, terminalId);
      }
      setTerminalOpen(true);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadRef,
      setTerminalOpen,
      storeNewTerminal,
      storeSetActiveTerminal,
      terminalState.terminalIds,
    ],
  );
  // A new worktree's setup script, asked for on this device, comes forward
  // when it starts. Other devices only see its tab appear in the list.
  const setupRevealRef = useRef<{ threadId: ThreadId; since: string } | null>(null);
  useEffect(() => {
    const pending = setupRevealRef.current;
    if (!pending || pending.threadId !== activeThreadId) return;
    const started = threadActivities.findLast(
      (activity) => activity.kind === "setup-script.started" && activity.createdAt >= pending.since,
    );
    const payload = started?.payload;
    const terminalId =
      typeof payload === "object" &&
      payload !== null &&
      "terminalId" in payload &&
      typeof payload.terminalId === "string"
        ? payload.terminalId
        : null;
    if (terminalId === null) return;
    setupRevealRef.current = null;
    showTerminalTab(terminalId);
  }, [activeThreadId, showTerminalTab, threadActivities]);
  const commandRunAgentLabel = useCallback(
    (participantId: ThreadParticipantId | null) =>
      roomAgentLabels?.get(roomAgentKey(participantId))?.name ?? activeProviderLabel,
    [activeProviderLabel, roomAgentLabels],
  );
  const commandRunActions = useCommandRunActions({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThread?.id ?? null,
    runs: activeThread?.commandRuns,
    cwd: gitCwd,
    projectCwd: activeProject?.cwd ?? null,
    worktreePath: activeThread?.worktreePath ?? null,
    terminalIds: terminalState.terminalIds,
    focusTerminal: showTerminalTab,
    agentLabel: commandRunAgentLabel,
  });
  const performCloseTerminal = useCallback(
    (
      targetThreadRef: { environmentId: EnvironmentId; threadId: ThreadId },
      targetThreadId: ThreadId,
      terminalId: string,
    ) => {
      const api = readEnvironmentApi(targetThreadRef.environmentId);
      if (!api) return;
      const targetTerminalState = selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        targetThreadRef,
      );
      const isFinalTerminal = targetTerminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: targetThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: targetThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: targetThreadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
      storeCloseTerminal(targetThreadRef, terminalId);
      dropTerminalBuffer(targetThreadRef.environmentId, targetThreadId, terminalId);
      removeComposerDraftTerminalContextsForTerminal(targetThreadRef, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [removeComposerDraftTerminalContextsForTerminal, storeCloseTerminal],
  );
  // A new shell in the thread's folder now, below the old one's output.
  const performRestartTerminal = useCallback(
    (
      targetThreadRef: { environmentId: EnvironmentId; threadId: ThreadId },
      targetThreadId: ThreadId,
      terminalId: string,
    ) => {
      const api = readEnvironmentApi(targetThreadRef.environmentId);
      const state = useStore.getState();
      const thread = createThreadSelectorByRef(targetThreadRef)(state);
      const project = thread
        ? createProjectSelectorByRef(scopeProjectRef(thread.environmentId, thread.projectId))(state)
        : null;
      if (!api || !thread || !project) return;
      const worktreePath = thread.worktreePath ?? null;
      void api.terminal
        .restart({
          threadId: targetThreadId,
          terminalId,
          cwd: resolveThreadWorkingCwd({
            projectCwd: project.cwd,
            worktreePath,
            effectiveCwd: thread.effectiveCwd ?? null,
          }),
          ...(worktreePath !== null ? { worktreePath } : {}),
          cols: SCRIPT_TERMINAL_COLS,
          rows: SCRIPT_TERMINAL_ROWS,
          env: projectScriptRuntimeEnv({ project: { cwd: project.cwd }, worktreePath }),
        })
        .catch((error: unknown) => {
          setThreadError(
            targetThreadId,
            error instanceof Error ? error.message : "Couldn't restart the terminal.",
          );
        });
      setTerminalFocusRequestId((value) => value + 1);
    },
    [setThreadError],
  );
  const [pendingTerminalAction, setPendingTerminalAction] = useState<{
    kind: "kill" | "restart";
    threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
    threadId: ThreadId;
    terminalId: string;
  } | null>(null);
  /** Whether stopping this tab's shell would stop something. */
  const isTerminalBusy = useCallback(
    (targetThreadRef: { environmentId: EnvironmentId; threadId: ThreadId }, terminalId: string) => {
      const store = useTerminalStateStore.getState();
      return shouldConfirmTerminalKill({
        runningTerminalIds: selectThreadTerminalState(
          store.terminalStateByThreadKey,
          targetThreadRef,
        ).runningTerminalIds,
        terminalId,
        commandPending:
          store.terminalCommandPendingByKey[terminalKey(targetThreadRef, terminalId)] === true ||
          terminalLineRecentlyEntered(targetThreadRef, terminalId),
        sessionExited: false,
      });
    },
    [],
  );
  const requestRestartTerminal = useCallback(
    (
      targetThreadRef: { environmentId: EnvironmentId; threadId: ThreadId },
      targetThreadId: ThreadId,
      terminalId: string,
    ) => {
      if (isTerminalBusy(targetThreadRef, terminalId)) {
        setPendingTerminalAction({
          kind: "restart",
          threadRef: targetThreadRef,
          threadId: targetThreadId,
          terminalId,
        });
        return;
      }
      performRestartTerminal(targetThreadRef, targetThreadId, terminalId);
    },
    [isTerminalBusy, performRestartTerminal],
  );
  const requestCloseTerminal = useCallback(
    (
      targetThreadRef: { environmentId: EnvironmentId; threadId: ThreadId },
      targetThreadId: ThreadId,
      terminalId: string,
      options?: { sessionExited?: boolean },
    ) => {
      if (options?.sessionExited !== true && isTerminalBusy(targetThreadRef, terminalId)) {
        setPendingTerminalAction({
          kind: "kill",
          threadRef: targetThreadRef,
          threadId: targetThreadId,
          terminalId,
        });
        return;
      }
      performCloseTerminal(targetThreadRef, targetThreadId, terminalId);
    },
    [isTerminalBusy, performCloseTerminal],
  );
  // A tool call the thread already tracks as an agent is not a separate
  // background run. History is consulted alongside the live turn so a promoted
  // agent stays promoted after its spawning turn settles.
  const subagentSpawnCallIds = useMemo(
    () => deriveSubagentSpawnCallIds(derivationThreadKey, subagentHistory, subagentProgress?.items),
    [derivationThreadKey, subagentHistory, subagentProgress?.items],
  );
  const providerBackgroundSnapshot = useMemo(
    () =>
      deriveThreadProviderBackgroundRuns(
        derivationThreadKey,
        threadActivities,
        timelineMessages,
        activeThread?.session?.pendingBackgroundTaskCount ?? 0,
        subagentProgress?.activeCount ?? 0,
        activeTurnInProgress
          ? (activeThread?.session?.activeTurnId ?? activeLatestTurn?.turnId ?? null)
          : null,
        subagentSpawnCallIds,
        activeThread?.session?.awaitedBackgroundTasks,
        activeThread?.workflowRuns,
      ),
    [
      activeLatestTurn?.turnId,
      activeThread?.session?.awaitedBackgroundTasks,
      activeThread?.workflowRuns,
      activeThread?.session?.pendingBackgroundTaskCount,
      activeThread?.session?.activeTurnId,
      activeTurnInProgress,
      subagentProgress?.activeCount,
      subagentSpawnCallIds,
      threadActivities,
      timelineMessages,
      derivationThreadKey,
    ],
  );
  const providerBackgroundRuns = useMemo(
    () => providerBackgroundSnapshot.runs.map(toThreadBackgroundRunItem),
    [providerBackgroundSnapshot],
  );
  // Each live agent row's Stop, keyed by the call that launched the agent: a
  // `codex exec` run's process, or the agent's own task when its driver can
  // stop one task at a time.
  const promotedSubagentRuns = useMemo(() => {
    const runs = new Map<string, ThreadBackgroundRunItem>(
      [...providerBackgroundSnapshot.promotedSubagentRuns].map(([spawnCallId, run]) => [
        spawnCallId,
        toThreadBackgroundRunItem(run),
      ]),
    );
    const stoppable = providerBackgroundSnapshot.stoppableSubagentTasks;
    for (const item of subagentProgress?.items ?? EMPTY_SUBAGENT_ITEMS) {
      const spawnCallId = item.spawnCallId;
      if (!spawnCallId || runs.has(spawnCallId)) continue;
      const taskId =
        (item.transcriptAgentId !== null && stoppable.has(item.transcriptAgentId)
          ? item.transcriptAgentId
          : null) ??
        [...stoppable].find(([, toolUseId]) => toolUseId === spawnCallId)?.[0] ??
        null;
      if (taskId === null) continue;
      runs.set(spawnCallId, {
        id: `provider:${taskId}`,
        source: "provider",
        providerKind: "task",
        label: "the agent",
        detail: null,
        cwd: null,
        statusLabel: "Running",
        urls: [],
        terminalId: null,
        pid: null,
        port: null,
        elapsed: null,
        canStop: true,
        providerTaskId: taskId,
      });
    }
    return runs;
  }, [providerBackgroundSnapshot, subagentProgress?.items]);
  const backgroundRunDetectionUrls = useMemo(
    () => [...providerBackgroundSnapshot.detectionSeeds.urls].sort(),
    [providerBackgroundSnapshot],
  );
  const backgroundRunDetectionPids = useMemo(
    () => [...providerBackgroundSnapshot.detectionSeeds.pids].sort((left, right) => left - right),
    [providerBackgroundSnapshot],
  );
  const backgroundRunCommandHints = useMemo(
    () => providerBackgroundSnapshot.detectionSeeds.commandHints.slice(0, 12),
    [providerBackgroundSnapshot],
  );
  const [stoppedBackgroundRunPids, setStoppedBackgroundRunPids] = useState<number[]>([]);
  useEffect(() => {
    setStoppedBackgroundRunPids([]);
  }, [activeThreadId]);
  const stoppedBackgroundRunPidSet = useMemo(
    () => new Set(stoppedBackgroundRunPids),
    [stoppedBackgroundRunPids],
  );
  const unresolvedBackgroundRunDetectionPids = useMemo(
    () => backgroundRunDetectionPids.filter((pid) => !stoppedBackgroundRunPidSet.has(pid)),
    [backgroundRunDetectionPids, stoppedBackgroundRunPidSet],
  );
  const [detectedBackgroundRuns, setDetectedBackgroundRuns] = useState<ThreadBackgroundRunItem[]>(
    [],
  );
  const backgroundRunResolutionTailRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (
      !activeThreadId ||
      (backgroundRunDetectionUrls.length === 0 &&
        unresolvedBackgroundRunDetectionPids.length === 0 &&
        backgroundRunCommandHints.length === 0)
    ) {
      setDetectedBackgroundRuns([]);
      return;
    }

    let localApi: ReturnType<typeof ensureLocalApi>;
    try {
      localApi = ensureLocalApi();
    } catch {
      setDetectedBackgroundRuns([]);
      return;
    }

    let cancelled = false;
    const retryTimers: number[] = [];
    function scheduleRetry(attemptIndex: number) {
      const delay = BACKGROUND_RUN_DETECTION_RETRY_DELAYS_MS[attemptIndex];
      if (delay === undefined) {
        return;
      }
      const timer = window.setTimeout(() => {
        const timerIndex = retryTimers.indexOf(timer);
        if (timerIndex >= 0) {
          retryTimers.splice(timerIndex, 1);
        }
        void resolveAttempt(attemptIndex);
      }, delay);
      retryTimers.push(timer);
    }
    function resolveAttempt(attemptIndex: number) {
      const queued = backgroundRunResolutionTailRef.current.then(async () => {
        if (cancelled) return;
        try {
          const result = await localApi.server.resolveBackgroundRuns({
            urls: backgroundRunDetectionUrls,
            pids: unresolvedBackgroundRunDetectionPids,
            commandHints: backgroundRunCommandHints,
          });
          if (cancelled) return;
          const resolvedAtMs = Date.now();
          setDetectedBackgroundRuns(
            result.runs.map((run) => {
              const providerRun = matchDetectedProviderRun({
                command: run.command,
                urls: run.urls,
                pid: run.pid,
                providerBackgroundRuns: providerBackgroundSnapshot.runs,
              });
              return {
                id: run.id,
                source: "detected",
                terminalId: null,
                pid: run.pid,
                port: run.port,
                elapsed: run.elapsed ?? null,
                startedAt: processStartedAt(run.elapsed, resolvedAtMs),
                canStop: run.canStop,
                label:
                  providerRun?.label ??
                  deriveDetectedBackgroundRunLabel({
                    command: run.command,
                    port: run.port,
                    providerBackgroundRuns: [],
                  }),
                command: run.command,
                detail: run.detail,
                cwd: null,
                statusLabel: run.statusLabel,
                urls: run.urls,
                pids: [run.pid],
                outputFile: providerRun?.outputFile ?? null,
              };
            }),
          );
          const detectedUrlSet = new Set(result.runs.flatMap((run) => run.urls));
          const detectedPidSet = new Set(result.runs.map((run) => run.pid));
          const hasUndetectedUrl = backgroundRunDetectionUrls.some(
            (url) => !detectedUrlSet.has(url),
          );
          const hasUndetectedPid = unresolvedBackgroundRunDetectionPids.some(
            (pid) => !detectedPidSet.has(pid),
          );
          if ((result.runs.length === 0 || hasUndetectedUrl || hasUndetectedPid) && !cancelled) {
            scheduleRetry(attemptIndex + 1);
          }
        } catch {
          if (cancelled) return;
          setDetectedBackgroundRuns([]);
          scheduleRetry(attemptIndex + 1);
        }
      });
      backgroundRunResolutionTailRef.current = queued.catch(() => undefined);
      return queued;
    }
    scheduleRetry(0);

    return () => {
      cancelled = true;
      for (const timer of retryTimers) {
        window.clearTimeout(timer);
      }
    };
  }, [
    activeThreadId,
    backgroundRunCommandHints,
    backgroundRunDetectionUrls,
    providerBackgroundSnapshot.runs,
    unresolvedBackgroundRunDetectionPids,
  ]);

  const backgroundRuns = useMemo(() => {
    const terminalNumbers = terminalTabNumbers(terminalState.terminalIds, activeTerminalTabs);
    const terminalCwdById = new Map(activeTerminalTabs.map((tab) => [tab.terminalId, tab.cwd]));
    const threadCwd = gitCwd ?? activeProject?.cwd ?? null;
    const terminalRuns = terminalState.runningTerminalIds.map((terminalId) => {
      const terminalLabel = `Terminal ${terminalNumbers.get(terminalId) ?? 1}`;
      const cwd = terminalCwdById.get(terminalId) ?? threadCwd;
      // The server's name for what runs: typed text only from a prompt,
      // else the process (a password typed into a program is never one).
      const command = selectTerminalActivityCommand(
        terminalActivityCommandByKey,
        activeThreadRef,
        terminalId,
      );
      return {
        id: `terminal:${terminalId}`,
        source: "terminal" as const,
        terminalId,
        pid: null,
        port: null,
        elapsed: null,
        startedAt: selectTerminalActivityStartedAt(
          terminalActivityStartedAtByKey,
          activeThreadRef,
          terminalId,
        ),
        canStop: true,
        label: command ?? terminalLabel,
        command,
        detail: command ? (cwd ? `${terminalLabel} - ${cwd}` : terminalLabel) : cwd,
        cwd,
        terminalVisible:
          terminalState.terminalOpen && terminalState.activeTerminalId === terminalId,
        statusLabel: "Running",
        urls: [],
      };
    });
    const unresolvedProviderRuns = filterUnresolvedProviderBackgroundRuns({
      providerBackgroundRuns,
      detectedBackgroundRuns: [
        ...detectedBackgroundRuns,
        ...stoppedBackgroundRunPids.map((pid) => ({ urls: [], pids: [pid] })),
      ],
    });

    return [...terminalRuns, ...detectedBackgroundRuns, ...unresolvedProviderRuns];
  }, [
    activeProject?.cwd,
    activeTerminalTabs,
    detectedBackgroundRuns,
    gitCwd,
    providerBackgroundRuns,
    stoppedBackgroundRunPids,
    activeThreadRef,
    terminalActivityCommandByKey,
    terminalActivityStartedAtByKey,
    terminalState.activeTerminalId,
    terminalState.runningTerminalIds,
    terminalState.terminalOpen,
    terminalState.terminalIds,
  ]);
  const toggleBackgroundRunTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef) return;
      if (terminalState.terminalOpen && terminalState.activeTerminalId === terminalId) {
        setTerminalOpen(false);
        return;
      }
      storeSetActiveTerminal(activeThreadRef, terminalId);
      setTerminalOpen(true);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [
      activeThreadRef,
      setTerminalOpen,
      storeSetActiveTerminal,
      terminalState.activeTerminalId,
      terminalState.terminalOpen,
    ],
  );
  /** A message an MCP app card asked to send: it goes into the composer,
   *  after anything already typed, for the user to send (docs/mcp-apps.md). */
  const putMcpAppMessage = useCallback(
    (text: string) => {
      const nextPrompt = appendRestoredFollowUpText(promptRef.current, [text]);
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      const composer = composerRef.current;
      composer?.resetCursorState({
        cursor: collapseExpandedComposerCursor(nextPrompt, nextPrompt.length),
        prompt: nextPrompt,
      });
      // After the editor has taken the new text: focusing reports what it
      // holds, and before then that is still the old prompt.
      window.requestAnimationFrame(() => composer?.focusAtEnd());
    },
    [composerDraftTarget, composerRef, setComposerDraftPrompt],
  );

  /**
   * Cancels an agent's check-backs. Nothing drops one schedule from a live
   * agent, so its runtime stops (only that agent's); work it left running
   * stops with it, which the user is asked about first.
   */
  const cancelCheckBack = useCallback(
    async (checkBack: OrchestrationCheckBack) => {
      if (!activeThreadId) return;
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      const session = activeThread?.session;
      // The thread's session says what its working agent left running; for
      // another agent in the room nothing here does, so the user is asked.
      const holdsSlot = (session?.participantId ?? null) === checkBack.participantId;
      const runningWork = holdsSlot ? (session?.pendingBackgroundTaskCount ?? 0) : 0;
      const stopBackgroundWork = runningWork > 0 || !holdsSlot;
      if (stopBackgroundWork) {
        const confirmed = await readLocalApi()?.dialogs.confirm(
          [
            "Cancel the check-back?",
            holdsSlot
              ? `This stops the agent's session, and ${
                  runningWork === 1
                    ? "the command it left running"
                    : `the ${runningWork} commands it left running`
                } with it.`
              : "This stops that agent's session, and anything it left running with it.",
          ].join("\n"),
        );
        if (!confirmed) return;
      }
      await api.orchestration
        .dispatchCommand({
          type: "thread.check-back.cancel",
          commandId: newCommandId(),
          threadId: activeThreadId,
          participantId: checkBack.participantId,
          stopBackgroundWork,
          createdAt: new Date().toISOString(),
        })
        .catch((error: unknown) => {
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : "Could not cancel the check-back.",
          );
        });
    },
    [activeThread?.session, activeThreadId, environmentId, setThreadError],
  );

  /** Stops one workflow run; the reactor finds the runtime that holds it. */
  const stopWorkflowRun = useCallback(
    (taskId: string) => {
      if (!activeThreadId) return;
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      void api.orchestration
        .dispatchCommand({
          type: "thread.background-task.stop",
          commandId: newCommandId(),
          threadId: activeThreadId,
          taskId: RuntimeTaskId.make(taskId),
          createdAt: new Date().toISOString(),
        })
        .catch((error: unknown) => {
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : "Could not stop the workflow.",
          );
        });
    },
    [activeThreadId, environmentId, setThreadError],
  );

  const stopBackgroundRun = useCallback(
    (run: ThreadBackgroundRunItem) => {
      if (!activeThreadRef || !activeThreadId) return;
      if (run.terminalId) {
        requestCloseTerminal(activeThreadRef, activeThreadId, run.terminalId);
        return;
      }
      // The agent stops its own task: it learns the task ended, and the wait
      // and counts settle from its answer. A pid would only kill the process.
      if (run.providerTaskId) {
        const api = readEnvironmentApi(activeThreadRef.environmentId);
        if (!api) return;
        void api.orchestration
          .dispatchCommand({
            type: "thread.background-task.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            taskId: RuntimeTaskId.make(run.providerTaskId),
            createdAt: new Date().toISOString(),
          })
          .catch((error: unknown) => {
            setThreadError(
              activeThreadId,
              error instanceof Error ? error.message : `Could not stop ${run.label}.`,
            );
          });
        return;
      }

      let localApi: ReturnType<typeof ensureLocalApi>;
      try {
        localApi = ensureLocalApi();
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Could not stop ${run.label}.`,
        );
        return;
      }

      const stopResolvedRun = (pid: number, port: number | null, id: string) =>
        localApi.server.stopBackgroundRun({ pid, port, signal: "SIGINT" }).then((result) => {
          if (result.signaled) {
            setStoppedBackgroundRunPids((current) =>
              current.includes(pid) ? current : [...current, pid],
            );
            setDetectedBackgroundRuns((current) => current.filter((item) => item.id !== id));
            return;
          }
          const message = Option.getOrUndefined(result.message);
          setThreadError(activeThreadId, message ?? `Could not stop ${run.label}.`);
        });

      if (run.pid !== null) {
        void stopResolvedRun(run.pid, run.port, run.id).catch((error: unknown) => {
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : `Could not stop ${run.label}.`,
          );
        });
        return;
      }

      const commandHints = [
        ...new Set(
          [run.command, ...(run.commandHints ?? [])].filter((hint): hint is string =>
            Boolean(hint && hint.trim().length > 0),
          ),
        ),
      ];
      if (commandHints.length === 0 && run.urls.length === 0 && (run.pids ?? []).length === 0) {
        setThreadError(activeThreadId, `Could not find a live process for ${run.label}.`);
        return;
      }

      void localApi.server
        .resolveBackgroundRuns({
          urls: [...run.urls],
          pids: [...(run.pids ?? [])],
          commandHints,
        })
        .then((result) => {
          const expectedCommand = backgroundRunCommandFingerprint(run.command);
          const resolvedRun =
            result.runs.find(
              (item) =>
                expectedCommand !== null &&
                backgroundRunCommandFingerprint(item.command) === expectedCommand,
            ) ??
            result.runs.find((item) => item.canStop) ??
            result.runs[0] ??
            null;
          if (!resolvedRun) {
            setThreadError(activeThreadId, `Could not find a live process for ${run.label}.`);
            return undefined;
          }
          if (!resolvedRun.canStop) {
            setThreadError(activeThreadId, `${run.label} is protected and cannot be stopped.`);
            return undefined;
          }
          return stopResolvedRun(resolvedRun.pid, resolvedRun.port, resolvedRun.id);
        })
        .catch((error: unknown) => {
          setThreadError(
            activeThreadId,
            error instanceof Error ? error.message : `Could not stop ${run.label}.`,
          );
        });
    },
    [activeThreadId, activeThreadRef, requestCloseTerminal, setThreadError],
  );

  // The detail-only activity slice exists in the store (even empty) exactly
  // from the thread's first detail snapshot, which is the honest "the agent
  // state below reflects loaded data" signal for consumers of the publish.
  const threadDetailHydrated = useStore((state) =>
    activeThreadRef
      ? selectEnvironmentState(state, activeThreadRef.environmentId).activityIdsByThreadId[
          activeThreadRef.threadId
        ] !== undefined
      : false,
  );
  // Whether the thread's messages are its history yet, or only what events and
  // this client wrote before its detail snapshot landed (threadDetailLoadedById).
  const threadDetailLoaded = useStore((state) => selectThreadDetailLoaded(state, activeThreadRef));
  // The agents panel mounts in the route's right-panel slot, beside the chat
  // column, so the live turn state it renders has to be published out of here.
  useEffect(() => {
    if (!activeThreadId) {
      publishAgentsPanelSource(null);
      return;
    }
    publishAgentsPanelSource({
      environmentId,
      threadId: activeThreadId,
      subagents: subagentProgress?.items ?? EMPTY_SUBAGENT_ITEMS,
      subagentRuns: promotedSubagentRuns,
      history: subagentHistory,
      providerInstanceId: activeProviderInstanceId,
      providerLabel: activeProviderDriver,
      turnInFlight: activeTurnInProgress,
      hydrated: threadDetailHydrated,
      threadCwd: gitCwd,
      workflowRuns: workflowRunsAsShown(activeThread?.workflowRuns ?? EMPTY_WORKFLOW_RUNS),
      onStopBackgroundRun: stopBackgroundRun,
      onStopWorkflowRun: stopWorkflowRun,
    });
  }, [
    activeThread?.workflowRuns,
    stopWorkflowRun,
    activeProviderDriver,
    activeProviderInstanceId,
    activeThreadId,
    activeTurnInProgress,
    environmentId,
    gitCwd,
    promotedSubagentRuns,
    stopBackgroundRun,
    subagentHistory,
    subagentProgress?.items,
    threadDetailHydrated,
  ]);
  useEffect(() => {
    if (!activeThreadId) {
      publishAgentsPanelActivitySource(null);
      return;
    }
    publishAgentsPanelActivitySource({
      environmentId,
      threadId: activeThreadId,
      workEntries: workLogEntries,
    });
  }, [activeThreadId, environmentId, workLogEntries]);
  useEffect(
    () => () => {
      publishAgentsPanelSource(null);
      publishAgentsPanelActivitySource(null);
    },
    [],
  );

  const confirmPendingTerminalAction = useCallback(() => {
    if (!pendingTerminalAction) return;
    const perform =
      pendingTerminalAction.kind === "kill" ? performCloseTerminal : performRestartTerminal;
    perform(
      pendingTerminalAction.threadRef,
      pendingTerminalAction.threadId,
      pendingTerminalAction.terminalId,
    );
    setPendingTerminalAction(null);
  }, [pendingTerminalAction, performCloseTerminal, performRestartTerminal]);
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId || !activeProject || !activeThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });

      try {
        // The server picks the first free tab (nothing typed or running in
        // it, same folder) and holds it for this script, or opens this new one.
        const opened = await api.terminal.open({
          threadId: activeThreadId,
          terminalId: `terminal-${randomUUID()}`,
          reuseTerminalIds: terminalState.terminalIds.slice(0, MAX_TERMINAL_REUSE_IDS),
          cwd: targetCwd,
          ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
          env: runtimeEnv,
          cols: SCRIPT_TERMINAL_COLS,
          rows: SCRIPT_TERMINAL_ROWS,
        });
        showTerminalTab(opened.terminalId);
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: opened.terminalId,
          data: `${script.command}\r`,
          origin: "script",
        });
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      gitCwd,
      setThreadError,
      setLastInvokedScriptByProjectId,
      showTerminalTab,
      environmentId,
      terminalState.terminalIds,
    ],
  );
  const runProviderAuthReconnect = useCallback(
    async (action?: ProviderAuthReconnectAction) => {
      const reconnectAction = action ?? providerAuthReconnectAction;
      if (!reconnectAction) {
        return;
      }
      const providerLabel =
        reconnectAction.provider === activeProviderDriver
          ? activeProviderLabel
          : formatProviderDriverKindLabel(reconnectAction.provider);
      await runProjectScript(
        {
          id: `provider-auth:${reconnectAction.provider}`,
          name: `${providerLabel} login`,
          command: reconnectAction.command,
          icon: "configure",
          runOnWorktreeCreate: false,
        },
        {
          rememberAsLastInvoked: false,
        },
      );
    },
    [activeProviderDriver, activeProviderLabel, providerAuthReconnectAction, runProjectScript],
  );

  const runMcpAuthReconnect = useCallback(
    async (action: McpAuthReconnectAction) => {
      if (action.provider !== CODEX_PROVIDER_DRIVER) {
        const providerLabel =
          action.provider === activeProviderDriver
            ? activeProviderLabel
            : formatProviderDriverKindLabel(action.provider);
        await runProjectScript(
          {
            id: `mcp-auth:${action.provider}:${action.serverName}`,
            name: `${providerLabel} ${action.serverLabel} MCP login`,
            command: action.terminalCommand,
            icon: "configure",
            runOnWorktreeCreate: false,
          },
          {
            rememberAsLastInvoked: false,
          },
        );
        return;
      }

      // The OAuth flow runs on the machine that owns this thread's provider; only
      // the browser prompt opens locally, where the user is sitting.
      const providersApi = readEnvironmentApi(environmentId)?.providers;
      if (!providersApi) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start MCP authorization",
            description: "This thread's machine is not connected.",
          }),
        );
        return;
      }

      const providerInstanceId =
        action.providerInstanceId ??
        (activeProviderDriver === action.provider && activeProviderInstanceId
          ? activeProviderInstanceId
          : defaultInstanceIdForDriver(action.provider));
      const statusKey = mcpAuthReconnectStateKey(providerInstanceId, action.serverName);
      let fallbackCommand = action.terminalCommand;

      setMcpAuthReconnectStatusByKey((current) => ({
        ...current,
        [statusKey]: "running",
      }));

      try {
        const baseInput = {
          providerInstanceId,
          ...(activeWorkspaceRoot ? { cwd: activeWorkspaceRoot } : {}),
        };
        const result = await providersApi.startExtensionMcpOAuth({
          ...baseInput,
          serverName: action.serverName,
          timeoutSecs: 300,
        });
        fallbackCommand = result.terminalCommand || fallbackCommand;
        if (result.authorizationUrl) {
          await ensureLocalApi().shell.openExternal(result.authorizationUrl);
        }

        const expiresAtMs = Date.parse(result.expiresAt);
        const deadlineMs =
          Number.isFinite(expiresAtMs) && expiresAtMs > 0
            ? expiresAtMs + 15_000
            : Date.now() + 315_000;

        while (Date.now() < deadlineMs) {
          await wait(1_500);
          const status = await providersApi.getExtensionOperationStatus({
            operationId: result.operationId,
          });

          if (status.status === "running") {
            continue;
          }

          if (status.status === "completed") {
            setMcpAuthReconnectStatusByKey((current) => ({
              ...current,
              [statusKey]: "completed",
            }));
            try {
              await providersApi.reloadExtensionMcpServers(baseInput);
              toastManager.add({
                type: "success",
                title: `${action.serverLabel} MCP authorized`,
                description: "MCP servers reloaded.",
              });
            } catch (reloadError) {
              console.warn("Failed to reload MCP servers after OAuth completion.", reloadError);
              toastManager.add(
                stackedThreadToast({
                  type: "warning",
                  title: `${action.serverLabel} MCP authorized`,
                  description:
                    reloadError instanceof Error
                      ? `Authorization completed, but MCP reload failed: ${reloadError.message}`
                      : "Authorization completed, but MCP reload failed.",
                }),
              );
            }
            return;
          }

          throw new Error(
            status.error
              ? `${status.message ?? status.status}\n\n${status.error}`
              : (status.message ?? status.status),
          );
        }

        throw new Error("OAuth timed out.");
      } catch (error) {
        setMcpAuthReconnectStatusByKey((current) => {
          const next = { ...current };
          delete next[statusKey];
          return next;
        });
        const message = error instanceof Error ? error.message : "MCP authorization failed.";
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not authorize ${action.serverLabel} MCP`,
            description: `${message}\n\nFallback: ${fallbackCommand}`,
          }),
        );
      }
    },
    [
      activeProviderDriver,
      activeProviderInstanceId,
      activeProviderLabel,
      activeWorkspaceRoot,
      environmentId,
      runProjectScript,
    ],
  );

  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        const localApi = readLocalApi();
        if (!localApi) {
          throw new Error("Local API unavailable.");
        }
        await localApi.server.upsertKeybinding(keybindingRule);
      }
    },
    [environmentId],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not delete action",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(composerDraftTarget, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      composerDraftTarget,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    }) => {
      if (!serverThread) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        return;
      }

      if (
        input.modelSelection !== undefined &&
        (input.modelSelection.model !== serverThread.modelSelection.model ||
          input.modelSelection.instanceId !== serverThread.modelSelection.instanceId ||
          JSON.stringify(input.modelSelection.options ?? null) !==
            JSON.stringify(serverThread.modelSelection.options ?? null))
      ) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadId,
          modelSelection: input.modelSelection,
        });
      }

      if (input.runtimeMode !== undefined && input.runtimeMode !== serverThread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (
        input.interactionMode !== undefined &&
        input.interactionMode !== serverThread.interactionMode
      ) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [environmentId, serverThread],
  );

  // Debounce *showing* the scroll-to-bottom pill so it doesn't flash during
  // thread switches.  LegendList fires scroll events with isAtEnd=false while
  // initialScrollAtEnd is settling; hiding is always immediate.
  const showScrollDebouncer = useRef(
    new Debouncer(
      () => {
        if (isLegendListVisiblyAtEnd(legendListRef.current)) {
          isAtEndRef.current = true;
          setShowScrollToBottom(false);
          return;
        }
        setShowScrollToBottom(true);
      },
      { wait: 150 },
    ),
  );

  const clearTimelineStickFrames = useCallback(() => {
    for (const frameId of timelineStickFrameIdsRef.current) {
      window.cancelAnimationFrame(frameId);
    }
    timelineStickFrameIdsRef.current = [];
  }, []);

  const requestTimelineStickToBottom = useCallback(
    async (animated = false) => {
      clearTimelineStickFrames();
      programmaticStickToBottomSuppressUntilRef.current =
        window.performance.now() + PROGRAMMATIC_STICK_TO_BOTTOM_SUPPRESS_MS;
      const stickToBottom = (nextAnimated: boolean) => {
        isAtEndRef.current = true;
        showScrollDebouncer.current.cancel();
        setShowScrollToBottom(false);
        setIsTimelineScrolledFarFromEnd(false);
        return legendListRef.current?.scrollToEnd?.({ animated: nextAnimated });
      };
      const scheduleSettlingFrame = (remainingFrames: number): void => {
        const frameId = window.requestAnimationFrame(() => {
          void stickToBottom(false);
          if (remainingFrames > 1) {
            scheduleSettlingFrame(remainingFrames - 1);
            return;
          }
          timelineStickFrameIdsRef.current = [];
        });
        timelineStickFrameIdsRef.current.push(frameId);
      };

      setStickToBottomRequestKey((current) => current + 1);
      await stickToBottom(animated);
      if (!animated) {
        scheduleSettlingFrame(LAYOUT_STICK_TO_BOTTOM_FRAME_COUNT);
      }
    },
    [clearTimelineStickFrames],
  );
  const scheduleTimelineStickToBottom = useCallback(() => {
    void requestTimelineStickToBottom(false);
  }, [requestTimelineStickToBottom]);

  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    const nextIsAtEnd = isAtEnd || isLegendListVisiblyAtEnd(legendListRef.current);
    const distanceFromEnd = legendListDistanceFromEnd(legendListRef.current);
    const farThresholdPx = questionsPanelCollapseThresholdPx();
    setIsTimelineScrolledFarFromEnd((current) =>
      deriveTimelineScrolledFarFromEnd({
        current,
        isAtEnd: nextIsAtEnd,
        distanceFromEnd,
        ...(farThresholdPx !== null ? { farThresholdPx } : {}),
      }),
    );
    if (isAtEndRef.current === nextIsAtEnd) return;
    if (
      !nextIsAtEnd &&
      window.performance.now() < programmaticStickToBottomSuppressUntilRef.current
    ) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      return;
    }
    isAtEndRef.current = nextIsAtEnd;
    if (nextIsAtEnd) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);

  useEffect(() => {
    setPullRequestDialogState(null);
    clearTimelineStickFrames();
    programmaticStickToBottomSuppressUntilRef.current = 0;
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    setIsTimelineScrolledFarFromEnd(false);
  }, [activeThread?.id, clearTimelineStickFrames]);

  useEffect(() => {
    return () => {
      clearTimelineStickFrames();
    };
  }, [clearTimelineStickFrames]);

  useEffect(() => {
    const activeThreadId = activeThread?.id ?? null;
    const isThreadEntry = layoutStickThreadIdRef.current !== activeThreadId;
    layoutStickThreadIdRef.current = activeThreadId;
    if (!activeThreadId) return;
    if (isThreadEntry && timelineSearchTargetRef.current) return;
    if (!isAtEndRef.current && !isLegendListVisiblyAtEnd(legendListRef.current)) {
      return;
    }

    const frameIds: number[] = [];
    const stickToBottom = () => {
      isAtEndRef.current = true;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      void legendListRef.current?.scrollToEnd?.({ animated: false });
    };
    const scheduleFrame = (remainingFrames: number) => {
      const frameId = window.requestAnimationFrame(() => {
        stickToBottom();
        if (remainingFrames > 1) {
          scheduleFrame(remainingFrames - 1);
        }
      });
      frameIds.push(frameId);
    };

    scheduleFrame(LAYOUT_STICK_TO_BOTTOM_FRAME_COUNT);

    return () => {
      for (const frameId of frameIds) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [
    activeThread?.id,
    infrastructureComposerNotices.length,
    providerSendPreflight,
    providerStatusNoticeVisible,
    terminalState.terminalHeight,
    terminalState.terminalOpen,
    threadErrorNoticeVisible,
  ]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  // Pristine drafts (the home surface) open without stealing focus; the
  // composer takes focus once a conversation exists or via an explicit action.
  const skipEntryComposerFocus = isLocalDraftThread && (activeThread?.messages.length ?? 0) === 0;
  useEffect(() => {
    if (
      !activeThread?.id ||
      skipEntryComposerFocus ||
      timelineSearchTargetRef.current ||
      terminalState.terminalOpen ||
      isCoarsePointer
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    activeThread?.id,
    focusComposer,
    isCoarsePointer,
    skipEntryComposerFocus,
    terminalState.terminalOpen,
  ]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      removeOptimisticThreadMessages(routeThreadRef, serverIds);
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [
    activeThread?.id,
    activeThread?.messages,
    handoffAttachmentPreviews,
    optimisticUserMessages,
    removeOptimisticThreadMessages,
    routeThreadRef,
  ]);

  useEffect(() => {
    resetLocalDispatch();
    closeExpandedImagePreview();
    setPreviewedFile(null);
  }, [draftId, resetLocalDispatch, threadId]);

  const closePreviewedFile = useCallback(() => {
    setPreviewedFile(null);
  }, []);

  const onPreviewFile = useCallback((request: FilePreviewRequest) => {
    setPreviewedFile(request);
  }, []);

  const activeWorktreePath = activeThread?.worktreePath ?? null;
  const derivedEnvMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath,
    hasServerThread: isServerThread,
    draftThreadEnvMode: isLocalDraftThread ? draftThread?.envMode : undefined,
  });
  const canOverrideServerThreadEnvMode = Boolean(
    isServerThread &&
    activeThread &&
    activeThread.messages.length === 0 &&
    activeThread.worktreePath === null &&
    !envLocked,
  );
  // The server records the thread a beat before it cuts the worktree, so the
  // merged thread briefly carries the project root and its branch. Hold the
  // requested mode until the worktree path lands instead of flashing "Current
  // checkout" at the user who just picked "New worktree".
  const envMode: DraftThreadEnvMode = isPreparingWorktree
    ? "worktree"
    : canOverrideServerThreadEnvMode
      ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
      : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBase !== undefined
      ? pendingServerThreadBase.branch
      : (activeThread?.branch ?? null);
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });

  useEffect(() => {
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBase(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadEnvMode) {
      return;
    }
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBase(undefined);
  }, [canOverrideServerThreadEnvMode]);

  useEffect(() => {
    if (!activeThreadKey) return;
    const previous = terminalOpenByThreadRef.current[activeThreadKey] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadKey] = current;
      setTerminalFocusRequestId((value) => value + 1);
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadKey] = current;
      if (isCoarsePointer) return;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadKey] = current;
  }, [activeThreadKey, focusComposer, isCoarsePointer, terminalState.terminalOpen]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || useCommandPaletteStore.getState().open || event.defaultPrevented) {
        return;
      }
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
        modelPickerOpen: composerRef.current?.isModelPickerOpen() ?? false,
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "chat.find") {
        // The browser panel answers the same key; whichever region the
        // reader is in owns it (findShortcutOwner).
        if (resolveFindShortcutOwner() !== "chat") return;
        event.preventDefault();
        event.stopPropagation();
        useChatFindStore
          .getState()
          .requestOpen(selectedChatText(document.querySelector("[data-chat-messages-list]")));
        return;
      }

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminal();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        if (activeThreadRef && activeThreadId) {
          requestCloseTerminal(activeThreadRef, activeThreadId, terminalState.activeTerminalId);
        }
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        createNewTerminal();
        return;
      }

      if (command === "terminal.find") {
        if (!terminalState.terminalOpen) return;
        event.preventDefault();
        event.stopPropagation();
        setTerminalFindRequested(true);
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleRail();
        return;
      }

      if (command === "modelPicker.toggle") {
        event.preventDefault();
        event.stopPropagation();
        composerRef.current?.toggleModelPicker();
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activeProject,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    activeThreadId,
    activeThreadRef,
    requestCloseTerminal,
    createNewTerminal,
    setTerminalOpen,
    runProjectScript,
    splitTerminal,
    keybindings,
    onToggleRail,
    toggleTerminalVisibility,
  ]);

  // Terminal actions asked for in the command palette, for this thread.
  const terminalCommandRequest = useTerminalCommandsStore((state) => state.request);
  const handledTerminalCommandNonceRef = useRef(terminalCommandRequest?.nonce ?? 0);
  const runTerminalCommand = useEffectEvent((kind: TerminalCommandKind) => {
    if (!activeThreadRef || !activeThreadId) return;
    const terminalId = terminalState.activeTerminalId;
    switch (kind) {
      case "toggle":
        toggleTerminalVisibility();
        return;
      case "new":
        setTerminalOpen(true);
        createNewTerminal();
        return;
      case "split":
        setTerminalOpen(true);
        splitTerminal();
        return;
      case "find":
        setTerminalOpen(true);
        setTerminalFindRequested(true);
        return;
      case "clear":
        void readEnvironmentApi(activeThreadRef.environmentId)
          ?.terminal.clear({ threadId: activeThreadId, terminalId })
          .catch(() => undefined);
        return;
      case "restart":
        setTerminalOpen(true);
        requestRestartTerminal(activeThreadRef, activeThreadId, terminalId);
        return;
      case "kill":
        requestCloseTerminal(activeThreadRef, activeThreadId, terminalId);
        return;
    }
  });
  useEffect(() => {
    if (
      !terminalCommandRequest ||
      terminalCommandRequest.nonce === handledTerminalCommandNonceRef.current
    ) {
      return;
    }
    handledTerminalCommandNonceRef.current = terminalCommandRequest.nonce;
    runTerminalCommand(terminalCommandRequest.kind);
  }, [terminalCommandRequest]);

  const onRevertToTurnCount = useCallback(
    async (turnCount: number, revertedMessageText?: string) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThread || isRevertingCheckpoint) return;

      if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
        setThreadError(
          activeThread.id,
          `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
        );
        return;
      }
      if (phase === "running" || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      // Preview the revert so the confirmation states exactly what will
      // happen; fall back to generic copy if the preview cannot be computed.
      const plan = await api.orchestration
        .getRevertPlan({ threadId: activeThread.id, turnCount })
        .catch(() => null);
      setRevertDialogState({
        turnCount,
        revertedMessageText,
        view: buildRevertConfirmView({
          turnCount,
          isWorktreeThread: activeThread.worktreePath !== null,
          plan,
        }),
      });
    },
    [
      activeThread,
      activeEnvironmentUnavailable,
      activeEnvironmentUnavailableLabel,
      environmentId,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      phase,
      setThreadError,
    ],
  );

  const confirmRevertThread = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    const state = revertDialogState;
    if (!api || !activeThread || !state || isRevertingCheckpoint) return;

    setIsRevertingCheckpoint(true);
    setThreadError(activeThread.id, null);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.checkpoint.revert",
        commandId: newCommandId(),
        threadId: activeThread.id,
        turnCount: state.turnCount,
        createdAt: new Date().toISOString(),
      });
      // Restore the reverted-away message for editing so rewinding a thread
      // never loses the prompt the user wants to iterate on.
      if (state.revertedMessageText !== undefined) {
        prefillComposerDraftPrompt(composerDraftTarget, state.revertedMessageText);
      }
    } catch (err) {
      setThreadError(
        activeThread.id,
        err instanceof Error ? err.message : "Failed to revert thread state.",
      );
    }
    setIsRevertingCheckpoint(false);
    setRevertDialogState(null);
  }, [
    activeThread,
    composerDraftTarget,
    environmentId,
    isRevertingCheckpoint,
    prefillComposerDraftPrompt,
    revertDialogState,
    setThreadError,
  ]);

  /**
   * Declines the approvals waiting in this thread for a message the user typed
   * meanwhile, so the agent reads the message as what to do instead. One that
   * arrives while the first are declined is declined too. False, with the
   * reason shown where there is one, when the message must not go out: an
   * approval can't be declined, a decline could not be sent, approvals keep
   * coming, the user moved to another thread, or a question now holds the
   * turn.
   */
  const declineApprovalsBeforeSend = async (
    api: NonNullable<ReturnType<typeof readEnvironmentApi>>,
    threadId: ThreadId,
    approvals: ReadonlyArray<PendingApproval>,
  ): Promise<boolean> => {
    const threadKeyAtSend = activeThreadKeyRef.current;
    const declined = new Set<ApprovalRequestId>();
    let waiting = approvals;
    for (let round = 0; round < 3 && waiting.length > 0; round += 1) {
      if (waiting.some((approval) => approvalDeclineDecision(approval) === null)) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Answer the approval first",
            description: "This agent can't be told no here. Approve it, or stop the turn.",
          }),
        );
        return false;
      }
      const requestIds = waiting.map((approval) => approval.requestId);
      setRespondingRequestIds((existing) => [
        ...existing,
        ...requestIds.filter((requestId) => !existing.includes(requestId)),
      ]);
      try {
        const createdAt = new Date().toISOString();
        await Promise.all(
          waiting.map((approval) =>
            api.orchestration.dispatchCommand({
              type: "thread.approval.respond",
              commandId: newCommandId(),
              threadId,
              requestId: approval.requestId,
              decision: approvalDeclineDecision(approval) ?? "decline",
              createdAt,
            }),
          ),
        );
      } catch (err) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Message not sent",
            description: describeDispatchFailure(err, "The approval could not be declined."),
          }),
        );
        return false;
      } finally {
        setRespondingRequestIds((existing) =>
          existing.filter((requestId) => !requestIds.includes(requestId)),
        );
      }
      // The refs follow the thread on screen; another thread's requests are
      // not this message's to answer.
      if (activeThreadKeyRef.current !== threadKeyAtSend) return false;
      for (const requestId of requestIds) declined.add(requestId);
      waiting = pendingApprovalsRef.current.filter((approval) => !declined.has(approval.requestId));
    }
    return waiting.length === 0 && !pendingUserInputsRef.current.some(isBlockingUserInput);
  };

  const onSend = async (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const api = readEnvironmentApi(environmentId);
    const activeSteerTurnId =
      activeThread?.session?.status === "running" && activeThread.session.activeTurnId != null
        ? activeThread.session.activeTurnId
        : activeThread?.latestTurn?.state === "running"
          ? activeThread.latestTurn.turnId
          : null;
    const canSubmitSteeringFollowUp =
      phase === "running" &&
      isServerThread &&
      activeThreadKey !== null &&
      activeSteerTurnId !== null;
    if (
      !api ||
      !activeThread ||
      (isSendBusy && !canSubmitSteeringFollowUp) ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      activeThread.move ||
      sendInFlightRef.current
    )
      return;
    if (pendingUserInputs.some(isBlockingUserInput)) return;
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx) return;
    const {
      images: composerAttachments,
      terminalContexts: composerTerminalContexts,
      transcriptHighlightContexts: composerTranscriptHighlightContexts,
      fileSelectionContexts: composerFileSelectionContexts,
      pickedElementContexts: composerPickedElementContexts,
      drawingContexts: composerDrawingContexts,
      selectedModel: ctxSelectedModel,
      selectedModelSelection: ctxSelectedModelSelection,
      skillReferences: composerSkillReferences,
    } = sendCtx;
    const promptForSend = promptRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      sendableTranscriptHighlightContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      attachmentCount: composerAttachments.length,
      terminalContexts: composerTerminalContexts,
      transcriptHighlightContexts: composerTranscriptHighlightContexts,
      fileSelectionContextCount: composerFileSelectionContexts.length,
      pickedElementContextCount: composerPickedElementContexts.length,
      drawingContextCount: composerDrawingContexts.length,
    });
    // A message for the agent whose turn waits on approvals answers them
    // first. Only the draft that was sent goes out afterwards, to the agent it
    // was for: one edited, or readdressed, meanwhile stays in the box, and its
    // next send goes as usual.
    const roomRecipientNow = () =>
      resolveRoomSend({
        enabled: roomsEnabled,
        thread: activeThread,
        threadRef: scopeThreadRef(environmentId, activeThread.id),
      }).recipient?.id ?? null;
    const declineBeforeSend = async (approvals: ReadonlyArray<PendingApproval>) => {
      const recipientAtSend = roomRecipientNow();
      if (!(await declineApprovalsBeforeSend(api, activeThread.id, approvals))) return false;
      const draftNow = composerRef.current?.getSendContext();
      return (
        roomRecipientNow() === recipientAtSend &&
        draftNow !== undefined &&
        promptRef.current === promptForSend &&
        sameItems(draftNow.images, composerAttachments) &&
        sameItems(draftNow.terminalContexts, composerTerminalContexts) &&
        sameItems(draftNow.transcriptHighlightContexts, composerTranscriptHighlightContexts) &&
        sameItems(draftNow.fileSelectionContexts, composerFileSelectionContexts) &&
        sameItems(draftNow.pickedElementContexts, composerPickedElementContexts) &&
        sameItems(draftNow.drawingContexts, composerDrawingContexts)
      );
    };
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      // While an approval waits, an empty box implements nothing: Enter there
      // is not the go-ahead for the plan.
      if (pendingApprovals.length > 0 && trimmed.length === 0) return;
      // In a room, plan feedback for another agent carries the plan with it,
      // so it can not wait in the queue while the agent holding the thread
      // is still waiting on background work. It stays in the box instead.
      const planRoomSend = resolveRoomSend({
        enabled: roomsEnabled,
        thread: activeThread,
        threadRef: scopeThreadRef(environmentId, activeThread.id),
      });
      if (
        planRoomSend.active &&
        waitingOnBackgroundTasks &&
        (planRoomSend.recipient?.id ?? null) !== (activeThread.session?.participantId ?? null)
      ) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: `${roomAgentLabels?.get(roomAgentKey(activeThread.session?.participantId))?.name ?? "The agent"} is still waiting on background work`,
            description: "Send this once it finishes.",
          }),
        );
        return;
      }
      if (pendingApprovals.length > 0) {
        sendInFlightRef.current = true;
        const declined = await declineBeforeSend(pendingApprovals);
        sendInFlightRef.current = false;
        if (!declined) return;
      }
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      // Feedback on the plan is the user's own words; the implement prompt
      // (an empty draft) is the agent's plan, never theirs.
      const planComposer =
        followUp.interactionMode === "plan"
          ? composerForTypedMessage({
              typedText: trimmed,
              sentText: followUp.text,
              plain: workflowKeywordSuppressed,
            })
          : undefined;
      setWorkflowKeywordSuppressed(false);
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
        ...(planComposer ? { composer: planComposer } : {}),
      });
      return;
    }
    const standaloneSlashCommand =
      composerAttachments.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      sendableTranscriptHighlightContexts.length === 0 &&
      composerFileSelectionContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      return;
    }
    // `/goal [objective]` submitted as text (the command menu only fires on
    // Enter-selection; typing past it with space must still work). Bare
    // `/goal` opens the editor; trailing text becomes the objective directly.
    const goalCommand =
      composerAttachments.length === 0 &&
      sendableComposerTerminalContexts.length === 0 &&
      sendableTranscriptHighlightContexts.length === 0 &&
      composerFileSelectionContexts.length === 0 &&
      goalControls !== null
        ? parseComposerGoalCommand(trimmed)
        : null;
    if (goalCommand) {
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      if (goalCommand.action === "set") {
        void onSetThreadGoal({ objective: goalCommand.objective });
      } else if (goalCommand.action === "clear") {
        void onClearThreadGoal();
      } else {
        composerRef.current?.openGoalEditor();
      }
      return;
    }
    if (!hasSendableContent) {
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "empty",
        );
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          }),
        );
      }
      return;
    }
    // Rooms: the message goes to the agent picked in the composer, which
    // defaults to whoever worked last. Only one agent works at a time. While
    // one has a turn in flight, or has finished but is still waiting on
    // background work it will wake up for, a message for another agent is
    // either asked now and answered read-only on the side, or waits in the
    // queue (resolveRoomDelivery).
    const roomThreadRef = scopeThreadRef(environmentId, activeThread.id);
    const roomSend = resolveRoomSend({
      enabled: roomsEnabled,
      thread: activeThread,
      threadRef: roomThreadRef,
    });
    const roomsActive = roomSend.active;
    const roomRecipient = roomSend.recipient;
    const roomRecipientId = roomRecipient?.id ?? null;
    // The added agent's model with any reasoning picked since its last turn.
    const roomRecipientModelSelection = roomSend.modelSelection;
    const roomHolderId = activeThread.session?.participantId ?? null;
    const roomDelivery = roomsActive
      ? resolveRoomDelivery({
          recipientId: roomRecipientId,
          holderId: roomHolderId,
          holderBusy: canSubmitSteeringFollowUp || waitingOnBackgroundTasks,
          recipientDriverKind: providerInstanceEntries.find(
            (entry) =>
              entry.instanceId ===
              (roomRecipient?.modelSelection ?? activeThread.modelSelection).instanceId,
          )?.driverKind,
          waitChosen: isRoomWaitChosen(
            useRoomRecipientStore.getState().waitChosen,
            roomThreadRef,
            activeThread.latestTurn?.turnId,
          ),
        })
      : "direct";
    const askOnTheSide = roomDelivery === "ask";
    const queueBehindTurnId =
      roomDelivery === "queue"
        ? canSubmitSteeringFollowUp
          ? activeSteerTurnId
          : (activeThread.latestTurn?.turnId ?? null)
        : null;
    const queueForAnotherAgent = queueBehindTurnId !== null;
    // After a send: carrying on with the same agent stays one keystroke, and
    // the next message is asked now again. Only a send that carried the model
    // selection (a turn or a queued message) took the picked reasoning with
    // it; a steer did not, so it is kept.
    const rememberRoomSend = (threadRef: ScopedThreadRef, carriedModelSelection: boolean) => {
      const store = useRoomRecipientStore.getState();
      store.choose(threadRef, roomRecipientId);
      store.chooseWait(threadRef, null, false);
      if (roomRecipientId !== null && carriedModelSelection) {
        store.setAgentOptions(threadRef, roomRecipientId, undefined);
      }
    };
    // Hold the turn back when the snapshot already says this instance cannot
    // serve it. The draft is untouched, so dismissing or fixing the provider
    // returns the user to exactly what they typed. The ref, not the render
    // value, is what a recheck-then-send has just written to.
    const preflight = deriveProviderSendPreflight({
      instanceId: roomRecipient?.modelSelection.instanceId ?? ctxSelectedModelSelection.instanceId,
      providers: providerStatusesRef.current,
    });
    if (preflight) {
      setProviderSendPreflight(preflight);
      return;
    }
    setProviderSendPreflight(null);
    if (!activeProject) return;
    // One agent answers on the side at a time, a side question is text only,
    // and an agent answering on the side cannot take the thread until it is
    // done. Each way the draft stays, so nothing is lost and a read-only
    // question never quietly becomes a queued editing turn.
    const answeringOnTheSide = roomsActive ? (activeThread.sideTurn ?? null) : null;
    if (
      askOnTheSide ||
      (roomDelivery === "direct" && answeringOnTheSide?.participantId === roomRecipientId)
    ) {
      const nameOf = (participantId: ThreadParticipantId | null) =>
        roomAgentLabels?.get(roomAgentKey(participantId))?.name ?? "The agent";
      const refusal =
        answeringOnTheSide !== null && !askOnTheSide
          ? {
              title: `${nameOf(roomRecipientId)} is answering on the side`,
              description: "Send this once it finishes, or stop its answer.",
            }
          : answeringOnTheSide !== null
            ? {
                title: `${nameOf(answeringOnTheSide.participantId)} is already answering on the side`,
                description: `Wait for it to finish, or pick "Send when done" to send this after ${nameOf(roomHolderId)}.`,
              }
            : composerAttachments.length > 0 || composerDrawingContexts.length > 0
              ? {
                  title: "Pictures and files can't go with a side question",
                  description: `Pick "Send when done" to send them after ${nameOf(roomHolderId)}.`,
                }
              : null;
      if (refusal) {
        toastManager.add(stackedThreadToast({ type: "warning", ...refusal }));
        return;
      }
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const steeringThreadKey = activeThreadKey;
    const isSteeringFollowUp =
      !askOnTheSide &&
      (canSubmitSteeringFollowUp || queueForAnotherAgent) &&
      steeringThreadKey !== null;
    // An approval holds the agent's turn. A message for that agent answers
    // it: every waiting approval is declined and the message steers the turn,
    // whatever "Send when done" says. A side question, or a message waiting
    // for another agent, leaves the approvals alone.
    const approvalDeclines = askOnTheSide || queueForAnotherAgent ? [] : pendingApprovals;
    // "Send when done" holds the message on the server until the turn ends;
    // the queue list shows it from there, so it gets no steering row.
    const followUpDelivery = queueForAnotherAgent
      ? "queue"
      : approvalDeclines.length > 0
        ? "steer"
        : settings.followUpDelivery;
    const baseBranchForWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath
        ? activeThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && sendEnvMode === "worktree" && !activeThread.worktreePath;
    if (shouldCreateWorktree && !activeThreadBranch) {
      setThreadError(threadIdForSend, "Select a base branch before sending in New worktree mode.");
      return;
    }

    sendInFlightRef.current = true;
    if (approvalDeclines.length > 0 && !(await declineBeforeSend(approvalDeclines))) {
      sendInFlightRef.current = false;
      return;
    }
    if (!isSteeringFollowUp && !askOnTheSide) {
      beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });
    }

    const composerAttachmentsSnapshot = [...composerAttachments];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerTranscriptHighlightContextsSnapshot = [...sendableTranscriptHighlightContexts];
    const composerFileSelectionContextsSnapshot = [...composerFileSelectionContexts];
    const composerPickedElementContextsSnapshot = [...composerPickedElementContexts];
    const composerDrawingContextsSnapshot = [...composerDrawingContexts];
    const messageTextWithTerminalContexts = appendTerminalContextsToPrompt(
      promptForSend,
      composerTerminalContextsSnapshot,
    );
    const messageTextWithHighlights = appendTranscriptHighlightContextsToPrompt(
      messageTextWithTerminalContexts,
      composerTranscriptHighlightContextsSnapshot,
    );
    const messageTextWithFileSelections = appendFileSelectionContextsToPrompt(
      messageTextWithHighlights,
      composerFileSelectionContextsSnapshot,
    );
    const messageTextWithPickedElements = appendPickedElementContextsToPrompt(
      messageTextWithFileSelections,
      composerPickedElementContextsSnapshot,
    );
    const messageTextForSend = appendDrawingContextsToPrompt(
      messageTextWithPickedElements,
      composerDrawingContextsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt(
      messageTextForSend || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
    );
    // The user wrote these words; Claude may act on "ultracode" in them.
    const composer = composerForTypedMessage({
      typedText: promptForSend,
      sentText: outgoingMessageText,
      plain: workflowKeywordSuppressed,
    });
    setWorkflowKeywordSuppressed(false);
    // A drawing's picture is not shown in the composer as its own thumbnail --
    // it lives behind the chip -- but it still has to reach the model as an
    // image, because the marks are the half of the message a sentence cannot
    // carry.
    const drawingAttachments = composerDrawingContextsSnapshot.map((context, index) => ({
      type: "image" as const,
      name: `drawing-${index + 1}.png`,
      mimeType: "image/png",
      sizeBytes: Math.round((context.imageDataUrl.length * 3) / 4),
      dataUrl: context.imageDataUrl,
    }));
    const turnAttachmentsPromise = Promise.all(
      composerAttachmentsSnapshot.map(async (attachment) => ({
        type: attachment.type,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: await readFileAsDataUrl(attachment.file),
      })),
    ).then((attachments) => [...attachments, ...drawingAttachments]);
    const optimisticAttachments = composerAttachmentsSnapshot.map((attachment): ChatAttachment =>
      attachment.type === "image"
        ? {
            type: "image",
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            previewUrl: attachment.previewUrl,
          }
        : {
            type: "file",
            kind: attachment.kind,
            id: attachment.id,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
    );
    const threadRefForSend = scopeThreadRef(environmentId, threadIdForSend);
    const draftIdForSend = draftId;
    const threadTitleForSend =
      isGeneralChatThread && isLocalDraftThread ? "New chat" : activeThread.title;
    const optimisticMessage: ChatMessage = {
      id: messageIdForSend,
      role: "user",
      text: outgoingMessageText,
      ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
      ...(composerSkillReferences.length > 0 ? { skills: composerSkillReferences } : {}),
      ...(isSteeringFollowUp && activeSteerTurnId !== null ? { turnId: activeSteerTurnId } : {}),
      ...(roomRecipientId !== null ? { participantId: roomRecipientId } : {}),
      createdAt: messageCreatedAt,
      streaming: false,
    };
    // Scroll to the current end *before* adding the outgoing message.
    // This sets LegendList's internal isAtEnd=true and tells the timeline to
    // re-arm maintainScrollAtEnd before the new item lands. Steering
    // follow-ups need this too: they queue near the composer first, and
    // without re-arming here the timeline stays parked wherever the user had
    // scrolled when the queued message (and the rest of the turn) lands.
    await requestTimelineStickToBottom(false);

    if (isSteeringFollowUp) {
      if (followUpDelivery === "steer") {
        setSteeringMessagesById((existing) => ({
          ...existing,
          [messageIdForSend]: {
            id: messageIdForSend,
            threadKey: steeringThreadKey,
            text: outgoingMessageText,
            createdAt: messageCreatedAt,
            status: "queued",
          },
        }));
      }
    } else if (!askOnTheSide) {
      // A side question shows once the server has it: until then it has no
      // answer state to draw.
      addOptimisticThreadMessage(threadRefForSend, optimisticMessage);
    }

    setThreadError(threadIdForSend, null);
    if (expiredTerminalContextCount > 0) {
      const toastCopy = buildExpiredTerminalContextToastCopy(
        expiredTerminalContextCount,
        "omitted",
      );
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        }),
      );
    }
    promptRef.current = "";
    clearComposerDraftContent(composerDraftTarget);
    composerRef.current?.resetCursorState();

    let dispatchSucceeded = false;
    await (async () => {
      let firstComposerImageName: string | null = null;
      if (composerAttachmentsSnapshot.length > 0) {
        const firstComposerImage = composerAttachmentsSnapshot[0];
        if (firstComposerImage) {
          firstComposerImageName = firstComposerImage.name;
        }
      }
      let titleSeed = trimmed;
      if (!titleSeed) {
        if (firstComposerImageName) {
          titleSeed = `Image: ${firstComposerImageName}`;
        } else if (composerTerminalContextsSnapshot.length > 0) {
          titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
        } else if (composerTranscriptHighlightContextsSnapshot.length > 0) {
          titleSeed = formatTranscriptHighlightContextLabel(
            composerTranscriptHighlightContextsSnapshot[0]!,
          );
        } else {
          titleSeed = "New thread";
        }
      }
      const title = truncate(titleSeed);
      const threadCreateModelSelection = createModelSelection(
        ctxSelectedModelSelection.instanceId,
        ctxSelectedModel || DEFAULT_MODEL,
        ctxSelectedModelSelection.options,
      );

      if (askOnTheSide) {
        await api.orchestration.dispatchCommand({
          type: "thread.side-turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          sideTurnId: SideTurnId.make(randomUUID()),
          participantId: roomRecipientId,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            ...(composerSkillReferences.length > 0 ? { skills: composerSkillReferences } : {}),
          },
          // Reasoning picked for the agent rides along; it stays picked for
          // the agent's next real turn.
          ...(roomRecipientModelSelection ? { modelSelection: roomRecipientModelSelection } : {}),
          createdAt: messageCreatedAt,
        });
        dispatchSucceeded = true;
        rememberRoomSend(threadRefForSend, false);
        return;
      }

      if (isSteeringFollowUp) {
        const steerTurnId = queueBehindTurnId ?? activeSteerTurnId;
        if (steerTurnId == null) {
          throw new Error("No active provider turn is available for a follow-up.");
        }
        const turnAttachments = await turnAttachmentsPromise;
        await api.orchestration.dispatchCommand({
          type: "thread.follow-up.submit",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          turnId: steerTurnId,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: turnAttachments,
            ...(composerSkillReferences.length > 0 ? { skills: composerSkillReferences } : {}),
          },
          delivery: followUpDelivery,
          composer,
          // What a queued message runs with, like a normal send would.
          ...(followUpDelivery === "queue"
            ? {
                modelSelection: roomRecipientModelSelection ?? ctxSelectedModelSelection,
                runtimeMode,
                interactionMode,
              }
            : {}),
          ...(roomsActive ? { participantId: roomRecipientId } : {}),
          createdAt: messageCreatedAt,
        });
        dispatchSucceeded = true;
        if (roomsActive) {
          rememberRoomSend(threadRefForSend, followUpDelivery === "queue");
        }
        return;
      }

      if (isServerThread) {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          runtimeMode,
          interactionMode,
        });
      }

      const turnAttachments = await turnAttachmentsPromise;
      if (baseBranchForWorktree) {
        setupRevealRef.current = { threadId: threadIdForSend, since: new Date().toISOString() };
      }
      const bootstrap =
        isLocalDraftThread || baseBranchForWorktree
          ? {
              ...(isLocalDraftThread
                ? {
                    createThread: {
                      projectId: activeProject.id,
                      title,
                      modelSelection: threadCreateModelSelection,
                      runtimeMode,
                      interactionMode,
                      branch: activeThreadBranch,
                      worktreePath: activeThread.worktreePath,
                      ...draftRoomCreateFields,
                      createdAt: activeThread.createdAt,
                    },
                  }
                : {}),
              ...(baseBranchForWorktree
                ? {
                    prepareWorktree: {
                      projectCwd: activeProject.cwd,
                      baseBranch: baseBranchForWorktree,
                      branch: buildTemporaryWorktreeBranchName(),
                    },
                    runSetupScript: true,
                  }
                : {}),
            }
          : undefined;
      // The worktree is cut inside this request; the flag stays up until the
      // thread reports its worktree path.
      beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
          ...(composerSkillReferences.length > 0 ? { skills: composerSkillReferences } : {}),
        },
        modelSelection: roomRecipientModelSelection ?? ctxSelectedModelSelection,
        ...(roomRecipientId !== null ? { participantId: roomRecipientId } : {}),
        composer,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        // A default-mode turn on a thread holding an unimplemented plan is the
        // implementation turn, even when the user typed their own prompt or
        // switched modes manually — otherwise the plan stays "ready" forever.
        ...(interactionMode === "default" &&
        activeThread.id === threadIdForSend &&
        hasActionableProposedPlan(activeProposedPlan) &&
        activeProposedPlan
          ? {
              sourceProposedPlan: {
                threadId: activeThread.id,
                planId: activeProposedPlan.id,
              },
            }
          : {}),
        ...(bootstrap ? { bootstrap } : {}),
        createdAt: messageCreatedAt,
      });
      dispatchSucceeded = true;
      markLocalDispatchAccepted(threadRefForSend);
      if (roomsActive) {
        rememberRoomSend(threadRefForSend, true);
      }
      // A turn for an added agent says nothing about the thread's own model.
      if (isServerThread && ctxSelectedModel && roomRecipientId === null) {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          modelSelection: ctxSelectedModelSelection,
        });
      }
    })().catch(async (err: unknown) => {
      if (
        !dispatchSucceeded &&
        promptRef.current.length === 0 &&
        composerAttachmentsRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0 &&
        composerTranscriptHighlightContextsRef.current.length === 0 &&
        composerFileSelectionContextsRef.current.length === 0
      ) {
        if (isSteeringFollowUp) {
          setSteeringMessagesById((existing) => {
            if (!(messageIdForSend in existing)) {
              return existing;
            }
            const next = { ...existing };
            delete next[messageIdForSend];
            return next;
          });
          revokeUserMessagePreviewUrls(optimisticMessage);
        } else {
          removeOptimisticThreadMessages(threadRefForSend, new Set([messageIdForSend]));
          revokeUserMessagePreviewUrls(optimisticMessage);
        }
        promptRef.current = promptForSend;
        const retryComposerAttachments = composerAttachmentsSnapshot.map(
          cloneComposerAttachmentForRetry,
        );
        composerAttachmentsRef.current = retryComposerAttachments;
        composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
        composerTranscriptHighlightContextsRef.current =
          composerTranscriptHighlightContextsSnapshot;
        composerFileSelectionContextsRef.current = composerFileSelectionContextsSnapshot;
        setComposerDraftPrompt(composerDraftTarget, promptForSend);
        addComposerDraftAttachments(composerDraftTarget, retryComposerAttachments);
        setComposerDraftTerminalContexts(composerDraftTarget, composerTerminalContextsSnapshot);
        setComposerDraftTranscriptHighlightContexts(
          composerDraftTarget,
          composerTranscriptHighlightContextsSnapshot,
        );
        for (const context of composerFileSelectionContextsSnapshot) {
          addComposerDraftFileSelectionContext(composerDraftTarget, context);
        }
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(promptForSend, promptForSend.length),
          prompt: promptForSend,
          detectTrigger: true,
        });
      }
      const dispatchFailureMessage = describeDispatchFailure(err, "Failed to send message.");
      setThreadError(threadIdForSend, dispatchFailureMessage);
      // The thread error banner only helps if the user is still looking at
      // this thread when the retry budget runs out (large uploads can take
      // minutes to exhaust it); the toast makes the failure visible anywhere,
      // and names the thread with a way back while another one is open.
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Message failed to send",
          description: dispatchFailureMessage,
          data: {
            aboutThread: {
              threadRef: threadRefForSend,
              title: threadTitleForSend,
              // Resolved on click: a draft that has since become a real
              // thread opens as that thread.
              open: () => {
                const draftStillOpen =
                  draftIdForSend !== null &&
                  !selectThreadExistsByRef(useStore.getState(), threadRefForSend) &&
                  useComposerDraftStore.getState().getDraftSession(draftIdForSend) !== null;
                void (draftStillOpen
                  ? navigate({
                      to: "/draft/$draftId",
                      params: buildDraftThreadRouteParams(draftIdForSend),
                    })
                  : navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(threadRefForSend),
                    }));
              },
            },
          },
        }),
      );
    });
    sendInFlightRef.current = false;
    if (!dispatchSucceeded && !isSteeringFollowUp && !askOnTheSide) {
      resetLocalDispatch();
    }
  };

  /**
   * "I've signed in" is a claim we can check. It re-probes the provider, folds
   * the answer into the app's snapshot, and — when the answer agrees — sends
   * the held message down the ordinary path, gate and all. Nothing bypasses
   * the preflight, so a user who guessed wrong gets told rather than dropped
   * into the reconnect noise the gate exists to prevent.
   */
  const onConfirmProviderSignedIn = async (): Promise<void> => {
    const prompt = providerSendPreflight;
    if (!prompt || isRecheckingProviderSendPreflight) {
      return;
    }
    setIsRecheckingProviderSendPreflight(true);
    try {
      const payload = await refreshProviderStatus({
        environmentId: threadComputerEnvironmentId,
        instanceId: prompt.instanceId,
      });
      providerStatusesRef.current = payload.providers;
      const stillUnusable = deriveProviderSendPreflight({
        instanceId: prompt.instanceId,
        providers: payload.providers,
      });
      if (stillUnusable) {
        setProviderSendPreflight(stillUnusable);
        setProviderSendPreflightRecheckFailed(true);
        return;
      }
      setProviderSendPreflight(null);
      setProviderSendPreflightRecheckFailed(false);
      await onSend();
    } catch {
      setProviderSendPreflightRecheckFailed(true);
    } finally {
      setIsRecheckingProviderSendPreflight(false);
    }
  };
  confirmProviderSignedInRef.current = () => {
    void onConfirmProviderSignedIn();
  };

  /** Rebuilds composer attachments from a queued message's stored files. */
  const loadQueuedAttachmentsForComposer = async (
    attachments: OrchestrationQueuedFollowUp["attachments"],
  ): Promise<{ restored: ComposerAttachment[]; failedCount: number }> => {
    const persisted = await Promise.all(
      attachments.map(async (attachment) => {
        try {
          const blob = await loadChatAttachmentBlob({
            environmentId,
            attachmentId: attachment.id,
          });
          const dataUrl = await readFileAsDataUrl(
            new File([blob], attachment.name, { type: attachment.mimeType }),
          );
          return {
            id: crypto.randomUUID(),
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            dataUrl,
          };
        } catch {
          return null;
        }
      }),
    );
    const loaded = persisted.filter((entry) => entry !== null);
    return {
      restored: hydrateAttachmentsFromPersisted(loaded),
      failedCount: attachments.length - loaded.length,
    };
  };

  /**
   * Takes queued messages out of the queue and back into the message box:
   * their text after whatever is typed there, their attachments beside it. A
   * message the server sent in the meantime stays sent and is left out.
   */
  const returnQueuedFollowUpsToComposer = async (
    followUps: ReadonlyArray<OrchestrationQueuedFollowUp>,
  ) => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeThread || followUps.length === 0) return;
    const threadId = activeThread.id;
    const target = composerDraftTarget;
    const threadKeyAtStart = activeThreadKey;
    // The box holds one message for one agent. In a room, only the messages
    // for the first one's agent come back; the rest stay queued for theirs.
    // What an agent queued (a hand-off, a reply, another thread's request or
    // answer) is never the user's to edit.
    const usersOwn = followUps.filter((followUp) => !isAgentOrigin(followUp));
    const firstAgentId = usersOwn[0]?.participantId ?? null;
    const returning = isRoom(activeThread)
      ? usersOwn.filter((followUp) => (followUp.participantId ?? null) === firstAgentId)
      : usersOwn;
    const taken: OrchestrationQueuedFollowUp[] = [];
    for (const followUp of returning) {
      const removed = await api.orchestration
        .dispatchCommand({
          type: "thread.follow-up.unqueue",
          commandId: newCommandId(),
          threadId,
          messageId: followUp.messageId,
          createdAt: new Date().toISOString(),
        })
        .then(
          () => true,
          () => false,
        );
      if (removed) {
        taken.push(followUp);
      }
    }
    if (taken.length === 0) return;
    // In a room, the message goes back to the agent it was waiting for.
    const lastTaken = taken.at(-1);
    if (isRoom(activeThread) && lastTaken !== undefined) {
      useRoomRecipientStore
        .getState()
        .choose(scopeThreadRef(environmentId, threadId), lastTaken.participantId ?? null);
    }

    const nextPrompt = appendRestoredFollowUpText(
      useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "",
      taken
        .map((followUp) => followUp.text)
        .filter((text) => text !== ATTACHMENT_ONLY_BOOTSTRAP_PROMPT),
    );
    setComposerDraftPrompt(target, nextPrompt);
    if (activeThreadKeyRef.current === threadKeyAtStart) {
      promptRef.current = nextPrompt;
      composerRef.current?.resetCursorState({
        cursor: collapseExpandedComposerCursor(nextPrompt, nextPrompt.length),
        prompt: nextPrompt,
      });
    }
    const { restored, failedCount } = await loadQueuedAttachmentsForComposer(
      taken.flatMap((followUp) => followUp.attachments),
    );
    if (restored.length > 0) {
      addComposerDraftAttachments(target, restored);
    }
    if (failedCount > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title:
            failedCount === 1
              ? "An attachment could not be restored"
              : `${failedCount} attachments could not be restored`,
          description: "Attach them again before sending.",
        }),
      );
    }
  };

  const removeQueuedFollowUp = (followUp: OrchestrationQueuedFollowUp) => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeThread) return;
    // Losing to the server sending it first is fine: it is already sent.
    void api.orchestration
      .dispatchCommand({
        type: "thread.follow-up.unqueue",
        commandId: newCommandId(),
        threadId: activeThread.id,
        messageId: followUp.messageId,
        createdAt: new Date().toISOString(),
      })
      .catch(() => undefined);
  };

  /** Stop a side answer; one that already ended is left alone, quietly. */
  const stopSideAnswer = useCallback(
    (sideTurnId: SideTurnId) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThread) return;
      void api.orchestration
        .dispatchCommand({
          type: "thread.side-turn.interrupt",
          commandId: newCommandId(),
          threadId: activeThread.id,
          sideTurnId,
          createdAt: new Date().toISOString(),
        })
        .catch(() => undefined);
    },
    [activeThread, environmentId],
  );

  const onInterrupt = async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeThread) return;
    const threadId = activeThread.id;
    const turnId = activeThread.session?.activeTurnId ?? activeThread.latestTurn?.turnId ?? null;
    if (interruptInFlightTurnByThreadRef.current.get(threadId) === turnId) {
      return;
    }
    interruptInFlightTurnByThreadRef.current.set(threadId, turnId);
    // Nothing queued goes out after Stop: those messages come back to the box.
    void returnQueuedFollowUpsToComposer(activeThread.queuedFollowUps ?? []);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId,
        ...(turnId ? { turnId } : {}),
        createdAt: new Date().toISOString(),
      });
      window.setTimeout(() => {
        if (interruptInFlightTurnByThreadRef.current.get(threadId) === turnId) {
          interruptInFlightTurnByThreadRef.current.delete(threadId);
        }
      }, INTERRUPT_RETRY_DELAY_MS);
    } catch (error) {
      interruptInFlightTurnByThreadRef.current.delete(threadId);
      throw error;
    }
  };

  /**
   * Stop for a thread whose turn settled but which still waits on background
   * work. There is no turn to interrupt, so this stops the session, which
   * ends the commands and agents running in it. It is the only way out when
   * the agent can't be asked to stop them (a usage limit, an error).
   */
  const stopBackgroundWork = async () => {
    if (!activeThread) return;
    const threadId = activeThread.id;
    if (backgroundWorkStopInFlightRef.current.has(threadId)) return;
    backgroundWorkStopInFlightRef.current.add(threadId);
    // As with Stop on a turn, nothing queued goes out afterwards.
    void returnQueuedFollowUpsToComposer(activeThread.queuedFollowUps ?? []);
    try {
      await stopThreadSession(scopeThreadRef(environmentId, threadId));
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not stop the background work",
          description: error instanceof Error ? error.message : "Try again.",
        }),
      );
    } finally {
      backgroundWorkStopInFlightRef.current.delete(threadId);
    }
  };

  const [goalDispatchingThreadId, setGoalDispatchingThreadId] = useState<ThreadId | null>(null);
  // Bridges the gap between dispatching a goal and its authoritative state
  // arriving through the projection stream — without it the bar flickers out
  // while a brand-new thread materializes (and edits briefly show the stale
  // pre-edit goal). Each entry remembers the server goal's updatedAt at
  // dispatch time; the entry clears once the server state advances past that
  // baseline, or the dispatch fails.
  const [optimisticGoals, setOptimisticGoals] = useState<
    ReadonlyMap<ThreadId, { goal: OrchestrationThreadGoal; baselineUpdatedAt: string | null }>
  >(new Map());

  useEffect(() => {
    const threadId = activeThread?.id;
    if (threadId === undefined) {
      return;
    }
    const entry = optimisticGoals.get(threadId);
    if (!entry) {
      return;
    }
    const serverGoal = activeThread?.goal ?? null;
    const serverAdvanced =
      serverGoal !== null &&
      (entry.baselineUpdatedAt === null || serverGoal.updatedAt !== entry.baselineUpdatedAt);
    if (!serverAdvanced) {
      return;
    }
    setOptimisticGoals((current) => {
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });
  }, [activeThread?.goal, activeThread?.id, optimisticGoals]);

  const onSetThreadGoal = useCallback(
    async (input: ComposerGoalSetInput) => {
      if (!activeThread || !activeProject) {
        return;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update goal",
            description: "Environment API unavailable.",
          }),
        );
        return;
      }
      const threadId = activeThread.id;
      const existingGoal = activeThread.goal ?? null;
      // The composer picker's selection lives in composer state until a send;
      // goals must honor it the same way the send path does, or the goal's
      // session starts on the thread's stale (often default) model.
      const goalModelSelection =
        composerRef.current?.getSendContext().selectedModelSelection ?? activeThread.modelSelection;
      const optimisticObjective = input.objective ?? existingGoal?.objective;
      if (optimisticObjective !== undefined) {
        const nowIso = new Date().toISOString();
        setOptimisticGoals((current) => {
          const next = new Map(current);
          next.set(threadId, {
            baselineUpdatedAt: existingGoal?.updatedAt ?? null,
            goal: {
              threadId,
              objective: optimisticObjective,
              status: input.status ?? existingGoal?.status ?? "active",
              tokenBudget:
                input.tokenBudget !== undefined
                  ? input.tokenBudget
                  : (existingGoal?.tokenBudget ?? null),
              tokensUsed: existingGoal?.tokensUsed ?? 0,
              timeUsedSeconds: existingGoal?.timeUsedSeconds ?? 0,
              createdAt: existingGoal?.createdAt ?? nowIso,
              updatedAt: nowIso,
            },
          });
          return next;
        });
      }
      const dropOptimisticGoal = () =>
        setOptimisticGoals((current) => {
          if (!current.has(threadId)) {
            return current;
          }
          const next = new Map(current);
          next.delete(threadId);
          return next;
        });
      setGoalDispatchingThreadId(threadId);
      try {
        // Codex starts working the moment a goal becomes active — a goal on a
        // not-yet-created thread materializes it immediately (same shape as
        // the plan-implementation flow) so the session spins up and the first
        // auto-turn begins without waiting for a user message.
        if (!isServerThread) {
          if (input.objective === undefined) {
            return;
          }
          await api.orchestration.dispatchCommand({
            type: "thread.create",
            commandId: newCommandId(),
            threadId,
            projectId: activeProject.id,
            title: truncate(input.objective),
            modelSelection: goalModelSelection,
            runtimeMode,
            interactionMode: "default",
            branch: activeThreadBranch,
            worktreePath: activeThread.worktreePath,
            ...draftRoomCreateFields,
            createdAt: new Date().toISOString(),
          });
        } else {
          await persistThreadSettingsForNextTurn({
            threadId,
            createdAt: new Date().toISOString(),
            modelSelection: goalModelSelection,
          });
        }
        await api.orchestration.dispatchCommand({
          type: "thread.goal.set",
          commandId: newCommandId(),
          threadId,
          ...(input.objective !== undefined ? { objective: input.objective } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}),
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        dropOptimisticGoal();
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update goal",
            description: error instanceof Error ? error.message : "Goal update failed.",
          }),
        );
      } finally {
        setGoalDispatchingThreadId((current) => (current === threadId ? null : current));
      }
    },
    [
      activeThread,
      activeProject,
      activeThreadBranch,
      draftRoomCreateFields,
      environmentId,
      isServerThread,
      persistThreadSettingsForNextTurn,
      runtimeMode,
    ],
  );

  const onClearThreadGoal = useCallback(async () => {
    // Goals only exist on server threads now that setting one materializes
    // the thread immediately.
    if (!activeThread || !isServerThread) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not clear goal",
          description: "Environment API unavailable.",
        }),
      );
      return;
    }
    const threadId = activeThread.id;
    setGoalDispatchingThreadId(threadId);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.goal.clear",
        commandId: newCommandId(),
        threadId,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not clear goal",
          description: error instanceof Error ? error.message : "Goal clear failed.",
        }),
      );
    } finally {
      setGoalDispatchingThreadId((current) => (current === threadId ? null : current));
    }
  }, [activeThread, environmentId, isServerThread]);

  const onCompactContext = useCallback(async () => {
    if (!activeThread || contextCompactDisabledReason !== null) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not compact context",
          description: "Environment API unavailable.",
        }),
      );
      return;
    }

    const threadId = activeThread.id;
    setContextCompactDispatchingThreadId(threadId);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.context-compact.request",
        commandId: newCommandId(),
        threadId,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not compact context",
          description: error instanceof Error ? error.message : "Context compaction failed.",
        }),
      );
    } finally {
      setContextCompactDispatchingThreadId((current) => (current === threadId ? null : current));
    }
  }, [activeThread, contextCompactDisabledReason, environmentId]);

  const onRetryFailedTurn = useCallback(async () => {
    if (!activeThread) {
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not retry",
          description: "Environment API unavailable.",
        }),
      );
      return;
    }

    const threadId = activeThread.id;
    setTurnRetryDispatchingThreadId(threadId);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.turn.retry",
        commandId: newCommandId(),
        threadId,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not retry",
          description: error instanceof Error ? error.message : "Retry dispatch failed.",
        }),
      );
    } finally {
      setTurnRetryDispatchingThreadId((current) => (current === threadId ? null : current));
    }
  }, [activeThread, environmentId]);

  const failedTurnRetryAction = useMemo(() => {
    const failedMessageId = deriveFailedTurnRetryMessageId({
      messages: activeThread?.messages ?? [],
      sessionLastError: activeThread?.session?.lastError,
    });
    if (
      !activeThread ||
      failedMessageId === null ||
      !shouldOfferFailedTurnRetry({
        isServerThread,
        failedMessageId,
        orchestrationStatus: activeThread.session?.orchestrationStatus,
      })
    ) {
      return null;
    }
    return {
      messageId: failedMessageId,
      isRetrying: turnRetryDispatchingThreadId === activeThread.id,
      onRetry: () => {
        void onRetryFailedTurn();
      },
    };
  }, [
    activeThread?.id,
    activeThread?.messages,
    activeThread?.session?.lastError,
    activeThread?.session?.orchestrationStatus,
    isServerThread,
    onRetryFailedTurn,
    turnRetryDispatchingThreadId,
  ]);

  const threadErrorRetryAction = useMemo(() => {
    if (
      !isServerThread ||
      providerAuthReconnectPrompt !== null ||
      threadErrorUsageResetAction !== null ||
      activeTurnInProgress ||
      activeThread?.session?.orchestrationStatus === "starting" ||
      activeThread?.session?.orchestrationStatus === "running" ||
      !isRetryableThreadError({
        threadError: activeThread?.error,
        activities: threadActivities,
      })
    ) {
      return null;
    }
    return {
      isRetrying: turnRetryDispatchingThreadId === activeThread?.id,
      onRetry: () => {
        void onRetryFailedTurn();
      },
    };
  }, [
    activeThread?.error,
    activeThread?.id,
    activeThread?.session?.orchestrationStatus,
    activeTurnInProgress,
    isServerThread,
    onRetryFailedTurn,
    providerAuthReconnectPrompt,
    threadActivities,
    threadErrorUsageResetAction,
    turnRetryDispatchingThreadId,
  ]);

  // The thread's folder can vanish underneath it (an agent removing its own
  // worktree after a merge, or the user deleting it in a terminal). The hook
  // owns the detection and both ways out; this surface only renders them.
  const checkoutRecoveryView = useCheckoutRecovery({
    environmentId,
    threadId: activeThread?.id ?? null,
    cwd: gitCwd,
    projectCwd: activeProject?.cwd ?? null,
    branch: activeThread?.branch ?? null,
    status: gitStatusQuery.data,
  });
  const checkoutRecovery = checkoutRecoveryView.recovery;
  const checkoutMissingNotice = useMemo(
    () =>
      checkoutRecovery
        ? buildCheckoutMissingNotice({
            recovery: checkoutRecovery,
            actions: {
              isBusy: checkoutRecoveryView.isBusy,
              onSwitchToProjectRoot: checkoutRecoveryView.onSwitchToProjectRoot,
              onRecreateWorktree: checkoutRecoveryView.onRecreateWorktree,
            },
          })
        : null,
    [checkoutRecovery, checkoutRecoveryView],
  );

  const providerStatusNotice = useProviderStatusNotice({
    status: activeProviderStatus,
    environmentId: threadComputerEnvironmentId,
    activeTurnInProgress,
    signIn: composerSignInView,
    // The held-send notice already states this provider's problem with the
    // actions that fix it; a second ambient row saying it again is the
    // stacking noise the dock exists to end.
    suppressed:
      providerSendPreflight !== null &&
      providerSendPreflight.instanceId === activeProviderStatus?.instanceId,
  });
  const sessionStartupNotice = useSessionStartupNotice({
    isSessionStarting,
    startedAt: activeWorkStartedAt,
    suppressed: providerStatusNoticeVisible || threadErrorNoticeVisible,
    providerStatus:
      (launchingInstanceId !== null
        ? providerStatuses.find((status) => status.instanceId === launchingInstanceId)
        : undefined) ?? activeProviderStatus,
    launching: launchingStartupNotice,
    environmentId: threadComputerEnvironmentId,
  });
  const threadErrorNotice = useMemo(
    () =>
      buildThreadErrorNotice({
        // A missing checkout has its own notice with actions that can actually
        // work; showing "Turn failed … Retry" beside it would only offer the
        // user the one button guaranteed to fail again.
        error:
          threadErrorNoticeVisible && checkoutRecovery === null
            ? (activeThread?.error ?? null)
            : null,
        authReconnect: providerAuthReconnectPrompt,
        usageReset: threadErrorUsageResetAction,
        usageResetLink: threadErrorUsageResetLink,
        retry: threadErrorRetryAction,
        providerLabel: activeProviderLabel,
        planUpgradeUrl: activeProviderStatus?.planUpgradeUrl ?? null,
        signIn: composerSignInView,
        onDismiss: () => setThreadError(activeThread?.id ?? null, null),
      }),
    [
      activeProviderLabel,
      activeProviderStatus?.planUpgradeUrl,
      activeThread?.error,
      activeThread?.id,
      checkoutRecovery,
      composerSignInView,
      providerAuthReconnectPrompt,
      setThreadError,
      threadErrorNoticeVisible,
      threadErrorRetryAction,
      threadErrorUsageResetAction,
      threadErrorUsageResetLink,
    ],
  );
  const noAgentReady = useNoAgentReady();
  const sendPreflightNotice = useMemo(
    () =>
      providerSendPreflight
        ? buildProviderSendPreflightNotice({
            prompt: providerSendPreflight,
            recheckFailed: providerSendPreflightRecheckFailed,
            isRechecking: isRecheckingProviderSendPreflight,
            signIn: composerSignInView,
            offerSetup: noAgentReady,
            onConfirmSignedIn: () => confirmProviderSignedInRef.current(),
            onDismiss: () => {
              setProviderSendPreflight(null);
              setProviderSendPreflightRecheckFailed(false);
            },
          })
        : null,
    [
      composerSignInView,
      isRecheckingProviderSendPreflight,
      noAgentReady,
      providerSendPreflight,
      providerSendPreflightRecheckFailed,
    ],
  );
  // A thread whose account was removed continues on whichever instance the
  // composer falls back to; say so before the next message goes out, since
  // that instance only gets a recap of the conversation.
  const removedAccountNotice = useMemo<ComposerNotice | null>(() => {
    if (!activeThread || !threadHasStarted(activeThread) || providerStatuses.length === 0) {
      return null;
    }
    const boundInstanceId =
      ownAgentSession(activeThread)?.providerInstanceId ?? activeThread.modelSelection.instanceId;
    if (providerStatuses.some((snapshot) => snapshot.instanceId === boundInstanceId)) return null;
    return {
      id: `removed-instance:${String(boundInstanceId)}`,
      severity: "info",
      // An extra account, or a community agent that was removed.
      lead: isAcpRegistryInstanceId(String(boundInstanceId))
        ? "The agent this chat used was removed."
        : "The account this chat used was removed.",
      detail:
        "Your next message continues it on the agent picked below, which picks up from a recap of the conversation.",
    };
  }, [activeThread, providerStatuses]);
  const composerNotices = useMemo(
    () =>
      selectComposerNotices([
        checkoutMissingNotice,
        threadErrorNotice,
        sendPreflightNotice,
        providerStatusNotice,
        sessionStartupNotice,
        removedAccountNotice,
        ...infrastructureComposerNotices,
      ]),
    [
      checkoutMissingNotice,
      infrastructureComposerNotices,
      providerStatusNotice,
      removedAccountNotice,
      sendPreflightNotice,
      sessionStartupNotice,
      threadErrorNotice,
    ],
  );

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, environmentId, setThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      const api = readEnvironmentApi(environmentId);
      if (!api || !activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, environmentId, setThreadError],
  );

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => {
        const question =
          (activePendingProgress?.activeQuestion?.id === questionId
            ? activePendingProgress.activeQuestion
            : undefined) ??
          activePendingUserInput.questions.find((entry) => entry.id === questionId);
        if (!question) {
          return existing;
        }

        return {
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[activePendingUserInput.requestId]?.[questionId],
              optionLabel,
            ),
          },
        };
      });
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (questionId: string, value: string) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
    },
    [activePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || activePendingUserInput.elicitation || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
      composer,
    }: {
      text: string;
      interactionMode: "default" | "plan";
      /** Set only when the user wrote the text. See MessageComposer. */
      composer?: MessageComposer;
    }) => {
      const api = readEnvironmentApi(environmentId);
      if (
        !api ||
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

      const sendCtx = composerRef.current?.getSendContext();
      if (!sendCtx) {
        return;
      }
      const { selectedModel: ctxSelectedModel, selectedModelSelection: ctxSelectedModelSelection } =
        sendCtx;
      // In a room, plan feedback and implementation go where a typed message
      // would: usually the agent that wrote the plan, since it worked last.
      const roomSend = resolveRoomSend({
        enabled: roomsEnabled,
        thread: activeThread,
        threadRef: scopeThreadRef(activeThread.environmentId, activeThread.id),
      });
      const roomRecipientId = roomSend.recipient?.id ?? null;

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt(trimmed);

      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);

      // Scroll to the current end *before* adding the optimistic message.
      await requestTimelineStickToBottom(false);

      const optimisticMessage: ChatMessage = {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        ...(roomRecipientId !== null ? { participantId: roomRecipientId } : {}),
        createdAt: messageCreatedAt,
        streaming: false,
      };
      const threadRefForSend = scopeThreadRef(activeThread.environmentId, threadIdForSend);
      addOptimisticThreadMessage(threadRefForSend, optimisticMessage);

      try {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          runtimeMode,
          interactionMode: nextInteractionMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(
          scopeThreadRef(activeThread.environmentId, threadIdForSend),
          nextInteractionMode,
        );

        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          message: {
            messageId: messageIdForSend,
            role: "user",
            text: outgoingMessageText,
            attachments: [],
          },
          modelSelection: roomSend.modelSelection ?? ctxSelectedModelSelection,
          ...(roomRecipientId !== null ? { participantId: roomRecipientId } : {}),
          titleSeed: activeThread.title,
          runtimeMode,
          interactionMode: nextInteractionMode,
          ...(composer ? { composer } : {}),
          ...(nextInteractionMode === "default" && activeProposedPlan
            ? {
                sourceProposedPlan: {
                  threadId: activeThread.id,
                  planId: activeProposedPlan.id,
                },
              }
            : {}),
          createdAt: messageCreatedAt,
        });
        markLocalDispatchAccepted(threadRefForSend);
        if (roomSend.active) {
          const store = useRoomRecipientStore.getState();
          store.choose(threadRefForSend, roomRecipientId);
          if (roomRecipientId !== null) {
            store.setAgentOptions(threadRefForSend, roomRecipientId, undefined);
          }
        }
        // A turn for an added agent says nothing about the thread's own model.
        if (ctxSelectedModel && roomRecipientId === null) {
          await persistThreadSettingsForNextTurn({
            threadId: threadIdForSend,
            createdAt: messageCreatedAt,
            modelSelection: ctxSelectedModelSelection,
          });
        }
        sendInFlightRef.current = false;
      } catch (err) {
        removeOptimisticThreadMessages(threadRefForSend, new Set([messageIdForSend]));
        revokeUserMessagePreviewUrls(optimisticMessage);
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
    },
    [
      activeThread,
      activeProposedPlan,
      addOptimisticThreadMessage,
      beginLocalDispatch,
      isConnecting,
      isSendBusy,
      isServerThread,
      markLocalDispatchAccepted,
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      removeOptimisticThreadMessages,
      runtimeMode,
      setComposerDraftInteractionMode,
      setThreadError,
      environmentId,
      roomsEnabled,
    ],
  );

  const buildForkModelSelection = useCallback(
    (
      instanceId: ProviderInstanceId,
      model: string,
      options: ModelSelection["options"] | undefined = undefined,
    ): ModelSelection | null => {
      const entry = providerInstanceEntries.find(
        (candidate) => candidate.instanceId === instanceId,
      );
      if (!entry || !entry.enabled || !entry.isAvailable) {
        return null;
      }
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        return null;
      }
      const normalizedModel = normalizeModelSlug(resolvedModel, entry.driverKind) ?? resolvedModel;
      const providerState = getComposerProviderState({
        provider: entry.driverKind,
        model: normalizedModel,
        models: entry.models,
        prompt: "",
        modelOptions: options,
      });
      return createModelSelection(
        instanceId,
        normalizedModel,
        providerState.modelOptionsForDispatch,
      );
    },
    [providerInstanceEntries, providerStatuses, settings],
  );

  const resolveInitialForkModelSelection = useCallback((): ModelSelection => {
    const sendCtx = composerRef.current?.getSendContext();
    if (sendCtx) {
      return sendCtx.selectedModelSelection;
    }
    const persistedSelection = activeThread?.modelSelection ?? null;
    if (persistedSelection) {
      const resolved = buildForkModelSelection(
        persistedSelection.instanceId,
        persistedSelection.model,
        persistedSelection.options,
      );
      if (resolved) {
        return resolved;
      }
    }
    const fallbackEntry =
      providerInstanceEntries.find((entry) => entry.enabled && entry.isAvailable) ??
      providerInstanceEntries[0];
    if (fallbackEntry) {
      const resolved = buildForkModelSelection(
        fallbackEntry.instanceId,
        fallbackEntry.models[0]?.slug ?? DEFAULT_MODEL,
      );
      if (resolved) {
        return resolved;
      }
    }
    return createModelSelection(defaultInstanceIdForDriver(CODEX_PROVIDER_DRIVER), DEFAULT_MODEL);
  }, [activeThread?.modelSelection, buildForkModelSelection, providerInstanceEntries]);

  const onContinueMessageInNewThread = useCallback(
    (messageId: MessageId) => {
      if (
        !activeThread ||
        !isServerThread ||
        isWorking ||
        isSendBusy ||
        isConnecting ||
        activeEnvironmentUnavailable ||
        sendInFlightRef.current
      ) {
        return;
      }

      const selectedMessage = activeThread.messages.find((message) => message.id === messageId);
      if (!selectedMessage) {
        return;
      }

      const editsUserPrompt = selectedMessage.role === "user";
      const displayedUserMessage = editsUserPrompt
        ? deriveDisplayedUserMessageState(selectedMessage.text)
        : null;
      const editableInstruction =
        displayedUserMessage?.visibleText ?? DEFAULT_FORK_THREAD_INSTRUCTION;

      setForkDialogState({
        sourceMessageId: selectedMessage.id,
        sourceMessageRole: selectedMessage.role,
        sourceMessageText: buildForkSourceExcerpt(selectedMessage),
        sourceAttachmentCount: selectedMessage.attachments?.length ?? 0,
        instruction: editableInstruction,
        preservedInstructionSuffix: editsUserPrompt
          ? selectedMessage.text.slice(editableInstruction.length)
          : "",
        replacementAttachments: editsUserPrompt ? (selectedMessage.attachments ?? []) : [],
        replacementSkills: editsUserPrompt ? (selectedMessage.skills ?? []) : [],
        modelSelection: resolveInitialForkModelSelection(),
      });
    },
    [
      activeEnvironmentUnavailable,
      activeThread,
      isConnecting,
      isSendBusy,
      isServerThread,
      isWorking,
      resolveInitialForkModelSelection,
    ],
  );

  const onContinueInProject = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (
        !activeThread ||
        !isServerThread ||
        activeTurnInProgress ||
        isSendBusy ||
        isConnecting ||
        activeEnvironmentUnavailable ||
        sendInFlightRef.current
      ) {
        return;
      }
      const lastMessage = activeThread.messages.at(-1);
      if (!lastMessage) {
        return;
      }
      const candidateProjects = selectWorkspaceProjectsAcrossEnvironments(
        useStore.getState(),
      ).filter((project) => project.environmentId === activeThread.environmentId);
      if (candidateProjects.length === 0) {
        toastManager.add({
          type: "error",
          title: "No projects to continue into",
          description: "Add a project first, then continue this chat into it.",
        });
        return;
      }
      const api = readLocalApi();
      if (!api) {
        return;
      }
      const position = { x: event.clientX, y: event.clientY };
      void (async () => {
        const clicked = await api.contextMenu.show(
          candidateProjects.map((project) => ({ id: project.id, label: project.name })),
          position,
        );
        if (!clicked) {
          return;
        }
        const targetProject = candidateProjects.find((project) => project.id === clicked);
        if (!targetProject) {
          return;
        }
        setForkDialogState({
          sourceMessageId: lastMessage.id,
          sourceMessageRole: forkSourceRole(lastMessage),
          sourceMessageText: buildForkSourceExcerpt(lastMessage),
          sourceAttachmentCount: lastMessage.attachments?.length ?? 0,
          instruction: DEFAULT_CONTINUE_IN_PROJECT_INSTRUCTION,
          preservedInstructionSuffix: "",
          replacementAttachments: [],
          replacementSkills: [],
          modelSelection: resolveInitialForkModelSelection(),
          targetProject: { projectId: targetProject.id, name: targetProject.name },
        });
      })();
    },
    [
      activeEnvironmentUnavailable,
      activeThread,
      activeTurnInProgress,
      isConnecting,
      isSendBusy,
      isServerThread,
      resolveInitialForkModelSelection,
    ],
  );

  // Moving to a linked computer (docs/design/fleet.md, Part 3). From the
  // move's start the thread is frozen here: its notice is the dock's only
  // one, and a move that can't go on offers a fork to keep working here.
  const resolveComputerLabel = useComputerLabel();
  const activeThreadComputerLabel = resolveComputerLabel(environmentId, environmentId);
  const continueHereAsNewThread = useCallback(() => {
    const lastMessage = activeThread?.messages.at(-1);
    if (lastMessage) onContinueMessageInNewThread(lastMessage.id);
  }, [activeThread?.messages, onContinueMessageInNewThread]);
  const threadMoveNotice = useThreadMoveNotice({
    thread: activeThread,
    computerLabel: activeThreadComputerLabel,
    onContinueHere: continueHereAsNewThread,
  });
  const dockedComposerNotices = useMemo(
    () => (threadMoveNotice ? [threadMoveNotice] : composerNotices),
    [composerNotices, threadMoveNotice],
  );

  const updateForkDialogInstruction = useCallback((instruction: string) => {
    setForkDialogState((current) => (current ? { ...current, instruction } : current));
  }, []);

  const updateForkDialogModel = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const modelSelection = buildForkModelSelection(instanceId, model);
      if (!modelSelection) {
        return;
      }
      setForkDialogState((current) => (current ? { ...current, modelSelection } : current));
    },
    [buildForkModelSelection],
  );

  const confirmForkThread = useCallback(async () => {
    const state = forkDialogState;
    const api = readEnvironmentApi(environmentId);
    if (
      !state ||
      !api ||
      !activeThread ||
      !isServerThread ||
      phase === "running" ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }
    const visibleInstruction = formatOutgoingPrompt(state.instruction);
    const instruction = `${visibleInstruction}${state.preservedInstructionSuffix}`;
    if (visibleInstruction.length === 0) {
      return;
    }
    if (!activeThread.messages.some((message) => message.id === state.sourceMessageId)) {
      setForkDialogState(null);
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    setForkDialogState(null);
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.fork",
        commandId: newCommandId(),
        threadId: nextThreadId,
        sourceThreadId: activeThread.id,
        sourceMessageId: state.sourceMessageId,
        ...(state.targetProject ? { targetProjectId: state.targetProject.projectId } : {}),
        message: {
          messageId: newMessageId(),
          role: "user",
          text: instruction,
          ...(state.replacementAttachments.length > 0
            ? { attachments: [...state.replacementAttachments] }
            : {}),
          ...(state.replacementSkills.length > 0 ? { skills: [...state.replacementSkills] } : {}),
        },
        composer: composerForTypedMessage({
          typedText: visibleInstruction,
          sentText: instruction,
          plain: false,
        }),
        modelSelection: state.modelSelection,
        runtimeMode,
        interactionMode,
        workspaceMode: "current",
        includeAttachments: true,
        createdAt,
      })
      .then(() => {
        return waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId));
      })
      .then(() => {
        return navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        });
      })
      .catch(async (err: unknown) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() => undefined);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start forked thread",
            description:
              err instanceof Error
                ? err.message
                : "An error occurred while creating the new thread.",
          }),
        );
      })
      .then(finish, finish);
  }, [
    activeEnvironmentUnavailable,
    activeThread,
    beginLocalDispatch,
    environmentId,
    forkDialogState,
    interactionMode,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    phase,
    resetLocalDispatch,
    runtimeMode,
  ]);

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      activeEnvironmentUnavailable ||
      sendInFlightRef.current
    ) {
      return;
    }

    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx) {
      return;
    }
    const { selectedModelSelection: ctxSelectedModelSelection } = sendCtx;

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt(implementationPrompt);
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = ctxSelectedModelSelection;
    // The plan's agent carries on; the computer's default agents join it.
    const startingAgents = serverConfig
      ? buildNewThreadParticipants({
          agents: resolveNewThreadDefaults(serverConfig).roomAgents,
          primaryModelSelection: nextThreadModelSelection,
          instanceEntries: providerInstanceEntries,
        })
      : [];

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        ...(startingAgents.length > 0 ? { participants: startingAgents } : {}),
        runtimeMode,
        interactionMode: "default",
        branch: activeThreadBranch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      })
      .then(() => {
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: ctxSelectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        });
      })
      .then(() => {
        return waitForStartedServerThread(scopeThreadRef(activeThread.environmentId, nextThreadId));
      })
      .then(() => {
        return navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: activeThread.environmentId,
            threadId: nextThreadId,
          },
        });
      })
      .catch(async (err: unknown) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() => undefined);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start implementation thread",
            description:
              err instanceof Error
                ? err.message
                : "An error occurred while creating the new thread.",
          }),
        );
      })
      .then(finish, finish);
  }, [
    activeProject,
    activeProposedPlan,
    activeThreadBranch,
    activeThread,
    beginLocalDispatch,
    activeEnvironmentUnavailable,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    providerInstanceEntries,
    resetLocalDispatch,
    runtimeMode,
    environmentId,
    serverConfig,
  ]);

  const [planScrollTarget, setPlanScrollTarget] = useState<{
    planId: string;
    requestKey: number;
  } | null>(null);

  useEffect(() => {
    setPlanScrollTarget(null);
  }, [activeThread?.id]);

  const onViewProposedPlan = useCallback(() => {
    if (!sidebarProposedPlan) {
      return;
    }
    const planId = sidebarProposedPlan.id;
    setPlanScrollTarget((current) => ({
      planId,
      requestKey: (current?.requestKey ?? 0) + 1,
    }));
  }, [sidebarProposedPlan]);

  const onImplementProposedPlanInThread = useCallback(() => {
    if (!activeProposedPlan) {
      return;
    }
    void onSubmitPlanFollowUp({
      text: buildPlanImplementationPrompt(activeProposedPlan.planMarkdown),
      interactionMode: "default",
    });
  }, [activeProposedPlan, onSubmitPlanFollowUp]);

  const canImplementProposedPlan =
    isServerThread &&
    !isSendBusy &&
    !isConnecting &&
    !activeEnvironmentUnavailable &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);

  const onDismissProposedPlan = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeThread || !activeProposedPlan) {
      return;
    }
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.proposed-plan.dismiss",
        commandId: newCommandId(),
        threadId: activeThread.id,
        planId: activeProposedPlan.id,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not dismiss plan",
          description:
            err instanceof Error ? err.message : "An error occurred while dismissing the plan.",
        }),
      );
    }
  }, [activeProposedPlan, activeThread, environmentId]);

  const applyModelSelection = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread) return;
      const resolvedModel = resolveAppModelSelectionForInstance(
        instanceId,
        settings,
        providerStatuses,
        model,
      );
      if (!resolvedModel) {
        scheduleComposerFocus();
        return;
      }
      const nextModelSelection: ModelSelection = {
        instanceId,
        model: resolvedModel,
      };
      setComposerDraftModelSelection(
        scopeThreadRef(activeThread.environmentId, activeThread.id),
        nextModelSelection,
      );
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeThread,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      providerStatuses,
      settings,
    ],
  );

  const onProviderModelSelect = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      if (!activeThread) return;
      // Look up the configured instance so model normalization and custom
      // model lookup stay scoped to that exact instance. Unknown instance ids
      // are rejected by returning early; the server remains authoritative too.
      const entry = providerStatuses.find((snapshot) => snapshot.instanceId === instanceId);
      const pickedDriverKind = entry?.driver ?? null;
      // The instance the server compares against: the own agent's runtime, or
      // the thread's saved selection when it has none (as the reactor does).
      const boundInstanceId =
        ownAgentSession(activeThread)?.providerInstanceId ?? activeThread.modelSelection.instanceId;
      const currentEntry = providerStatuses.find(
        (snapshot) => snapshot.instanceId === boundInstanceId,
      );
      const classification = classifyModelSwitch({
        boundProvider: lockedProvider,
        pickedDriverKind,
        boundContinuationGroupKey: currentEntry?.continuation?.groupKey ?? null,
        pickedContinuationGroupKey: entry?.continuation?.groupKey ?? null,
        // Only once providers have loaded: before that every instance looks missing.
        boundInstanceMissing:
          providerStatuses.length > 0 &&
          currentEntry === undefined &&
          instanceId !== boundInstanceId,
      });
      // Another agent, or another account with its own history, is a
      // deliberate, lossy handoff (the new instance gets a recap + the working
      // tree, not the outgoing model's full state): confirm once unless the
      // user has opted out.
      if (classification === "confirm-handoff" && !suppressCrossProviderWarning) {
        // Name both sides the way the model picker does.
        const pickerLabel = (id: ProviderInstanceId | undefined) =>
          providerInstanceEntries.find((candidate) => candidate.instanceId === id)?.displayName;
        const toLabel =
          pickerLabel(instanceId) ??
          entry?.displayName ??
          (pickedDriverKind ? String(pickedDriverKind) : model);
        const fromLabel =
          pickerLabel(currentEntry?.instanceId) ??
          currentEntry?.displayName ??
          (lockedProvider ? String(lockedProvider) : "the current provider");
        setCrossProviderDontAskAgain(false);
        setPendingModelHandoff({
          open: true,
          instanceId,
          model,
          copy: buildModelHandoffConfirmCopy({
            fromLabel,
            toLabel,
            sameAgent: pickedDriverKind === lockedProvider,
          }),
        });
        return;
      }
      applyModelSelection(instanceId, model);
    },
    [
      activeThread,
      lockedProvider,
      providerInstanceEntries,
      providerStatuses,
      suppressCrossProviderWarning,
      applyModelSelection,
    ],
  );

  const confirmModelHandoff = useCallback(() => {
    if (!pendingModelHandoff?.open) return;
    if (crossProviderDontAskAgain) {
      updateSettings({ suppressCrossProviderSwitchWarning: true });
    }
    applyModelSelection(pendingModelHandoff.instanceId, pendingModelHandoff.model);
    closeModelHandoffDialog();
  }, [
    pendingModelHandoff,
    crossProviderDontAskAgain,
    updateSettings,
    applyModelSelection,
    closeModelHandoffDialog,
  ]);
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      // A new worktree starts from the computer's "New worktrees from"
      // branch, which the branch selector fills in, not from the branch of
      // the checkout the thread was on (for a worktree, often a throwaway
      // `threadlines/...` name). Going back to the checkout drops that base.
      if (canOverrideServerThreadEnvMode) {
        setPendingServerThreadEnvMode(mode);
        setPendingServerThreadBase(
          mode === "worktree" ? { branch: null, fromSetting: false } : undefined,
        );
        scheduleComposerFocus();
        return;
      }
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, {
          envMode: mode,
          branch: null,
          ...(mode === "worktree" ? { worktreePath: null } : {}),
        });
      }
      scheduleComposerFocus();
    },
    [
      canOverrideServerThreadEnvMode,
      composerDraftTarget,
      isLocalDraftThread,
      setPendingServerThreadEnvMode,
      scheduleComposerFocus,
      setDraftThreadContext,
    ],
  );

  /** A "view diff" link in the conversation opens or retargets the one Diff
   *  tab, leaving the rest of the strip alone. */
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!isServerThread) {
        return;
      }
      onDiffPanelOpen?.();
      const target: RightPanelDiffTarget = {
        diffTurnId: turnId,
        ...(filePath ? { diffFilePath: filePath } : {}),
      };
      retargetRightPanelDiff(rightPanelStateKey, target);
      navigateToRightPanelTab("diff", target);
    },
    [isServerThread, navigateToRightPanelTab, onDiffPanelOpen, rightPanelStateKey],
  );
  // Both the Map and the revert handler are read from refs at call-time so
  // the callback reference is fully stable and never busts context identity.
  const revertTurnCountRef = useRef(revertTurnCountByUserMessageId);
  revertTurnCountRef.current = revertTurnCountByUserMessageId;
  const onRevertToTurnCountRef = useRef(onRevertToTurnCount);
  onRevertToTurnCountRef.current = onRevertToTurnCount;
  const activeThreadMessagesRef = useRef(activeThread?.messages);
  activeThreadMessagesRef.current = activeThread?.messages;
  const onRevertUserMessage = useCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountRef.current.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    const revertedMessageText = activeThreadMessagesRef.current?.find(
      (message) => message.id === messageId,
    )?.text;
    void onRevertToTurnCountRef.current(targetTurnCount, revertedMessageText);
  }, []);
  const onOpenForkSourceThread = useCallback(
    (sourceThreadId: ThreadId, environmentId?: EnvironmentId) => {
      if (!activeThread) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: environmentId ?? activeThread.environmentId,
          threadId: sourceThreadId,
        },
      });
    },
    [activeThread, navigate],
  );

  /** The closed panel button's live-agent node. */
  const headerLiveAgents = useMemo(
    () => summarizeLiveAgents({ subagents: subagentProgress?.items ?? EMPTY_SUBAGENT_ITEMS }),
    [subagentProgress?.items],
  );

  /**
   * The turn activity row's agent summary. The live items only cover the turn in
   * flight, so the thread's durable agent history rides along: it is what every
   * settled turn's tracker is drawn from, and the only source at all after a
   * reload.
   */
  const timelineTurnAgents = useMemo<TimelineTurnAgentsState | null>(() => {
    const subagents = subagentProgress?.items ?? [];
    if (subagents.length === 0 && subagentHistory.length === 0) {
      return null;
    }
    return { subagents, history: subagentHistory };
  }, [subagentHistory, subagentProgress?.items]);

  /**
   * The conversation's way into the sidebar: the turn activity row opens or
   * focuses the Agents tab, a finished agent's receipt opens it drilled into
   * that agent. Selecting before navigating keeps a second receipt press
   * working while the tab is already showing.
   */
  const onOpenAgentsPanel = useCallback(
    (agentThreadId: string | null) => {
      selectAgentsPanelAgent(agentThreadId);
      if (!agentsPanelOpen) {
        openRightPanelTab("agents");
      }
    },
    [agentsPanelOpen, openRightPanelTab],
  );
  /** A workflow run's card: the Agents tab drilled into the run. */
  const workflowRunActions = useMemo<WorkflowRunActions>(() => {
    const open = (
      taskId: string,
      target?: { tab?: WorkflowRunViewTab; agentId?: string; saving?: boolean },
    ) => {
      selectAgentsPanelWorkflow({
        taskId,
        tab: target?.tab ?? "agents",
        agentId: target?.agentId ?? null,
        saving: target?.saving === true,
      });
      if (!agentsPanelOpen) {
        openRightPanelTab("agents");
      }
    };
    return {
      open,
      stop: stopWorkflowRun,
      save: (taskId) => open(taskId, { tab: "script", saving: true }),
      ultracode:
        getModelSelectionBooleanOptionValue(activeThread?.modelSelection, "ultracode") === true,
      sizeGuideline: settings.claudeWorkflowSize === "default" ? null : settings.claudeWorkflowSize,
    };
  }, [
    activeThread?.modelSelection,
    agentsPanelOpen,
    openRightPanelTab,
    settings.claudeWorkflowSize,
    stopWorkflowRun,
  ]);
  const openWorkflowRun = useCallback(
    (taskId: string) => workflowRunActions.open(taskId),
    [workflowRunActions],
  );
  const runningWorkflowRuns = useMemo(
    () =>
      (activeThread?.workflowRuns ?? EMPTY_WORKFLOW_RUNS).filter((run) => run.status === "running"),
    [activeThread?.workflowRuns],
  );
  /** The header's agent faces: the Agents tab on its list, not on one agent. */
  const onOpenHeaderAgentsTab = useCallback(() => onOpenAgentsPanel(null), [onOpenAgentsPanel]);
  const onOpenHeaderSourceTab = useCallback(
    () => openRightPanelTab("sourceControl"),
    [openRightPanelTab],
  );

  const timelineProposedPlanState = useMemo<TimelineProposedPlanState>(
    () => ({
      activePlanId: hasActionableProposedPlan(activeProposedPlan)
        ? (activeProposedPlan?.id ?? null)
        : null,
      activeThreadId: activeThread?.id ?? null,
      onImplement: canImplementProposedPlan ? onImplementProposedPlanInThread : undefined,
      onImplementInNewThread: canImplementProposedPlan
        ? () => void onImplementPlanInNewThread()
        : undefined,
      onDismiss: canImplementProposedPlan ? () => void onDismissProposedPlan() : undefined,
      onOpenThread: onOpenForkSourceThread,
    }),
    [
      activeProposedPlan,
      activeThread?.id,
      canImplementProposedPlan,
      onDismissProposedPlan,
      onImplementPlanInNewThread,
      onImplementProposedPlanInThread,
      onOpenForkSourceThread,
    ],
  );

  const chatHeaderBottomVarRef = useChatHeaderBottomVarRef();

  const chatHeader = activeThread ? (
    <ChatHeader
      activeThreadEnvironmentId={activeThread.environmentId}
      activeThreadTitle={
        isGeneralChatThread && isLocalDraftThread ? "New chat" : activeThread.title
      }
      // "General Chats" is the backing project, not a place the user chose
      // to be. Chats present as their own mode, so the crumb says so.
      activeProjectName={isGeneralChatThread ? "General chats" : activeProject?.name}
      isGitRepo={isGitRepo}
      openInCwd={isGeneralChatThread ? null : gitCwd}
      projectCwd={isGeneralChatThread ? null : (activeProject?.cwd ?? null)}
      activeProjectScripts={isGeneralChatThread ? undefined : activeProject?.scripts}
      preferredScriptId={
        activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
      }
      keybindings={keybindings}
      availableEditors={availableEditors}
      terminalAvailable={activeProject !== undefined}
      terminalOpen={terminalState.terminalOpen}
      terminalToggleShortcutLabel={terminalToggleShortcutLabel}
      railToggleShortcutLabel={sourceControlPanelShortcutLabel}
      railOpen={rightPanelEngaged}
      sourceControlAvailable={activeProject !== undefined && !isGeneralChatThread}
      browserAvailable={browserAvailable}
      browserOpen={browserOpen}
      onToggleBrowser={handleToggleBrowser}
      workingTreeChanges={workingTreeChanges}
      remoteBehindCount={remoteBehindCount}
      liveAgents={headerLiveAgents}
      agentProviderInstanceId={activeProviderInstanceId}
      agentProviderDriverKind={activeProviderDriver}
      fileBrowserAvailable={!isGeneralChatThread}
      taskProgress={taskProgress}
      forkContext={forkHeaderContext}
      parentContext={parentHeaderContext}
      outsideOrigin={activeThread.outsideOrigin ?? null}
      onOpenParentThread={onOpenParentThread}
      backgroundRuns={backgroundRuns}
      activeThreadRef={activeThreadRef}
      onRunProjectScript={runProjectScript}
      onAddProjectScript={saveProjectScript}
      onUpdateProjectScript={updateProjectScript}
      onDeleteProjectScript={deleteProjectScript}
      onToggleBackgroundRunTerminal={toggleBackgroundRunTerminal}
      onStopBackgroundRun={stopBackgroundRun}
      workflowRuns={runningWorkflowRuns}
      onOpenWorkflowRun={openWorkflowRun}
      onStopWorkflowRun={stopWorkflowRun}
      onViewProposedPlan={
        taskProgressProposedPlan !== null && !isGeneralChatThread ? onViewProposedPlan : undefined
      }
      onImplementProposedPlan={
        canImplementProposedPlan ? onImplementProposedPlanInThread : undefined
      }
      onDismissProposedPlan={
        canImplementProposedPlan ? () => void onDismissProposedPlan() : undefined
      }
      onOpenForkSourceThread={onOpenForkSourceThread}
      onToggleTerminal={toggleTerminalVisibility}
      onToggleRail={onToggleRail}
      onOpenSourceTab={onOpenHeaderSourceTab}
      onOpenAgentsTab={onOpenHeaderAgentsTab}
      onContinueInProject={
        isGeneralChatThread && isServerThread && (activeThread?.messages.length ?? 0) > 0
          ? onContinueInProject
          : undefined
      }
      continueInProjectDisabledReason={continueInProjectDisabledReason}
    />
  ) : null;

  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      {/* Top bar: up in the window's title row while there is one, else here. */}
      <TitleBarContent
        measureRef={chatHeaderBottomVarRef}
        findRegion="chat"
        fallback={
          <header
            ref={chatHeaderBottomVarRef}
            data-find-region="chat"
            className={cn(
              "relative transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
              isElectron
                ? cn("drag-region flex items-center px-3 sm:px-5", ELECTRON_HEADER_HEIGHT_CLASS)
                : "pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-2 sm:pb-3 sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)] sm:pt-3",
            )}
          >
            {chatHeader}
          </header>
        }
      >
        {chatHeader}
      </TitleBarContent>

      {threadErrorRateLimitResetCreditDialog}
      <ForkThreadDialog
        state={forkDialogState}
        providerInstanceEntries={providerInstanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        keybindings={keybindings}
        terminalOpen={Boolean(terminalState.terminalOpen)}
        providerSettingsShown={
          threadComputerEnvironmentId === null ||
          isAppBackendEnvironment(threadComputerEnvironmentId)
        }
        disabled={isSendBusy || isConnecting || activeEnvironmentUnavailable}
        onOpenChange={(open) => {
          if (!open) {
            setForkDialogState(null);
          }
        }}
        onInstructionChange={updateForkDialogInstruction}
        onModelChange={updateForkDialogModel}
        onConfirm={confirmForkThread}
      />
      <RevertThreadDialog
        state={revertDialogState}
        disabled={isRevertingCheckpoint}
        onOpenChange={(open) => {
          if (!open) {
            setRevertDialogState(null);
          }
        }}
        onConfirm={() => {
          void confirmRevertThread();
        }}
      />
      {/* Main content area. The browser splits the centre beside the chat; the
          bottom edge belongs to the terminal. Expanding hides the chat. */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Chat column. On a pristine draft with room for it (the `draft-hero`
            variant, see useDraftHero) the timeline shrinks to the question, the
            composer rises to the middle and the column scrolls as one. */}
        <div
          ref={setChatColumnElement}
          data-chat-column=""
          data-find-region="chat"
          className={cn(
            "flex min-h-0 min-w-0 flex-col draft-hero:overflow-y-auto draft-hero:overscroll-y-contain",
            browserOpen && browserExpanded && "hidden",
          )}
          style={browserOpen ? { flex: `${splitChatFraction} 1 0%` } : { flex: "1 1 0%" }}
        >
          {/* Messages Wrapper */}
          <div className="relative flex min-h-0 flex-1 flex-col draft-hero:mt-auto draft-hero:flex-none">
            <HeaderEdgeFade at="top" />
            {/* Messages — LegendList handles virtualization and scrolling internally */}
            <CommandRunActionsContext value={commandRunActions}>
              <MessagesTimeline
                key={activeThread.id}
                emptyState={draftTimelineEmptyState}
                detailPending={isServerThread && !threadDetailLoaded}
                savedEnvironmentConnected={
                  activeSavedEnvironmentRecord === null ? undefined : !activeEnvironmentUnavailable
                }
                isWorking={isWorking}
                isWaitingOnBackgroundTasks={waitingOnBackgroundTasks}
                awaitedTasks={awaitedTasks}
                checkBacks={activeThread.checkBacks}
                onCancelCheckBack={cancelCheckBack}
                onPutMcpAppMessage={putMcpAppMessage}
                activeStatusLabel={activeStatusLabel}
                activeTurnInProgress={isWorking || !latestTurnSettled}
                activeTurnId={activeLatestTurn?.turnId ?? null}
                activeTurnStartedAt={activeWorkStartedAt}
                listRef={legendListRef}
                stickToBottomRequestKey={stickToBottomRequestKey}
                timelineEntries={timelineEntries}
                sideAnswers={sideAnswers}
                onStopSideAnswer={stopSideAnswer}
                turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                activeThreadEnvironmentId={activeThread.environmentId}
                activeThreadId={activeThread.id}
                routeThreadKey={routeThreadKey}
                onOpenTurnDiff={onOpenTurnDiff}
                revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                roomAgents={roomAgentLabels}
                agentModelLabeler={agentModelLabeler}
                ownAgentLabels={ownAgentLabels}
                workingParticipantId={activeThread.session?.participantId ?? null}
                {...(activeThread.agentRequests
                  ? { openAgentRequests: activeThread.agentRequests.open }
                  : {})}
                onRevertUserMessage={onRevertUserMessage}
                onContinueInNewThread={onContinueMessageInNewThread}
                onRevealPickedElement={isElectron ? revealPickedElement : undefined}
                onAddTranscriptHighlightContext={addTranscriptHighlightContextToDraft}
                isRevertingCheckpoint={isRevertingCheckpoint}
                onImageExpand={openExpandedImagePreview}
                onPreviewFile={onPreviewFile}
                markdownCwd={gitCwd ?? undefined}
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={activeWorkspaceRoot}
                skills={activeProviderStatus?.skills ?? EMPTY_PROVIDER_SKILLS}
                providerAuthReconnect={providerAuthReconnectAction}
                failedTurnRetry={failedTurnRetryAction}
                onRunProviderAuthReconnect={runProviderAuthReconnect}
                mcpAuthReconnectStatusByServerName={activeMcpAuthReconnectStatusByServerName}
                onRunMcpAuthReconnect={runMcpAuthReconnect}
                onIsAtEndChange={onIsAtEndChange}
                onVisibleTurnIdsChange={handleVisibleTurnIdsChange}
                searchTarget={timelineSearchTarget}
                planScrollTarget={planScrollTarget}
                proposedPlanState={timelineProposedPlanState}
                turnAgents={timelineTurnAgents}
                onOpenAgentsPanel={onOpenAgentsPanel}
                workflowRunActions={workflowRunActions}
                onOpenThread={onOpenForkSourceThread}
                scheduledRunLabel={scheduledRunLabel}
                scheduledRunEvent={activeThread.scheduledRun?.event === true}
              />
            </CommandRunActionsContext>
            {/* An MCP app open beside the chat: outside the timeline, so it keeps
                running when its card scrolls away. */}
            <McpAppSidePanel
              environmentId={environmentId}
              threadId={activeThreadId ?? null}
              onPutMessage={putMcpAppMessage}
            />

            {/* scroll to bottom button — shown when user has scrolled away from the bottom. */}
            {showScrollToBottom && (
              <div className="pointer-events-none absolute bottom-2 left-1/2 z-30 -translate-x-1/2 py-1.5">
                <button
                  type="button"
                  aria-label="Scroll to bottom"
                  onClick={() => {
                    void requestTimelineStickToBottom(true);
                  }}
                  className="pointer-events-auto flex size-8 items-center justify-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
                >
                  <ChevronDownIcon className="size-4" />
                </button>
              </div>
            )}
          </div>

          {/* Input bar */}
          <div
            ref={setInputBarElement}
            className={cn(
              "pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
              isGitRepo
                ? "pb-[calc(env(safe-area-inset-bottom)+0.25rem)]"
                : "pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:pb-[calc(env(safe-area-inset-bottom)+1rem)]",
            )}
          >
            <div className="relative isolate mx-auto w-full draft-hero:max-w-[45rem]">
              <div className="relative z-10">
                <ChatComposer
                  composerRef={composerRef}
                  composerDraftTarget={composerDraftTarget}
                  environmentId={environmentId}
                  routeKind={routeKind}
                  routeThreadRef={routeThreadRef}
                  draftId={draftId}
                  activeThreadId={activeThreadId}
                  activeThreadEnvironmentId={activeThread?.environmentId}
                  activeThread={activeThread}
                  isLocalDraftThread={isLocalDraftThread}
                  serverThreadExists={serverThread !== undefined}
                  phase={phase}
                  isConnecting={isConnecting}
                  isSendBusy={isSendBusy}
                  isPreparingWorktree={isPreparingWorktree}
                  environmentUnavailable={activeEnvironmentUnavailableState}
                  threadLocked={threadMoveComposerLock}
                  activePendingApproval={activePendingApproval}
                  pendingApprovals={pendingApprovals}
                  pendingUserInputs={pendingUserInputs}
                  activePendingDraftAnswers={activePendingDraftAnswers}
                  activePendingQuestionIndex={activePendingQuestionIndex}
                  respondingRequestIds={respondingRequestIds}
                  respondingUserInputRequestIds={respondingUserInputRequestIds}
                  isTimelineScrolledAway={isTimelineScrolledFarFromEnd}
                  showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                  activeProposedPlan={activeProposedPlan}
                  runtimeMode={runtimeMode}
                  interactionMode={interactionMode}
                  // Unlocked so every instance's models are selectable;
                  // `onProviderModelSelect` gates a switch the thread can't
                  // resume natively (another agent or account) behind the
                  // handoff confirmation.
                  lockedProvider={null}
                  providerStatuses={providerStatuses as ServerProvider[]}
                  // A local draft has not chosen a concrete model yet. Ignore
                  // its placeholder Thread value so the composer can resolve
                  // the active provider instance's live `isDefault` model.
                  activeThreadModelSelection={
                    isLocalDraftThread ? null : activeThread?.modelSelection
                  }
                  activeThreadActivities={activeThread ? threadActivities : undefined}
                  notices={dockedComposerNotices}
                  pullRequests={composerPullRequests}
                  stackedAbove={
                    <ComposerFollowUpQueue
                      steering={queuedSteeringMessages}
                      queued={queuedFollowUps}
                      paused={!isWorking && !waitingOnBackgroundTasks}
                      attachmentOnlyPrompt={ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}
                      roomAgents={roomAgentLabels}
                      environmentId={environmentId}
                      onEdit={(followUp) => void returnQueuedFollowUpsToComposer([followUp])}
                      onRemove={removeQueuedFollowUp}
                    />
                  }
                  resolvedTheme={resolvedTheme}
                  settings={settings}
                  roomsEnabled={roomsEnabled}
                  keybindings={keybindings}
                  terminalOpen={Boolean(terminalState.terminalOpen)}
                  gitCwd={gitCwd}
                  canReferenceWorkspaceFiles={!isGeneralChatThread && gitCwd !== null}
                  promptRef={promptRef}
                  composerAttachmentsRef={composerAttachmentsRef}
                  composerTerminalContextsRef={composerTerminalContextsRef}
                  composerTranscriptHighlightContextsRef={composerTranscriptHighlightContextsRef}
                  composerFileSelectionContextsRef={composerFileSelectionContextsRef}
                  composerPickedElementContextsRef={composerPickedElementContextsRef}
                  onRevealPickedElement={isElectron ? revealPickedElement : undefined}
                  shouldAutoScrollRef={isAtEndRef}
                  scheduleStickToBottom={scheduleTimelineStickToBottom}
                  onSend={onSend}
                  workflowKeywordSuppressed={workflowKeywordSuppressed}
                  onToggleWorkflowKeyword={toggleWorkflowKeyword}
                  onInterrupt={onInterrupt}
                  onStopBackgroundWork={stopBackgroundWork}
                  onCompactContext={contextCompactControlVisible ? onCompactContext : undefined}
                  goalControls={goalControls}
                  goalDispatching={
                    activeThread !== undefined && goalDispatchingThreadId === activeThread.id
                  }
                  optimisticGoal={
                    activeThread !== undefined
                      ? (optimisticGoals.get(activeThread.id)?.goal ?? null)
                      : null
                  }
                  onSetThreadGoal={onSetThreadGoal}
                  onClearThreadGoal={onClearThreadGoal}
                  contextCompactDisabled={
                    contextCompactControlVisible ? contextCompactDisabled : undefined
                  }
                  contextCompactInFlight={
                    contextCompactControlVisible ? contextCompactInFlight : undefined
                  }
                  contextCompactDisabledReason={
                    contextCompactControlVisible ? contextCompactDisabledReason : undefined
                  }
                  onImplementPlanInNewThread={onImplementPlanInNewThread}
                  onRespondToApproval={onRespondToApproval}
                  onSelectActivePendingUserInputOption={onSelectActivePendingUserInputOption}
                  onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                  onRespondToUserInput={onRespondToUserInput}
                  onPreviousActivePendingUserInputQuestion={
                    onPreviousActivePendingUserInputQuestion
                  }
                  onChangeActivePendingUserInputCustomAnswer={
                    onChangeActivePendingUserInputCustomAnswer
                  }
                  onProviderModelSelect={onProviderModelSelect}
                  toggleInteractionMode={toggleInteractionMode}
                  handleRuntimeModeChange={handleRuntimeModeChange}
                  handleInteractionModeChange={handleInteractionModeChange}
                  focusComposer={focusComposer}
                  setThreadError={setThreadError}
                  onExpandImage={openExpandedImagePreview}
                  onPreviewFile={onPreviewFile}
                />
                <AlertDialog
                  open={pendingModelHandoff?.open === true}
                  onOpenChange={(open) => {
                    if (!open) closeModelHandoffDialog();
                  }}
                >
                  <AlertDialogPopup>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{pendingModelHandoff?.copy.title}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {pendingModelHandoff?.copy.description}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <label className="flex cursor-pointer items-center gap-2 px-6 pb-4 text-muted-foreground text-sm">
                      <Checkbox
                        checked={crossProviderDontAskAgain}
                        onCheckedChange={(checked) =>
                          setCrossProviderDontAskAgain(checked === true)
                        }
                      />
                      Don't ask again
                    </label>
                    <AlertDialogFooter>
                      <AlertDialogClose render={<Button variant="outline" />}>
                        Cancel
                      </AlertDialogClose>
                      <Button onClick={confirmModelHandoff}>
                        {pendingModelHandoff?.copy.confirmLabel}
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogPopup>
                </AlertDialog>
              </div>
            </div>
            {isGitRepo && (
              <BranchToolbar
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                {...(routeKind === "draft" && draftId ? { draftId } : {})}
                onEnvModeChange={onEnvModeChange}
                {...(canOverrideServerThreadEnvMode || isPreparingWorktree
                  ? { effectiveEnvModeOverride: envMode }
                  : {})}
                {...(canOverrideServerThreadEnvMode
                  ? {
                      activeThreadBranchOverride: activeThreadBranch,
                      activeThreadBranchOverrideFromSetting:
                        pendingServerThreadBase?.fromSetting === true,
                      onActiveThreadBranchOverrideChange: onPendingServerThreadBaseChange,
                    }
                  : {})}
                envLocked={envLocked}
                onComposerFocusRequest={scheduleComposerFocus}
                {...(canCheckoutPullRequestIntoThread
                  ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                  : {})}
                {...(hasMultipleEnvironments || setupTargets.length > 0
                  ? { onEnvironmentChange }
                  : {})}
                {...(setupTargets.length > 0 ? { onSetUpElsewhere } : {})}
                availableEnvironments={logicalProjectEnvironments}
              />
            )}
          </div>

          {/* Under the hero's composer: where the user left off. Mounted for
              any roomy draft and shown by the marker, so it appears and leaves
              in the same frame as the hero itself. */}
          {isLocalDraftThread && draftHeroCapable ? (
            <div className="hidden w-full flex-col items-center px-4 pb-8 draft-hero:mb-auto draft-hero:flex">
              <div className="flex w-full max-w-[45rem] flex-col items-center">
                <DraftRecentThreads isGeneralChat={isGeneralChatThread} />
              </div>
            </div>
          ) : null}

          {pullRequestDialogState ? (
            <PullRequestThreadDialog
              key={pullRequestDialogState.key}
              open
              environmentId={activeThread.environmentId}
              threadId={pullRequestDialogState.threadId}
              cwd={activeProject?.cwd ?? null}
              initialReference={pullRequestDialogState.initialReference}
              onOpenChange={(open) => {
                if (!open) {
                  closePullRequestDialog();
                }
              }}
              onPrepared={handlePreparedPullRequestThread}
            />
          ) : null}
        </div>
        {/* end chat column */}
        {browserOpen && routeThreadRef !== null ? (
          <>
            {browserExpanded ? null : (
              <BrowserSplitHandle
                chatFraction={splitChatFraction}
                onChange={setSplitChatFraction}
              />
            )}
            <BrowserPanel
              threadRef={routeThreadRef}
              projectId={activeThread?.projectId ?? null}
              flexGrow={browserExpanded ? 1 : 1 - splitChatFraction}
              onClose={handleCloseBrowser}
              onPickElement={appendPickedElementToComposer}
              onScreenshot={(shot) => composerRef.current?.addScreenshotAttachment(shot) ?? false}
              onDrawing={(drawing) => composerRef.current?.addDrawingContext(drawing)}
              onAttachPageErrors={appendPageErrorsToComposer}
              pendingReveal={pendingElementReveal}
              onRevealHandled={() => setPendingElementReveal(null)}
            />
          </>
        ) : null}
      </div>
      {/* end horizontal flex container */}

      {mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
        <PersistentThreadTerminalDrawer
          key={mountedThreadKey}
          threadRef={mountedThreadRef}
          threadId={mountedThreadRef.threadId}
          visible={mountedThreadKey === activeThreadKey && terminalState.terminalOpen}
          focusRequestId={mountedThreadKey === activeThreadKey ? terminalFocusRequestId : 0}
          findRequested={mountedThreadKey === activeThreadKey && terminalFindRequested}
          onFindRequestHandled={() => setTerminalFindRequested(false)}
          splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
          newShortcutLabel={newTerminalShortcutLabel ?? undefined}
          closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
          hideShortcutLabel={terminalToggleShortcutLabel ?? undefined}
          findShortcutLabel={findTerminalShortcutLabel ?? undefined}
          keybindings={keybindings}
          onAddTerminalContext={addTerminalContextToDraft}
          onCloseTerminal={requestCloseTerminal}
          onRestartTerminal={requestRestartTerminal}
          onHideTerminal={toggleTerminalVisibility}
        />
      ))}
      <AlertDialog
        open={pendingTerminalAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingTerminalAction(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingTerminalAction?.kind === "restart" ? "Restart terminal?" : "Kill terminal?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingTerminalAction?.kind === "restart"
                ? "Something is still running in this terminal. Restarting stops it and starts a new shell in the thread's folder, below what it printed."
                : "A process is still running in this terminal. Killing the terminal stops the process and discards the terminal history. To keep it running, hide the terminal instead."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmPendingTerminalAction}>
              {pendingTerminalAction?.kind === "restart" ? "Restart terminal" : "Kill terminal"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {previewedFile && <FilePreviewDialog request={previewedFile} onClose={closePreviewedFile} />}
    </div>
  );
}

import {
  type ApprovalRequestId,
  DEFAULT_MODEL,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type ProjectScript,
  type ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  type ServerProvider,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  ProviderDriverKind,
  RuntimeMode,
  TerminalOpenInput,
} from "@threadlines/contracts";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@threadlines/client-runtime";
import { createModelSelection, normalizeModelSlug } from "@threadlines/shared/model";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@threadlines/shared/projectScripts";
import { formatForkSourceExcerpt, truncate } from "@threadlines/shared/String";
import { Debouncer } from "@tanstack/react-pacer";
import * as Option from "effect/Option";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useGitStatus } from "~/lib/gitStatusState";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { readEnvironmentApi } from "../environmentApi";
import { ELECTRON_HEADER_HEIGHT_CLASS } from "../desktopChrome";
import { isElectron } from "../env";
import { ensureLocalApi, readLocalApi } from "../localApi";
import {
  closeRightPanelSearchParams,
  isSourceControlPanelOpen,
  parseDiffRouteSearch,
  preserveRightPanelSearchParamsForNavigation,
  stripRightPanelSearchParams,
} from "../diffRouteSearch";
import {
  collapseExpandedComposerCursor,
  parseStandaloneComposerSlashCommand,
} from "../composer-logic";
import {
  deriveCompletionDividerBeforeEntryId,
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveForkContextEntries,
  deriveActiveStatusLabel,
  deriveActiveWorkStartedAt,
  deriveActivePlanState,
  deriveSubagentProgressState,
  deriveSubagentResultEntries,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  formatElapsed,
  type McpAuthReconnectAction,
  type ProviderAuthReconnectAction,
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
  selectProjectsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
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
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";
import { buildTemporaryWorktreeBranchName } from "@threadlines/shared/git";
import { BranchToolbar } from "./BranchToolbar";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import { ChevronDownIcon, CornerDownRightIcon, TriangleAlertIcon, WifiOffIcon } from "lucide-react";
import { cn, randomUUID } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptIdFromCommand,
} from "~/projectScripts";
import { newCommandId, newDraftId, newMessageId, newThreadId } from "~/lib/utils";
import { formatProviderDriverKindLabel, resolveSelectableProvider } from "../providerModels";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import {
  type AppModelOption,
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "../modelSelection";
import { isTerminalFocused } from "../lib/terminalFocus";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import {
  reconnectSavedEnvironment,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { buildDraftThreadRouteParams } from "../threadRoutes";
import {
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import {
  appendTerminalContextsToPrompt,
  formatTerminalContextLabel,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { ChatComposer, type ChatComposerHandle } from "./chat/ChatComposer";
import { getComposerProviderState } from "./chat/composerProviderState";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { ChatHeader, type ForkHeaderContext } from "./chat/ChatHeader";
import type { ThreadBackgroundRunItem } from "./chat/ThreadActivityPopover";
import { type ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { resolveEffectiveEnvMode, resolveEnvironmentOptionLabel } from "./BranchToolbar.logic";
import {
  ProviderStatusBanner,
  shouldRenderProviderStatusBanner,
} from "./chat/ProviderStatusBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  DEFAULT_SCROLL_END_TOLERANCE_PX,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveProviderBackgroundRuns,
  deriveComposerSendState,
  deriveProviderAuthReconnectPrompt,
  hasServerAcknowledgedLocalDispatch,
  isScrollMetricsAtEnd,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LEGACY_LAST_INVOKED_SCRIPT_BY_PROJECT_KEYS,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  PullRequestDialogState,
  classifyModelSwitch,
  cloneComposerImageForRetry,
  deriveLockedProvider,
  readFileAsDataUrl,
  reconcileSteeringHandoffStatuses,
  reconcileMountedTerminalThreadIds,
  resolveSendEnvMode,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
  shouldConfirmTerminalKill,
  shouldWriteThreadErrorToCurrentServerThread,
  waitForStartedServerThread,
  mergeLocalDraftThreadWithServerThread,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerHandleContext } from "../composerHandleContext";
import {
  useServerAvailableEditors,
  useServerConfig,
  useServerKeybindings,
} from "~/rpc/serverState";
import {
  selectOptimisticThreadMessages,
  useOptimisticThreadMessagesStore,
} from "../optimisticThreadMessages";
import { sanitizeThreadErrorMessage } from "~/rpc/transportError";
import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { hasActiveContextCompactionActivity } from "~/lib/contextCompactionActivities";
import { deriveProviderAccountUsagePresentationForProvider } from "~/lib/providerUsage";
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
import {
  canRequestProviderRateLimitResetCredit,
  isProviderUsageLimitErrorMessage,
  useProviderRateLimitResetCredit,
} from "./ProviderRateLimitResetCredit";
import {
  buildVersionMismatchDismissalKey,
  dismissVersionMismatch,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
} from "../versionSkew";
import { derivePlanTaskBadge, useThreadPlanCatalog } from "../planPanelState";
import {
  deriveProviderInstanceEntries,
  filterMaintainedProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";

const IMAGE_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_PROVIDERS: ServerProvider[] = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const CODEX_PROVIDER_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_PROVIDER_DRIVER = ProviderDriverKind.make("claudeAgent");
const LAYOUT_STICK_TO_BOTTOM_FRAME_COUNT = 4;
type McpAuthReconnectStatus = "running" | "completed";

function finiteScrollMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isScrollableNodeAtEnd(node: unknown): boolean | null {
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

  return isScrollMetricsAtEnd({
    scrollOffset: finiteScrollMetric(metrics.scrollTop) ?? 0,
    viewportLength,
    contentLength,
    tolerancePx: DEFAULT_SCROLL_END_TOLERANCE_PX,
  });
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

function SteeringQueueIndicator({
  messages,
}: {
  readonly messages: ReadonlyArray<SteeringMessageHandoff>;
}) {
  const latest = messages[messages.length - 1];
  if (!latest) {
    return null;
  }

  const countLabel = messages.length > 1 ? `${messages.length} pending` : "Pending";

  return (
    <div className="mx-auto mb-2 max-w-208 px-1">
      <div className="flex min-w-0 items-start gap-2 rounded-lg border border-primary/20 bg-primary/8 px-3 py-2 text-xs shadow-sm">
        <CornerDownRightIcon className="mt-0.5 size-3.5 shrink-0 text-primary-readable" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="font-medium text-primary-readable">Follow-up pending</span>
            <span className="rounded-full bg-primary/12 px-1.5 py-0.5 text-[11px] text-primary-readable/80">
              {countLabel}
            </span>
          </div>
          <div className="mt-0.5 truncate text-muted-foreground/70">
            {truncate(latest.text, 140)}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatOutgoingPrompt(text: string): string {
  return text.trim();
}

const FORK_SOURCE_EXCERPT_CHARS = 1_200;
const DEFAULT_FORK_THREAD_INSTRUCTION =
  "Continue from this fork point. Use the carried context for background, inspect the current files for ground truth, and take the next best step.";

type ForkThreadDialogState = {
  readonly sourceMessageId: MessageId;
  readonly sourceMessageRole: ChatMessage["role"];
  readonly sourceMessageText: string;
  readonly sourceAttachmentCount: number;
  readonly instruction: string;
  readonly modelSelection: ModelSelection;
};

function buildForkSourceExcerpt(message: ChatMessage): string {
  return formatForkSourceExcerpt(message.text, FORK_SOURCE_EXCERPT_CHARS);
}

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
  const instruction = state.instruction.trim();
  const sourceText =
    state.sourceMessageText.length > 0 ? state.sourceMessageText : "No text in the source message.";

  return (
    <AlertDialog open onOpenChange={props.onOpenChange}>
      <AlertDialogPopup className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Continue in a new thread?</AlertDialogTitle>
          <AlertDialogDescription>
            This starts a separate thread immediately. It uses your current files, does not checkout
            or revert the worktree, and carries a server-built context snapshot up to the selected
            message.
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
              <span className="font-medium text-foreground/80">Files:</span> current worktree
            </p>
            <p>
              <span className="font-medium text-foreground/80">Revert:</span> none
            </p>
            <p>
              <span className="font-medium text-foreground/80">Images:</span>{" "}
              {state.sourceAttachmentCount > 0
                ? "copied only if carried in context"
                : "none on source message"}
            </p>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
              First message
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
            Start fork
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;

type ChatViewProps =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      routeKind: "server";
      draftId?: never;
    }
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      onDiffPanelOpen?: () => void;
      reserveTitleBarControlInset?: boolean;
      routeKind: "draft";
      draftId: DraftId;
    };

interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

type PersistentTerminalLaunchContext = Pick<TerminalLaunchContext, "cwd" | "worktreePath">;

function useLocalDispatchState(input: {
  activeThread: Thread | undefined;
  activeLatestTurn: Thread["latestTurn"] | null;
  phase: SessionPhase;
  activePendingApproval: ApprovalRequestId | null;
  activePendingUserInput: ApprovalRequestId | null;
  threadError: string | null | undefined;
}) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);

  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) => {
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

  return {
    beginLocalDispatch,
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
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  hideShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onCloseTerminal: (
    threadRef: { environmentId: EnvironmentId; threadId: ThreadId },
    threadId: ThreadId,
    terminalId: string,
    options?: { sessionExited?: boolean },
  ) => void;
  onHideTerminal: () => void;
}

const PersistentThreadTerminalDrawer = memo(function PersistentThreadTerminalDrawer({
  threadRef,
  threadId,
  visible,
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  hideShortcutLabel,
  keybindings,
  onAddTerminalContext,
  onCloseTerminal,
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
  const storeSetTerminalHeight = useTerminalStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = useMemo(() => {
    if (launchContext !== null) {
      return launchContext.worktreePath;
    }
    return worktreePath;
  }, [launchContext, worktreePath]);
  const cwd = useMemo(
    () =>
      launchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : null),
    [effectiveWorktreePath, launchContext?.cwd, project],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );

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
      <ThreadTerminalDrawer
        threadRef={threadRef}
        threadId={threadId}
        cwd={cwd}
        worktreePath={effectiveWorktreePath}
        runtimeEnv={runtimeEnv}
        visible={visible}
        height={terminalState.terminalHeight}
        terminalIds={terminalState.terminalIds}
        activeTerminalId={terminalState.activeTerminalId}
        terminalGroups={terminalState.terminalGroups}
        activeTerminalGroupId={terminalState.activeTerminalGroupId}
        focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
        onSplitTerminal={splitTerminal}
        onNewTerminal={createNewTerminal}
        onHideTerminal={onHideTerminal}
        splitShortcutLabel={visible ? splitShortcutLabel : undefined}
        newShortcutLabel={visible ? newShortcutLabel : undefined}
        closeShortcutLabel={visible ? closeShortcutLabel : undefined}
        hideShortcutLabel={visible ? hideShortcutLabel : undefined}
        keybindings={keybindings}
        onActiveTerminalChange={activateTerminal}
        onCloseTerminal={closeTerminal}
        onHeightChange={setTerminalHeight}
        onAddTerminalContext={handleAddTerminalContext}
      />
    </div>
  );
});

export default function ChatView(props: ChatViewProps) {
  const {
    environmentId,
    threadId,
    routeKind,
    onDiffPanelOpen,
    reserveTitleBarControlInset = true,
  } = props;
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
  const markThreadVisited = useUiStateStore((store) => store.markThreadVisited);
  const activeThreadLastVisitedAt = useUiStateStore((store) =>
    routeKind === "server" ? store.threadLastVisitedAtById[routeThreadKey] : undefined,
  );
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const suppressCrossProviderWarning = settings.suppressCrossProviderSwitchWarning ?? false;
  const [pendingCrossProviderSwitch, setPendingCrossProviderSwitch] = useState<{
    instanceId: ProviderInstanceId;
    model: string;
    fromLabel: string;
    toLabel: string;
  } | null>(null);
  const [crossProviderDontAskAgain, setCrossProviderDontAskAgain] = useState(false);
  const [forkDialogState, setForkDialogState] = useState<ForkThreadDialogState | null>(null);
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const shouldUseRightPanelSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
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
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftSessionByLogicalProjectKey = useComposerDraftStore(
    (store) => store.getDraftSessionByLogicalProjectKey,
  );
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore((store) =>
    routeKind === "server"
      ? store.getDraftSessionByRef(routeThreadRef)
      : draftId
        ? store.getDraftSession(draftId)
        : null,
  );
  const promptRef = useRef("");
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>([]);
  const localComposerRef = useRef<ChatComposerHandle | null>(null);
  const composerRef = useComposerHandleContext() ?? localComposerRef;
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
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
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [terminalLaunchContext, setTerminalLaunchContext] = useState<TerminalLaunchContext | null>(
    null,
  );
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [pendingServerThreadEnvMode, setPendingServerThreadEnvMode] =
    useState<DraftThreadEnvMode | null>(null);
  const [pendingServerThreadBranch, setPendingServerThreadBranch] = useState<string | null>();
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

  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef),
  );
  const openTerminalThreadKeys = useTerminalStateStore(
    useShallow((state) =>
      Object.entries(state.terminalStateByThreadKey).flatMap(([nextThreadKey, nextTerminalState]) =>
        nextTerminalState.terminalOpen ? [nextThreadKey] : [],
      ),
    ),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSplitTerminal = useTerminalStateStore((s) => s.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);
  const serverThreadKeys = useStore(
    useShallow((state) =>
      selectThreadsAcrossEnvironments(state).map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    ),
  );
  const storeServerTerminalLaunchContext = useTerminalStateStore(
    (s) => s.terminalLaunchContextByThreadKey[scopedThreadKey(routeThreadRef)] ?? null,
  );
  const storeClearTerminalLaunchContext = useTerminalStateStore(
    (s) => s.clearTerminalLaunchContext,
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

  const fallbackDraftProjectRef = draftThread
    ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
    : null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelectorByRef(fallbackDraftProjectRef), [fallbackDraftProjectRef]),
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
            fallbackDraftProject?.defaultModelSelection ?? {
              instanceId: ProviderInstanceId.make("codex"),
              model: DEFAULT_MODEL,
            },
            localDraftError,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, localDraftError, threadId],
  );
  const isServerThread = routeKind === "server" && serverThread !== undefined;
  const activeThread = isServerThread
    ? serverThread
    : mergeLocalDraftThreadWithServerThread(localDraftThread, serverThread);
  const runtimeMode = composerRuntimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode =
    composerInteractionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const sourceControlOpen = isSourceControlPanelOpen(rawSearch, {
    defaultOpen: !shouldUseRightPanelSheet,
  });
  const preserveRightPanelSearchForDraftNavigation = useCallback(
    (previous: Record<string, unknown>) =>
      preserveRightPanelSearchParamsForNavigation(previous, { sourceControlOpen }),
    [sourceControlOpen],
  );
  const activeThreadId = activeThread?.id ?? null;
  const activeThreadRef = useMemo(
    () => (activeThread ? scopeThreadRef(activeThread.environmentId, activeThread.id) : null),
    [activeThread],
  );
  const activeThreadKey = activeThreadRef ? scopedThreadKey(activeThreadRef) : null;
  const existingOpenTerminalThreadKeys = useMemo(() => {
    const existingThreadKeys = new Set<string>([...serverThreadKeys, ...draftThreadKeys]);
    return openTerminalThreadKeys.filter((nextThreadKey) => existingThreadKeys.has(nextThreadKey));
  }, [draftThreadKeys, openTerminalThreadKeys, serverThreadKeys]);
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
  const activeProjectRef = activeThread
    ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
    : null;
  const activeProject = useStore(
    useMemo(() => createProjectSelectorByRef(activeProjectRef), [activeProjectRef]),
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
      });
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      );
      const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (storedDraftSession) {
        setDraftThreadContext(storedDraftSession.draftId, input);
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          activeProjectRef,
          storedDraftSession.draftId,
          {
            threadId: storedDraftSession.threadId,
            ...input,
          },
        );
        if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
          await navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(storedDraftSession.draftId),
            search: preserveRightPanelSearchForDraftNavigation,
          });
        }
        return storedDraftSession.threadId;
      }

      const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
      if (
        !isServerThread &&
        activeDraftSession?.logicalProjectKey === logicalProjectKey &&
        draftId
      ) {
        setDraftThreadContext(draftId, input);
        setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
          threadId: activeDraftSession.threadId,
          createdAt: activeDraftSession.createdAt,
          runtimeMode: activeDraftSession.runtimeMode,
          interactionMode: activeDraftSession.interactionMode,
          ...input,
        });
        return activeDraftSession.threadId;
      }

      const nextDraftId = newDraftId();
      const nextThreadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
        threadId: nextThreadId,
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(nextDraftId),
        search: preserveRightPanelSearchForDraftNavigation,
      });
      return nextThreadId;
    },
    [
      activeProject,
      draftId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      preserveRightPanelSearchForDraftNavigation,
      projectGroupingSettings,
      routeKind,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!serverThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThreadLastVisitedAt ? Date.parse(activeThreadLastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      activeLatestTurn.completedAt,
    );
  }, [
    activeLatestTurn?.completedAt,
    activeThreadLastVisitedAt,
    latestTurnSettled,
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
  ]);

  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
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
  const infrastructureComposerBannerItems = useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    if (activeEnvironmentUnavailableState) {
      items.push({
        id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
        variant:
          activeEnvironmentUnavailableState.connectionState === "error" ? "error" : "warning",
        icon: <WifiOffIcon />,
        title: (
          <>
            {activeEnvironmentUnavailableState.label} is{" "}
            {activeEnvironmentUnavailableState.connectionState === "connecting"
              ? "connecting"
              : "disconnected"}
          </>
        ),
        description: "Reconnect this environment before sending messages or running actions.",
        actions: (
          <>
            <Button
              size="xs"
              disabled={
                activeEnvironmentUnavailableState.connectionState === "connecting" ||
                reconnectingEnvironmentId === activeEnvironmentUnavailableState.environmentId
              }
              onClick={() =>
                void handleReconnectActiveEnvironment(
                  activeEnvironmentUnavailableState.environmentId,
                  activeEnvironmentUnavailableState.label,
                )
              }
            >
              {activeEnvironmentUnavailableState.connectionState === "connecting" ||
              reconnectingEnvironmentId === activeEnvironmentUnavailableState.environmentId
                ? "Reconnecting..."
                : "Reconnect"}
            </Button>
          </>
        ),
      });
    }
    if (showVersionMismatchBanner && versionMismatch && versionMismatchDismissKey) {
      items.push({
        id: `version-mismatch:${versionMismatchDismissKey}`,
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: "Client and server versions differ",
        description: (
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
  const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () =>
      filterMaintainedProviderInstanceEntries(
        sortProviderInstanceEntries(deriveProviderInstanceEntries(providerStatuses)),
      ),
    [providerStatuses],
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
  const unlockedSelectedProvider = resolveSelectableProvider(
    providerStatuses,
    selectedProviderByThreadId ?? threadProvider ?? ProviderDriverKind.make("codex"),
  );
  const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const phase = derivePhase(activeThread?.session ?? null);
  const isSessionStarting = activeThread?.session?.orchestrationStatus === "starting";
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const workLogEntries = useMemo(() => deriveWorkLogEntries(threadActivities), [threadActivities]);
  const forkContextEntries = useMemo(
    () => deriveForkContextEntries(threadActivities),
    [threadActivities],
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
  const latestTurnHasToolActivity = useMemo(
    () => hasToolActivityForTurn(threadActivities, activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, threadActivities],
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
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
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
  const taskProgress = useMemo(
    () =>
      activePlan || taskProgressProposedPlan || taskProgressBadge
        ? {
            activePlan,
            activeProposedPlan: taskProgressProposedPlan,
            badge: taskProgressBadge,
            label: taskProgressLabel,
          }
        : null,
    [activePlan, taskProgressBadge, taskProgressLabel, taskProgressProposedPlan],
  );
  const subagentProgress = useMemo(
    () =>
      deriveSubagentProgressState({
        activities: threadActivities,
        latestTurnId: activeLatestTurn?.turnId ?? null,
        latestTurnSettled,
      }),
    [activeLatestTurn?.turnId, latestTurnSettled, threadActivities],
  );
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const {
    beginLocalDispatch,
    resetLocalDispatch,
    localDispatchStartedAt,
    isPreparingWorktree,
    isSendBusy,
  } = useLocalDispatchState({
    activeThread,
    activeLatestTurn,
    phase,
    activePendingApproval: activePendingApproval?.requestId ?? null,
    activePendingUserInput: activePendingUserInput?.requestId ?? null,
    threadError: activeThread?.error,
  });
  const isWorking =
    phase === "running" ||
    phase === "connecting" ||
    isSessionStarting ||
    isSendBusy ||
    isConnecting ||
    isRevertingCheckpoint;
  const activeTurnInProgress = isWorking || (activeLatestTurn !== null && !latestTurnSettled);
  const activeStatusLabel = deriveActiveStatusLabel({
    phase,
    workLogEntries,
    latestTurnId: activeLatestTurn?.turnId ?? null,
    isConnecting,
    isSendBusy,
    isPreparingWorktree,
    isSessionStarting,
    isRevertingCheckpoint,
    pendingApprovalCount: pendingApprovals.length,
    pendingUserInputCount: pendingUserInputs.length,
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
      });
    });
  }, [activeThread?.latestTurn, activeThreadKey, serverMessages]);
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
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [
    serverMessages,
    queuedSteeringMessageIds,
    attachmentPreviewHandoffByMessageId,
    optimisticUserMessages,
  ]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessages,
        activeThread?.proposedPlans ?? [],
        workLogEntries,
        deriveSubagentResultEntries(threadActivities),
        forkContextEntries,
      ),
    [
      activeThread?.proposedPlans,
      forkContextEntries,
      threadActivities,
      timelineMessages,
      workLogEntries,
    ],
  );
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    const assistantTurnIdByMessageId = new Map<MessageId, TurnId | null | undefined>();
    for (const message of activeThread?.messages ?? []) {
      if (message.role === "assistant") {
        assistantTurnIdByMessageId.set(message.id, message.turnId);
      }
    }
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      if (assistantTurnIdByMessageId.get(summary.assistantMessageId) !== summary.turnId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [activeThread?.messages, turnDiffSummaries]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!completionSummary) return null;
    return deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn);
  }, [activeLatestTurn, completionSummary, latestTurnSettled, timelineEntries]);
  const gitCwd = activeProject
    ? projectScriptCwd({
        project: { cwd: activeProject.cwd },
        worktreePath: activeThread?.worktreePath ?? null,
      })
    : null;
  const gitStatusQuery = useGitStatus({ environmentId, cwd: gitCwd });
  const keybindings = useServerKeybindings();
  const availableEditors = useServerAvailableEditors();
  // Prefer an instance-id match so a custom Codex instance (e.g.
  // `codex_personal`) surfaces its own status/message in the banner rather
  // than the default Codex's. Falls back to first-match-by-kind when no
  // saved instance id is available or the instance no longer exists.
  const activeProviderInstanceId =
    activeThread?.session?.providerInstanceId ??
    activeThread?.modelSelection.instanceId ??
    activeProject?.defaultModelSelection?.instanceId ??
    null;
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
  const activeProviderAccountUsage = useMemo(
    () => deriveProviderAccountUsagePresentationForProvider(activeProviderStatus),
    [activeProviderStatus],
  );
  const {
    isConsumingRateLimitResetCredit: isConsumingThreadErrorRateLimitResetCredit,
    requestRateLimitResetCredit: requestThreadErrorRateLimitResetCredit,
    rateLimitResetCreditDialog: threadErrorRateLimitResetCreditDialog,
  } = useProviderRateLimitResetCredit();
  const activeProviderResetCredits = activeProviderAccountUsage?.resetCredits ?? null;
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
      availableCount: activeProviderResetCredits.availableCount,
    });
  }, [
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
  const activeProviderSupportsManualContextCompaction = providerSupportsManualContextCompaction(
    activeProviderStatus,
    activeProviderDriver,
  );
  const contextCompactActivityInProgress = hasActiveContextCompactionActivity(
    activeThread?.activities,
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
        threadError: activeThread?.error ?? activeThread?.session?.lastError ?? null,
        activities: threadActivities,
        messages: timelineMessages,
      }),
    [
      activeProviderDriver,
      activeThread?.error,
      activeThread?.session?.lastError,
      threadActivities,
      timelineMessages,
    ],
  );
  const providerStatusBannerVisible = shouldRenderProviderStatusBanner(activeProviderStatus, {
    activeTurnInProgress,
  });
  const threadErrorBannerVisible = Boolean(activeThread?.error);
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const activeWorkspaceRoot = activeThreadWorktreePath ?? activeProjectCwd ?? undefined;
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
  const activeTerminalLaunchContext =
    terminalLaunchContext?.threadId === activeThreadId
      ? terminalLaunchContext
      : (storeServerTerminalLaunchContext ?? null);
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
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
  const sourceControlPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle", nonTerminalShortcutLabelOptions),
    [keybindings, nonTerminalShortcutLabelOptions],
  );
  const onToggleSourceControl = useCallback(() => {
    if (!activeThread) {
      return;
    }
    if (routeKind === "draft" && draftId) {
      void navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(draftId),
        replace: true,
        search: (previous) => {
          const rest = stripRightPanelSearchParams(previous);
          return sourceControlOpen
            ? closeRightPanelSearchParams(previous)
            : { ...rest, sourceControl: "1" };
        },
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
      search: (previous) => {
        const rest = stripRightPanelSearchParams(previous);
        return sourceControlOpen
          ? closeRightPanelSearchParams(previous)
          : { ...rest, sourceControl: "1" };
      },
    });
  }, [activeThread, draftId, environmentId, navigate, routeKind, sourceControlOpen, threadId]);

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
    },
    [draftId, envLocked, logicalProjectEnvironments, setDraftThreadContext],
  );

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
  const addTerminalContextToDraft = useCallback((selection: TerminalContextSelection) => {
    composerRef.current?.addTerminalContext(selection);
  }, []);
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadRef) return;
      storeSetTerminalOpen(activeThreadRef, open);
    },
    [activeThreadRef, storeSetTerminalOpen],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadRef) return;
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadRef, setTerminalOpen, terminalState.terminalOpen]);
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
      setTerminalFocusRequestId((value) => value + 1);
    },
    [storeCloseTerminal],
  );
  const [pendingTerminalKill, setPendingTerminalKill] = useState<{
    threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
    threadId: ThreadId;
    terminalId: string;
  } | null>(null);
  const requestCloseTerminal = useCallback(
    (
      targetThreadRef: { environmentId: EnvironmentId; threadId: ThreadId },
      targetThreadId: ThreadId,
      terminalId: string,
      options?: { sessionExited?: boolean },
    ) => {
      const targetTerminalState = selectThreadTerminalState(
        useTerminalStateStore.getState().terminalStateByThreadKey,
        targetThreadRef,
      );
      if (
        shouldConfirmTerminalKill({
          runningTerminalIds: targetTerminalState.runningTerminalIds,
          terminalId,
          sessionExited: options?.sessionExited === true,
        })
      ) {
        setPendingTerminalKill({
          threadRef: targetThreadRef,
          threadId: targetThreadId,
          terminalId,
        });
        return;
      }
      performCloseTerminal(targetThreadRef, targetThreadId, terminalId);
    },
    [performCloseTerminal],
  );
  const providerBackgroundRuns = useMemo(
    () =>
      deriveProviderBackgroundRuns({
        activities: threadActivities,
        messages: timelineMessages,
        pendingBackgroundTaskCount: activeThread?.session?.pendingBackgroundTaskCount ?? 0,
        activeSubagentCount: subagentProgress?.activeCount ?? 0,
      }).map((run) => ({
        ...run,
        terminalId: null,
        pid: null,
        port: null,
        elapsed: null,
        canStop: false,
        cwd: null,
      })),
    [
      activeThread?.session?.pendingBackgroundTaskCount,
      subagentProgress?.activeCount,
      threadActivities,
      timelineMessages,
    ],
  );
  const backgroundRunDetectionUrls = useMemo(
    () => [...new Set(providerBackgroundRuns.flatMap((run) => run.urls))].sort(),
    [providerBackgroundRuns],
  );
  const backgroundRunCommandHints = useMemo(
    () => [...new Set(providerBackgroundRuns.flatMap((run) => run.commandHints))].slice(0, 12),
    [providerBackgroundRuns],
  );
  const [detectedBackgroundRuns, setDetectedBackgroundRuns] = useState<ThreadBackgroundRunItem[]>(
    [],
  );
  const [backgroundRunDetectionCheckedUrls, setBackgroundRunDetectionCheckedUrls] = useState<
    string[]
  >([]);

  useEffect(() => {
    if (
      !activeThreadId ||
      (backgroundRunDetectionUrls.length === 0 && backgroundRunCommandHints.length === 0)
    ) {
      setDetectedBackgroundRuns([]);
      setBackgroundRunDetectionCheckedUrls([]);
      return;
    }

    let localApi: ReturnType<typeof ensureLocalApi>;
    try {
      localApi = ensureLocalApi();
    } catch {
      setDetectedBackgroundRuns([]);
      setBackgroundRunDetectionCheckedUrls([]);
      return;
    }

    let cancelled = false;
    void localApi.server
      .resolveBackgroundRuns({
        urls: backgroundRunDetectionUrls,
        commandHints: backgroundRunCommandHints,
      })
      .then((result) => {
        if (cancelled) return;
        setBackgroundRunDetectionCheckedUrls(backgroundRunDetectionUrls);
        setDetectedBackgroundRuns(
          result.runs.map((run) => ({
            id: run.id,
            source: "detected",
            terminalId: null,
            pid: run.pid,
            port: run.port,
            elapsed: run.elapsed ?? null,
            canStop: run.canStop,
            label: "Detected local preview",
            detail: run.detail,
            cwd: null,
            statusLabel: run.statusLabel,
            urls: run.urls,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setDetectedBackgroundRuns([]);
          setBackgroundRunDetectionCheckedUrls([]);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeThreadId, backgroundRunCommandHints, backgroundRunDetectionUrls]);

  const backgroundRuns = useMemo(() => {
    const terminalLabelById = new Map(
      terminalState.terminalIds.map((terminalId, index) => [terminalId, `Terminal ${index + 1}`]),
    );
    const cwd = activeTerminalLaunchContext?.cwd ?? gitCwd ?? activeProject?.cwd ?? null;
    const terminalRuns = terminalState.runningTerminalIds.map((terminalId) => ({
      id: `terminal:${terminalId}`,
      source: "terminal" as const,
      terminalId,
      pid: null,
      port: null,
      elapsed: null,
      canStop: true,
      label: terminalLabelById.get(terminalId) ?? "Terminal",
      detail: cwd,
      cwd,
      statusLabel: "Running",
      urls: [],
    }));
    const detectedUrlSet = new Set(detectedBackgroundRuns.flatMap((run) => run.urls));
    const checkedUrlSet = new Set(backgroundRunDetectionCheckedUrls);
    const unresolvedProviderRuns = providerBackgroundRuns.filter(
      (run) =>
        (run.urls.length === 0 || !run.urls.every((url) => detectedUrlSet.has(url))) &&
        !(
          run.source === "mentioned-preview" &&
          run.urls.length > 0 &&
          run.urls.every((url) => checkedUrlSet.has(url))
        ),
    );

    return [...terminalRuns, ...detectedBackgroundRuns, ...unresolvedProviderRuns];
  }, [
    activeProject?.cwd,
    activeTerminalLaunchContext?.cwd,
    backgroundRunDetectionCheckedUrls,
    detectedBackgroundRuns,
    gitCwd,
    providerBackgroundRuns,
    terminalState.runningTerminalIds,
    terminalState.terminalIds,
  ]);
  const openBackgroundRunTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef) return;
      storeSetActiveTerminal(activeThreadRef, terminalId);
      setTerminalOpen(true);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadRef, setTerminalOpen, storeSetActiveTerminal],
  );
  const stopBackgroundRun = useCallback(
    (run: ThreadBackgroundRunItem) => {
      if (!activeThreadRef || !activeThreadId) return;
      if (run.terminalId) {
        requestCloseTerminal(activeThreadRef, activeThreadId, run.terminalId);
        return;
      }
      if (run.pid === null || run.port === null) {
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

      void localApi.server
        .stopBackgroundRun({ pid: run.pid, port: run.port, signal: "SIGINT" })
        .then((result) => {
          if (result.signaled) {
            setDetectedBackgroundRuns((current) => current.filter((item) => item.id !== run.id));
            return;
          }
          const message = Option.getOrUndefined(result.message);
          setThreadError(activeThreadId, message ?? `Could not stop ${run.label}.`);
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
  const confirmPendingTerminalKill = useCallback(() => {
    if (!pendingTerminalKill) return;
    performCloseTerminal(
      pendingTerminalKill.threadRef,
      pendingTerminalKill.threadId,
      pendingTerminalKill.terminalId,
    );
    setPendingTerminalKill(null);
  }, [pendingTerminalKill, performCloseTerminal]);
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
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
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${randomUUID()}`
        : baseTerminalId;
      const targetWorktreePath = options?.worktreePath ?? activeThread.worktreePath ?? null;

      setTerminalLaunchContext({
        threadId: activeThreadId,
        cwd: targetCwd,
        worktreePath: targetWorktreePath,
      });
      setTerminalOpen(true);
      if (!activeThreadRef) {
        return;
      }
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadRef, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadRef, targetTerminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: targetWorktreePath,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: TerminalOpenInput = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            ...(targetWorktreePath !== null ? { worktreePath: targetWorktreePath } : {}),
            env: runtimeEnv,
          };

      try {
        await api.terminal.open(openTerminalInput);
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
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
      activeThreadRef,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      setLastInvokedScriptByProjectId,
      environmentId,
      terminalState.activeTerminalId,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );
  const runProviderAuthReconnect = useCallback(
    async (action?: ProviderAuthReconnectAction) => {
      const reconnectAction = action ?? providerAuthReconnectPrompt;
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
    [activeProviderDriver, activeProviderLabel, providerAuthReconnectPrompt, runProjectScript],
  );

  const runMcpAuthReconnect = useCallback(
    async (action: McpAuthReconnectAction) => {
      if (activeProviderDriver !== CODEX_PROVIDER_DRIVER) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "MCP authorization is unavailable",
            description: "Inline MCP OAuth is currently available for Codex providers only.",
          }),
        );
        return;
      }

      const api = readLocalApi();
      if (!api) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start MCP authorization",
            description: "Local API unavailable.",
          }),
        );
        return;
      }

      const providerInstanceId =
        activeProviderInstanceId ?? defaultInstanceIdForDriver(CODEX_PROVIDER_DRIVER);
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
        const result = await api.server.startProviderExtensionMcpOAuth({
          ...baseInput,
          serverName: action.serverName,
          timeoutSecs: 300,
        });
        fallbackCommand = result.terminalCommand || fallbackCommand;
        await api.shell.openExternal(result.authorizationUrl);

        const expiresAtMs = Date.parse(result.expiresAt);
        const deadlineMs =
          Number.isFinite(expiresAtMs) && expiresAtMs > 0
            ? expiresAtMs + 15_000
            : Date.now() + 315_000;

        while (Date.now() < deadlineMs) {
          await wait(1_500);
          const status = await api.server.getProviderExtensionOperationStatus({
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
              await api.server.reloadProviderExtensionMcpServers(baseInput);
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
    [activeProviderDriver, activeProviderInstanceId, activeWorkspaceRoot],
  );

  const composerBannerItems = infrastructureComposerBannerItems;

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

  // Scroll helpers — LegendList handles auto-scroll via maintainScrollAtEnd.
  const scrollToEnd = useCallback((animated = false) => {
    legendListRef.current?.scrollToEnd?.({ animated });
  }, []);

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
  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    const nextIsAtEnd = isAtEnd || isLegendListVisiblyAtEnd(legendListRef.current);
    if (isAtEndRef.current === nextIsAtEnd) return;
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
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id) return;
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
    composerBannerItems.length,
    providerStatusBannerVisible,
    terminalState.terminalHeight,
    terminalState.terminalOpen,
    threadErrorBannerVisible,
  ]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalState.terminalOpen]);

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
    setExpandedImage(null);
  }, [draftId, resetLocalDispatch, threadId]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
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
  const envMode: DraftThreadEnvMode = canOverrideServerThreadEnvMode
    ? (pendingServerThreadEnvMode ?? draftThread?.envMode ?? derivedEnvMode)
    : derivedEnvMode;
  const activeThreadBranch =
    canOverrideServerThreadEnvMode && pendingServerThreadBranch !== undefined
      ? pendingServerThreadBranch
      : (activeThread?.branch ?? null);
  const sendEnvMode = resolveSendEnvMode({
    requestedEnvMode: envMode,
    isGitRepo,
  });

  useEffect(() => {
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [activeThread?.id]);

  useEffect(() => {
    if (canOverrideServerThreadEnvMode) {
      return;
    }
    setPendingServerThreadEnvMode(null);
    setPendingServerThreadBranch(undefined);
  }, [canOverrideServerThreadEnvMode]);

  useEffect(() => {
    if (!activeThreadId) {
      setTerminalLaunchContext(null);
      storeClearTerminalLaunchContext(routeThreadRef);
      return;
    }
    setTerminalLaunchContext((current) => {
      if (!current) return current;
      if (current.threadId === activeThreadId) return current;
      return null;
    });
  }, [activeThreadId, routeThreadRef, storeClearTerminalLaunchContext]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd) {
      return;
    }
    setTerminalLaunchContext((current) => {
      if (!current || current.threadId !== activeThreadId) {
        return current;
      }
      const settledCwd = projectScriptCwd({
        project: { cwd: activeProjectCwd },
        worktreePath: activeThreadWorktreePath,
      });
      if (
        settledCwd === current.cwd &&
        (activeThreadWorktreePath ?? null) === current.worktreePath
      ) {
        if (activeThreadRef) {
          storeClearTerminalLaunchContext(activeThreadRef);
        }
        return null;
      }
      return current;
    });
  }, [
    activeProjectCwd,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    storeClearTerminalLaunchContext,
  ]);

  useEffect(() => {
    if (!activeThreadId || !activeProjectCwd || !storeServerTerminalLaunchContext) {
      return;
    }
    const settledCwd = projectScriptCwd({
      project: { cwd: activeProjectCwd },
      worktreePath: activeThreadWorktreePath,
    });
    if (
      settledCwd === storeServerTerminalLaunchContext.cwd &&
      (activeThreadWorktreePath ?? null) === storeServerTerminalLaunchContext.worktreePath
    ) {
      if (activeThreadRef) {
        storeClearTerminalLaunchContext(activeThreadRef);
      }
    }
  }, [
    activeProjectCwd,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    storeClearTerminalLaunchContext,
    storeServerTerminalLaunchContext,
  ]);

  useEffect(() => {
    if (terminalState.terminalOpen) {
      return;
    }
    if (activeThreadRef) {
      storeClearTerminalLaunchContext(activeThreadRef);
    }
    setTerminalLaunchContext((current) => (current?.threadId === activeThreadId ? null : current));
  }, [
    activeThreadId,
    activeThreadRef,
    storeClearTerminalLaunchContext,
    terminalState.terminalOpen,
  ]);

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
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadKey] = current;
  }, [activeThreadKey, focusComposer, terminalState.terminalOpen]);

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

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleSourceControl();
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
    onToggleSourceControl,
    toggleTerminalVisibility,
  ]);

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readEnvironmentApi(environmentId);
      const localApi = readLocalApi();
      if (!api || !localApi || !activeThread || isRevertingCheckpoint) return;

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
      const confirmed = await localApi.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
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
      sendInFlightRef.current
    )
      return;
    if (activePendingProgress) {
      onAdvanceActivePendingUserInput();
      return;
    }
    const sendCtx = composerRef.current?.getSendContext();
    if (!sendCtx) return;
    const {
      images: composerImages,
      terminalContexts: composerTerminalContexts,
      selectedModel: ctxSelectedModel,
      selectedModelSelection: ctxSelectedModelSelection,
    } = sendCtx;
    const promptForSend = promptRef.current;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImages.length,
      terminalContexts: composerTerminalContexts,
    });
    if (showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
      await onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
      });
      return;
    }
    const standaloneSlashCommand =
      composerImages.length === 0 && sendableComposerTerminalContexts.length === 0
        ? parseStandaloneComposerSlashCommand(trimmed)
        : null;
    if (standaloneSlashCommand) {
      handleInteractionModeChange(standaloneSlashCommand);
      promptRef.current = "";
      clearComposerDraftContent(composerDraftTarget);
      composerRef.current?.resetCursorState();
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
    if (!activeProject) return;
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || activeThread.messages.length === 0;
    const steeringThreadKey = activeThreadKey;
    const isSteeringFollowUp = canSubmitSteeringFollowUp && steeringThreadKey !== null;
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
    if (!isSteeringFollowUp) {
      beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });
    }

    const composerImagesSnapshot = [...composerImages];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const messageTextForSend = appendTerminalContextsToPrompt(
      promptForSend,
      composerTerminalContextsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt(
      messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    );
    const turnAttachmentsPromise = Promise.all(
      composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    );
    const optimisticAttachments = composerImagesSnapshot.map((image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.previewUrl,
    }));
    const threadRefForSend = scopeThreadRef(environmentId, threadIdForSend);
    const optimisticMessage: ChatMessage = {
      id: messageIdForSend,
      role: "user",
      text: outgoingMessageText,
      ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
      ...(isSteeringFollowUp && activeSteerTurnId !== null ? { turnId: activeSteerTurnId } : {}),
      createdAt: messageCreatedAt,
      streaming: false,
    };
    if (isSteeringFollowUp) {
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
    } else {
      // Scroll to the current end *before* adding the optimistic message.
      // This sets LegendList's internal isAtEnd=true so maintainScrollAtEnd
      // automatically pins to the new item when the data changes.
      isAtEndRef.current = true;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      await legendListRef.current?.scrollToEnd?.({ animated: false });

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
      if (composerImagesSnapshot.length > 0) {
        const firstComposerImage = composerImagesSnapshot[0];
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
        } else {
          titleSeed = "New thread";
        }
      }
      const title = truncate(titleSeed);
      const threadCreateModelSelection = createModelSelection(
        ctxSelectedModelSelection.instanceId,
        ctxSelectedModel || activeProject.defaultModelSelection?.model || DEFAULT_MODEL,
        ctxSelectedModelSelection.options,
      );

      if (isSteeringFollowUp) {
        const steerTurnId = activeSteerTurnId;
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
          },
          createdAt: messageCreatedAt,
        });
        dispatchSucceeded = true;
        return;
      }

      // Auto-title from first message
      if (isFirstMessage && isServerThread) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: threadIdForSend,
          title,
        });
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
      beginLocalDispatch({ preparingWorktree: false });
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: turnAttachments,
        },
        modelSelection: ctxSelectedModelSelection,
        titleSeed: title,
        runtimeMode,
        interactionMode,
        ...(bootstrap ? { bootstrap } : {}),
        createdAt: messageCreatedAt,
      });
      dispatchSucceeded = true;
      if (isServerThread && ctxSelectedModel) {
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
        composerImagesRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0
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
        const retryComposerImages = composerImagesSnapshot.map(cloneComposerImageForRetry);
        composerImagesRef.current = retryComposerImages;
        composerTerminalContextsRef.current = composerTerminalContextsSnapshot;
        setComposerDraftPrompt(composerDraftTarget, promptForSend);
        addComposerDraftImages(composerDraftTarget, retryComposerImages);
        setComposerDraftTerminalContexts(composerDraftTarget, composerTerminalContextsSnapshot);
        composerRef.current?.resetCursorState({
          cursor: collapseExpandedComposerCursor(promptForSend, promptForSend.length),
          prompt: promptForSend,
          detectTrigger: true,
        });
      }
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    });
    sendInFlightRef.current = false;
    if (!dispatchSucceeded && !isSteeringFollowUp) {
      resetLocalDispatch();
    }
  };

  const onInterrupt = async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeThread) return;
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: activeThread.id,
      createdAt: new Date().toISOString(),
    });
  };

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
      promptRef.current = "";
      composerRef.current?.resetCursorState({ cursor: 0 });
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
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
      const snapshot = composerRef.current?.readSnapshot();
      if (
        snapshot?.value !== value ||
        snapshot.cursor !== nextCursor ||
        snapshot.expandedCursor !== expandedCursor
      ) {
        composerRef.current?.focusAt(nextCursor);
      }
    },
    [activePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
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
    }: {
      text: string;
      interactionMode: "default" | "plan";
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

      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt(trimmed);

      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);

      // Scroll to the current end *before* adding the optimistic message.
      isAtEndRef.current = true;
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
      await legendListRef.current?.scrollToEnd?.({ animated: false });

      const optimisticMessage: ChatMessage = {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
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
          modelSelection: ctxSelectedModelSelection,
          titleSeed: activeThread.title,
          runtimeMode,
          interactionMode: nextInteractionMode,
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
        if (ctxSelectedModel) {
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
      persistThreadSettingsForNextTurn,
      resetLocalDispatch,
      removeOptimisticThreadMessages,
      runtimeMode,
      setComposerDraftInteractionMode,
      setThreadError,
      environmentId,
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
    const persistedSelection = activeThread?.modelSelection ?? activeProject?.defaultModelSelection;
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
  }, [
    activeProject?.defaultModelSelection,
    activeThread?.modelSelection,
    buildForkModelSelection,
    providerInstanceEntries,
  ]);

  const onContinueMessageInNewThread = useCallback(
    (messageId: MessageId) => {
      if (
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

      const selectedMessage = activeThread.messages.find((message) => message.id === messageId);
      if (!selectedMessage) {
        return;
      }

      setForkDialogState({
        sourceMessageId: selectedMessage.id,
        sourceMessageRole: selectedMessage.role,
        sourceMessageText: buildForkSourceExcerpt(selectedMessage),
        sourceAttachmentCount: selectedMessage.attachments?.length ?? 0,
        instruction: DEFAULT_FORK_THREAD_INSTRUCTION,
        modelSelection: resolveInitialForkModelSelection(),
      });
    },
    [
      activeEnvironmentUnavailable,
      activeThread,
      isConnecting,
      isSendBusy,
      isServerThread,
      phase,
      resolveInitialForkModelSelection,
    ],
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
    const instruction = formatOutgoingPrompt(state.instruction);
    if (instruction.length === 0) {
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
        message: {
          messageId: newMessageId(),
          role: "user",
          text: instruction,
        },
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
    resetLocalDispatch,
    runtimeMode,
    environmentId,
  ]);

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
      const currentEntry = providerStatuses.find(
        (snapshot) => snapshot.instanceId === activeThread.session?.providerInstanceId,
      );
      const classification = classifyModelSwitch({
        boundProvider: lockedProvider,
        pickedDriverKind,
        boundContinuationGroupKey: currentEntry?.continuation?.groupKey ?? null,
        pickedContinuationGroupKey: entry?.continuation?.groupKey ?? null,
      });
      // Same driver across incompatible resume state can't be reconciled; the
      // server rejects it, so keep blocking it in the UI.
      if (classification === "blocked-incompatible-instance") {
        scheduleComposerFocus();
        return;
      }
      // Cross-driver is a deliberate, lossy handoff (the new model gets a recap
      // + the working tree, not the outgoing model's full state): confirm once
      // unless the user has opted out.
      if (classification === "confirm-cross-driver" && !suppressCrossProviderWarning) {
        const toLabel = entry?.displayName ?? (pickedDriverKind ? String(pickedDriverKind) : model);
        const fromLabel =
          currentEntry?.displayName ??
          (lockedProvider ? String(lockedProvider) : "the current provider");
        setCrossProviderDontAskAgain(false);
        setPendingCrossProviderSwitch({ instanceId, model, fromLabel, toLabel });
        return;
      }
      applyModelSelection(instanceId, model);
    },
    [
      activeThread,
      lockedProvider,
      providerStatuses,
      suppressCrossProviderWarning,
      applyModelSelection,
      scheduleComposerFocus,
    ],
  );

  const confirmCrossProviderSwitch = useCallback(() => {
    if (!pendingCrossProviderSwitch) return;
    if (crossProviderDontAskAgain) {
      updateSettings({ suppressCrossProviderSwitchWarning: true });
    }
    applyModelSelection(pendingCrossProviderSwitch.instanceId, pendingCrossProviderSwitch.model);
    setPendingCrossProviderSwitch(null);
  }, [pendingCrossProviderSwitch, crossProviderDontAskAgain, updateSettings, applyModelSelection]);
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      if (canOverrideServerThreadEnvMode) {
        setPendingServerThreadEnvMode(mode);
        scheduleComposerFocus();
        return;
      }
      if (isLocalDraftThread) {
        setDraftThreadContext(composerDraftTarget, {
          envMode: mode,
          ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
        });
      }
      scheduleComposerFocus();
    },
    [
      canOverrideServerThreadEnvMode,
      composerDraftTarget,
      draftThread?.worktreePath,
      isLocalDraftThread,
      setPendingServerThreadEnvMode,
      scheduleComposerFocus,
      setDraftThreadContext,
    ],
  );

  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!isServerThread) {
        return;
      }
      onDiffPanelOpen?.();
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId,
          threadId,
        },
        search: (previous) => {
          const rest = stripRightPanelSearchParams(previous);
          return filePath
            ? {
                ...rest,
                diff: "1",
                sourceControlReturn: "1",
                diffTurnId: turnId,
                diffFilePath: filePath,
              }
            : { ...rest, diff: "1", sourceControlReturn: "1", diffTurnId: turnId };
        },
      });
    },
    [environmentId, isServerThread, navigate, onDiffPanelOpen, threadId],
  );
  // Both the Map and the revert handler are read from refs at call-time so
  // the callback reference is fully stable and never busts context identity.
  const revertTurnCountRef = useRef(revertTurnCountByUserMessageId);
  revertTurnCountRef.current = revertTurnCountByUserMessageId;
  const onRevertToTurnCountRef = useRef(onRevertToTurnCount);
  onRevertToTurnCountRef.current = onRevertToTurnCount;
  const onRevertUserMessage = useCallback((messageId: MessageId) => {
    const targetTurnCount = revertTurnCountRef.current.get(messageId);
    if (typeof targetTurnCount !== "number") {
      return;
    }
    void onRevertToTurnCountRef.current(targetTurnCount);
  }, []);
  const onOpenForkSourceThread = useCallback(
    (sourceThreadId: ThreadId) => {
      if (!activeThread) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: activeThread.environmentId,
          threadId: sourceThreadId,
        },
      });
    },
    [activeThread, navigate],
  );

  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      {/* Top bar */}
      <header
        className={cn(
          "border-b border-border transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
          isElectron
            ? cn(
                "drag-region flex items-center px-3 sm:px-5 wco:h-[env(titlebar-area-height)]",
                ELECTRON_HEADER_HEIGHT_CLASS,
                reserveTitleBarControlInset &&
                  "wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
              )
            : "pb-2 pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-2 sm:pb-3 sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)] sm:pt-3",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <ChatHeader
          activeThreadEnvironmentId={activeThread.environmentId}
          activeThreadTitle={activeThread.title}
          activeProjectName={activeProject?.name}
          isGitRepo={isGitRepo}
          openInCwd={gitCwd}
          activeProjectScripts={activeProject?.scripts}
          preferredScriptId={
            activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
          }
          keybindings={keybindings}
          availableEditors={availableEditors}
          terminalAvailable={activeProject !== undefined}
          terminalOpen={terminalState.terminalOpen}
          terminalToggleShortcutLabel={terminalToggleShortcutLabel}
          sourceControlToggleShortcutLabel={sourceControlPanelShortcutLabel}
          sourceControlOpen={sourceControlOpen}
          taskProgress={taskProgress}
          subagentProgress={subagentProgress}
          forkContext={forkHeaderContext}
          backgroundRuns={backgroundRuns}
          onRunProjectScript={runProjectScript}
          onAddProjectScript={saveProjectScript}
          onUpdateProjectScript={updateProjectScript}
          onDeleteProjectScript={deleteProjectScript}
          onOpenBackgroundRunTerminal={openBackgroundRunTerminal}
          onStopBackgroundRun={stopBackgroundRun}
          onOpenForkSourceThread={onOpenForkSourceThread}
          onToggleTerminal={toggleTerminalVisibility}
          onToggleSourceControl={onToggleSourceControl}
        />
      </header>

      {/* Error banner */}
      <ProviderStatusBanner
        activeTurnInProgress={activeTurnInProgress}
        status={activeProviderStatus}
      />
      <ThreadErrorBanner
        error={activeThread.error}
        authReconnect={providerAuthReconnectPrompt}
        usageReset={threadErrorUsageResetAction}
        providerLabel={activeProviderLabel}
        onRunAuthReconnect={runProviderAuthReconnect}
        onDismiss={() => setThreadError(activeThread.id, null)}
      />
      {threadErrorRateLimitResetCreditDialog}
      <ForkThreadDialog
        state={forkDialogState}
        providerInstanceEntries={providerInstanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        keybindings={keybindings}
        terminalOpen={Boolean(terminalState.terminalOpen)}
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
      {/* Main content area */}
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* Chat column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Messages Wrapper */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Messages — LegendList handles virtualization and scrolling internally */}
            <MessagesTimeline
              key={activeThread.id}
              isWorking={isWorking}
              activeStatusLabel={activeStatusLabel}
              activeTurnInProgress={isWorking || !latestTurnSettled}
              activeTurnId={activeLatestTurn?.turnId ?? null}
              activeTurnStartedAt={activeWorkStartedAt}
              listRef={legendListRef}
              timelineEntries={timelineEntries}
              completionDividerBeforeEntryId={completionDividerBeforeEntryId}
              completionSummary={completionSummary}
              turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
              activeThreadEnvironmentId={activeThread.environmentId}
              routeThreadKey={routeThreadKey}
              onOpenTurnDiff={onOpenTurnDiff}
              revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
              onRevertUserMessage={onRevertUserMessage}
              onContinueInNewThread={onContinueMessageInNewThread}
              isRevertingCheckpoint={isRevertingCheckpoint}
              onImageExpand={onExpandTimelineImage}
              markdownCwd={gitCwd ?? undefined}
              resolvedTheme={resolvedTheme}
              timestampFormat={timestampFormat}
              workspaceRoot={activeWorkspaceRoot}
              skills={activeProviderStatus?.skills ?? EMPTY_PROVIDER_SKILLS}
              providerAuthReconnect={providerAuthReconnectPrompt}
              onRunProviderAuthReconnect={runProviderAuthReconnect}
              mcpAuthReconnectStatusByServerName={activeMcpAuthReconnectStatusByServerName}
              onRunMcpAuthReconnect={runMcpAuthReconnect}
              onIsAtEndChange={onIsAtEndChange}
            />

            {/* scroll to bottom pill — shown when user has scrolled away from the bottom */}
            {showScrollToBottom && (
              <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
                <button
                  type="button"
                  onClick={() => scrollToEnd(true)}
                  className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1 text-muted-foreground text-xs shadow-sm transition-colors hover:border-border hover:text-foreground hover:cursor-pointer"
                >
                  <ChevronDownIcon className="size-3.5" />
                  Scroll to bottom
                </button>
              </div>
            )}
          </div>

          {/* Input bar */}
          <div
            className={cn(
              "pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] pt-1.5 sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)] sm:pt-2",
              isGitRepo
                ? "pb-[calc(env(safe-area-inset-bottom)+0.25rem)]"
                : "pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:pb-[calc(env(safe-area-inset-bottom)+1rem)]",
            )}
          >
            <div className="relative isolate">
              <SteeringQueueIndicator messages={queuedSteeringMessages} />
              <ComposerBannerStack className="relative z-0" items={composerBannerItems} />
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
                  isServerThread={isServerThread}
                  isLocalDraftThread={isLocalDraftThread}
                  phase={phase}
                  isConnecting={isConnecting}
                  isSendBusy={isSendBusy}
                  isPreparingWorktree={isPreparingWorktree}
                  environmentUnavailable={activeEnvironmentUnavailableState}
                  activePendingApproval={activePendingApproval}
                  pendingApprovals={pendingApprovals}
                  pendingUserInputs={pendingUserInputs}
                  activePendingProgress={activePendingProgress}
                  activePendingResolvedAnswers={activePendingResolvedAnswers}
                  activePendingIsResponding={activePendingIsResponding}
                  activePendingDraftAnswers={activePendingDraftAnswers}
                  activePendingQuestionIndex={activePendingQuestionIndex}
                  respondingRequestIds={respondingRequestIds}
                  showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                  activeProposedPlan={activeProposedPlan}
                  runtimeMode={runtimeMode}
                  interactionMode={interactionMode}
                  // Unlocked so any provider's models are selectable;
                  // `onProviderModelSelect` gates a driver change behind the
                  // cross-provider handoff confirmation.
                  lockedProvider={null}
                  providerStatuses={providerStatuses as ServerProvider[]}
                  activeProjectDefaultModelSelection={activeProject?.defaultModelSelection}
                  activeThreadModelSelection={activeThread?.modelSelection}
                  activeThreadActivities={activeThread?.activities}
                  resolvedTheme={resolvedTheme}
                  settings={settings}
                  keybindings={keybindings}
                  terminalOpen={Boolean(terminalState.terminalOpen)}
                  gitCwd={gitCwd}
                  promptRef={promptRef}
                  composerImagesRef={composerImagesRef}
                  composerTerminalContextsRef={composerTerminalContextsRef}
                  shouldAutoScrollRef={isAtEndRef}
                  scheduleStickToBottom={scrollToEnd}
                  onSend={onSend}
                  onInterrupt={onInterrupt}
                  onCompactContext={contextCompactControlVisible ? onCompactContext : undefined}
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
                  onExpandImage={onExpandTimelineImage}
                />
                <AlertDialog
                  open={pendingCrossProviderSwitch !== null}
                  onOpenChange={(open) => {
                    if (!open) setPendingCrossProviderSwitch(null);
                  }}
                >
                  <AlertDialogPopup>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Switch to {pendingCrossProviderSwitch?.toLabel ?? "another provider"}?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        This thread is running on{" "}
                        {pendingCrossProviderSwitch?.fromLabel ?? "the current provider"}.{" "}
                        {pendingCrossProviderSwitch?.toLabel ?? "The new provider"} will pick up a
                        recap of the conversation and your current working tree — but not{" "}
                        {pendingCrossProviderSwitch?.fromLabel ?? "the current provider"}'s full
                        internal reasoning.
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
                      <Button onClick={confirmCrossProviderSwitch}>
                        Switch to {pendingCrossProviderSwitch?.toLabel ?? "provider"}
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
                {...(canOverrideServerThreadEnvMode ? { effectiveEnvModeOverride: envMode } : {})}
                {...(canOverrideServerThreadEnvMode
                  ? {
                      activeThreadBranchOverride: activeThreadBranch,
                      onActiveThreadBranchOverrideChange: setPendingServerThreadBranch,
                    }
                  : {})}
                envLocked={envLocked}
                onComposerFocusRequest={scheduleComposerFocus}
                {...(canCheckoutPullRequestIntoThread
                  ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                  : {})}
                {...(hasMultipleEnvironments ? { onEnvironmentChange } : {})}
                availableEnvironments={logicalProjectEnvironments}
              />
            )}
          </div>

          {pullRequestDialogState ? (
            <PullRequestThreadDialog
              key={pullRequestDialogState.key}
              open
              environmentId={activeThread.environmentId}
              threadId={activeThread.id}
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
      </div>
      {/* end horizontal flex container */}

      {mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
        <PersistentThreadTerminalDrawer
          key={mountedThreadKey}
          threadRef={mountedThreadRef}
          threadId={mountedThreadRef.threadId}
          visible={mountedThreadKey === activeThreadKey && terminalState.terminalOpen}
          launchContext={
            mountedThreadKey === activeThreadKey ? (activeTerminalLaunchContext ?? null) : null
          }
          focusRequestId={mountedThreadKey === activeThreadKey ? terminalFocusRequestId : 0}
          splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
          newShortcutLabel={newTerminalShortcutLabel ?? undefined}
          closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
          hideShortcutLabel={terminalToggleShortcutLabel ?? undefined}
          keybindings={keybindings}
          onAddTerminalContext={addTerminalContextToDraft}
          onCloseTerminal={requestCloseTerminal}
          onHideTerminal={toggleTerminalVisibility}
        />
      ))}
      <AlertDialog
        open={pendingTerminalKill !== null}
        onOpenChange={(open) => {
          if (!open) setPendingTerminalKill(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Kill terminal?</AlertDialogTitle>
            <AlertDialogDescription>
              A process is still running in this terminal. Killing the terminal stops the process
              and discards the terminal history. To keep it running, hide the terminal instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmPendingTerminalKill}>
              Kill terminal
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {expandedImage && (
        <ExpandedImageDialog preview={expandedImage} onClose={closeExpandedImage} />
      )}
    </div>
  );
}

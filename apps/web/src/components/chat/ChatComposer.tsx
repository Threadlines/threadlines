import type {
  ApprovalRequestId,
  ChatSkillReference,
  EnvironmentId,
  ModelSelection,
  ProjectEntry,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ResolvedKeybindingsConfig,
  RuntimeMode,
  ScopedThreadRef,
  ServerProvider,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@threadlines/contracts";
import { createModelSelection, normalizeModelSlug } from "@threadlines/shared/model";
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { serializeComposerMentionPath } from "~/composerMentionPath";
import type { FileSelectionContextDraft } from "~/lib/fileSelectionContext";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { providerSkillsQueryOptions } from "~/lib/providerSkillsReactQuery";
import { ComposerPendingFileSelectionContexts } from "./ComposerPendingFileSelectionContexts";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
} from "../../composer-logic";
import {
  deriveComposerSendState,
  desktopCapturedScreenshotToFile,
  readFileAsDataUrl,
} from "../ChatView.logic";
import {
  type ComposerAttachment,
  type DraftId,
  type PersistedComposerAttachment,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  removeInlineTerminalContextPlaceholder,
} from "../../lib/terminalContext";
import type {
  TranscriptHighlightContextDraft,
  TranscriptHighlightContextSelection,
} from "../../lib/transcriptHighlightContext";
import {
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "../composerFooterLayout";
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from "../ComposerPromptEditor";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerAttachmentMenu } from "./ComposerAttachmentMenu";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { ComposerPendingTranscriptHighlightContexts } from "./ComposerPendingTranscriptHighlightContexts";
import { ComposerPendingTerminalContexts } from "./ComposerPendingTerminalContexts";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import { buildDefaultComposerPlaceholder } from "./composerPlaceholder";
import {
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import type { FilePreviewRequest } from "./FilePreviewDialog";
import { basenameOfPath } from "../../vscode-icons";
import { cn, randomUUID } from "~/lib/utils";
import { getInteractionModeToggleTitle, interactionModeConfig } from "../../interactionModeOptions";
import { Separator } from "../ui/separator";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  canRequestProviderRateLimitResetCredit,
  useProviderRateLimitResetCredit,
} from "../ProviderRateLimitResetCredit";
import { CircleAlertIcon, FileTextIcon, SparklesIcon, XIcon } from "lucide-react";
import { proposedPlanTitle } from "../../proposedPlan";
import {
  getProviderInteractionModeToggle,
  providerModelSupportsInputModality,
} from "../../providerModels";
import {
  deriveRuntimeModeOptions,
  runtimeModeConfig,
  type RuntimeModeOption,
} from "../../runtimeModeOptions";
import {
  deriveProviderInstanceEntries,
  filterMaintainedProviderInstanceEntries,
  resolveProviderDriverKindForInstanceSelection,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import type { UnifiedSettings } from "@threadlines/contracts/settings";
import type { SessionPhase, Thread } from "../../types";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import {
  deriveActiveModelFallbackState,
  type PendingApproval,
  type PendingUserInput,
} from "../../session-logic";
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import { selectPromptSuggestion } from "../../lib/promptSuggestions";
import {
  deriveProviderAccountUsagePresentationForProvider,
  type ProviderAccountUsagePresentation,
} from "../../lib/providerUsage";
import { formatProviderSkillDisplayName } from "../../providerSkillPresentation";
import {
  FILE_ATTACHMENT_ACCEPT,
  resolveFileAttachmentType,
} from "@threadlines/shared/fileAttachments";
import { searchProviderSkills } from "../../providerSkillSearch";
import { resolveComposerSkillReferences } from "../../providerSkillReferences";
import { useMediaQuery } from "../../hooks/useMediaQuery";

const ATTACHMENT_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const ALL_ATTACHMENT_ACCEPT = `image/*,${FILE_ATTACHMENT_ACCEPT}`;

const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const CODEX_AGENT_PROVIDER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_PROVIDER = ProviderDriverKind.make("claudeAgent");
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

function formatPromptSuggestionDisplayText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

function isInsideComposerFloatingLayer(element: Element): boolean {
  return element.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

function unknownErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatModelDisplayName(modelId: string, options: ReadonlyArray<AppModelOption>): string {
  const option = options.find((candidate) => candidate.slug === modelId);
  return option?.shortName ?? option?.name ?? modelId;
}

const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const isPlanInteraction = props.interactionMode === "plan";
  const currentRuntimeModeOption = props.runtimeModeOptions.find(
    (option) => option.mode === props.runtimeMode,
  ) ?? {
    mode: props.runtimeMode,
    ...runtimeModeConfig[props.runtimeMode],
  };
  const RuntimeModeIcon = currentRuntimeModeOption.icon;
  const InteractionModeIcon = interactionModeConfig[props.interactionMode].icon;

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

      {props.showInteractionModeToggle ? (
        <>
          <Button
            variant="ghost"
            className="shrink-0 whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
            size="sm"
            type="button"
            onClick={props.onToggleInteractionMode}
            tooltip={getInteractionModeToggleTitle(props.interactionMode)}
          >
            <InteractionModeIcon
              className={cn(isPlanInteraction && "text-primary-readable opacity-100")}
            />
            <span className="sr-only sm:not-sr-only">
              {interactionModeConfig[props.interactionMode].label}
            </span>
          </Button>

          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
        </>
      ) : null}

      <Select
        value={props.runtimeMode}
        onValueChange={(value) => props.onRuntimeModeChange(value!)}
      >
        <SelectTrigger
          variant="ghost"
          size="sm"
          className={cn("font-medium", isPlanInteraction && "opacity-65")}
          aria-label="Runtime mode"
          title={
            isPlanInteraction
              ? "Plan turns don't edit files. This access level applies when you build."
              : currentRuntimeModeOption.description
          }
        >
          <RuntimeModeIcon className="size-3.5" />
          <SelectValue>{currentRuntimeModeOption.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {props.runtimeModeOptions.map((option) => {
            const OptionIcon = option.icon;
            return (
              <SelectItem
                key={option.mode}
                value={option.mode}
                disabled={option.disabled === true}
                className="min-w-64 py-2"
              >
                <div className="grid min-w-0 gap-0.5">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    {option.label}
                  </span>
                  <span className="text-muted-foreground text-xs leading-4">
                    {option.disabled && option.disabledReason
                      ? option.disabledReason
                      : option.description}
                  </span>
                </div>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
    </>
  );
});

const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  activeContextWindow: ReturnType<typeof deriveLatestContextWindowSnapshot>;
  providerAccountUsage: ProviderAccountUsagePresentation | null;
  contextWindowLabel: string | null;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
  onResetAccountUsage?: (() => void) | undefined;
  accountUsageResetInFlight?: boolean | undefined;
  onCompactContext?: (() => void) | undefined;
  contextCompactDisabled?: boolean | undefined;
  contextCompactInFlight?: boolean | undefined;
  contextCompactDisabledReason?: string | null | undefined;
}) {
  return (
    <>
      <ContextWindowMeter
        usage={props.activeContextWindow}
        accountUsage={props.providerAccountUsage}
        contextWindowLabel={props.contextWindowLabel}
        onResetAccountUsage={props.onResetAccountUsage}
        accountUsageResetInFlight={props.accountUsageResetInFlight}
        onCompactContext={props.onCompactContext}
        contextCompactDisabled={props.contextCompactDisabled}
        contextCompactInFlight={props.contextCompactInFlight}
        contextCompactDisabledReason={props.contextCompactDisabledReason}
      />
      {props.isPreparingWorktree ? (
        <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        isConnecting={props.isConnecting}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        runtimeMode={props.runtimeMode}
        runtimeModeOptions={props.runtimeModeOptions}
        onRuntimeModeChange={props.onRuntimeModeChange}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
      />
    </>
  );
});

// --------------------------------------------------------------------------
// Handle exposed to ChatView
// --------------------------------------------------------------------------

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  openModelPicker: () => void;
  toggleModelPicker: () => void;
  isModelPickerOpen: () => boolean;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
  /** Reset composer cursor/trigger/highlight after external prompt mutations (e.g. onSend). */
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  /** Insert a terminal context from the terminal drawer. */
  addTerminalContext: (selection: TerminalContextSelection) => void;
  /** Add a note attached to selected transcript text. */
  addTranscriptHighlightContext: (selection: TranscriptHighlightContextSelection) => void;
  /** Get the current prompt/effort/model state for use in send. */
  getSendContext: () => {
    prompt: string;
    images: ComposerAttachment[];
    terminalContexts: TerminalContextDraft[];
    transcriptHighlightContexts: TranscriptHighlightContextDraft[];
    fileSelectionContexts: FileSelectionContextDraft[];
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelSelection;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
    skillReferences: ChatSkillReference[];
  };
}

// --------------------------------------------------------------------------
// Props
// --------------------------------------------------------------------------

export interface ChatComposerProps {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;

  // Thread context
  activeThreadId: ThreadId | null;
  activeThreadEnvironmentId: EnvironmentId | undefined;
  activeThread: Thread | undefined;
  isServerThread: boolean;
  isLocalDraftThread: boolean;

  // Session phase
  phase: SessionPhase;
  isConnecting: boolean;
  isSendBusy: boolean;
  isPreparingWorktree: boolean;
  environmentUnavailable: {
    readonly label: string;
    readonly connectionState: "connecting" | "disconnected" | "error";
  } | null;

  // Pending approvals / inputs
  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
    activeQuestion: { id: string; multiSelect?: boolean | undefined } | null;
  } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activePendingIsResponding: boolean;
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  respondingRequestIds: ApprovalRequestId[];
  /** True while the timeline is scrolled away from the bottom; auto-collapses the questions panel. */
  isTimelineScrolledAway: boolean;

  // Plan
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: Thread["proposedPlans"][number] | null;

  // Mode
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;

  // Provider / model
  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  activeThreadModelSelection: ModelSelection | null | undefined;

  // Context window
  activeThreadActivities: Thread["activities"] | undefined;

  // Misc
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  gitCwd: string | null;
  canReferenceWorkspaceFiles: boolean;

  // Refs the parent needs kept in sync
  promptRef: React.RefObject<string>;
  composerAttachmentsRef: React.RefObject<ComposerAttachment[]>;
  composerTerminalContextsRef: React.RefObject<TerminalContextDraft[]>;
  composerTranscriptHighlightContextsRef: React.RefObject<TranscriptHighlightContextDraft[]>;
  composerFileSelectionContextsRef: React.RefObject<FileSelectionContextDraft[]>;
  composerRef: React.RefObject<ChatComposerHandle | null>;

  // Scroll
  shouldAutoScrollRef: React.RefObject<boolean>;
  scheduleStickToBottom: () => void;

  // Callbacks
  onSend: (e?: { preventDefault: () => void }) => void;
  onInterrupt: () => void;
  onCompactContext?: (() => void) | undefined;
  contextCompactDisabled?: boolean | undefined;
  contextCompactInFlight?: boolean | undefined;
  contextCompactDisabledReason?: string | null | undefined;
  onImplementPlanInNewThread: () => void;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;

  onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;

  focusComposer: () => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
  onPreviewFile: (request: FilePreviewRequest) => void;
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    composerDraftTarget,
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    activeThreadId,
    activeThreadEnvironmentId: _activeThreadEnvironmentId,
    activeThread,
    isServerThread: _isServerThread,
    isLocalDraftThread: _isLocalDraftThread,
    phase,
    isConnecting,
    isSendBusy,
    isPreparingWorktree,
    environmentUnavailable,
    activePendingApproval,
    pendingApprovals,
    pendingUserInputs,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    isTimelineScrolledAway,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    runtimeMode,
    interactionMode,
    lockedProvider,
    providerStatuses,
    activeProjectDefaultModelSelection,
    activeThreadModelSelection,
    activeThreadActivities,
    resolvedTheme,
    settings,
    keybindings,
    terminalOpen,
    gitCwd,
    canReferenceWorkspaceFiles,
    promptRef,
    composerRef,
    composerAttachmentsRef,
    composerTerminalContextsRef,
    composerTranscriptHighlightContextsRef,
    composerFileSelectionContextsRef,
    shouldAutoScrollRef,
    scheduleStickToBottom,
    onSend,
    onInterrupt,
    onCompactContext,
    contextCompactDisabled,
    contextCompactInFlight,
    contextCompactDisabledReason,
    onImplementPlanInNewThread,
    onRespondToApproval,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect,
    toggleInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    focusComposer,
    setThreadError,
    onExpandImage,
    onPreviewFile,
  } = props;

  // ------------------------------------------------------------------
  // Store subscriptions (prompt / images / terminal contexts)
  // ------------------------------------------------------------------
  const composerDraft = useComposerThreadDraft(composerDraftTarget);
  const prompt = composerDraft.prompt;
  const composerAttachments = composerDraft.attachments;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerTranscriptHighlightContexts = composerDraft.transcriptHighlightContexts;
  const composerFileSelectionContexts = composerDraft.fileSelectionContexts;
  const nonPersistedComposerImageIds = composerDraft.nonPersistedAttachmentIds;

  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftAttachment = useComposerDraftStore((store) => store.addAttachment);
  const addComposerDraftAttachments = useComposerDraftStore((store) => store.addAttachments);
  const removeComposerDraftAttachment = useComposerDraftStore((store) => store.removeAttachment);
  const addComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.addTerminalContext,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const removeComposerDraftFileSelectionContext = useComposerDraftStore(
    (store) => store.removeFileSelectionContext,
  );
  const addComposerDraftTranscriptHighlightContext = useComposerDraftStore(
    (store) => store.addTranscriptHighlightContext,
  );
  const removeComposerDraftTranscriptHighlightContext = useComposerDraftStore(
    (store) => store.removeTranscriptHighlightContext,
  );
  const updateComposerDraftTranscriptHighlightContextNote = useComposerDraftStore(
    (store) => store.updateTranscriptHighlightContextNote,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  // ------------------------------------------------------------------
  // Model state
  // ------------------------------------------------------------------
  // Instance-aware projection of the wire provider list. One entry per
  // configured instance (default built-in + any custom `providerInstances.*`),
  // sorted default-first per driver kind for a stable picker order.
  const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () =>
      filterMaintainedProviderInstanceEntries(
        sortProviderInstanceEntries(deriveProviderInstanceEntries(providerStatuses)),
      ),
    [providerStatuses],
  );
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const threadProvider =
    activeThread?.session?.providerInstanceId ??
    activeThreadModelSelection?.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  const explicitSelectedInstanceId = selectedProviderByThreadId ?? threadProvider;

  const unlockedSelectedProvider =
    resolveProviderDriverKindForInstanceSelection(
      providerInstanceEntries,
      providerStatuses,
      explicitSelectedInstanceId,
    ) ?? ProviderDriverKind.make("codex");
  const selectedProvider: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const lockedContinuationGroupKey = useMemo((): string | null => {
    if (!lockedProvider || !activeThread) return null;
    const lockedInstanceId =
      activeThread.session?.providerInstanceId ?? activeThreadModelSelection?.instanceId;
    if (!lockedInstanceId) return null;
    return (
      providerInstanceEntries.find((entry) => entry.instanceId === lockedInstanceId)
        ?.continuationGroupKey ?? null
    );
  }, [
    activeThread,
    activeThreadModelSelection?.instanceId,
    lockedProvider,
    providerInstanceEntries,
  ]);

  // Resolve which configured instance the composer is currently targeting.
  // Priority:
  //   1. The composer draft's `activeProvider` — the user's unsaved pick
  //      from the model picker (must win, otherwise the UI appears to
  //      ignore picker selections).
  //   2. Thread's persisted instance id (server-side saved selection).
  //   3. Project default's instance id.
  //   4. First enabled entry matching the current driver kind.
  //   5. First enabled entry overall / default instance for the kind.
  //
  const selectedInstanceId = useMemo<ProviderInstanceId>(() => {
    const candidates: Array<string | null | undefined> = [
      composerDraft.activeProvider,
      activeThread?.session?.providerInstanceId,
      activeThreadModelSelection?.instanceId,
      activeProjectDefaultModelSelection?.instanceId,
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const match = providerInstanceEntries.find(
        (entry) => entry.instanceId === candidate && entry.enabled,
      );
      if (match) {
        // When locked to a specific driver kind, ignore persisted instance
        // ids from a different kind or continuation group.
        if (lockedProvider && match.driverKind !== lockedProvider) continue;
        if (
          lockedContinuationGroupKey &&
          match.continuationGroupKey !== lockedContinuationGroupKey
        ) {
          continue;
        }
        return match.instanceId;
      }
    }
    const byKind = providerInstanceEntries.find(
      (entry) =>
        entry.enabled &&
        entry.driverKind === selectedProvider &&
        (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey),
    );
    if (byKind) return byKind.instanceId;
    const anyEnabled = providerInstanceEntries.find((entry) => entry.enabled);
    return (
      anyEnabled?.instanceId ??
      providerInstanceEntries[0]?.instanceId ??
      activeThreadModelSelection?.instanceId ??
      activeProjectDefaultModelSelection?.instanceId ??
      ProviderInstanceId.make("codex")
    );
  }, [
    activeProjectDefaultModelSelection?.instanceId,
    activeThread?.session?.providerInstanceId,
    activeThreadModelSelection?.instanceId,
    composerDraft.activeProvider,
    lockedContinuationGroupKey,
    lockedProvider,
    providerInstanceEntries,
    selectedProvider,
  ]);

  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadRef: composerDraftTarget,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: activeThreadModelSelection,
    projectModelSelection: activeProjectDefaultModelSelection,
    settings,
  });

  // Resolve the active instance's snapshot by `instanceId` so a custom
  // instance gets its own slash commands, skills, and model list — not
  // the first snapshot for the same driver kind.
  const selectedProviderEntry = useMemo(
    () => providerInstanceEntries.find((entry) => entry.instanceId === selectedInstanceId),
    [providerInstanceEntries, selectedInstanceId],
  );
  const selectedProviderStatus = useMemo(
    () => selectedProviderEntry?.snapshot ?? null,
    [selectedProviderEntry],
  );
  const projectSkillsQuery = useQuery(
    providerSkillsQueryOptions({
      environmentId,
      cwd: gitCwd,
      providerInstanceId: selectedInstanceId,
      enabled: selectedProvider === CODEX_AGENT_PROVIDER,
    }),
  );
  const composerSkills = projectSkillsQuery.data ?? EMPTY_PROVIDER_SKILLS;
  // Account-level usage (5h/weekly windows) for the instance the composer
  // is targeting — surfaced in the context window meter's hover card.
  const selectedProviderAccountUsage = useMemo(
    () => deriveProviderAccountUsagePresentationForProvider(selectedProviderStatus),
    [selectedProviderStatus],
  );
  const {
    isConsumingRateLimitResetCredit,
    requestRateLimitResetCredit,
    rateLimitResetCreditDialog,
  } = useProviderRateLimitResetCredit();
  const selectedProviderResetCredits =
    selectedProviderStatus?.accountUsage?.rateLimitResetCredits ?? null;
  const canResetSelectedProviderUsage = canRequestProviderRateLimitResetCredit(
    selectedProviderStatus,
    selectedProviderResetCredits?.availableCount,
  );
  const requestSelectedProviderUsageReset = useCallback(() => {
    if (!canResetSelectedProviderUsage || !selectedProviderResetCredits) return;
    requestRateLimitResetCredit({
      instanceId: selectedInstanceId,
      resetCredits: selectedProviderResetCredits,
    });
  }, [
    canResetSelectedProviderUsage,
    requestRateLimitResetCredit,
    selectedInstanceId,
    selectedProviderResetCredits,
  ]);
  const selectedProviderModels = useMemo<ReadonlyArray<ServerProvider["models"][number]>>(
    () => selectedProviderEntry?.models ?? [],
    [selectedProviderEntry],
  );
  const selectedModelSupportsImages = useMemo(
    () =>
      providerModelSupportsInputModality(
        selectedProviderModels,
        selectedModel,
        selectedProvider,
        "image",
      ),
    [selectedProvider, selectedProviderModels, selectedModel],
  );

  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        prompt,
        modelOptions: composerModelOptions?.[selectedInstanceId],
      }),
    [
      composerModelOptions,
      prompt,
      selectedInstanceId,
      selectedModel,
      selectedProvider,
      selectedProviderModels,
    ],
  );

  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const composerProviderControls = useMemo(() => {
    const selectedModelName = selectedProviderModels.find(
      (candidate) => candidate.slug === selectedModel,
    )?.name;
    return {
      showInteractionModeToggle: getProviderInteractionModeToggle(
        providerStatuses,
        selectedProvider,
      ),
      runtimeModeOptions: deriveRuntimeModeOptions({
        providers: providerStatuses,
        provider: selectedProvider,
        models: selectedProviderModels,
        model: selectedModel,
        ...(selectedModelName ? { modelName: selectedModelName } : {}),
      }),
    };
  }, [providerStatuses, selectedProvider, selectedProviderModels, selectedModel]);
  const selectedModelSelection = useMemo<ModelSelection>(
    () => createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch),
    [selectedInstanceId, selectedModel, selectedModelOptionsForDispatch],
  );
  const selectedModelForPicker = selectedModel;
  // Instance-keyed option list so the picker can show each configured
  // instance (built-in + custom) as a first-class sidebar entry. The
  // options are server-reported models plus that exact instance's
  // configured custom models; selected slugs are not injected into lists.
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of providerInstanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [providerInstanceEntries, settings]);
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? [];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByInstance, selectedInstanceId, selectedModelForPicker, selectedProvider]);
  const activeModelFallback = useMemo(
    () => deriveActiveModelFallbackState(activeThreadActivities ?? [], activeThread?.latestTurn),
    [activeThread?.latestTurn, activeThreadActivities],
  );
  const activeFallbackModelDisplayName = useMemo(() => {
    if (!activeModelFallback) {
      return null;
    }
    return formatModelDisplayName(
      activeModelFallback.activeModel,
      modelOptionsByInstance.get(selectedInstanceId) ?? [],
    );
  }, [activeModelFallback, modelOptionsByInstance, selectedInstanceId]);

  // ------------------------------------------------------------------
  // Context window
  // ------------------------------------------------------------------
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(activeThreadActivities ?? []),
    [activeThreadActivities],
  );

  // ------------------------------------------------------------------
  // Composer-local state
  // ------------------------------------------------------------------
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
    null,
  );
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
  const [, setIsComposerFocused] = useState(false);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const isMobileViewport = useMediaQuery("max-sm");
  // Keep the real editor mounted on phones; the one-line proxy is fragile with mobile browser focus.
  const isComposerCollapsedMobile = false;
  const canCaptureScreenshot =
    typeof window !== "undefined" && typeof window.desktopBridge?.captureScreenshot === "function";

  // ------------------------------------------------------------------
  // Refs
  // ------------------------------------------------------------------
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const attachmentFileInputRef = useRef<HTMLInputElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const composerFormHeightRef = useRef(0);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const composerBlurFrameRef = useRef<number | null>(null);
  const mobileComposerExpandFrameRef = useRef<number | null>(null);
  const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null);
  const mobileComposerExpandInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);

  // ------------------------------------------------------------------
  // Derived: composer send state
  // ------------------------------------------------------------------
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        attachmentCount: composerAttachments.length,
        terminalContexts: composerTerminalContexts,
        transcriptHighlightContexts: composerTranscriptHighlightContexts,
        fileSelectionContextCount: composerFileSelectionContexts.length,
      }),
    [
      composerAttachments.length,
      composerTerminalContexts,
      composerTranscriptHighlightContexts,
      composerFileSelectionContexts.length,
      prompt,
    ],
  );

  // ------------------------------------------------------------------
  // Derived: composer trigger / menu
  // ------------------------------------------------------------------
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path" && canReferenceWorkspaceFiles;
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    pathTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectivePathQuery = pathTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      environmentId,
      cwd: gitCwd,
      query: effectivePathQuery,
      enabled: isPathTrigger,
      allowEmptyQuery: true,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;

  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.parentPath ?? "",
      }));
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        {
          id: "slash:plan",
          type: "slash-command",
          command: "plan",
          label: "/plan",
          description: "Switch this thread into plan mode",
        },
        {
          id: "slash:default",
          type: "slash-command",
          command: "default",
          label: "/default",
          description: "Switch this thread back to normal build mode",
        },
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const providerSlashCommandItems = (selectedProviderStatus?.slashCommands ?? []).map(
        (command) => ({
          id: `provider-slash-command:${selectedProvider}:${command.name}`,
          type: "provider-slash-command" as const,
          provider: selectedProvider,
          command,
          label: `/${command.name}`,
          description: command.description ?? command.input?.hint ?? "Run provider command",
        }),
      );
      const query = composerTrigger.query.trim().toLowerCase();
      const slashCommandItems = [...builtInSlashCommandItems, ...providerSlashCommandItems];
      if (!query) {
        return slashCommandItems;
      }
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(composerSkills, composerTrigger.query).map((skill) => ({
        id: `skill:${selectedProvider}:${skill.name}`,
        type: "skill" as const,
        provider: selectedProvider,
        skill,
        label: formatProviderSkillDisplayName(skill),
        description:
          skill.shortDescription ??
          skill.description ??
          (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
      }));
    }
    return [];
  }, [composerSkills, composerTrigger, selectedProvider, selectedProviderStatus, workspaceEntries]);

  const composerMenuOpen = Boolean(composerTrigger);
  const composerMenuSearchKey = composerTrigger
    ? `${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
    : null;
  const activeComposerMenuItem = useMemo(() => {
    const activeItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    return composerMenuItems.find((item) => item.id === activeItemId) ?? null;
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuSearchKey,
  ]);

  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;

  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );

  const isComposerApprovalState = activePendingApproval !== null;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const hasComposerHeader =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (showPlanFollowUpPrompt && activeProposedPlan !== null);
  const showCollapsedMobilePromptRow =
    isComposerCollapsedMobile && !isComposerApprovalState && pendingUserInputs.length === 0;
  // Turn whose suggestion the user already responded to. Suppresses the stale
  // suggestion from flashing back over an empty composer while the next turn is
  // connecting / starting (before it registers as the latest turn).
  const [dismissedSuggestionTurnId, setDismissedSuggestionTurnId] = useState<TurnId | null>(null);
  const latestPromptSuggestion = useMemo(
    () =>
      selectPromptSuggestion({
        isSuggestionProvider: selectedProvider === CLAUDE_AGENT_PROVIDER,
        composerIsEmpty: prompt.trim().length === 0,
        phase,
        isSendBusy,
        hasComposerApproval: isComposerApprovalState,
        pendingUserInputCount: pendingUserInputs.length,
        showPlanFollowUpPrompt,
        latestTurn: activeThread?.latestTurn ?? null,
        dismissedTurnId: dismissedSuggestionTurnId,
        activities: activeThreadActivities ?? [],
      }),
    [
      activeThread?.latestTurn,
      activeThreadActivities,
      dismissedSuggestionTurnId,
      isComposerApprovalState,
      isSendBusy,
      pendingUserInputs.length,
      phase,
      prompt,
      selectedProvider,
      showPlanFollowUpPrompt,
    ],
  );
  const latestPromptSuggestionDisplayText = latestPromptSuggestion
    ? formatPromptSuggestionDisplayText(latestPromptSuggestion)
    : null;

  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (phase === "running") {
      return `running:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}`;
    }
    if (showPlanFollowUpPrompt) {
      return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    phase,
    prompt,
    showPlanFollowUpPrompt,
  ]);

  const isComposerMenuLoading =
    (isPathTrigger &&
      ((pathTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching)) ||
    (composerTriggerKind === "skill" &&
      (projectSkillsQuery.isLoading || projectSkillsQuery.isFetching));
  const composerMenuEmptyState = useMemo(() => {
    if (composerTriggerKind === "skill") {
      if (projectSkillsQuery.isError) {
        return "Could not load skills for this project and provider.";
      }
      return "No skills found. Try / to browse provider commands.";
    }
    if (composerTriggerKind === "path") {
      if (!canReferenceWorkspaceFiles) {
        return "Continue this chat in a project to reference workspace files.";
      }
      if (workspaceEntriesQuery.isError) {
        return "Could not load files and folders from this workspace.";
      }
      return pathTriggerQuery.trim().length === 0
        ? "No files or folders are available in this workspace."
        : "No matching files or folders.";
    }
    return "No matching command.";
  }, [
    composerTriggerKind,
    canReferenceWorkspaceFiles,
    pathTriggerQuery,
    projectSkillsQuery.isError,
    workspaceEntriesQuery.isError,
  ]);
  const defaultComposerPlaceholder = useMemo(
    () =>
      buildDefaultComposerPlaceholder({
        canReferenceFiles: canReferenceWorkspaceFiles,
        canInvokeSkills: composerSkills.some((skill) => skill.enabled),
      }),
    [canReferenceWorkspaceFiles, composerSkills],
  );

  // ------------------------------------------------------------------
  // Provider traits UI
  // ------------------------------------------------------------------
  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
  });
  const providerTraitsPicker = renderProviderTraitsPicker({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
  });
  const pendingPrimaryAction = useMemo(
    () =>
      activePendingProgress
        ? {
            questionIndex: activePendingProgress.questionIndex,
            isLastQuestion: activePendingProgress.isLastQuestion,
            canAdvance: activePendingProgress.canAdvance,
            isResponding: activePendingIsResponding,
            isComplete: Boolean(activePendingResolvedAnswers),
          }
        : null,
    [activePendingIsResponding, activePendingProgress, activePendingResolvedAnswers],
  );
  const collapsedComposerPrimaryActionDisabled =
    isSendBusy || isConnecting || !composerSendState.hasSendableContent;
  const collapsedComposerPrimaryActionLabel =
    phase === "running" ? "Steer active turn" : "Send message";
  const showMobilePendingAnswerActions =
    isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;
  // Shared gate for every "Add" action (upload + screenshot). The in-flight
  // capture only blocks the screenshot item, not uploading images, so it is
  // handled inside the menu rather than here. Models without image input
  // still accept document attachments, so modality no longer disables the
  // whole menu — image files are rejected per-file during ingest instead.
  const attachmentsDisabled = isComposerApprovalState || pendingUserInputs.length > 0;
  const attachmentsDisabledReason = attachmentsDisabled
    ? "Finish the pending prompt before adding attachments"
    : null;

  // ------------------------------------------------------------------
  // Prompt helpers
  // ------------------------------------------------------------------
  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    },
    [composerDraftTarget, setComposerDraftPrompt],
  );

  const applyPromptSuggestion = useCallback(
    (suggestion: string) => {
      const nextPrompt = formatPromptSuggestionDisplayText(suggestion);
      if (nextPrompt.length === 0) return;
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
    },
    [promptRef, setPrompt],
  );

  const addComposerAttachment = useCallback(
    (image: ComposerAttachment) => {
      addComposerDraftAttachment(composerDraftTarget, image);
    },
    [composerDraftTarget, addComposerDraftAttachment],
  );

  const addComposerAttachmentsToDraft = useCallback(
    (images: ComposerAttachment[]) => {
      addComposerDraftAttachments(composerDraftTarget, images);
    },
    [composerDraftTarget, addComposerDraftAttachments],
  );

  const removeComposerAttachmentFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftAttachment(composerDraftTarget, imageId);
    },
    [composerDraftTarget, removeComposerDraftAttachment],
  );

  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) return;
      const removal = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      removeComposerDraftTerminalContext(composerDraftTarget, contextId);
      if (removal.prompt !== promptRef.current) {
        promptRef.current = removal.prompt;
        setPrompt(removal.prompt);
        const nextCursor = collapseExpandedComposerCursor(removal.prompt, removal.cursor);
        setComposerCursor(nextCursor);
        setComposerTrigger(detectComposerTrigger(removal.prompt, removal.cursor));
      }
    },
    [
      composerDraftTarget,
      composerTerminalContexts,
      promptRef,
      removeComposerDraftTerminalContext,
      setPrompt,
    ],
  );

  const removeComposerFileSelectionContextFromDraft = useCallback(
    (contextId: string) => {
      removeComposerDraftFileSelectionContext(composerDraftTarget, contextId);
    },
    [composerDraftTarget, removeComposerDraftFileSelectionContext],
  );

  const removeComposerTranscriptHighlightContextFromDraft = useCallback(
    (contextId: string) => {
      removeComposerDraftTranscriptHighlightContext(composerDraftTarget, contextId);
    },
    [composerDraftTarget, removeComposerDraftTranscriptHighlightContext],
  );

  const updateComposerTranscriptHighlightContextNote = useCallback(
    (contextId: string, note: string) => {
      updateComposerDraftTranscriptHighlightContextNote(composerDraftTarget, contextId, note);
    },
    [composerDraftTarget, updateComposerDraftTranscriptHighlightContextNote],
  );

  // ------------------------------------------------------------------
  // Sync refs back to parent
  // ------------------------------------------------------------------
  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt, promptRef]);

  useEffect(() => {
    composerAttachmentsRef.current = composerAttachments;
  }, [composerAttachments, composerAttachmentsRef]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts, composerTerminalContextsRef]);

  useEffect(() => {
    composerTranscriptHighlightContextsRef.current = composerTranscriptHighlightContexts;
  }, [composerTranscriptHighlightContexts, composerTranscriptHighlightContextsRef]);
  useEffect(() => {
    composerFileSelectionContextsRef.current = composerFileSelectionContexts;
  }, [composerFileSelectionContexts, composerFileSelectionContextsRef]);

  // ------------------------------------------------------------------
  // Composer menu highlight sync
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      setComposerHighlightedSearchKey(null);
      return;
    }
    const nextActiveItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    setComposerHighlightedItemId((existing) =>
      existing === nextActiveItemId ? existing : nextActiveItemId,
    );
    setComposerHighlightedSearchKey((existing) =>
      existing === composerMenuSearchKey ? existing : composerMenuSearchKey,
    );
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
  ]);

  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }

    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingProgress?.activeQuestion?.id,
    activePendingUserInput?.requestId,
    promptRef,
  ]);

  // ------------------------------------------------------------------
  // Reset compositor state on thread/draft change
  // ------------------------------------------------------------------
  useEffect(() => {
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
  }, [draftId, activeThreadId, promptRef]);

  // ------------------------------------------------------------------
  // Footer compact layout observation
  // ------------------------------------------------------------------
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterCompactness = () => {
      const composerFormWidth = measureComposerFormWidth();
      const footerCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const primaryActionsCompact =
        footerCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });
      return {
        primaryActionsCompact,
        footerCompact,
      };
    };

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    const initialCompactness = measureFooterCompactness();
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;
      const nextCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );
      const nextHeight = entry.contentRect.height;
      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;
      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) return;
      if (!shouldAutoScrollRef.current) return;
      scheduleStickToBottom();
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [
    activeThreadId,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions,
    scheduleStickToBottom,
    shouldAutoScrollRef,
  ]);

  // ------------------------------------------------------------------
  // Image persist effect
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerAttachments.length === 0) {
        clearComposerDraftPersistedAttachments(composerDraftTarget);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        getComposerDraft(composerDraftTarget)?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerAttachment>();
        await Promise.all(
          composerAttachments.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, serialized);
      } catch {
        const currentImageIds = new Set(composerAttachments.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds = fallbackPersistedAttachments
          .map((attachment) => attachment.id)
          .filter((id) => currentImageIds.has(id));
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    composerDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerAttachments,
    getComposerDraft,
    syncComposerDraftPersistedAttachments,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: prompt change
  // ------------------------------------------------------------------
  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
        setComposerCursor(nextCursor);
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        );
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      const previousPrompt = promptRef.current;
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const shouldSyncInlineTerminalContexts =
        previousPrompt.includes(INLINE_TERMINAL_CONTEXT_PLACEHOLDER) ||
        nextPrompt.includes(INLINE_TERMINAL_CONTEXT_PLACEHOLDER) ||
        terminalContextIds.length > 0;
      if (
        shouldSyncInlineTerminalContexts &&
        !terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)
      ) {
        setComposerDraftTerminalContexts(
          composerDraftTarget,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      pendingUserInputs.length,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
      composerDraftTarget,
      composerTerminalContexts,
      setComposerDraftTerminalContexts,
    ],
  );

  // ------------------------------------------------------------------
  // Callbacks: prompt replacement / menu
  // ------------------------------------------------------------------
  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; focusEditorAfterReplace?: boolean },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      const nextExpandedCursor = expandCollapsedComposerCursor(next.text, nextCursor);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingQuestion.id,
          next.text,
          nextCursor,
          nextExpandedCursor,
          false,
        );
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(next.text, nextExpandedCursor));
      if (options?.focusEditorAfterReplace !== false) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCursor);
        });
      }
      return true;
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
    ],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts, promptRef]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        const replacement = `@${serializeComposerMentionPath(item.path)} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            setIsComposerModelPickerOpen(true);
          }
          return;
        }
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "provider-slash-command") {
        const replacement = `/${item.command.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "skill") {
        const replacement = `$${item.skill.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
    },
    [applyPromptReplacement, handleInteractionModeChange, resolveActiveComposerTrigger],
  );

  const onComposerMenuItemHighlighted = useCallback(
    (itemId: string | null) => {
      setComposerHighlightedItemId(itemId);
      setComposerHighlightedSearchKey(composerMenuSearchKey);
    },
    [composerMenuSearchKey],
  );

  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) return;
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );

  const blurMobileComposerAfterSend = useCallback(() => {
    if (!isMobileViewport) return;
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    setIsComposerFocused(false);
  }, [isMobileViewport]);

  const shouldBlurMobileComposerOnSubmit = useCallback(() => {
    if (!isMobileViewport) return false;
    if (isSendBusy || isConnecting || phase === "running") return false;
    if (activePendingProgress) {
      return activePendingProgress.isLastQuestion && Boolean(activePendingResolvedAnswers);
    }
    return showPlanFollowUpPrompt || composerSendState.hasSendableContent;
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    composerSendState.hasSendableContent,
    isConnecting,
    isMobileViewport,
    isSendBusy,
    phase,
    showPlanFollowUpPrompt,
  ]);

  const submitComposer = useCallback(
    (event?: { preventDefault: () => void }) => {
      if (composerAttachments.length > 0 && !selectedModelSupportsImages) {
        event?.preventDefault();
        toastManager.add({
          type: "error",
          title: "Selected model does not accept images.",
        });
        return;
      }
      // Sending a follow-up to a completed turn consumes that turn's suggestion;
      // keep it hidden until a newer turn produces its own.
      const latestTurn = activeThread?.latestTurn ?? null;
      if (composerSendState.hasSendableContent && latestTurn?.state === "completed") {
        setDismissedSuggestionTurnId(latestTurn.turnId);
      }
      onSend(event);
      if (shouldBlurMobileComposerOnSubmit()) {
        blurMobileComposerAfterSend();
      }
    },
    [
      activeThread?.latestTurn,
      blurMobileComposerAfterSend,
      composerAttachments.length,
      composerSendState.hasSendableContent,
      onSend,
      selectedModelSupportsImages,
      shouldBlurMobileComposerOnSubmit,
    ],
  );
  const expandMobileComposer = useCallback(() => {
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandFrameRef.current = null;
      composerEditorRef.current?.focusAtEnd();
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandReleaseFrameRef.current = null;
        mobileComposerExpandInFlightRef.current = false;
      });
    });
  }, []);

  // ------------------------------------------------------------------
  // Callbacks: command key
  // ------------------------------------------------------------------
  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      toggleInteractionMode();
      return true;
    }
    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;
    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if ((key === "Enter" || key === "Tab") && selectedItem) {
        onSelectComposerItem(selectedItem);
        return true;
      }
    }
    if (key === "Enter" && !event.shiftKey) {
      submitComposer();
      return true;
    }
    return false;
  };

  // ------------------------------------------------------------------
  // Callbacks: images
  // ------------------------------------------------------------------
  const addComposerFiles = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;
    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach files after answering plan questions.",
      });
      return;
    }
    const nextAttachments: ComposerAttachment[] = [];
    let nextAttachmentCount = composerAttachmentsRef.current.length;
    let error: string | null = null;
    let rejectedImageForModel = false;
    for (const file of files) {
      const isImage = file.type.startsWith("image/");
      const fileType = isImage
        ? null
        : resolveFileAttachmentType({ mimeType: file.type, fileName: file.name });
      if (!isImage && !fileType) {
        error = `Unsupported file type for '${file.name}'. Attach images, PDFs, or text, Markdown, and CSV files.`;
        continue;
      }
      if (isImage && !selectedModelSupportsImages) {
        rejectedImageForModel = true;
        continue;
      }
      const maxBytes = isImage
        ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
      if (file.size > maxBytes) {
        error = `'${file.name}' exceeds the ${ATTACHMENT_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextAttachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
        break;
      }
      if (isImage) {
        nextAttachments.push({
          type: "image",
          id: randomUUID(),
          name: file.name || "image",
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: URL.createObjectURL(file),
          file,
        });
      } else if (fileType) {
        nextAttachments.push({
          type: "file",
          kind: fileType.kind,
          id: randomUUID(),
          name: file.name || `file${fileType.extension}`,
          mimeType: fileType.mimeType,
          sizeBytes: file.size,
          file,
        });
      }
      nextAttachmentCount += 1;
    }
    if (rejectedImageForModel) {
      toastManager.add({
        type: "error",
        title: "Selected model does not accept images.",
      });
    }
    if (nextAttachments.length === 1 && nextAttachments[0]) {
      addComposerAttachment(nextAttachments[0]);
    } else if (nextAttachments.length > 1) {
      addComposerAttachmentsToDraft(nextAttachments);
    }
    setThreadError(activeThreadId, error);
  };

  const openImageFilePicker = () => {
    if (attachmentsDisabled) return;
    imageFileInputRef.current?.click();
  };

  const openAttachmentFilePicker = () => {
    if (attachmentsDisabled) return;
    attachmentFileInputRef.current?.click();
  };

  const onAttachmentFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Reset so selecting the same file again still fires a change event.
    event.target.value = "";
    if (files.length === 0) return;
    addComposerFiles(files);
    focusComposer();
  };

  const onCaptureScreenshot = () => {
    const captureScreenshot = window.desktopBridge?.captureScreenshot;
    if (!captureScreenshot || isCapturingScreenshot) return;
    if (attachmentsDisabled) return;

    setIsCapturingScreenshot(true);
    void captureScreenshot({ mode: "interactive" })
      .then((result) => {
        if (result.status === "cancelled") {
          return;
        }
        if (result.status === "unsupported" || result.status === "failed") {
          toastManager.add({
            type: "error",
            title:
              result.status === "unsupported"
                ? "Screenshot capture is not available."
                : "Screenshot capture failed.",
            description: result.message,
          });
          return;
        }

        const file = desktopCapturedScreenshotToFile(result.image);
        if (!file) {
          toastManager.add({
            type: "error",
            title: "Screenshot capture failed.",
            description: "The captured image could not be read.",
          });
          return;
        }

        addComposerFiles([file]);
        focusComposer();
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Screenshot capture failed.",
          description: unknownErrorMessage(error, "The desktop capture request failed."),
        });
      })
      .finally(() => {
        setIsCapturingScreenshot(false);
      });
  };

  const removeComposerAttachment = (imageId: string) => {
    removeComposerAttachmentFromDraft(imageId);
  };

  // ------------------------------------------------------------------
  // Callbacks: paste / drag
  // ------------------------------------------------------------------
  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    const supportedFiles = files.filter(
      (file) =>
        file.type.startsWith("image/") ||
        resolveFileAttachmentType({ mimeType: file.type, fileName: file.name }) !== null,
    );
    if (supportedFiles.length === 0) return;
    event.preventDefault();
    addComposerFiles(supportedFiles);
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    addComposerFiles(files);
    focusComposer();
  };
  const handleInterruptPrimaryAction = useCallback(() => {
    void onInterrupt();
  }, [onInterrupt]);
  const handleImplementPlanInNewThreadPrimaryAction = useCallback(() => {
    void onImplementPlanInNewThread();
  }, [onImplementPlanInNewThread]);
  const scheduleComposerCollapseCheck = useCallback(() => {
    if (!isMobileViewport) {
      return;
    }
    if (mobileComposerExpandInFlightRef.current) {
      return;
    }
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (mobileComposerExpandInFlightRef.current) {
        return;
      }
      const composerSurface = composerSurfaceRef.current;
      const activeElement = document.activeElement;
      if (activeElement instanceof Element && isInsideComposerFloatingLayer(activeElement)) {
        return;
      }
      if (
        composerSurface &&
        activeElement instanceof Node &&
        composerSurface.contains(activeElement)
      ) {
        return;
      }
      setIsComposerFocused(false);
    });
  }, [isMobileViewport]);

  useEffect(() => {
    return () => {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
      }
      if (mobileComposerExpandFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
      }
      if (mobileComposerExpandReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
      }
    };
  }, []);

  // ------------------------------------------------------------------
  // Imperative handle
  // ------------------------------------------------------------------
  useImperativeHandle(
    composerRef,
    () => ({
      focusAtEnd: () => {
        composerEditorRef.current?.focusAtEnd();
      },
      focusAt: (cursor: number) => {
        composerEditorRef.current?.focusAt(cursor);
      },
      openModelPicker: () => {
        setIsComposerModelPickerOpen(true);
      },
      toggleModelPicker: () => {
        setIsComposerModelPickerOpen((open) => !open);
      },
      isModelPickerOpen: () => isComposerModelPickerOpen,
      readSnapshot: () => {
        return readComposerSnapshot();
      },
      resetCursorState: (options?: {
        cursor?: number;
        prompt?: string;
        detectTrigger?: boolean;
      }) => {
        const promptForState = options?.prompt ?? promptRef.current;
        const cursor = clampCollapsedComposerCursor(promptForState, options?.cursor ?? 0);
        setComposerHighlightedItemId(null);
        setComposerCursor(cursor);
        setComposerTrigger(
          options?.detectTrigger
            ? detectComposerTrigger(
                promptForState,
                expandCollapsedComposerCursor(promptForState, cursor),
              )
            : null,
        );
      },
      addTerminalContext: (selection: TerminalContextSelection) => {
        if (!activeThread) return;
        addComposerDraftTerminalContext(composerDraftTarget, {
          id: randomUUID(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
          ...selection,
        });
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAtEnd();
        });
      },
      addTranscriptHighlightContext: (selection: TranscriptHighlightContextSelection) => {
        if (!activeThread) return;
        addComposerDraftTranscriptHighlightContext(composerDraftTarget, {
          ...selection,
          id: randomUUID(),
          threadId: activeThread.id,
          createdAt: new Date().toISOString(),
        });
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAtEnd();
        });
      },
      getSendContext: () => ({
        prompt: promptRef.current,
        images: composerAttachmentsRef.current,
        terminalContexts: composerTerminalContextsRef.current,
        transcriptHighlightContexts: composerTranscriptHighlightContextsRef.current,
        fileSelectionContexts: composerFileSelectionContextsRef.current,
        selectedPromptEffort,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        selectedProvider,
        selectedModel,
        selectedProviderModels,
        skillReferences: resolveComposerSkillReferences(promptRef.current, composerSkills),
      }),
    }),
    [
      activeThread,
      addComposerDraftTerminalContext,
      addComposerDraftTranscriptHighlightContext,
      composerDraftTarget,
      promptRef,
      composerAttachmentsRef,
      composerTerminalContextsRef,
      composerTranscriptHighlightContextsRef,
      composerFileSelectionContextsRef,
      isComposerModelPickerOpen,
      readComposerSnapshot,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedModelSelection,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
      composerSkills,
    ],
  );

  // Render
  // ------------------------------------------------------------------
  return (
    <form
      ref={composerFormRef}
      onSubmit={submitComposer}
      className="relative mx-auto w-full min-w-0 max-w-4xl"
      data-chat-composer-form="true"
    >
      {/* Float the suggestion above the composer (like the scroll-to-bottom button) so it
          overlays the bottom of the message list instead of consuming input-bar height.
          Width is capped below half the composer so it never reaches the centered
          scroll-to-bottom button that shares this band. */}
      {latestPromptSuggestion && latestPromptSuggestionDisplayText && !isComposerCollapsedMobile ? (
        <div className="absolute inset-x-0 bottom-full z-20 mb-1 flex px-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-prompt-suggestion="true"
                  className="inline-flex max-w-[calc(50%-2rem)] cursor-pointer items-center gap-2 rounded-md border border-border/55 bg-card px-2.5 py-1.5 text-left text-muted-foreground text-xs shadow-sm shadow-black/5 transition-colors hover:border-border hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
                  aria-label={`Use Claude suggested prompt: ${latestPromptSuggestion}`}
                  onClick={() => applyPromptSuggestion(latestPromptSuggestion)}
                >
                  <SparklesIcon className="size-3.5 shrink-0 text-muted-foreground/65" />
                  <span className="truncate">{latestPromptSuggestionDisplayText}</span>
                </button>
              }
            />
            <TooltipPopup side="top">Claude suggested this prompt</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      <div
        className={cn(
          "group rounded-2xl p-px transition-[background-color,box-shadow] duration-200",
          interactionMode === "plan" && "plan-mode-frame",
          composerProviderState.composerFrameClassName,
        )}
        onDragEnter={onComposerDragEnter}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
      >
        <div
          ref={composerSurfaceRef}
          data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
          className={cn(
            "rounded-xl border bg-card elevate-raised transition-colors duration-200 has-focus-visible:border-ring/45",
            isDragOverComposer ? "border-primary/70 bg-accent/30" : "border-border",
            environmentUnavailable ? "opacity-75" : null,
            composerProviderState.composerSurfaceClassName,
          )}
          onFocusCapture={(event) => {
            const activeElement = event.target;
            if (
              isComposerCollapsedMobile &&
              activeElement instanceof HTMLElement &&
              activeElement.closest('[data-chat-composer-collapsed-controls="true"]')
            ) {
              return;
            }
            if (composerBlurFrameRef.current !== null) {
              window.cancelAnimationFrame(composerBlurFrameRef.current);
              composerBlurFrameRef.current = null;
            }
            setIsComposerFocused(true);
          }}
          onBlurCapture={() => {
            scheduleComposerCollapseCheck();
          }}
        >
          {!isComposerCollapsedMobile &&
            (activePendingApproval ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingApprovalPanel
                  approval={activePendingApproval}
                  pendingCount={pendingApprovals.length}
                />
              </div>
            ) : pendingUserInputs.length > 0 ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  respondingRequestIds={respondingRequestIds}
                  answers={activePendingDraftAnswers}
                  questionIndex={activePendingQuestionIndex}
                  isTimelineScrolledAway={isTimelineScrolledAway}
                  onToggleOption={onSelectActivePendingUserInputOption}
                  onAdvance={onAdvanceActivePendingUserInput}
                />
              </div>
            ) : showPlanFollowUpPrompt && activeProposedPlan ? (
              <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
                <ComposerPlanFollowUpBanner
                  key={activeProposedPlan.id}
                  planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                />
              </div>
            ) : null)}

          {isComposerCollapsedMobile && activePendingApproval ? (
            <div
              className="rounded-t-[19px] border-b border-border/65 bg-muted/20"
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingApprovalPanel
                approval={activePendingApproval}
                pendingCount={pendingApprovals.length}
              />
              <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-3 sm:px-4">
                <ComposerPendingApprovalActions
                  requestId={activePendingApproval.requestId}
                  isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                  onRespondToApproval={onRespondToApproval}
                />
              </div>
            </div>
          ) : isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
            <div
              className="rounded-t-[19px] border-b border-border/65 bg-muted/20"
              data-chat-composer-collapsed-controls="true"
            >
              <ComposerPendingUserInputPanel
                pendingUserInputs={pendingUserInputs}
                respondingRequestIds={respondingRequestIds}
                answers={activePendingDraftAnswers}
                questionIndex={activePendingQuestionIndex}
                isTimelineScrolledAway={isTimelineScrolledAway}
                onToggleOption={onSelectActivePendingUserInputOption}
                onAdvance={onAdvanceActivePendingUserInput}
              />
              <div className="px-3 pb-3 sm:px-4">
                <div
                  data-chat-composer-mobile-pending-compact="true"
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-lg border border-border/55 bg-background/55 p-1.5 pl-3 transition-colors hover:bg-background/80",
                    !activePendingProgress?.activeQuestion?.multiSelect && "p-0",
                  )}
                >
                  <button
                    type="button"
                    className={cn(
                      "min-w-0 flex-1 truncate bg-transparent py-1.5 text-left text-sm",
                      activePendingProgress?.customAnswer
                        ? "text-foreground"
                        : "text-muted-foreground/60",
                      !activePendingProgress?.activeQuestion?.multiSelect && "px-3 py-2",
                    )}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={expandMobileComposer}
                    aria-label="Write custom answer"
                  >
                    {activePendingProgress?.customAnswer || "Write custom answer"}
                  </button>
                  {activePendingProgress?.activeQuestion?.multiSelect ? (
                    <ComposerPrimaryActions
                      compact
                      pendingAction={pendingPrimaryAction}
                      isRunning={false}
                      showPlanFollowUpPrompt={false}
                      promptHasText={false}
                      isSendBusy={isSendBusy}
                      isConnecting={isConnecting}
                      isEnvironmentUnavailable={environmentUnavailable !== null}
                      isPreparingWorktree={false}
                      hasSendableContent={false}
                      preserveComposerFocusOnPointerDown
                      runtimeMode={runtimeMode}
                      runtimeModeOptions={composerProviderControls.runtimeModeOptions}
                      onRuntimeModeChange={handleRuntimeModeChange}
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={handleInterruptPrimaryAction}
                      onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                    />
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {showCollapsedMobilePromptRow ? (
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <button
                type="button"
                className={cn(
                  "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-[14px] focus:outline-none",
                  (activePendingProgress ? activePendingProgress.customAnswer : prompt.trim())
                    ? "text-foreground"
                    : "text-muted-foreground/35",
                )}
                onPointerDown={(event) => event.preventDefault()}
                onClick={expandMobileComposer}
                aria-label="Expand composer"
              >
                {activePendingProgress
                  ? activePendingProgress.customAnswer ||
                    "Type your own answer, or leave this blank to use the selected option"
                  : prompt.trim() || "Ask anything..."}
              </button>
              <button
                type="button"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/90 text-primary-foreground disabled:opacity-30"
                disabled={collapsedComposerPrimaryActionDisabled}
                aria-label={collapsedComposerPrimaryActionLabel}
                onPointerDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  submitComposer();
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M8 3L8 13M8 3L4 7M8 3L12 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>
          ) : null}

          <div
            className={cn(
              "relative px-3 pb-2 sm:px-4",
              hasComposerHeader ? "pt-2.5 sm:pt-3" : "pt-3.5 sm:pt-4",
              isComposerCollapsedMobile && "hidden",
            )}
          >
            {composerMenuOpen && !isComposerApprovalState && (
              <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                <ComposerCommandMenu
                  items={composerMenuItems}
                  resolvedTheme={resolvedTheme}
                  isLoading={isComposerMenuLoading}
                  triggerKind={composerTriggerKind}
                  groupSlashCommandSections={
                    composerTrigger?.kind === "slash-command" &&
                    composerTrigger.query.trim().length === 0
                  }
                  emptyStateText={composerMenuEmptyState}
                  activeItemId={activeComposerMenuItem?.id ?? null}
                  onHighlightedItemChange={onComposerMenuItemHighlighted}
                  onSelect={onSelectComposerItem}
                />
              </div>
            )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerAttachments.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-2">
                  {composerAttachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                      title={attachment.name}
                    >
                      {attachment.previewUrl ? (
                        <button
                          type="button"
                          className="h-full w-full cursor-zoom-in"
                          aria-label={`Preview ${attachment.name}`}
                          onClick={() => {
                            const preview = buildExpandedImagePreview(
                              composerAttachments,
                              attachment.id,
                            );
                            if (!preview) return;
                            onExpandImage(preview);
                          }}
                        >
                          <img
                            src={attachment.previewUrl}
                            alt={attachment.name}
                            className="h-full w-full object-cover"
                          />
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="flex h-full w-full cursor-zoom-in flex-col items-center justify-center gap-1 px-1 text-center"
                          aria-label={`Preview ${attachment.name}`}
                          onClick={() => {
                            if (attachment.type !== "file") return;
                            onPreviewFile({
                              name: attachment.name,
                              kind: attachment.kind,
                              // Slice re-labels the blob with the resolved canonical
                              // MIME type (browsers report none for e.g. .md files).
                              loadBlob: () =>
                                Promise.resolve(
                                  attachment.file.slice(
                                    0,
                                    attachment.file.size,
                                    attachment.mimeType,
                                  ),
                                ),
                            });
                          }}
                        >
                          <FileTextIcon className="size-5 text-muted-foreground" />
                          <span className="w-full truncate text-[9px] leading-tight text-muted-foreground/80">
                            {attachment.name}
                          </span>
                        </button>
                      )}
                      {nonPersistedComposerImageIdSet.has(attachment.id) && (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <span
                                role="img"
                                aria-label="Draft attachment may not persist"
                                className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                              >
                                <CircleAlertIcon className="size-3" />
                              </span>
                            }
                          />
                          <TooltipPopup
                            side="top"
                            className="max-w-64 whitespace-normal leading-tight"
                          >
                            Draft attachment could not be saved locally and may be lost on
                            navigation.
                          </TooltipPopup>
                        </Tooltip>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                        onClick={() => removeComposerAttachment(attachment.id)}
                        aria-label={`Remove ${attachment.name}`}
                      >
                        <XIcon />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerTerminalContexts.length > 0 && (
                <ComposerPendingTerminalContexts
                  contexts={composerTerminalContexts}
                  onRemove={removeComposerTerminalContextFromDraft}
                  className="mb-2"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerTranscriptHighlightContexts.length > 0 && (
                <ComposerPendingTranscriptHighlightContexts
                  contexts={composerTranscriptHighlightContexts}
                  onRemove={removeComposerTranscriptHighlightContextFromDraft}
                  onUpdateNote={updateComposerTranscriptHighlightContextNote}
                  className="mb-2"
                />
              )}

            {!isComposerCollapsedMobile &&
              !isComposerApprovalState &&
              pendingUserInputs.length === 0 &&
              composerFileSelectionContexts.length > 0 && (
                <ComposerPendingFileSelectionContexts
                  contexts={composerFileSelectionContexts}
                  onRemove={removeComposerFileSelectionContextFromDraft}
                  className="mb-2"
                />
              )}

            <div className="relative">
              <ComposerPromptEditor
                editorRef={composerEditorRef}
                value={
                  isComposerApprovalState
                    ? ""
                    : activePendingProgress
                      ? activePendingProgress.customAnswer
                      : prompt
                }
                cursor={composerCursor}
                terminalContexts={[]}
                skills={composerSkills}
                {...(showMobilePendingAnswerActions ? { className: "max-sm:pb-11" } : {})}
                onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                onChange={onPromptChange}
                onCommandKeyDown={onComposerCommandKey}
                onPaste={onComposerPaste}
                placeholder={
                  isComposerApprovalState
                    ? (activePendingApproval?.detail ?? "Resolve this approval request to continue")
                    : activePendingProgress
                      ? "Type your own answer, or leave this blank to use the selected option"
                      : showPlanFollowUpPrompt && activeProposedPlan
                        ? "Add feedback to refine the plan, or leave this blank to implement it"
                        : environmentUnavailable
                          ? `${environmentUnavailable.label} is ${
                              environmentUnavailable.connectionState === "connecting"
                                ? "connecting"
                                : "disconnected"
                            }`
                          : defaultComposerPlaceholder
                }
                disabled={
                  isConnecting ||
                  isComposerApprovalState ||
                  (environmentUnavailable !== null && activePendingProgress === null)
                }
              />
              {showMobilePendingAnswerActions ? (
                <div
                  data-chat-composer-mobile-pending-actions="true"
                  className="absolute bottom-0 right-0 flex justify-end"
                >
                  <ComposerPrimaryActions
                    compact
                    pendingAction={pendingPrimaryAction}
                    isRunning={false}
                    showPlanFollowUpPrompt={false}
                    promptHasText={false}
                    isSendBusy={isSendBusy}
                    isConnecting={isConnecting}
                    isEnvironmentUnavailable={environmentUnavailable !== null}
                    isPreparingWorktree={false}
                    hasSendableContent={false}
                    preserveComposerFocusOnPointerDown
                    runtimeMode={runtimeMode}
                    runtimeModeOptions={composerProviderControls.runtimeModeOptions}
                    onRuntimeModeChange={handleRuntimeModeChange}
                    onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                    onInterrupt={handleInterruptPrimaryAction}
                    onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                  />
                </div>
              ) : null}
            </div>
          </div>

          {/* Bottom toolbar */}
          {isComposerCollapsedMobile ? null : activePendingApproval ? (
            <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
              <ComposerPendingApprovalActions
                requestId={activePendingApproval.requestId}
                isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                onRespondToApproval={onRespondToApproval}
              />
            </div>
          ) : (
            <div
              data-chat-composer-footer="true"
              data-chat-composer-footer-compact={isComposerFooterCompact ? "true" : "false"}
              className={cn(
                "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-2.5 pb-2.5 sm:px-3 sm:pb-3",
                isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                showMobilePendingAnswerActions && "hidden sm:flex",
              )}
            >
              <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <ProviderModelPicker
                  compact={isComposerFooterCompact}
                  activeInstanceId={selectedInstanceId}
                  model={selectedModelForPickerWithCustomFallback}
                  lockedProvider={lockedProvider}
                  lockedContinuationGroupKey={lockedContinuationGroupKey}
                  instanceEntries={providerInstanceEntries}
                  keybindings={keybindings}
                  modelOptionsByInstance={modelOptionsByInstance}
                  terminalOpen={terminalOpen}
                  side="top"
                  open={isComposerModelPickerOpen}
                  {...(composerProviderState.modelPickerIconClassName
                    ? {
                        activeProviderIconClassName: composerProviderState.modelPickerIconClassName,
                      }
                    : {})}
                  onOpenChange={(open) => {
                    setIsComposerModelPickerOpen(open);
                  }}
                  onInstanceModelChange={onProviderModelSelect}
                />
                {activeModelFallback && activeFallbackModelDisplayName ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          data-chat-model-fallback-chip="true"
                          className={cn(
                            "inline-flex h-7 max-w-52 shrink-0 cursor-help items-center gap-1.5 rounded-full border border-warning/25 bg-warning/8 px-2 text-[11px] font-medium text-warning-foreground sm:h-6",
                            isComposerFooterCompact ? "max-w-36" : "max-w-52",
                          )}
                        />
                      }
                    >
                      <CircleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
                      <span className="min-w-0 truncate">
                        {isComposerFooterCompact
                          ? activeFallbackModelDisplayName
                          : `Fallback: ${activeFallbackModelDisplayName}`}
                      </span>
                    </TooltipTrigger>
                    <TooltipPopup side="top" className="max-w-72 whitespace-normal leading-tight">
                      {activeModelFallback.detail ??
                        `Using ${activeModelFallback.activeModel} instead of ${activeModelFallback.requestedModel}.`}
                    </TooltipPopup>
                  </Tooltip>
                ) : null}

                {isComposerFooterCompact ? (
                  <CompactComposerControlsMenu
                    interactionMode={interactionMode}
                    runtimeMode={runtimeMode}
                    runtimeModeOptions={composerProviderControls.runtimeModeOptions}
                    showInteractionModeToggle={composerProviderControls.showInteractionModeToggle}
                    traitsMenuContent={providerTraitsMenuContent}
                    onInteractionModeChange={handleInteractionModeChange}
                    onRuntimeModeChange={handleRuntimeModeChange}
                  />
                ) : (
                  <>
                    {providerTraitsPicker ? (
                      <>
                        <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
                        {providerTraitsPicker}
                      </>
                    ) : null}
                    <ComposerFooterModeControls
                      showInteractionModeToggle={composerProviderControls.showInteractionModeToggle}
                      interactionMode={interactionMode}
                      runtimeMode={runtimeMode}
                      runtimeModeOptions={composerProviderControls.runtimeModeOptions}
                      onToggleInteractionMode={toggleInteractionMode}
                      onRuntimeModeChange={handleRuntimeModeChange}
                    />
                  </>
                )}
              </div>

              {/* Right side: add attachments + send / stop button */}
              <div
                data-chat-composer-actions="right"
                data-chat-composer-primary-actions-compact={
                  isComposerPrimaryActionsCompact ? "true" : "false"
                }
                className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
              >
                <input
                  ref={imageFileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={onAttachmentFileInputChange}
                />
                <input
                  ref={attachmentFileInputRef}
                  type="file"
                  accept={isMobileViewport ? FILE_ATTACHMENT_ACCEPT : ALL_ATTACHMENT_ACCEPT}
                  multiple
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={onAttachmentFileInputChange}
                />
                <ComposerAttachmentMenu
                  canCaptureScreenshot={canCaptureScreenshot}
                  isCapturingScreenshot={isCapturingScreenshot}
                  isMobileViewport={isMobileViewport}
                  disabled={attachmentsDisabled}
                  disabledReason={attachmentsDisabledReason}
                  onAddImage={openImageFilePicker}
                  onAttachFiles={openAttachmentFilePicker}
                  onCaptureScreenshot={onCaptureScreenshot}
                />
                <ComposerFooterPrimaryActions
                  compact={isComposerPrimaryActionsCompact}
                  activeContextWindow={activeContextWindow}
                  providerAccountUsage={selectedProviderAccountUsage}
                  contextWindowLabel={composerProviderState.contextWindowLabel}
                  pendingAction={pendingPrimaryAction}
                  isRunning={phase === "running"}
                  showPlanFollowUpPrompt={pendingUserInputs.length === 0 && showPlanFollowUpPrompt}
                  promptHasText={prompt.trim().length > 0}
                  isSendBusy={isSendBusy}
                  isConnecting={isConnecting}
                  isEnvironmentUnavailable={environmentUnavailable !== null}
                  isPreparingWorktree={isPreparingWorktree}
                  hasSendableContent={composerSendState.hasSendableContent}
                  preserveComposerFocusOnPointerDown={isMobileViewport}
                  runtimeMode={runtimeMode}
                  runtimeModeOptions={composerProviderControls.runtimeModeOptions}
                  onRuntimeModeChange={handleRuntimeModeChange}
                  onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                  onInterrupt={handleInterruptPrimaryAction}
                  onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                  onResetAccountUsage={
                    canResetSelectedProviderUsage ? requestSelectedProviderUsageReset : undefined
                  }
                  accountUsageResetInFlight={isConsumingRateLimitResetCredit}
                  onCompactContext={onCompactContext}
                  contextCompactDisabled={contextCompactDisabled}
                  contextCompactInFlight={contextCompactInFlight}
                  contextCompactDisabledReason={contextCompactDisabledReason}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      {rateLimitResetCreditDialog}
    </form>
  );
});

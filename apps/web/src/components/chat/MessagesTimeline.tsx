import {
  type EnvironmentId,
  type MessageId,
  type ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  type ServerProviderSkill,
  type ThreadId,
  type TurnId,
} from "@threadlines/contracts";
import {
  createContext,
  Fragment,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SyntheticEvent as ReactSyntheticEvent,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useQueries } from "@tanstack/react-query";
import { isProviderAuthErrorMessage } from "@threadlines/shared/providerAuth";
import {
  deriveTimelineEntries,
  formatSubagentDisplayName,
  isActiveSubagentStatus,
  type McpAuthReconnectAction,
  type ProviderAuthReconnectAction,
  type SubagentProgressItem,
  type ThreadSubagentHistoryEntry,
} from "../../session-logic";
import {
  formatLiveAgentStatusRows,
  formatSubagentReceiptSummary,
  selectTurnAgents,
  summarizeTurnAgents,
  type LiveAgentStatusRoster,
  type TurnAgentSummary,
} from "./agentsPanel.logic";
import { DEFAULT_SCROLL_END_TOLERANCE_PX, isScrollMetricsAtEnd } from "../ChatView.logic";
import { type ChatAttachment, type TurnDiffSummary } from "../../types";
import { chatAttachmentPreviewQueryOptions } from "../../lib/attachmentPreviewQuery";
import { environmentRequiresRpcAssetTransport } from "../../environments/runtime";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  FileTextIcon,
  KeyRoundIcon,
  LoaderIcon,
  LogInIcon,
  RefreshCwIcon,
  PencilIcon,
  SplitIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import type { FilePreviewRequest } from "./FilePreviewDialog";
import { loadChatAttachmentBlob } from "../../lib/attachmentPreviewQuery";
import { ProposedPlanCard, type ProposedPlanCardStatus } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import { ActivityGroup } from "./ActivityGroup";
import {
  activityStepFromWorkLogEntry,
  newestThoughtSentence,
  type ActivityStep,
} from "./activitySteps";
import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
  estimateTimelineRowHeight,
  resolveAssistantMessageCopyState,
  shouldCollapseUserMessage,
  type StableMessagesTimelineRowsState,
  type TrayPlacement,
  type TurnSummary,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  PickedElementContextChip,
  PickedElementContextGroupChip,
} from "./ComposerPendingPickedElementContexts";
import {
  handleTranscriptHighlightNoteFormSubmit,
  handleTranscriptHighlightNoteKeyDown,
  TRANSCRIPT_HIGHLIGHT_CARD_LABEL_CLASS_NAME,
  TranscriptHighlightContextCard,
} from "./TranscriptHighlightContextCard";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import {
  groupPickedElementContexts,
  type PickedElementContext,
  type PickedElementContextDraft,
} from "~/lib/pickedElementContext";
import {
  formatParsedDrawingDescriptor,
  type ParsedDrawingContextEntry,
} from "~/lib/drawingContext";
import { cn, pluralize } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@threadlines/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";
import { useSettings } from "../../hooks/useSettings";
import { useStreamingTextReveal } from "../../hooks/useStreamingTextReveal";
import { findSearchTextHighlightSpans } from "../../lib/searchTextHighlight";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { SkillInlineText } from "./SkillInlineText";
import {
  WorkingAnchorDots,
  isWaitingOnUserState,
  workingDotsStateForLabel,
} from "./WorkingAnchorDots";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useLocalImagePreview } from "~/hooks/useLocalImagePreview";
import type {
  ParsedTranscriptHighlightContextEntry,
  TranscriptHighlightContextSelection,
  TranscriptHighlightSourceRole,
} from "~/lib/transcriptHighlightContext";
import { formatTranscriptHighlightContextPreview } from "~/lib/transcriptHighlightContext";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { type RoomAgentLabel, roomAgentKey } from "../../rooms";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  timestampFormat: TimestampFormat;
  /** Room agents by `roomAgentKey`; null outside rooms. */
  roomAgents: ReadonlyMap<string, RoomAgentLabel> | null;
  /** Agent messages that start a new speaker's stretch and carry an author line. */
  roomAuthorLineMessageIds: ReadonlySet<MessageId>;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId | null;
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>;
  providerAuthReconnect: ProviderAuthReconnectAction | null;
  resolvedProviderAuthReconnectIds: ReadonlySet<string>;
  mcpAuthReconnectStatusByServerName: ReadonlyMap<string, McpAuthReconnectStatus>;
  failedTurnRetry: FailedTurnRetryAction | null;
  onRevertUserMessage: (messageId: MessageId) => void;
  onContinueInNewThread?: (messageId: MessageId) => void;
  /** Shows a sent message's picked element again in the preview; absent
   *  outside the desktop app. */
  onRevealPickedElement?: ((context: PickedElementContextDraft) => void) | undefined;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onPreviewFile: (request: FilePreviewRequest) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onRunProviderAuthReconnect?: (action: ProviderAuthReconnectAction) => void;
  onRunMcpAuthReconnect?: (action: McpAuthReconnectAction) => void;
  searchTargetMessageId: MessageId | null;
  searchTargetQuery: string;
  activeSearchTargetMessageId: MessageId | null;
  proposedPlanState: TimelineProposedPlanState | null;
  turnAgents: TimelineTurnAgentsState | null;
  onOpenAgentsPanel: ((agentThreadId: string | null) => void) | null;
  /** True while the working anchor at the tail is mounted. The per-agent live
   *  status rows render there and only there; a receipt keeps its compact
   *  tracker chip but must not repeat those rows above the exchange. */
  anchorOwnsLiveAgents: boolean;
}

/** The turn's spawned agents, summarized on the turn's activity row. */
export interface TimelineTurnAgentsState {
  /** Live state for the turn in flight; empty for every settled turn. */
  readonly subagents: ReadonlyArray<SubagentProgressItem>;
  /** The thread's durable agent history — the same records the agents panel
   *  lists — so a settled turn's tracker survives the turn ending and a reload. */
  readonly history?: ReadonlyArray<ThreadSubagentHistoryEntry> | undefined;
}

/** Lifecycle context for proposed-plan rows: which plan is still actionable,
 *  and the implement/navigate handlers the active card should expose. */
export interface TimelineProposedPlanState {
  readonly activePlanId: string | null;
  readonly activeThreadId: ThreadId | null;
  readonly onImplement?: (() => void) | undefined;
  readonly onImplementInNewThread?: (() => void) | undefined;
  readonly onDismiss?: (() => void) | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

interface FailedTurnRetryAction {
  readonly messageId: MessageId;
  readonly isRetrying: boolean;
  readonly onRetry: () => void;
}

interface TimelineRowActivityState {
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);
const TimelineRowActivityCtx = createContext<TimelineRowActivityState>(null!);
const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />;
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
type McpAuthReconnectStatus = "running" | "completed";
const EMPTY_MCP_AUTH_RECONNECT_STATUS: ReadonlyMap<string, McpAuthReconnectStatus> = new Map();
const INITIAL_STICK_TO_BOTTOM_FRAME_COUNT = 3;
// The on-screen keyboard resizes the layout over an animation, so the observer
// can fire while the container is still growing. Keep re-sticking a little
// longer than the mount/request paths do.
const VIEWPORT_RESIZE_STICK_TO_BOTTOM_FRAME_COUNT = 6;
const THREAD_SEARCH_TARGET_HIGHLIGHT_MS = 2_200;
const THREAD_SEARCH_TARGET_HIGHLIGHT_NAME = "threadlines-thread-search-match";
const THREAD_SEARCH_TARGET_MAX_TEXT_RANGES = 128;
const THREAD_SEARCH_TARGET_SCROLL_ATTEMPTS = 4;
const THREAD_SEARCH_TARGET_RENDER_ATTEMPTS = 60;
const THREAD_SEARCH_TARGET_VIEWPORT_MARGIN_PX = 24;
const THREAD_SEARCH_TARGET_VIEWPORT_POSITION = 0.28;
const USER_SCROLL_STICK_LOCK_MS = 450;
const TIMELINE_MAINTAIN_END_THRESHOLD_RATIO = 0.01;
const SCROLLBAR_POINTER_GUTTER_PX = 18;
const TRANSCRIPT_SELECTION_TEXT_MAX_CHARS = 8_000;
const TRANSCRIPT_SELECTION_COPY_FEEDBACK_MS = 800;
const TRANSCRIPT_NOTE_HIGHLIGHT_MAX_RECTS = 256;
const TRANSCRIPT_SELECTION_POPOVER_WIDTH_PX = 320;
const TRANSCRIPT_SELECTION_POPOVER_MARGIN_PX = 12;
const TRANSCRIPT_SELECTION_POPOVER_GAP_PX = 8;
// Room the note form needs when the popover opens below the selection; with
// less than this left under the selection, the popover flips above it.
const TRANSCRIPT_SELECTION_POPOVER_MIN_SPACE_BELOW_PX = 224;

// `top` places the popover below the selection; `bottom` places it above,
// growing upward so the note form never covers the highlighted text.
type TranscriptSelectionPopoverAnchor = { top: number } | { bottom: number };

// Timeline-container-relative rect painted over one selected line fragment
// while the note editor holds focus (native selection stops painting then).
type TranscriptNoteHighlightRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type TranscriptSelectionPopoverState = {
  sourceMessageId: MessageId;
  sourceRole: TranscriptHighlightSourceRole;
  selectedText: string;
  left: number;
  anchor: TranscriptSelectionPopoverAnchor;
  mode: "actions" | "note";
  note: string;
};

export function getTranscriptSelectionAfterTimelineScroll(
  current: TranscriptSelectionPopoverState | null,
): TranscriptSelectionPopoverState | null {
  return current?.mode === "note" ? current : null;
}

const TOUCH_SCROLL_INTENT_THRESHOLD_PX = 4;
// After a finger lifts, the browser can keep the list moving: momentum, or the
// bounce at either end. The gesture owns the scroll until that motion has been
// quiet this long, and never longer than the cap after the finger lifted.
const TOUCH_SCROLL_SETTLE_MS = 150;
const TOUCH_SCROLL_SETTLE_MAX_MS = 3_000;
const MAINTAIN_SCROLL_AT_END = { animated: false } as const;
// While the reader is above the tail, the working row never anchors: holding it
// still would push the text they are reading up as the response grows. After a
// short scroll LegendList can still count the row as on screen, because it only
// re-measures what is in view once the scroll crosses a row boundary.
const HOLD_READING_POSITION = {
  data: true,
  size: true,
  shouldRestorePosition: (row: MessagesTimelineRow) => row.kind !== "working",
};
type TimelineScrollEvent = {
  readonly nativeEvent?: {
    readonly contentOffset?: {
      readonly y?: number | null;
    };
    readonly contentSize?: {
      readonly height?: number | null;
    };
    readonly layoutMeasurement?: {
      readonly height?: number | null;
    };
    readonly contentInset?: {
      readonly bottom?: number | null;
    };
  };
};

function finiteScrollMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getTimelineScrollMetrics(event: TimelineScrollEvent) {
  const nativeEvent = event.nativeEvent;
  const viewportLength = finiteScrollMetric(nativeEvent?.layoutMeasurement?.height);
  const contentLength = finiteScrollMetric(nativeEvent?.contentSize?.height);
  if (viewportLength === null || contentLength === null) {
    return null;
  }

  return {
    scrollOffset: finiteScrollMetric(nativeEvent?.contentOffset?.y) ?? 0,
    viewportLength,
    contentLength,
    contentInsetEnd: finiteScrollMetric(nativeEvent?.contentInset?.bottom) ?? 0,
  };
}

function isTimelineScrollEventAtEnd(event: TimelineScrollEvent): boolean | null {
  const metrics = getTimelineScrollMetrics(event);
  if (metrics === null) {
    return null;
  }
  return isScrollMetricsAtEnd({
    ...metrics,
    tolerancePx: DEFAULT_SCROLL_END_TOLERANCE_PX,
  });
}

/** The list's scroll position, read from its scroll node. */
function readTimelineListMetrics(list: LegendListRef | null) {
  const scrollableNode = list?.getScrollableNode?.();
  if (!scrollableNode || typeof scrollableNode !== "object") {
    return null;
  }

  const metrics = scrollableNode as {
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

function isTimelineListAtEnd(list: LegendListRef | null): boolean {
  const metrics = readTimelineListMetrics(list);
  if (metrics === null) {
    return Boolean(list?.getState?.().isAtEnd);
  }
  return isScrollMetricsAtEnd({
    ...metrics,
    tolerancePx: DEFAULT_SCROLL_END_TOLERANCE_PX,
  });
}

/**
 * Run `stick` on each of the next `frameCount` frames and return a cancel
 * function. LegendList settles item measurements across a couple of frames
 * after content or layout changes, so a single scroll-to-end lands short.
 */
function scheduleStickToBottomFrames(frameCount: number, stick: () => void): () => void {
  const frameIds: number[] = [];
  const scheduleFrame = (remainingFrames: number) => {
    const frameId = window.requestAnimationFrame(() => {
      stick();
      if (remainingFrames > 1) {
        scheduleFrame(remainingFrames - 1);
      }
    });
    frameIds.push(frameId);
  };

  scheduleFrame(frameCount);

  return () => {
    for (const frameId of frameIds) {
      window.cancelAnimationFrame(frameId);
    }
  };
}

interface SearchHighlightRegistry {
  readonly set: (name: string, highlight: object) => void;
  readonly get: (name: string) => object | undefined;
  readonly delete: (name: string) => boolean;
}

interface SearchHighlightConstructor {
  new (...ranges: Range[]): object;
}

function findRenderedTimelineMessageRow(
  container: HTMLElement,
  messageId: MessageId,
): HTMLElement | null {
  return (
    [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find(
      (element) => element.dataset.messageId === messageId,
    ) ?? null
  );
}

function applyTimelineSearchTextHighlight(
  messageRow: HTMLElement,
  query: string,
  onHighlightApplied: () => void,
): (() => void) | null {
  const messageBody = messageRow.querySelector<HTMLElement>(
    "[data-transcript-message-body='true']",
  );
  const css = Reflect.get(globalThis, "CSS") as
    | { readonly highlights?: SearchHighlightRegistry }
    | undefined;
  const registry = css?.highlights;
  const HighlightConstructor = Reflect.get(globalThis, "Highlight") as
    | SearchHighlightConstructor
    | undefined;
  if (!messageBody || query.trim().length === 0) {
    return null;
  }
  if (!registry || !HighlightConstructor) {
    onHighlightApplied();
    return null;
  }

  let activeHighlight: object | null = null;
  let scheduledFrameId: number | null = null;
  const clearActiveHighlight = () => {
    if (activeHighlight && registry.get(THREAD_SEARCH_TARGET_HIGHLIGHT_NAME) === activeHighlight) {
      registry.delete(THREAD_SEARCH_TARGET_HIGHLIGHT_NAME);
    }
    activeHighlight = null;
  };
  const applyHighlight = () => {
    scheduledFrameId = null;
    clearActiveHighlight();

    const ranges: Range[] = [];
    const walker = document.createTreeWalker(messageBody, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        return parent?.closest(
          "button, script, style, [aria-hidden='true'], .thread-search-inline-match",
        )
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const textNode = node as Text;
      for (const span of findSearchTextHighlightSpans(textNode.data, query)) {
        const range = document.createRange();
        range.setStart(textNode, span.start);
        range.setEnd(textNode, span.end);
        ranges.push(range);
        if (ranges.length >= THREAD_SEARCH_TARGET_MAX_TEXT_RANGES) {
          break;
        }
      }
      if (ranges.length >= THREAD_SEARCH_TARGET_MAX_TEXT_RANGES) {
        break;
      }
    }
    if (ranges.length === 0) {
      onHighlightApplied();
      return;
    }

    activeHighlight = new HighlightConstructor(...ranges);
    registry.set(THREAD_SEARCH_TARGET_HIGHLIGHT_NAME, activeHighlight);
    onHighlightApplied();
  };
  const scheduleHighlight = () => {
    if (scheduledFrameId !== null) {
      return;
    }
    scheduledFrameId = window.requestAnimationFrame(applyHighlight);
  };
  const observer = new MutationObserver(scheduleHighlight);
  observer.observe(messageBody, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  applyHighlight();

  return () => {
    observer.disconnect();
    if (scheduledFrameId !== null) {
      window.cancelAnimationFrame(scheduledFrameId);
      scheduledFrameId = null;
    }
    clearActiveHighlight();
  };
}

function findFirstTimelineSearchMatchRect(messageRow: HTMLElement, query: string): DOMRect | null {
  const messageBody = messageRow.querySelector<HTMLElement>(
    "[data-transcript-message-body='true']",
  );
  if (!messageBody || query.trim().length === 0) {
    return null;
  }

  const walker = document.createTreeWalker(messageBody, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("button, script, style, [aria-hidden='true']")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const firstSpan = findSearchTextHighlightSpans(textNode.data, query)[0];
    if (!firstSpan) {
      continue;
    }
    const range = document.createRange();
    range.setStart(textNode, firstSpan.start);
    range.setEnd(textNode, firstSpan.end);
    const rects = range.getClientRects();
    for (let index = 0; index < rects.length; index += 1) {
      const rect = rects[index];
      if (rect && rect.width > 0 && rect.height > 0) {
        return rect;
      }
    }
  }
  return null;
}

function revealTimelineSearchMatch(
  list: LegendListRef | null,
  messageRow: HTMLElement,
  query: string,
): void {
  const scrollableNode = list?.getScrollableNode?.();
  const matchRect = findFirstTimelineSearchMatchRect(messageRow, query);
  if (!list || !scrollableNode || !matchRect) {
    return;
  }

  const viewportRect = scrollableNode.getBoundingClientRect();
  const safeTop = viewportRect.top + THREAD_SEARCH_TARGET_VIEWPORT_MARGIN_PX;
  const safeBottom = viewportRect.bottom - THREAD_SEARCH_TARGET_VIEWPORT_MARGIN_PX;
  if (matchRect.top >= safeTop && matchRect.bottom <= safeBottom) {
    return;
  }

  const targetTop = viewportRect.top + viewportRect.height * THREAD_SEARCH_TARGET_VIEWPORT_POSITION;
  const currentOffset = finiteScrollMetric(scrollableNode.scrollTop) ?? 0;
  void list.scrollToOffset({
    offset: Math.max(0, currentOffset + matchRect.top - targetTop),
    animated: false,
  });
}

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  emptyState?: ReactNode;
  isWorking: boolean;
  /** The turn settled but provider background work (a command, a cron) will
   *  wake it again; the anchor stays up as "Waiting" until then. */
  isWaitingOnBackgroundTasks?: boolean | undefined;
  activeStatusLabel?: string | undefined;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  stickToBottomRequestKey?: number;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  /** Room agents by `roomAgentKey`; null or absent outside rooms. */
  roomAgents?: ReadonlyMap<string, RoomAgentLabel> | null;
  onRevertUserMessage: (messageId: MessageId) => void;
  onContinueInNewThread?: (messageId: MessageId) => void;
  onRevealPickedElement?: ((context: PickedElementContextDraft) => void) | undefined;
  onAddTranscriptHighlightContext?: (selection: TranscriptHighlightContextSelection) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onPreviewFile: (request: FilePreviewRequest) => void;
  activeThreadEnvironmentId: EnvironmentId;
  /** Server thread id backing this timeline; null for views without one
   *  (drafts, previews) — the subagent transcript fetch disables itself. */
  activeThreadId?: ThreadId | null;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  providerAuthReconnect?: ProviderAuthReconnectAction | null;
  failedTurnRetry?: FailedTurnRetryAction | null;
  onRunProviderAuthReconnect?: (action: ProviderAuthReconnectAction) => void;
  mcpAuthReconnectStatusByServerName?: ReadonlyMap<string, McpAuthReconnectStatus>;
  onRunMcpAuthReconnect?: (action: McpAuthReconnectAction) => void;
  onIsAtEndChange: (isAtEnd: boolean) => void;
  searchTarget?:
    | {
        readonly messageId: MessageId;
        readonly query: string;
        readonly requestKey: string;
      }
    | null
    | undefined;
  planScrollTarget?:
    | {
        readonly planId: string;
        readonly requestKey: number;
      }
    | null
    | undefined;
  proposedPlanState?: TimelineProposedPlanState | null | undefined;
  turnAgents?: TimelineTurnAgentsState | null | undefined;
  /**
   * Opens the rail's Agents tab, optionally drilled into one agent. Passed in
   * separately from `turnAgents` on purpose: a finished agent's receipt has to
   * stay clickable after the live progress state for the turn has emptied.
   */
  onOpenAgentsPanel?: ((agentThreadId: string | null) => void) | null | undefined;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  emptyState,
  isWorking,
  isWaitingOnBackgroundTasks = false,
  activeStatusLabel,
  activeTurnInProgress,
  activeTurnId,
  activeTurnStartedAt,
  listRef,
  stickToBottomRequestKey = 0,
  timelineEntries,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  roomAgents = null,
  onRevertUserMessage,
  onContinueInNewThread,
  onRevealPickedElement,
  onAddTranscriptHighlightContext,
  isRevertingCheckpoint,
  onImageExpand,
  onPreviewFile,
  activeThreadEnvironmentId,
  activeThreadId = null,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  providerAuthReconnect = null,
  failedTurnRetry = null,
  onRunProviderAuthReconnect,
  mcpAuthReconnectStatusByServerName = EMPTY_MCP_AUTH_RECONNECT_STATUS,
  onRunMcpAuthReconnect,
  onIsAtEndChange,
  searchTarget = null,
  planScrollTarget = null,
  proposedPlanState = null,
  turnAgents = null,
  onOpenAgentsPanel = null,
}: MessagesTimelineProps) {
  const liveAgentCount = useMemo(
    () =>
      (turnAgents?.subagents ?? []).filter((item) => isActiveSubagentStatus(item.status)).length,
    [turnAgents?.subagents],
  );
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        isWorking,
        liveAgentCount,
        isWaitingOnBackgroundTasks,
        activeStatusLabel,
        activeTurnInProgress,
        activeTurnId: activeTurnId ?? null,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      isWorking,
      liveAgentCount,
      isWaitingOnBackgroundTasks,
      activeStatusLabel,
      activeTurnInProgress,
      activeTurnId,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);
  const anchorOwnsLiveAgents = rows.some((row) => row.kind === "working");
  // In a room, an agent message gets an author line when the speaker changes:
  // after the user spoke, or after a different agent.
  const roomAuthorLineMessageIds = useMemo(() => {
    const ids = new Set<MessageId>();
    if (roomAgents === null) {
      return ids;
    }
    let lastAuthor: string | null = null;
    for (const row of rows) {
      if (row.kind !== "message") continue;
      if (row.message.role === "user") {
        lastAuthor = null;
        continue;
      }
      if (row.message.role !== "assistant") continue;
      const author = roomAgentKey(row.message.participantId);
      if (author !== lastAuthor) {
        ids.add(row.message.id);
      }
      lastAuthor = author;
    }
    return ids;
  }, [roomAgents, rows]);
  const resolvedProviderAuthReconnectIds = useMemo(
    () => deriveResolvedProviderAuthReconnectIds(rows),
    [rows],
  );
  const turnDiffSummaryByTurnId = useMemo(() => {
    const next = new Map<TurnId, TurnDiffSummary>();
    for (const summary of turnDiffSummaryByAssistantMessageId.values()) {
      next.set(summary.turnId, summary);
    }
    return next;
  }, [turnDiffSummaryByAssistantMessageId]);
  const searchTargetRowIndex = useMemo(
    () =>
      searchTarget
        ? rows.findIndex(
            (row) => row.kind === "message" && row.message.id === searchTarget.messageId,
          )
        : -1,
    [rows, searchTarget],
  );
  const initialAutoStickToBottom = searchTargetRowIndex < 0;
  const [autoStickToBottom, setAutoStickToBottom] = useState(initialAutoStickToBottom);
  const autoStickToBottomRef = useRef(initialAutoStickToBottom);
  const [legendListReady, setLegendListReady] = useState(false);
  const [activeSearchTargetMessageId, setActiveSearchTargetMessageId] = useState<MessageId | null>(
    null,
  );
  const [legendListEpoch, setLegendListEpoch] = useState(0);
  const lastHandledStickToBottomRequestKeyRef = useRef(stickToBottomRequestKey);
  const previousActiveTurnInProgressRef = useRef(activeTurnInProgress);
  const userScrollLockTimerRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  // Set from touchstart until the list stops moving after the finger lifts.
  // Following never scrolls while a touch owns the list: a programmatic scroll
  // mid-glide fights the browser's own momentum and edge bounce, which iOS
  // shows as the chat jumping near the bottom.
  const touchScrollActiveRef = useRef(false);
  const [touchScrollActive, setTouchScrollActive] = useState(false);
  const touchReleasedAtRef = useRef<number | null>(null);
  const touchSettleTimerRef = useRef<number | null>(null);
  // Whether the gesture's latest move left the list at the bottom. Streamed
  // content grows the list without moving it, so this still reads true for a
  // glide that stopped at the bottom while new lines kept arriving below it.
  const touchEndedAtBottomRef = useRef(false);
  // Where the gesture last moved the list, and how long the list was then.
  const touchLastMoveRef = useRef<{ scrollOffset: number; contentLength: number } | null>(null);
  const touchLiftListenersRef = useRef<AbortController | null>(null);
  const timelineContainerRef = useRef<HTMLDivElement | null>(null);
  // The timeline's width, for guessing how tall an undrawn row is. Read on
  // first use, then kept current by the resize observer.
  const timelineWidthRef = useRef(0);
  const [transcriptSelection, setTranscriptSelection] =
    useState<TranscriptSelectionPopoverState | null>(null);
  const transcriptNoteHighlightRangeRef = useRef<Range | null>(null);
  const [transcriptNoteHighlightRects, setTranscriptNoteHighlightRects] = useState<
    TranscriptNoteHighlightRect[] | null
  >(null);

  const setAutoStickToBottomState = useCallback((next: boolean) => {
    if (autoStickToBottomRef.current === next) {
      return;
    }
    autoStickToBottomRef.current = next;
    setAutoStickToBottom(next);
  }, []);

  const getEstimatedItemSize = useCallback((row: MessagesTimelineRow) => {
    if (timelineWidthRef.current === 0) {
      timelineWidthRef.current = timelineContainerRef.current?.clientWidth || window.innerWidth;
    }
    return estimateTimelineRowHeight(row, timelineWidthRef.current);
  }, []);

  const assignLegendListRef = useCallback(
    (instance: LegendListRef | null) => {
      listRef.current = instance;
      setLegendListReady(instance !== null);
    },
    [listRef],
  );

  const clearUserScrollLockTimer = useCallback(() => {
    if (userScrollLockTimerRef.current === null) {
      return;
    }
    window.clearTimeout(userScrollLockTimerRef.current);
    userScrollLockTimerRef.current = null;
  }, []);

  useEffect(() => {
    setActiveSearchTargetMessageId(null);
    if (!searchTarget || searchTargetRowIndex < 0) {
      return;
    }

    clearUserScrollLockTimer();
    setAutoStickToBottomState(false);
    onIsAtEndChange(false);
    if (!legendListReady) {
      return;
    }
    setActiveSearchTargetMessageId(searchTarget.messageId);

    let cancelled = false;
    let highlightCleanup: (() => void) | null = null;
    let highlightTimerId: number | null = null;
    const frameIds: number[] = [];
    const stopHighlight = () => {
      highlightCleanup?.();
      highlightCleanup = null;
      setActiveSearchTargetMessageId((current) =>
        current === searchTarget.messageId ? null : current,
      );
    };
    const scheduleStopHighlight = () => {
      if (highlightTimerId === null) {
        highlightTimerId = window.setTimeout(stopHighlight, THREAD_SEARCH_TARGET_HIGHLIGHT_MS);
      }
    };
    const findAndHighlight = (remainingRenderAttempts: number, remainingScrollAttempts: number) => {
      const frameId = window.requestAnimationFrame(() => {
        if (cancelled) {
          return;
        }
        const container = timelineContainerRef.current;
        const messageRow = container
          ? findRenderedTimelineMessageRow(container, searchTarget.messageId)
          : null;
        if (!messageRow && remainingRenderAttempts > 1) {
          findAndHighlight(remainingRenderAttempts - 1, remainingScrollAttempts);
          return;
        }
        if (!messageRow && remainingScrollAttempts > 1) {
          scrollToTarget(remainingScrollAttempts - 1);
          return;
        }
        if (messageRow) {
          highlightCleanup = applyTimelineSearchTextHighlight(
            messageRow,
            searchTarget.query,
            () => {
              revealTimelineSearchMatch(listRef.current, messageRow, searchTarget.query);
            },
          );
        }
        scheduleStopHighlight();
      });
      frameIds.push(frameId);
    };

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    function scrollToTarget(remainingScrollAttempts: number): void {
      const frameId = window.requestAnimationFrame(() => {
        if (cancelled) {
          return;
        }
        const currentList = listRef.current;
        if (!currentList) {
          if (remainingScrollAttempts > 1) {
            scrollToTarget(remainingScrollAttempts - 1);
          } else {
            scheduleStopHighlight();
          }
          return;
        }
        void currentList
          .scrollToIndex({
            index: searchTargetRowIndex,
            animated: !prefersReducedMotion,
            viewPosition: 0.35,
          })
          .then(
            () => {
              if (!cancelled) {
                findAndHighlight(THREAD_SEARCH_TARGET_RENDER_ATTEMPTS, remainingScrollAttempts);
              }
            },
            () => {
              if (!cancelled && remainingScrollAttempts > 1) {
                scrollToTarget(remainingScrollAttempts - 1);
              } else if (!cancelled) {
                scheduleStopHighlight();
              }
            },
          );
      });
      frameIds.push(frameId);
    }
    scrollToTarget(THREAD_SEARCH_TARGET_SCROLL_ATTEMPTS);

    return () => {
      cancelled = true;
      for (const frameId of frameIds) {
        window.cancelAnimationFrame(frameId);
      }
      if (highlightTimerId !== null) {
        window.clearTimeout(highlightTimerId);
      }
      highlightCleanup?.();
    };
  }, [
    clearUserScrollLockTimer,
    legendListReady,
    listRef,
    onIsAtEndChange,
    searchTarget,
    searchTargetRowIndex,
    setAutoStickToBottomState,
  ]);

  const planScrollTargetRowIndex = useMemo(
    () =>
      planScrollTarget
        ? rows.findIndex(
            (row) =>
              row.kind === "proposed-plan" && row.proposedPlan.id === planScrollTarget.planId,
          )
        : -1,
    [planScrollTarget, rows],
  );

  useEffect(() => {
    if (!planScrollTarget || planScrollTargetRowIndex < 0 || !legendListReady) {
      return;
    }
    clearUserScrollLockTimer();
    setAutoStickToBottomState(false);
    onIsAtEndChange(false);
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    void listRef.current?.scrollToIndex({
      index: planScrollTargetRowIndex,
      animated: !prefersReducedMotion,
      viewPosition: 0.2,
    });
  }, [
    clearUserScrollLockTimer,
    legendListReady,
    listRef,
    onIsAtEndChange,
    planScrollTarget,
    planScrollTargetRowIndex,
    setAutoStickToBottomState,
  ]);

  const stickToBottomNow = useCallback(() => {
    clearUserScrollLockTimer();
    setAutoStickToBottomState(true);
    onIsAtEndChange(true);
    void listRef.current?.scrollToEnd?.({ animated: false });
  }, [clearUserScrollLockTimer, listRef, onIsAtEndChange, setAutoStickToBottomState]);

  const enableAutoStickIfAtEnd = useCallback(() => {
    // A touch owns the list until it comes to rest: a finger that pauses is
    // still mid-gesture, and a glide that passes the bottom is still moving.
    // Re-arming then would yank the list under the touch; `settleTouchScroll`
    // re-checks once the list is still.
    if (
      touchStartYRef.current !== null ||
      touchScrollActiveRef.current ||
      !isTimelineListAtEnd(listRef.current)
    ) {
      return;
    }
    setAutoStickToBottomState(true);
    onIsAtEndChange(true);
  }, [listRef, onIsAtEndChange, setAutoStickToBottomState]);

  const scheduleStickReArmCheck = useCallback(() => {
    clearUserScrollLockTimer();
    userScrollLockTimerRef.current = window.setTimeout(() => {
      userScrollLockTimerRef.current = null;
      enableAutoStickIfAtEnd();
    }, USER_SCROLL_STICK_LOCK_MS);
  }, [clearUserScrollLockTimer, enableAutoStickIfAtEnd]);

  const clearTouchSettleTimer = useCallback(() => {
    if (touchSettleTimerRef.current === null) {
      return;
    }
    window.clearTimeout(touchSettleTimerRef.current);
    touchSettleTimerRef.current = null;
  }, []);

  const settleTouchScroll = useCallback(() => {
    clearTouchSettleTimer();
    touchReleasedAtRef.current = null;
    if (!touchScrollActiveRef.current) {
      return;
    }
    touchScrollActiveRef.current = false;
    setTouchScrollActive(false);
    // A gesture that ends at the bottom follows again, and catches up with
    // whatever streamed in while it held the list.
    if (autoStickToBottomRef.current || touchEndedAtBottomRef.current) {
      stickToBottomNow();
    }
  }, [clearTouchSettleTimer, stickToBottomNow]);

  // Called when the finger lifts and on every scroll after it, so the gesture
  // settles once the glide has been quiet for a moment.
  const scheduleTouchScrollSettle = useCallback(() => {
    const releasedAt = touchReleasedAtRef.current;
    if (releasedAt === null) {
      return;
    }
    clearTouchSettleTimer();
    const untilCap = releasedAt + TOUCH_SCROLL_SETTLE_MAX_MS - performance.now();
    touchSettleTimerRef.current = window.setTimeout(
      settleTouchScroll,
      Math.max(0, Math.min(TOUCH_SCROLL_SETTLE_MS, untilCap)),
    );
  }, [clearTouchSettleTimer, settleTouchScroll]);

  const markUserScrollIntent = useCallback(
    (options?: { notifyAwayFromEnd?: boolean }) => {
      setAutoStickToBottomState(false);
      if (options?.notifyAwayFromEnd) {
        onIsAtEndChange(false);
      }
      scheduleStickReArmCheck();
    },
    [onIsAtEndChange, scheduleStickReArmCheck, setAutoStickToBottomState],
  );

  const stickToBottomRequestPending =
    stickToBottomRequestKey !== lastHandledStickToBottomRequestKeyRef.current;

  const refreshTranscriptNoteHighlightRects = useCallback(() => {
    const range = transcriptNoteHighlightRangeRef.current;
    const container = timelineContainerRef.current;
    if (!range || !container) {
      return;
    }
    setTranscriptNoteHighlightRects(computeTranscriptNoteHighlightRects(range, container));
  }, []);

  const handleScroll = useCallback(
    (event: TimelineScrollEvent) => {
      setTranscriptSelection(getTranscriptSelectionAfterTimelineScroll);
      refreshTranscriptNoteHighlightRects();
      scheduleTouchScrollSettle();
      const eventAtEnd = isTimelineScrollEventAtEnd(event);
      const nextIsAtEnd =
        eventAtEnd !== null ? eventAtEnd : Boolean(listRef.current?.getState?.().isAtEnd);
      // Only a report that moved the list speaks for the gesture. The list
      // repeats reports, and sends them up to a frame late, measured after any
      // lines that streamed in meanwhile, so reaching the end of the list as
      // long as it was at the gesture's previous move counts as the bottom.
      const metrics = getTimelineScrollMetrics(event);
      const lastMove = touchLastMoveRef.current;
      if (
        touchScrollActiveRef.current &&
        metrics !== null &&
        (lastMove === null || Math.abs(metrics.scrollOffset - lastMove.scrollOffset) >= 1)
      ) {
        touchEndedAtBottomRef.current = isScrollMetricsAtEnd({
          ...metrics,
          contentLength: Math.min(metrics.contentLength, lastMove?.contentLength ?? Infinity),
          tolerancePx: DEFAULT_SCROLL_END_TOLERANCE_PX,
        });
        touchLastMoveRef.current = metrics;
      }
      if (!nextIsAtEnd && (autoStickToBottomRef.current || stickToBottomRequestPending)) {
        onIsAtEndChange(true);
        return;
      }
      // Only re-arm from a scroll event once the user-scroll lock has expired.
      // A touch drag clears the intent threshold (a few px) long before it
      // clears the at-end tolerance (24px), so re-arming here would stick the
      // list back to the bottom under the moving finger, report at-end on the
      // next frame, and stick again — the list flickers instead of scrolling.
      // Pointer devices never hit this because one wheel notch clears the
      // tolerance outright. The lock timer re-checks once scrolling settles,
      // and a touch re-checks once its glide comes to rest.
      if (nextIsAtEnd && userScrollLockTimerRef.current === null && !touchScrollActiveRef.current) {
        setAutoStickToBottomState(true);
      }
      onIsAtEndChange(nextIsAtEnd);
    },
    [
      listRef,
      onIsAtEndChange,
      refreshTranscriptNoteHighlightRects,
      scheduleTouchScrollSettle,
      setAutoStickToBottomState,
      stickToBottomRequestPending,
    ],
  );

  const refreshTranscriptSelectionPopover = useCallback(() => {
    if (!onAddTranscriptHighlightContext) {
      setTranscriptSelection(null);
      return;
    }
    const nextSelection = readTranscriptSelectionPopoverState(timelineContainerRef.current);
    setTranscriptSelection(nextSelection);
  }, [onAddTranscriptHighlightContext]);

  const handleTranscriptSelectionEnd = useCallback(
    (event: ReactSyntheticEvent<HTMLElement>) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-transcript-selection-popover='true']")
      ) {
        return;
      }
      window.requestAnimationFrame(refreshTranscriptSelectionPopover);
    },
    [refreshTranscriptSelectionPopover],
  );

  const updateTranscriptSelectionNote = useCallback((note: string) => {
    setTranscriptSelection((current) => (current ? { ...current, note } : current));
  }, []);

  const openTranscriptSelectionNote = useCallback(() => {
    const selection = window.getSelection();
    const container = timelineContainerRef.current;
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed && container) {
      const range = selection.getRangeAt(0).cloneRange();
      transcriptNoteHighlightRangeRef.current = range;
      setTranscriptNoteHighlightRects(computeTranscriptNoteHighlightRects(range, container));
    }
    setTranscriptSelection((current) => (current ? { ...current, mode: "note" } : current));
  }, []);

  const transcriptNoteHighlightActive = transcriptSelection?.mode === "note";
  useEffect(() => {
    if (!transcriptNoteHighlightActive) {
      return;
    }
    return () => {
      transcriptNoteHighlightRangeRef.current = null;
      setTranscriptNoteHighlightRects(null);
    };
  }, [transcriptNoteHighlightActive]);

  const dismissTranscriptSelection = useCallback(() => {
    setTranscriptSelection(null);
  }, []);

  const submitTranscriptSelectionNote = useCallback(() => {
    if (!transcriptSelection || !onAddTranscriptHighlightContext) {
      return;
    }
    const note = transcriptSelection.note.trim();
    if (note.length === 0) {
      return;
    }
    onAddTranscriptHighlightContext({
      sourceMessageId: transcriptSelection.sourceMessageId,
      sourceRole: transcriptSelection.sourceRole,
      selectedText: transcriptSelection.selectedText,
      note,
    });
    window.getSelection()?.removeAllRanges();
    setTranscriptSelection(null);
  }, [onAddTranscriptHighlightContext, transcriptSelection]);

  const handleWheelCapture = useCallback(
    (event: ReactWheelEvent) => {
      if (event.deltaY < 0 && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) {
        markUserScrollIntent({ notifyAwayFromEnd: true });
      }
    },
    [markUserScrollIntent],
  );

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent) => {
      const targetBounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX >= targetBounds.right - SCROLLBAR_POINTER_GUTTER_PX) {
        markUserScrollIntent();
      }
    },
    [markUserScrollIntent],
  );

  const releaseTouch = useCallback(
    (remainingTouches: number) => {
      if (remainingTouches > 0 || touchStartYRef.current === null) {
        return;
      }
      touchStartYRef.current = null;
      touchReleasedAtRef.current = performance.now();
      scheduleTouchScrollSettle();
      if (!autoStickToBottomRef.current) {
        scheduleStickReArmCheck();
      }
    },
    [scheduleStickReArmCheck, scheduleTouchScrollSettle],
  );

  const handleTouchStartCapture = useCallback(
    (event: ReactTouchEvent) => {
      touchStartYRef.current = event.touches[0]?.clientY ?? null;
      touchReleasedAtRef.current = null;
      touchEndedAtBottomRef.current = isTimelineListAtEnd(listRef.current);
      touchLastMoveRef.current = readTimelineListMetrics(listRef.current);
      clearTouchSettleTimer();
      if (!touchScrollActiveRef.current) {
        touchScrollActiveRef.current = true;
        setTouchScrollActive(true);
      }
      // A touch keeps targeting the element it started on. If a streamed
      // update replaces that element mid-gesture, its touchend no longer
      // reaches the list, so also hear the lift on the target itself.
      touchLiftListenersRef.current?.abort();
      const target = event.nativeEvent.target;
      if (target instanceof Node) {
        const listeners = new AbortController();
        touchLiftListenersRef.current = listeners;
        const onLift = (lift: Event) => {
          listeners.abort();
          releaseTouch((lift as TouchEvent).touches.length);
        };
        const options = { passive: true, signal: listeners.signal };
        target.addEventListener("touchend", onLift, options);
        target.addEventListener("touchcancel", onLift, options);
      }
    },
    [clearTouchSettleTimer, listRef, releaseTouch],
  );

  const handleTouchMoveCapture = useCallback(
    (event: ReactTouchEvent) => {
      const touchStartY = touchStartYRef.current;
      const currentY = event.touches[0]?.clientY;
      if (touchStartY === null || currentY === undefined) {
        return;
      }
      if (currentY - touchStartY > TOUCH_SCROLL_INTENT_THRESHOLD_PX) {
        markUserScrollIntent({ notifyAwayFromEnd: true });
      }
    },
    [markUserScrollIntent],
  );

  const handleTouchEndCapture = useCallback(
    (event: ReactTouchEvent) => {
      releaseTouch(event.touches.length);
    },
    [releaseTouch],
  );

  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent) => {
      if (
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey)
      ) {
        markUserScrollIntent({ notifyAwayFromEnd: true });
      }
    },
    [markUserScrollIntent],
  );

  const hasRows = rows.length > 0;

  // LegendList can retain the live tail's old total size when the working row
  // disappears, leaving scrollable space below the settled response. Reset its
  // layout only for a pinned active-to-settled transition; a reader who has
  // scrolled up keeps the current list and position.
  useEffect(() => {
    const wasActiveTurnInProgress = previousActiveTurnInProgressRef.current;
    previousActiveTurnInProgressRef.current = activeTurnInProgress;
    if (!wasActiveTurnInProgress || activeTurnInProgress || !hasRows || searchTargetRowIndex >= 0) {
      return;
    }
    if (!autoStickToBottomRef.current && !isTimelineListAtEnd(listRef.current)) {
      return;
    }

    clearUserScrollLockTimer();
    setAutoStickToBottomState(true);
    onIsAtEndChange(true);
    setLegendListEpoch((epoch) => epoch + 1);
  }, [
    activeTurnInProgress,
    clearUserScrollLockTimer,
    hasRows,
    listRef,
    onIsAtEndChange,
    searchTargetRowIndex,
    setAutoStickToBottomState,
  ]);

  useEffect(() => {
    if (!legendListReady || !hasRows || searchTargetRowIndex >= 0) {
      return;
    }

    return scheduleStickToBottomFrames(INITIAL_STICK_TO_BOTTOM_FRAME_COUNT, stickToBottomNow);
  }, [
    hasRows,
    legendListEpoch,
    legendListReady,
    routeThreadKey,
    searchTargetRowIndex,
    stickToBottomNow,
  ]);

  useEffect(() => {
    if (!hasRows || stickToBottomRequestKey === lastHandledStickToBottomRequestKeyRef.current) {
      return;
    }

    lastHandledStickToBottomRequestKeyRef.current = stickToBottomRequestKey;

    return scheduleStickToBottomFrames(INITIAL_STICK_TO_BOTTOM_FRAME_COUNT, stickToBottomNow);
  }, [hasRows, stickToBottomNow, stickToBottomRequestKey]);

  // A mobile send blurs the composer, and the on-screen keyboard closing
  // resizes the timeline long after the send-time stick frames have run.
  // LegendList restores its anchored offset across that resize, which parks a
  // pinned thread slightly above the message that was just sent. Re-stick on
  // any viewport change while sticking is armed — this also covers rotation,
  // drawer toggles and a growing composer.
  useEffect(() => {
    const container = timelineContainerRef.current;
    if (!container || !legendListReady) {
      return;
    }

    let cancelStickFrames: (() => void) | null = null;
    const restickIfArmed = () => {
      // Mobile browsers collapse and expand the URL bar as the user scrolls,
      // which resizes the visual viewport mid-gesture. Never re-stick while a
      // touch owns the list; `settleTouchScroll` catches up once it is still.
      if (
        !autoStickToBottomRef.current ||
        touchStartYRef.current !== null ||
        touchScrollActiveRef.current
      ) {
        return;
      }
      cancelStickFrames?.();
      cancelStickFrames = scheduleStickToBottomFrames(
        VIEWPORT_RESIZE_STICK_TO_BOTTOM_FRAME_COUNT,
        stickToBottomNow,
      );
    };

    // Browsers that resize the layout for the keyboard (Android Chrome, via
    // `interactive-widget=resizes-content`) change the container's box…
    let lastHeight = container.getBoundingClientRect().height;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const rect = container.getBoundingClientRect();
            timelineWidthRef.current = rect.width;
            const nextHeight = rect.height;
            if (Math.abs(nextHeight - lastHeight) < 1) {
              return;
            }
            lastHeight = nextHeight;
            restickIfArmed();
          });
    resizeObserver?.observe(container);

    // …while browsers that overlay it (iOS Safari) leave the layout alone and
    // only shrink the visual viewport. Pinch zoom resizes it too, so ignore
    // anything that isn't at a 1:1 scale.
    const viewport = window.visualViewport;
    const handleVisualViewportResize = () => {
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) {
        return;
      }
      restickIfArmed();
    };
    viewport?.addEventListener("resize", handleVisualViewportResize);

    return () => {
      resizeObserver?.disconnect();
      viewport?.removeEventListener("resize", handleVisualViewportResize);
      cancelStickFrames?.();
    };
  }, [legendListReady, stickToBottomNow]);

  useEffect(() => {
    // Following never moves the list while a touch owns it (the finger, then
    // its glide): the scroll would fight the gesture. `settleTouchScroll`
    // catches up once the list is still.
    const shouldFollow = () =>
      stickToBottomRequestPending ||
      (autoStickToBottomRef.current &&
        touchStartYRef.current === null &&
        !touchScrollActiveRef.current);
    if (!hasRows || !shouldFollow()) {
      return;
    }

    // Rows above the visual tail can change height both while a turn is live
    // and just after it settles (completion metadata, receipts, late measured
    // markdown). LegendList settles those measurements across a few frames, so
    // keep the pinned tail aligned throughout that window.
    return scheduleStickToBottomFrames(INITIAL_STICK_TO_BOTTOM_FRAME_COUNT, () => {
      if (!shouldFollow()) {
        return;
      }
      void listRef.current?.scrollToEnd?.({ animated: false });
    });
  }, [hasRows, listRef, rows, stickToBottomRequestPending]);

  useEffect(() => {
    return () => {
      clearUserScrollLockTimer();
      clearTouchSettleTimer();
      touchLiftListenersRef.current?.abort();
    };
  }, [clearTouchSettleTimer, clearUserScrollLockTimer]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      roomAgents,
      roomAuthorLineMessageIds,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      activeThreadId,
      turnDiffSummaryByTurnId,
      providerAuthReconnect,
      resolvedProviderAuthReconnectIds,
      mcpAuthReconnectStatusByServerName,
      failedTurnRetry,
      onRevertUserMessage,
      ...(onContinueInNewThread ? { onContinueInNewThread } : {}),
      ...(onRevealPickedElement ? { onRevealPickedElement } : {}),
      onImageExpand,
      onPreviewFile,
      onOpenTurnDiff,
      ...(onRunProviderAuthReconnect ? { onRunProviderAuthReconnect } : {}),
      ...(onRunMcpAuthReconnect ? { onRunMcpAuthReconnect } : {}),
      searchTargetMessageId: searchTarget?.messageId ?? null,
      searchTargetQuery: searchTarget?.query ?? "",
      activeSearchTargetMessageId,
      proposedPlanState,
      turnAgents,
      onOpenAgentsPanel,
      anchorOwnsLiveAgents,
    }),
    [
      timestampFormat,
      roomAgents,
      roomAuthorLineMessageIds,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      activeThreadId,
      turnDiffSummaryByTurnId,
      providerAuthReconnect,
      resolvedProviderAuthReconnectIds,
      mcpAuthReconnectStatusByServerName,
      failedTurnRetry,
      onRevertUserMessage,
      onContinueInNewThread,
      onRevealPickedElement,
      onImageExpand,
      onPreviewFile,
      onOpenTurnDiff,
      onRunProviderAuthReconnect,
      onRunMcpAuthReconnect,
      searchTarget?.messageId,
      searchTarget?.query,
      activeSearchTargetMessageId,
      proposedPlanState,
      turnAgents,
      onOpenAgentsPanel,
      anchorOwnsLiveAgents,
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isRevertingCheckpoint,
    }),
    [isRevertingCheckpoint, isWorking],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  // Each row paints its own piece of its turn's work tray, in the window
  // frame's color, edge to edge of the column; the column keeps the rows'
  // content in from those edges. The list clips every row to its own box, so
  // the tray cannot be one element behind several rows.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div
        className={cn(
          "mx-auto w-full min-w-0 max-w-4xl overflow-x-clip px-2 transition-colors duration-300",
          item.tray && "bg-[var(--app-chrome-background)]",
          item.tray && TRAY_CORNERS[item.tray],
        )}
        data-timeline-root="true"
        data-tray={item.tray ?? undefined}
      >
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    if (emptyState) {
      return (
        <div className="h-full overflow-x-hidden overflow-y-auto overscroll-y-contain">
          <div className="flex min-h-full flex-col items-center justify-center px-4 py-8">
            {emptyState}
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <div
          ref={timelineContainerRef}
          className="relative h-full"
          onMouseUpCapture={handleTranscriptSelectionEnd}
          onKeyUpCapture={handleTranscriptSelectionEnd}
        >
          <LegendList<MessagesTimelineRow>
            key={`${routeThreadKey}:${legendListEpoch}`}
            ref={assignLegendListRef}
            data={rows}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            estimatedItemSize={90}
            getEstimatedItemSize={getEstimatedItemSize}
            initialScrollAtEnd={searchTargetRowIndex < 0}
            {...(searchTargetRowIndex >= 0
              ? { initialScrollIndex: { index: searchTargetRowIndex, viewPosition: 0.35 } }
              : {})}
            maintainScrollAtEnd={
              searchTargetRowIndex < 0 &&
              ((autoStickToBottom && !touchScrollActive) || stickToBottomRequestPending)
                ? MAINTAIN_SCROLL_AT_END
                : false
            }
            maintainScrollAtEndThreshold={TIMELINE_MAINTAIN_END_THRESHOLD_RATIO}
            // Anchoring and bottom-following both adjust for streamed line wraps.
            // Use anchoring only while reading above the tail to avoid overshoot.
            maintainVisibleContentPosition={
              !autoStickToBottom && !stickToBottomRequestPending ? HOLD_READING_POSITION : false
            }
            onScroll={handleScroll}
            onWheelCapture={handleWheelCapture}
            onPointerDownCapture={handlePointerDownCapture}
            onTouchStartCapture={handleTouchStartCapture}
            onTouchMoveCapture={handleTouchMoveCapture}
            onTouchEndCapture={handleTouchEndCapture}
            onTouchCancelCapture={handleTouchEndCapture}
            onKeyDownCapture={handleKeyDownCapture}
            data-chat-messages-list="true"
            className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5 [scrollbar-gutter:stable_both-edges]"
            ListHeaderComponent={TIMELINE_LIST_HEADER}
            ListFooterComponent={TIMELINE_LIST_FOOTER}
          />
          {/* Dissolve rows into the background at the viewport's bottom edge so
              scrolled-under content fades out instead of hard-clipping right
              above the composer. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-linear-to-t from-background to-transparent"
          />
          {transcriptNoteHighlightRects && transcriptNoteHighlightRects.length > 0 ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden"
            >
              {transcriptNoteHighlightRects.map((rect) => (
                <div
                  key={`${rect.top}:${rect.left}:${rect.width}`}
                  className="transcript-note-highlight absolute"
                  style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                />
              ))}
            </div>
          ) : null}
          {transcriptSelection && onAddTranscriptHighlightContext ? (
            <TranscriptSelectionPopover
              state={transcriptSelection}
              onCopyDismiss={dismissTranscriptSelection}
              onOpenNote={openTranscriptSelectionNote}
              onNoteChange={updateTranscriptSelectionNote}
              onSubmitNote={submitTranscriptSelectionNote}
              onCancel={dismissTranscriptSelection}
            />
          ) : null}
        </div>
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
});

function TranscriptSelectionPopover({
  state,
  onCopyDismiss,
  onOpenNote,
  onNoteChange,
  onSubmitNote,
  onCancel,
}: {
  state: TranscriptSelectionPopoverState;
  onCopyDismiss: () => void;
  onOpenNote: () => void;
  onNoteChange: (note: string) => void;
  onSubmitNote: () => void;
  onCancel: () => void;
}) {
  const noteInputRef = useRef<HTMLTextAreaElement | null>(null);
  // timeout: 0 keeps the checkmark painted until the delayed dismiss unmounts
  // the popover, so it never flips back to the copy icon mid-animation.
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 0 });
  const noteIsEmpty = state.note.trim().length === 0;

  useEffect(() => {
    if (!isCopied) {
      return;
    }
    const timeoutId = window.setTimeout(onCopyDismiss, TRANSCRIPT_SELECTION_COPY_FEEDBACK_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isCopied, onCopyDismiss]);

  useEffect(() => {
    if (state.mode !== "note") {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      noteInputRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [state.mode]);

  return (
    <div
      className="absolute z-40"
      style={{ left: state.left, width: TRANSCRIPT_SELECTION_POPOVER_WIDTH_PX, ...state.anchor }}
      data-transcript-selection-popover="true"
      onMouseDown={(event) => {
        if (state.mode === "actions") {
          event.preventDefault();
        }
        event.stopPropagation();
      }}
    >
      {state.mode === "actions" ? (
        <div className="inline-flex items-center gap-1 rounded-lg border border-border/75 bg-popover/96 px-1.5 py-1 text-popover-foreground shadow-lg shadow-black/10 backdrop-blur">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Copy selected text"
                  onClick={() => copyToClipboard(state.selectedText, undefined)}
                />
              }
            >
              {isCopied ? (
                <CheckIcon className="copy-check-pop size-3 text-success" />
              ) : (
                <CopyIcon className="size-3" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">Copy selected text</TooltipPopup>
          </Tooltip>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onOpenNote}
            className="h-6 px-2 text-xs"
          >
            <SquarePenIcon className="size-3" />
            Add note
          </Button>
        </div>
      ) : (
        <form
          className="rounded-lg border border-border/75 bg-popover/96 p-2 text-popover-foreground shadow-lg shadow-black/10 backdrop-blur"
          onSubmit={(event) => handleTranscriptHighlightNoteFormSubmit(event, onSubmitNote)}
        >
          <p className="mb-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
            {state.selectedText}
          </p>
          <Textarea
            ref={noteInputRef}
            size="sm"
            value={state.note}
            onChange={(event) => onNoteChange(event.currentTarget.value)}
            placeholder="Add context for this highlight"
            className="text-xs"
            onKeyDown={(event) =>
              handleTranscriptHighlightNoteKeyDown(event, {
                onSubmit: onSubmitNote,
                onCancel,
              })
            }
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={noteIsEmpty}>
              Add
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function readTranscriptSelectionPopoverState(
  container: HTMLDivElement | null,
): TranscriptSelectionPopoverState | null {
  if (!container || typeof window === "undefined") {
    return null;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const selectedText = selection.toString().trim();
  if (selectedText.length === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const startBody = findTranscriptMessageBody(range.startContainer);
  const endBody = findTranscriptMessageBody(range.endContainer);
  if (!startBody || startBody !== endBody) {
    return null;
  }
  if (startBody.dataset.transcriptMessageStreaming === "true") {
    return null;
  }
  const sourceMessageId = startBody.dataset.transcriptMessageId;
  const sourceRole = startBody.dataset.transcriptMessageRole;
  if (!sourceMessageId || (sourceRole !== "assistant" && sourceRole !== "user")) {
    return null;
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }
  const containerRect = container.getBoundingClientRect();
  const unclampedLeft =
    rect.left - containerRect.left + rect.width / 2 - TRANSCRIPT_SELECTION_POPOVER_WIDTH_PX / 2;
  const maxLeft = Math.max(
    TRANSCRIPT_SELECTION_POPOVER_MARGIN_PX,
    containerRect.width -
      TRANSCRIPT_SELECTION_POPOVER_WIDTH_PX -
      TRANSCRIPT_SELECTION_POPOVER_MARGIN_PX,
  );
  const left = Math.min(Math.max(TRANSCRIPT_SELECTION_POPOVER_MARGIN_PX, unclampedLeft), maxLeft);
  const selectionTop = rect.top - containerRect.top;
  const selectionBottom = rect.bottom - containerRect.top;
  const spaceBelow = containerRect.height - selectionBottom;
  const anchor: TranscriptSelectionPopoverAnchor =
    spaceBelow >= TRANSCRIPT_SELECTION_POPOVER_MIN_SPACE_BELOW_PX
      ? {
          top: Math.max(
            TRANSCRIPT_SELECTION_POPOVER_MARGIN_PX,
            selectionBottom + TRANSCRIPT_SELECTION_POPOVER_GAP_PX,
          ),
        }
      : {
          bottom: Math.max(
            TRANSCRIPT_SELECTION_POPOVER_MARGIN_PX,
            containerRect.height - selectionTop + TRANSCRIPT_SELECTION_POPOVER_GAP_PX,
          ),
        };

  return {
    sourceMessageId: sourceMessageId as MessageId,
    sourceRole,
    selectedText:
      selectedText.length > TRANSCRIPT_SELECTION_TEXT_MAX_CHARS
        ? selectedText.slice(0, TRANSCRIPT_SELECTION_TEXT_MAX_CHARS)
        : selectedText,
    left,
    anchor,
    mode: "actions",
    note: "",
  };
}

// The native selection stops painting once the note textarea takes focus, so
// the selected range is re-painted as overlay rects while the note is open.
// CSS ::highlight() can't be used here: Chromium paints custom highlights at
// the font's ascent/descent height while native selection fills the whole
// line box, so the two visibly disagree. Expanding each text fragment's rect
// to its element's line-height reproduces the native selection geometry.
function collectRangeTextNodes(range: Range): Text[] {
  const root = range.commonAncestorContainer;
  if (root instanceof Text) {
    return [root];
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text);
  }
  return nodes;
}

function computeTranscriptNoteHighlightRects(
  range: Range,
  container: HTMLElement,
): TranscriptNoteHighlightRect[] {
  const containerRect = container.getBoundingClientRect();
  const rects: TranscriptNoteHighlightRect[] = [];
  for (const textNode of collectRangeTextNodes(range)) {
    const nodeRange = document.createRange();
    nodeRange.selectNodeContents(textNode);
    if (textNode === range.startContainer) {
      nodeRange.setStart(textNode, range.startOffset);
    }
    if (textNode === range.endContainer) {
      nodeRange.setEnd(textNode, range.endOffset);
    }
    const lineHeight = textNode.parentElement
      ? Number.parseFloat(window.getComputedStyle(textNode.parentElement).lineHeight)
      : Number.NaN;
    const fragmentRects = nodeRange.getClientRects();
    for (let index = 0; index < fragmentRects.length; index += 1) {
      const rect = fragmentRects[index];
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        continue;
      }
      const expansion =
        Number.isFinite(lineHeight) && lineHeight > rect.height
          ? (lineHeight - rect.height) / 2
          : 0;
      rects.push({
        left: rect.left - containerRect.left,
        top: rect.top - containerRect.top - expansion,
        width: rect.width,
        height: rect.height + expansion * 2,
      });
      if (rects.length >= TRANSCRIPT_NOTE_HIGHLIGHT_MAX_RECTS) {
        return rects;
      }
    }
  }
  return rects;
}

function findTranscriptMessageBody(node: Node): HTMLElement | null {
  const element = node instanceof Element ? node : node.parentNode;
  if (!(element instanceof Element)) {
    return null;
  }
  return element?.closest<HTMLElement>("[data-transcript-message-body='true']") ?? null;
}

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function isResolvedProviderAuthRecoverySignal(row: MessagesTimelineRow): boolean {
  if (row.kind !== "message" || row.message.role !== "assistant" || row.message.streaming) {
    return false;
  }
  const text = row.message.text.trim();
  return Boolean(text && !isProviderAuthErrorMessage(text));
}

function deriveResolvedProviderAuthReconnectIds(
  rows: ReadonlyArray<MessagesTimelineRow>,
): ReadonlySet<string> {
  const resolvedIds = new Set<string>();
  let hasLaterAssistantSuccess = false;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) {
      continue;
    }

    if (isResolvedProviderAuthRecoverySignal(row)) {
      hasLaterAssistantSuccess = true;
      continue;
    }

    if (!hasLaterAssistantSuccess) {
      continue;
    }

    if (row.kind === "message" && row.message.role === "assistant") {
      const text = row.message.text.trim();
      if (isProviderAuthErrorMessage(text)) {
        resolvedIds.add(row.id);
      }
      continue;
    }

    if (row.kind === "work") {
      for (const entry of row.groupedEntries) {
        if (entry.authReconnect) {
          resolvedIds.add(entry.id);
        }
      }
    }
  }

  return resolvedIds;
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;
type TimelineImagePreviewItem = {
  id: string;
  name: string;
  previewUrl?: string;
  /** Set instead of `previewUrl` when the provider only named the file; the
   *  grid loads it over the workspace RPC. */
  path?: string;
};

/**
 * Room below a row. A note sits right on top of its steps. The agent's work
 * leaves half a gap inside its tray and the row after it adds the other half,
 * so the tray's edge falls in the middle of the gap. Your messages and plans
 * keep a full gap on the page.
 */
function rowBottomPadding(row: TimelineRow): string {
  switch (row.kind) {
    case "message":
      if (row.message.role !== "assistant") {
        return "pb-4";
      }
      return row.turnSummary === null ? "pb-1" : "pb-2";
    case "work":
    case "subagent-result":
    case "working":
      return "pb-2";
    default:
      return "pb-4";
  }
}

const TRAY_CORNERS = {
  single: "rounded-xl",
  first: "rounded-t-xl",
  middle: "",
  last: "rounded-b-xl",
} as const satisfies Record<TrayPlacement, string>;

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const ctx = use(TimelineRowCtx);
  const isActiveSearchTarget =
    row.kind === "message" && row.message.id === ctx.activeSearchTargetMessageId;
  return (
    <div
      // A row whose section renders nothing (e.g. an all-anchor work group
      // with no resolvable tracker) must not leave a phantom padded gap.
      className={cn(
        rowBottomPadding(row),
        row.padTop && "pt-2",
        "[&:not(:has(*))]:p-0",
        isActiveSearchTarget && "thread-search-target-pulse",
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
      data-thread-search-target={isActiveSearchTarget ? "true" : undefined}
    >
      {row.kind === "work" ? <WorkGroupSection row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "fork-context" ? <ForkContextTimelineRow row={row} /> : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "subagent-result" ? <SubagentReceiptTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
    </div>
  );
});

function ForkContextTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "fork-context" }> }) {
  const ctx = use(TimelineRowCtx);
  const payload = row.forkContext.payload;
  const isNativeFork = row.forkContext.seedMode === "provider-native";
  const sourceRole = payload.sourceMessageRole === "assistant" ? "assistant" : "user";
  const contextCounts = [
    `${payload.includedMessageCount} message${payload.includedMessageCount === 1 ? "" : "s"}`,
    payload.includedToolSummaryCount > 0
      ? `${payload.includedToolSummaryCount} tool summar${
          payload.includedToolSummaryCount === 1 ? "y" : "ies"
        }`
      : null,
    payload.includedAttachmentCount > 0
      ? `${payload.includedAttachmentCount} image${payload.includedAttachmentCount === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => part !== null);
  const attachmentNames = payload.attachments.map((attachment) => attachment.name).join(", ");

  return (
    <div className="mx-auto max-w-4xl px-1">
      <div className="rounded-lg border border-border/70 bg-muted/35 px-3.5 py-3 text-sm">
        <div className="flex min-w-0 items-start gap-2.5">
          <SplitIcon className="mt-0.5 size-4 shrink-0 rotate-90 text-muted-foreground/70" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <p className="font-medium text-foreground/90">Fork context</p>
              <p className="text-xs text-muted-foreground/60">
                {formatTimestamp(payload.createdAt, ctx.timestampFormat)}
              </p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground/75">
              {isNativeFork
                ? "Current files were used. Full conversation history carried over (native provider fork)."
                : `Current files were used. Context carried over: ${contextCounts.join(", ") || "none"}.`}
            </p>
            <div className="mt-2 rounded-md border border-border/60 bg-background/45 px-3 py-2">
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55">
                Source {sourceRole} message
              </p>
              <p className="line-clamp-3 text-xs text-muted-foreground/85">
                {payload.sourceMessageText || "No text in the source message."}
              </p>
            </div>
            {attachmentNames || payload.omittedAttachmentCount > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground/70">
                {attachmentNames ? `Images: ${attachmentNames}.` : null}
                {payload.omittedAttachmentCount > 0
                  ? ` ${payload.omittedAttachmentCount} image${
                      payload.omittedAttachmentCount === 1 ? " was" : "s were"
                    } omitted.`
                  : null}
              </p>
            ) : null}
            {isNativeFork ? null : (
              <details className="mt-2 group/fork-context">
                <summary className="cursor-pointer select-none text-xs text-muted-foreground/75 transition-colors hover:text-foreground">
                  Carried context
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-background/55 p-3 text-[11px] leading-relaxed text-muted-foreground/85">
                  {payload.contextText}
                </pre>
              </details>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const EMPTY_IMAGE_PREVIEW_ITEMS: ReadonlyArray<TimelineImagePreviewItem> = [];

/**
 * Message attachments carry HTTP preview URLs against the environment's base
 * URL. A saved environment's route is cross-origin and authenticated over its
 * WebSocket, which the browser cannot attach to an `<img>` request, so swap
 * those previews for data URLs fetched over the RPC channel. Locally-echoed
 * blob/data previews (composer handoff) pass through untouched. Only chat
 * attachments belong here: work entry images may carry foreign http URLs that
 * are not stored attachments.
 */
function useResolvedAttachmentPreviews(
  images: ReadonlyArray<TimelineImagePreviewItem>,
): ReadonlyArray<TimelineImagePreviewItem> {
  const ctx = use(TimelineRowCtx);
  const environmentId = ctx.activeThreadEnvironmentId;
  const rpcImages =
    images.length > 0 && environmentRequiresRpcAssetTransport(environmentId)
      ? images.filter((image) => image.previewUrl && /^https?:/i.test(image.previewUrl))
      : EMPTY_IMAGE_PREVIEW_ITEMS;
  const previewQueries = useQueries({
    queries: rpcImages.map((image) =>
      chatAttachmentPreviewQueryOptions({ environmentId, attachmentId: image.id }),
    ),
  });
  if (rpcImages.length === 0) {
    return images;
  }

  const dataUrlById = new Map<string, string | undefined>();
  rpcImages.forEach((image, index) => {
    dataUrlById.set(image.id, previewQueries[index]?.data);
  });
  return images.map((image) => {
    if (!dataUrlById.has(image.id)) {
      return image;
    }
    const dataUrl = dataUrlById.get(image.id);
    // While the RPC fetch is pending (or failed), drop the unreachable HTTP
    // URL so the grid shows its name placeholder instead of a broken image.
    return dataUrl ? { ...image, previewUrl: dataUrl } : { id: image.id, name: image.name };
  });
}

function TimelineFileAttachmentChips(props: {
  attachments: ReadonlyArray<ChatAttachment>;
  className?: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const files = props.attachments.filter((attachment) => attachment.type === "file");
  if (files.length === 0) {
    return null;
  }
  const environmentId = ctx.activeThreadEnvironmentId;
  return (
    <div className={cn("flex flex-wrap gap-1.5", props.className)}>
      {files.map((file) => (
        <button
          key={file.id}
          type="button"
          title={file.name}
          aria-label={`Preview ${file.name}`}
          className="inline-flex max-w-[260px] cursor-zoom-in items-center gap-1.5 rounded-md border border-border/80 bg-background/70 px-2 py-1 text-xs text-muted-foreground hover:text-foreground/80"
          onClick={() =>
            ctx.onPreviewFile({
              name: file.name,
              kind: file.kind,
              loadBlob: () => loadChatAttachmentBlob({ environmentId, attachmentId: file.id }),
            })
          }
        >
          <FileTextIcon className="size-3.5 shrink-0" />
          <span className="truncate">{file.name}</span>
        </button>
      ))}
    </div>
  );
}

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageAttachments = row.message.attachments ?? [];
  const userImages = useResolvedAttachmentPreviews(
    messageAttachments.filter((attachment) => attachment.type === "image"),
  );
  const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
  const terminalContexts = displayedUserMessage.contexts;
  const transcriptHighlights = displayedUserMessage.transcriptHighlights;
  const pickedElements = displayedUserMessage.pickedElements.map((context, index) => ({
    // Stable enough to key a chip and name a reveal request: the blocks in a
    // sent message no longer move.
    id: `${row.message.id}:element:${index}`,
    createdAt: row.message.createdAt,
    context,
  }));
  const drawings = displayedUserMessage.drawings.map((entry, index) => ({
    id: `${row.message.id}:drawing:${index}`,
    entry,
  }));
  const canRevertAgentWork = typeof row.revertTurnCount === "number";
  const canRetryFailedTurn = ctx.failedTurnRetry?.messageId === row.message.id;

  const addressee =
    ctx.roomAgents !== null && row.message.participantId
      ? ctx.roomAgents.get(roomAgentKey(row.message.participantId))
      : undefined;

  return (
    <div className="flex flex-col items-end">
      {addressee ? (
        <div className="mb-1 pr-1 font-mono text-[10.5px] text-muted-foreground">
          to {addressee.name}
        </div>
      ) : null}
      <div className="flex w-full justify-end">
        <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
          <TimelineFileAttachmentChips attachments={messageAttachments} className="mb-2" />
          <TimelineImagePreviewGrid
            images={userImages}
            className="mb-2 max-w-[420px]"
            imageClassName="max-h-[220px] object-cover"
          />
          <CollapsibleUserMessageBody
            text={displayedUserMessage.visibleText}
            terminalContexts={terminalContexts}
            transcriptHighlights={transcriptHighlights}
            pickedElements={pickedElements}
            drawings={drawings}
            transcriptMessage={{
              id: row.message.id,
              role: "user",
            }}
            skills={ctx.skills}
            forceExpanded={ctx.searchTargetMessageId === row.message.id}
            searchHighlightQuery={
              ctx.activeSearchTargetMessageId === row.message.id ? ctx.searchTargetQuery : undefined
            }
            footer={
              <>
                <div className="flex items-center gap-1.5">
                  {canRetryFailedTurn && <RetryUserMessageButton />}
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton text={displayedUserMessage.copyText} />
                    )}
                    {displayedUserMessage.copyText && (
                      <ContinueInNewThreadButton messageId={row.message.id} />
                    )}
                    {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
                  </div>
                </div>
                <p className="text-right text-xs tracking-tight tabular-nums text-muted-foreground/50">
                  {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
                </p>
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}

const TimelineImagePreviewGrid = memo(function TimelineImagePreviewGrid(props: {
  images: ReadonlyArray<TimelineImagePreviewItem>;
  className?: string | undefined;
  imageClassName?: string | undefined;
}) {
  if (props.images.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "grid gap-2",
        props.images.length === 1 ? "grid-cols-1" : "grid-cols-2",
        props.className,
      )}
    >
      {props.images.map((image) => (
        <TimelineImagePreviewTile
          key={image.id}
          image={image}
          images={props.images}
          imageClassName={props.imageClassName}
        />
      ))}
    </div>
  );
});

/**
 * One tile in the grid. A row that only named its image (a Codex `view_image`,
 * a Claude `Read` of a screenshot) loads the bytes here, on mount — the
 * timeline is virtualized, so only rows the reader has actually reached ask for
 * anything. Until they arrive, and forever if they never do, the tile shows the
 * file name exactly as it did before.
 */
function TimelineImagePreviewTile(props: {
  image: TimelineImagePreviewItem;
  images: ReadonlyArray<TimelineImagePreviewItem>;
  imageClassName?: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
  const loaded = useLocalImagePreview({
    environmentId: ctx.activeThreadEnvironmentId,
    cwd: ctx.markdownCwd,
    path: props.image.previewUrl ? undefined : props.image.path,
  });
  const previewUrl = props.image.previewUrl ?? loaded.dataUrl;

  return (
    <div className="overflow-hidden rounded-lg border border-border/80 bg-background/70">
      {previewUrl ? (
        <button
          type="button"
          className="h-full w-full cursor-zoom-in"
          aria-label={`Preview ${props.image.name}`}
          onClick={() => {
            const preview = buildExpandedImagePreview(
              props.images.map((candidate) =>
                candidate.id === props.image.id ? { ...candidate, previewUrl } : candidate,
              ),
              props.image.id,
            );
            if (!preview) return;
            ctx.onImageExpand(preview);
          }}
        >
          <img
            src={previewUrl}
            alt={props.image.name}
            className={cn("block h-auto w-full", props.imageClassName)}
          />
        </button>
      ) : (
        <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
          {props.image.name}
        </div>
      )}
    </div>
  );
}

function RevertUserMessageButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={activity.isRevertingCheckpoint || activity.isWorking}
      onClick={() => ctx.onRevertUserMessage(messageId)}
      aria-label="Revert to this message"
      tooltip="Revert to this message"
    >
      <Undo2Icon className="size-3" />
    </Button>
  );
}

function RetryUserMessageButton() {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);
  const retry = ctx.failedTurnRetry;
  if (!retry) {
    return null;
  }

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={retry.isRetrying || activity.isWorking}
      onClick={retry.onRetry}
      aria-label="Retry this message"
      tooltip="Retry this message"
      className="gap-1 px-2 enabled:cursor-pointer"
    >
      <RefreshCwIcon className={cn("size-3", retry.isRetrying && "animate-spin")} />
      {retry.isRetrying ? "Retrying" : "Retry"}
    </Button>
  );
}

function ContinueInNewThreadButton({
  messageId,
  className,
}: {
  messageId: MessageId;
  className?: string;
}) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);
  if (!ctx.onContinueInNewThread || activity.isWorking) {
    return null;
  }

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      onClick={() => ctx.onContinueInNewThread?.(messageId)}
      aria-label="Branch from here"
      tooltip="Branch from here"
      className={cn("enabled:cursor-pointer", className)}
    >
      <SplitIcon className="size-3 rotate-90" />
    </Button>
  );
}

function titleCaseModelPart(value: string): string {
  return value.length > 0 ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function formatFallbackModelName(modelId: string): string {
  const parts = modelId.trim().split(/[-_]+/u).filter(Boolean);
  if (parts.length === 0) {
    return modelId;
  }
  if (parts[0]?.toLowerCase() !== "claude") {
    return modelId;
  }

  const tailNumbers: string[] = [];
  while (parts.length > 1) {
    const tail = parts[parts.length - 1];
    if (!tail || !/^\d+$/u.test(tail)) {
      break;
    }
    tailNumbers.unshift(tail);
    parts.pop();
  }

  const family = parts
    .slice(1)
    .map((part) => titleCaseModelPart(part.toLowerCase()))
    .join(" ");
  const version =
    tailNumbers.length >= 2
      ? `${tailNumbers[tailNumbers.length - 2]}.${tailNumbers[tailNumbers.length - 1]}`
      : tailNumbers[0];
  return ["Claude", family, version].filter(Boolean).join(" ");
}

function FallbackAssistantResponseContainer({
  row,
  children,
}: {
  row: Extract<TimelineRow, { kind: "message" }>;
  children: ReactNode;
}) {
  const fallback = row.assistantModelFallback;
  if (!fallback) {
    return children;
  }

  const requestedModel = formatFallbackModelName(fallback.requestedModel);
  const activeModel = formatFallbackModelName(fallback.activeModel);

  return (
    <div
      data-assistant-fallback-response="true"
      className="max-w-full rounded-xl border border-warning/30 bg-warning/6 px-3 py-2.5 shadow-sm shadow-warning/5"
    >
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-tight">
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 font-medium text-warning-foreground">
          <CircleAlertIcon aria-hidden="true" className="size-3" />
          Fallback response
        </span>
        <span className="min-w-0 text-muted-foreground">
          Requested <span className="font-medium text-foreground/80">{requestedModel}</span>,
          answered by <span className="font-medium text-foreground/80">{activeModel}</span>.
        </span>
      </div>
      {children}
    </div>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
  const revealRef = useRef<HTMLDivElement>(null);
  useStreamingTextReveal(revealRef, Boolean(row.message.streaming));
  const authReconnect =
    ctx.providerAuthReconnect && isProviderAuthErrorMessage(messageText)
      ? ctx.providerAuthReconnect
      : null;
  // Notes carry the story while the agent works, in the turn's work tray. A
  // finished turn's last message is its answer: it leaves the tray for the
  // page at full strength and carries the turn's footer, while the notes
  // before it fade to the steps' grey. A note's time stays one hover away.
  const summary = row.turnSummary;

  return (
    <>
      {/* Mid-turn responses settle in with the same fade the activity rows use,
          so a non-streamed message doesn't pop in fully formed. Settled rows
          skip it — the class re-animates on virtualization remounts. */}
      <div className={cn("min-w-0 px-1 py-0.5", row.assistantTurnInProgress && "work-row-enter")}>
        <div
          className={cn(
            "group/assistant-message block w-full max-w-full align-top [&_.chat-markdown]:transition-colors [&_.chat-markdown]:duration-300",
            row.settledNote && "[&_.chat-markdown]:text-muted-foreground/80",
            summary && "[&_.chat-markdown]:text-foreground",
          )}
          data-assistant-message-section="true"
          data-settled-note={row.settledNote ? "true" : undefined}
          title={summary ? undefined : formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
        >
          {ctx.roomAgents !== null && ctx.roomAuthorLineMessageIds.has(row.message.id) ? (
            <RoomAuthorLine label={ctx.roomAgents.get(roomAgentKey(row.message.participantId))} />
          ) : null}
          {authReconnect ? (
            <ProviderAuthReconnectCard
              action={authReconnect}
              className="max-w-2xl"
              resolved={ctx.resolvedProviderAuthReconnectIds.has(row.id)}
              {...(ctx.onRunProviderAuthReconnect ? { onRun: ctx.onRunProviderAuthReconnect } : {})}
            />
          ) : (
            <FallbackAssistantResponseContainer row={row}>
              <div
                ref={revealRef}
                data-agent-response-body="true"
                data-assistant-message-body="true"
                data-transcript-message-body="true"
                data-transcript-message-id={row.message.id}
                data-transcript-message-role="assistant"
                data-transcript-message-streaming={row.message.streaming ? "true" : undefined}
              >
                <ChatMarkdown
                  text={messageText}
                  cwd={ctx.markdownCwd}
                  environmentId={ctx.activeThreadEnvironmentId}
                  threadId={ctx.activeThreadId ?? undefined}
                  isStreaming={Boolean(row.message.streaming)}
                  skills={ctx.skills}
                  searchHighlightQuery={
                    ctx.activeSearchTargetMessageId === row.message.id
                      ? ctx.searchTargetQuery
                      : undefined
                  }
                />
              </div>
            </FallbackAssistantResponseContainer>
          )}
          {/* The footer comes first so the turn's changes, which land a beat
              later, open below it instead of pushing it down. */}
          {summary ? <AssistantTurnFooter row={row} summary={summary} /> : null}
          <AssistantChangedFilesSection
            turnSummary={row.assistantTurnDiffSummary}
            isTurnInProgress={row.assistantTurnInProgress}
            routeThreadKey={ctx.routeThreadKey}
            resolvedTheme={ctx.resolvedTheme}
            onOpenTurnDiff={ctx.onOpenTurnDiff}
          />
        </div>
      </div>
    </>
  );
}

/**
 * A finished turn's footer under its answer: how long the agent worked, what
 * it changed, how its checks ended, the agents it ran, and when it answered.
 * It takes the working row's place at the tail, so a turn ending moves
 * nothing above it.
 */
function AssistantTurnFooter({
  row,
  summary,
}: {
  row: Extract<TimelineRow, { kind: "message" }>;
  summary: TurnSummary;
}) {
  const { onOpenAgentsPanel, timestampFormat } = use(TimelineRowCtx);
  const tracker = useTurnAgentTracker(summary.trackerTurnIds, summary.trackerAgentSpawnIds);
  const parts: Array<{ key: string; node: ReactNode }> = [];
  if (summary.workedMs !== null && summary.workedMs >= 1_000) {
    parts.push({
      key: "worked",
      node: <span className="shrink-0">Worked for {formatWorkingDuration(summary.workedMs)}</span>,
    });
  }
  if (summary.editedFileCount > 0) {
    parts.push({
      key: "edited",
      node: <span className="shrink-0">edited {pluralize(summary.editedFileCount, "file")}</span>,
    });
  }
  if (summary.checks) {
    const failed = summary.checks.failed > 0;
    parts.push({
      key: "checks",
      node: (
        <span
          className={cn(
            "shrink-0",
            failed ? "text-destructive-foreground/85" : "text-success-foreground/75",
          )}
          data-turn-footer-checks={failed ? "failed" : "passed"}
        >
          {failed ? `${pluralize(summary.checks.failed, "check")} failed` : "checks passed"}
        </span>
      ),
    });
  }
  if (tracker.summary && onOpenAgentsPanel) {
    parts.push({
      key: "agents",
      node: (
        <TurnAgentTrackerButton summary={tracker.summary} onOpen={() => onOpenAgentsPanel(null)} />
      ),
    });
  }
  parts.push({
    key: "time",
    node: (
      <span className="shrink-0 text-muted-foreground/40">
        {formatTimestamp(row.message.createdAt, timestampFormat)}
      </span>
    ),
  });

  return (
    <div
      className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs leading-5 text-muted-foreground/60 tabular-nums"
      data-turn-footer="true"
    >
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 ? (
            <span aria-hidden="true" className="shrink-0 text-muted-foreground/35">
              ·
            </span>
          ) : null}
          {part.node}
        </Fragment>
      ))}
      <span className="ml-1 flex shrink-0 items-center gap-2">
        {row.message.text.trim().length > 0 ? (
          <ContinueInNewThreadButton
            messageId={row.message.id}
            className="pointer-events-none border-border/50 bg-background/35 text-muted-foreground/45 opacity-0 shadow-none transition-opacity duration-200 hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70 group-hover/assistant-message:pointer-events-auto group-hover/assistant-message:opacity-100 group-focus-within/assistant-message:pointer-events-auto group-focus-within/assistant-message:opacity-100"
          />
        ) : null}
        <AssistantCopyButton row={row} />
      </span>
    </div>
  );
}

function AssistantCopyButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return (
    <div className="flex items-center opacity-0 transition-opacity duration-200 group-hover/assistant-message:opacity-100 group-focus-within/assistant-message:opacity-100">
      <MessageCopyButton
        text={assistantCopyState.text ?? ""}
        size="icon-xs"
        variant="outline"
        className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
      />
    </div>
  );
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const planState = ctx.proposedPlanState;
  const proposedPlan = row.proposedPlan;
  const status: ProposedPlanCardStatus =
    proposedPlan.implementedAt !== null
      ? "implemented"
      : (proposedPlan.dismissedAt ?? null) !== null
        ? "dismissed"
        : planState === null || proposedPlan.id === planState.activePlanId
          ? "actionable"
          : "superseded";
  const implementationThreadId =
    status === "implemented" &&
    proposedPlan.implementationThreadId !== null &&
    proposedPlan.implementationThreadId !== planState?.activeThreadId
      ? proposedPlan.implementationThreadId
      : null;
  const isActionable = status === "actionable" && planState !== null;

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadId={ctx.activeThreadId ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
        status={status}
        onImplement={isActionable ? planState.onImplement : undefined}
        onImplementInNewThread={isActionable ? planState.onImplementInNewThread : undefined}
        onDismiss={isActionable ? planState.onDismiss : undefined}
        onOpenImplementationThread={
          implementationThreadId && planState
            ? () => planState.onOpenThread(implementationThreadId)
            : undefined
        }
      />
    </div>
  );
}

const COLLAPSED_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;
const COLLAPSED_MESSAGE_FADE_STYLE: CSSProperties = {
  WebkitMaskImage: COLLAPSED_MESSAGE_FADE_MASK,
  maskImage: COLLAPSED_MESSAGE_FADE_MASK,
};

/**
 * A finished agent, as one line of the conversation. The full report is not
 * inlined: the rail's Agents tab owns the transcript, and this row is the
 * receipt that says it happened and takes you there.
 */
function SubagentReceiptTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "subagent-result" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const displayName = formatSubagentDisplayName(row.result);
  const summary = formatSubagentReceiptSummary(row.result.body);
  const agentThreadId = row.result.agentThreadId;
  const meta = [row.result.model, formatTimestamp(row.createdAt, ctx.timestampFormat)]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ");
  // A provider that serves no transcript for this agent has nothing to drill
  // into, so the receipt is just a line of the record.
  const onOpenAgentsPanel = ctx.onOpenAgentsPanel;
  const interactive = onOpenAgentsPanel !== null && agentThreadId.length > 0;

  const body = (
    <>
      {/* Leads with the same icon as the rail's Agents tab, so the receipt and
          the surface it opens read as one thing. */}
      <BotIcon aria-hidden="true" className="mt-1 size-3 shrink-0 text-muted-foreground/60" />
      <span className="min-w-0 flex-1 truncate text-[12px] leading-5">
        <span className="font-medium text-foreground/85">{displayName}</span>
        {summary ? (
          <>
            <span className="px-1.5 text-muted-foreground/30">·</span>
            <span className="text-muted-foreground/75">{summary}</span>
          </>
        ) : null}
      </span>
      <span className="mt-[3px] flex shrink-0 items-center gap-1 rounded border border-border/50 bg-background/60 px-1 py-px text-[9px] leading-none font-medium tracking-[0.08em] text-muted-foreground/70 uppercase">
        <CheckIcon aria-hidden="true" className="size-2.5" />
        Subagent finished
      </span>
      {meta ? (
        <span className="shrink-0 font-mono text-[10px] leading-5 text-muted-foreground/35 tabular-nums">
          {meta}
        </span>
      ) : null}
    </>
  );

  // A bordered clickable tile — the one shape the flat system reserves for
  // exactly this: a row that opens another surface.
  const rowClassName =
    "flex w-full min-w-0 items-start gap-2 rounded-md border border-border/50 px-2 py-1 text-left";

  return (
    // The receipt lands mid-turn the moment its agent finishes; the fade makes
    // that arrival read as an event rather than a row that was always there.
    <div className="work-row-enter min-w-0" data-subagent-receipt-row="true">
      {interactive ? (
        <button
          type="button"
          className={cn(
            rowClassName,
            "group/subagent-receipt transition-colors hover:border-border/80 hover:bg-foreground/[0.03] focus-ring",
          )}
          aria-label={`Open ${displayName} transcript`}
          data-subagent-receipt-open="true"
          onClick={() => onOpenAgentsPanel(agentThreadId)}
        >
          {body}
          {/* The drill-in affordance: quiet at rest, named on hover. */}
          <ChevronRightIcon
            aria-hidden="true"
            className="mt-1 size-3 shrink-0 text-muted-foreground/30 transition-colors duration-150 group-hover/subagent-receipt:text-muted-foreground/70"
          />
        </button>
      ) : (
        <div className={rowClassName}>{body}</div>
      )}
    </div>
  );
}

/** The turn's fixed anchor at the timeline tail: the surface's one live node,
 *  the turn timer, and the agent tracker live here from the first token to the
 *  last, whatever the rows above are doing — so nothing about "now" teleports
 *  mid-turn. Its word is the step running right now ("Reading service.ts"), or
 *  the state the turn is in ("Thinking", "Waiting for approval"). While the
 *  agent thinks out loud, its newest thought sits under the word. */
function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  const { turnAgents, onOpenAgentsPanel } = use(TimelineRowCtx);
  const liveSubagents = turnAgents?.subagents ?? [];
  const agentSummary = summarizeTurnAgents(liveSubagents);
  const liveAgentRoster = formatLiveAgentStatusRows(liveSubagents);
  const liveAgentCount = liveSubagents.filter((item) => isActiveSubagentStatus(item.status)).length;
  const dotsState = workingDotsStateForLabel(row.label, liveAgentCount);
  const waitingOnUser = isWaitingOnUserState(dotsState);

  return (
    // The three dots are the anchor's whole "alive" signal. They sit in the
    // activity lines' icon column, so the word lines up with the steps above.
    // Amber means the agent stopped and needs the user. Even room above and
    // below keeps the word centered when it is the tray's only line.
    <div className="py-1" data-turn-working-anchor="true">
      <div className="min-w-0 pl-1">
        <p className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground/70">
          <span className="flex min-w-0 items-center gap-1 tabular-nums">
            <span
              className={cn(
                "flex min-w-0 items-center gap-1.5",
                waitingOnUser && "text-warning-foreground",
              )}
            >
              {/* -top-px: the 12px box centers half a pixel low against the
                  type's caps, and dots read best a hair above middle. */}
              <WorkingAnchorDots state={dotsState} className="relative -top-px -mr-0.5 shrink-0" />
              <span
                className="working-shimmer min-w-0 truncate"
                data-tone={waitingOnUser ? "warning" : undefined}
                data-turn-working-label="true"
              >
                {row.createdAt ? row.label : `${row.label}...`}
              </span>
            </span>
            {row.createdAt ? (
              <>
                <span className="shrink-0 text-muted-foreground/40">·</span>
                <span className="shrink-0">
                  <WorkingTimer createdAt={row.createdAt} />
                </span>
              </>
            ) : null}
          </span>
          {agentSummary && onOpenAgentsPanel ? (
            <>
              <span className="shrink-0 text-muted-foreground/35">·</span>
              <TurnAgentTrackerButton
                summary={agentSummary}
                onOpen={() => onOpenAgentsPanel(null)}
              />
            </>
          ) : null}
        </p>
        {/* What the agent is thinking, in its own summary's words, under the
            word it explains. Indented to the word, past the dots. One line,
            the newest sentence, so the row never grows while a thought streams;
            the whole thought is a hover away. */}
        {row.thought ? (
          <p
            className="work-meta-enter truncate pl-[19px] text-[11px] leading-4 text-muted-foreground/55"
            title={row.thought}
            data-turn-working-thought="true"
          >
            {newestThoughtSentence(row.thought)}
          </p>
        ) : null}
        {/* Each live agent keeps its own row, so concurrent updates change the
            action text in place instead of replacing another agent's status. */}
        <div className={agentSummary ? "min-h-4" : undefined}>
          <LiveAgentRoster roster={liveAgentRoster} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking labels — update their own text nodes so elapsed-time display
// does not create a React commit every second while a response is streaming.
// ---------------------------------------------------------------------------

/** Live elapsed label for the active turn. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatWorkingTimerNow(createdAt);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatWorkingTimerNow(createdAt);
      }
    };
    updateText();
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt]);

  return <span ref={textRef}>{initialText}</span>;
}

/**
 * One stretch of the agent's steps between two things it said: the looking
 * around folded into one grey line, the steps worth noticing on lines of their
 * own. Steps still running are left to the working row's live line. A turn's
 * agents ride on its answer's footer; a turn that ended without an answer shows
 * them on its first group instead.
 */
const WorkGroupSection = memo(function WorkGroupSection({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "work" }>;
}) {
  const { workspaceRoot, turnDiffSummaryByTurnId, onOpenAgentsPanel, anchorOwnsLiveAgents } =
    use(TimelineRowCtx);
  const { isWorking } = use(TimelineRowActivityCtx);
  const groupedEntries = useMemo(
    () => coalesceFileChangeWorkEntries(row.groupedEntries, turnDiffSummaryByTurnId, workspaceRoot),
    [row.groupedEntries, turnDiffSummaryByTurnId, workspaceRoot],
  );
  const steps = useMemo(
    () =>
      groupedEntries.flatMap((entry) => {
        const step = activityStepFromWorkLogEntry(entry, {
          workspaceRoot,
          ...(isFileChangeWorkEntry(entry)
            ? { diff: summarizeWorkEntryDiffStat(entry, turnDiffSummaryByTurnId) }
            : {}),
        });
        return step ? [step] : [];
      }),
    [groupedEntries, turnDiffSummaryByTurnId, workspaceRoot],
  );
  const entriesById = useMemo(
    () => new Map(groupedEntries.map((entry) => [entry.id, entry] as const)),
    [groupedEntries],
  );
  const renderExtras = useCallback(
    (step: ActivityStep) => {
      const entry = entriesById.get(step.id);
      return entry && hasWorkEntryExtras(entry) ? <WorkEntryExtras entry={entry} /> : null;
    },
    [entriesById],
  );
  const turnAgentTracker = useTurnAgentTracker(row.trackerTurnIds, row.trackerAgentSpawnIds);
  // While the turn is live, the working row at the tail carries its agents.
  const showTracker =
    turnAgentTracker.summary !== null &&
    onOpenAgentsPanel !== null &&
    !(isWorking && row.inActiveExchange);
  const hasSettledSteps = steps.some((step) => !step.running);

  if (!hasSettledSteps && !showTracker) {
    return null;
  }

  return (
    <div className="min-w-0 px-1 pt-0.5" data-work-group="true">
      {showTracker && turnAgentTracker.summary ? (
        <div
          className="flex min-w-0 items-center gap-[7px] text-xs leading-5 text-muted-foreground/60"
          data-turn-agents-line="true"
        >
          <BotIcon className="size-3 shrink-0 text-muted-foreground/45" aria-hidden="true" />
          <TurnAgentTrackerButton
            summary={turnAgentTracker.summary}
            onOpen={() => onOpenAgentsPanel?.(null)}
          />
        </div>
      ) : null}
      {showTracker && !anchorOwnsLiveAgents ? (
        <LiveAgentRoster roster={turnAgentTracker.liveRoster} />
      ) : null}
      {hasSettledSteps ? <ActivityGroup steps={steps} renderExtras={renderExtras} /> : null}
    </div>
  );
});

function hasWorkEntryExtras(entry: TimelineWorkEntry): boolean {
  return Boolean(entry.authReconnect || entry.mcpAuthReconnect || (entry.images?.length ?? 0) > 0);
}

/** What a step shows beyond its line: a sign-in card to act on, or the
 *  images it produced. */
function WorkEntryExtras({ entry }: { entry: TimelineWorkEntry }) {
  const {
    onRunProviderAuthReconnect,
    resolvedProviderAuthReconnectIds,
    mcpAuthReconnectStatusByServerName,
    onRunMcpAuthReconnect,
  } = use(TimelineRowCtx);
  const images = entry.images ?? [];
  return (
    <>
      {entry.authReconnect ? (
        <ProviderAuthReconnectCard
          action={entry.authReconnect}
          resolved={resolvedProviderAuthReconnectIds.has(entry.id)}
          {...(onRunProviderAuthReconnect ? { onRun: onRunProviderAuthReconnect } : {})}
        />
      ) : null}
      {entry.mcpAuthReconnect ? (
        <McpAuthReconnectCard
          action={entry.mcpAuthReconnect}
          status={mcpAuthReconnectStatusByServerName.get(entry.mcpAuthReconnect.serverName)}
          {...(onRunMcpAuthReconnect ? { onRun: onRunMcpAuthReconnect } : {})}
        />
      ) : null}
      {images.length > 0 ? (
        <TimelineImagePreviewGrid
          images={images}
          className="max-w-[420px]"
          imageClassName="max-h-[260px] object-contain"
        />
      ) : null}
    </>
  );
}

/** A flat, stable mini-roster for the live agents on this turn. Accent stays on
 *  the status dot; the neutral name and quieter action remain easy to separate. */
function LiveAgentRoster({ roster }: { roster: LiveAgentStatusRoster }) {
  const { onOpenAgentsPanel } = use(TimelineRowCtx);
  if (roster.rows.length === 0 || !onOpenAgentsPanel) {
    return null;
  }

  return (
    <div className="work-meta-enter ml-1 min-w-0" data-turn-live-agent-roster="true">
      {roster.rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className="group/live-agent grid w-full min-w-0 cursor-pointer grid-cols-[0.375rem_minmax(0,7rem)_minmax(0,1fr)] items-center gap-x-1.5 text-left text-[11px] leading-4 outline-none focus-ring"
          data-turn-live-agent-status="true"
          data-turn-live-agent-state={row.status}
          title={`${row.name}: ${row.step}`}
          aria-label={`Open ${row.name}: ${row.step}`}
          onClick={() => onOpenAgentsPanel(row.agentThreadId)}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              row.status === "waiting" ? "bg-amber-500" : "bg-primary-graph",
            )}
          />
          <span
            className="truncate font-medium text-foreground/70 transition-colors duration-150 group-hover/live-agent:text-foreground/90"
            data-turn-live-agent-name="true"
          >
            {row.name}
          </span>
          <span
            className="truncate text-muted-foreground/55 transition-colors duration-150 group-hover/live-agent:text-muted-foreground/80"
            data-turn-live-agent-action="true"
          >
            {row.step}
          </span>
        </button>
      ))}
      {roster.hiddenCount > 0 ? (
        <button
          type="button"
          className="ml-3 block cursor-pointer text-[10px] leading-4 text-muted-foreground/45 outline-none transition-colors duration-150 hover:text-muted-foreground/75 focus-ring"
          data-turn-live-agent-overflow="true"
          aria-label={`Open ${roster.hiddenCount.toLocaleString()} more active ${roster.hiddenCount === 1 ? "subagent" : "subagents"}`}
          onClick={() => onOpenAgentsPanel(null)}
        >
          +{roster.hiddenCount.toLocaleString()} more active
        </button>
      ) : null}
    </div>
  );
}

interface TurnAgentTracker {
  readonly summary: TurnAgentSummary | null;
  readonly liveRoster: LiveAgentStatusRoster;
}

/** The turn's agents, resolved from the turns this group owns the tracker for —
 *  which is only the turns that started in it, so a turn with several activity
 *  groups shows one tracker rather than the same one repeated down the turn.
 *  Derived once by the group so the receipt and the group's own render decision
 *  cannot disagree about whether there is a tracker to show. */
function useTurnAgentTracker(
  trackerTurnIds: ReadonlyArray<TurnId>,
  trackerAgentSpawnIds: ReadonlyArray<string> = [],
): TurnAgentTracker {
  const { turnAgents } = use(TimelineRowCtx);
  const turnIds = useMemo(() => new Set(trackerTurnIds), [trackerTurnIds]);
  const spawnCallIds = useMemo(() => new Set(trackerAgentSpawnIds), [trackerAgentSpawnIds]);
  const turnSubagents = useMemo(
    () =>
      turnAgents
        ? selectTurnAgents({
            live: turnAgents.subagents,
            history: turnAgents.history,
            turnIds,
            spawnCallIds,
          })
        : [],
    [turnAgents, turnIds, spawnCallIds],
  );
  return {
    // An empty selection summarizes to null on its own, so a turn that ran no
    // agents has no tracker whether or not the thread has agent state at all.
    summary: summarizeTurnAgents(turnSubagents),
    liveRoster: formatLiveAgentStatusRows(turnSubagents),
  };
}

/** The clickable turn-agents chip: one segment bar per agent plus the count,
 *  shared by the settled receipt and the live working row so the tracker looks
 *  the same wherever it renders. */
function TurnAgentTrackerButton({
  summary,
  onOpen,
}: {
  summary: TurnAgentSummary;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex min-w-0 items-center gap-1.5 transition-colors duration-150 hover:text-foreground/75"
      aria-label={`${summary.text}. Open the agents panel.`}
      data-turn-agents-summary="true"
      onClick={onOpen}
    >
      <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-0.5">
        {summary.segments.map((segment) => (
          <span
            key={segment.id}
            className={cn(
              "block h-1 w-[22px] rounded-full",
              segment.status === "running" && "bg-primary-graph",
              segment.status === "waiting" && "bg-amber-500",
              segment.status === "failed" && "bg-destructive",
              segment.status === "stopped" && "bg-muted-foreground/35",
              segment.status === "completed" && "bg-muted-foreground/35",
            )}
          />
        ))}
      </span>
      <span className="truncate">{summary.text}</span>
    </button>
  );
}

function coalesceFileChangeWorkEntries(
  entries: ReadonlyArray<TimelineWorkEntry>,
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>,
  workspaceRoot: string | undefined,
): TimelineWorkEntry[] {
  const coalesced: TimelineWorkEntry[] = [];
  const indexByKey = new Map<string, number>();

  for (const entry of entries) {
    const enrichedEntry = withInferredFileChangePaths(entry, turnDiffSummaryByTurnId);
    const key = fileChangeCoalesceKey(enrichedEntry, turnDiffSummaryByTurnId, workspaceRoot);
    if (!key) {
      coalesced.push(enrichedEntry);
      continue;
    }

    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, coalesced.length);
      coalesced.push(enrichedEntry);
      continue;
    }

    const previous = coalesced[existingIndex];
    if (!previous) {
      coalesced.push(enrichedEntry);
      continue;
    }
    coalesced[existingIndex] = mergeFileChangeWorkEntries(previous, enrichedEntry, workspaceRoot);
  }

  return coalesced;
}

function withInferredFileChangePaths(
  entry: TimelineWorkEntry,
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>,
): TimelineWorkEntry {
  if (!isFileChangeWorkEntry(entry) || (entry.changedFiles?.length ?? 0) > 0) {
    return entry;
  }
  // A running edit that hasn't revealed its target (tool input still
  // streaming) must not adopt the turn's accumulated file list: that pins
  // the previous edits' files — and their whole-turn +/- totals — onto an
  // unrelated in-flight row.
  if (entry.executionState === "running") {
    return entry;
  }

  const turnSummary = resolveWorkEntryTurnDiffSummary(entry, turnDiffSummaryByTurnId);
  if (!turnSummary || turnSummary.files.length === 0) {
    return entry;
  }

  return {
    ...entry,
    changedFiles: dedupeChangedFilePaths(turnSummary.files.map((file) => file.path)),
  };
}

function fileChangeCoalesceKey(
  entry: TimelineWorkEntry,
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>,
  workspaceRoot: string | undefined,
): string | null {
  if (!isFileChangeWorkEntry(entry)) {
    return null;
  }
  if (entry.executionState === "running" || entry.executionState === "failed") {
    return null;
  }

  const changedFiles = dedupeChangedFilePaths(entry.changedFiles, workspaceRoot);
  if (changedFiles.length === 0) {
    return null;
  }

  const turnSummary = resolveWorkEntryTurnDiffSummary(entry, turnDiffSummaryByTurnId);
  const turnKey = entry.turnId ?? turnSummary?.turnId ?? "unkeyed";
  const pathKey = changedFiles
    .map((filePath) => normalizeFileChangeCoalescePath(filePath, workspaceRoot))
    .filter((filePath) => filePath.length > 0)
    .toSorted()
    .join("\u001e");
  if (!pathKey) {
    return null;
  }

  return ["file-change", turnKey, pathKey].join("\u001f");
}

function normalizeFileChangeCoalescePath(
  filePath: string,
  workspaceRoot: string | undefined,
): string {
  return normalizeDiffMatchPath(formatWorkspaceRelativePath(filePath, workspaceRoot));
}

function mergeFileChangeWorkEntries(
  previous: TimelineWorkEntry,
  next: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): TimelineWorkEntry {
  const changedFiles = dedupeChangedFilePaths(
    [...(previous.changedFiles ?? []), ...(next.changedFiles ?? [])],
    workspaceRoot,
  );
  const changedFileStats = sumChangedFileStats(previous.changedFileStats, next.changedFileStats);
  const executionState = next.executionState ?? previous.executionState;
  return {
    ...previous,
    ...next,
    id: previous.id,
    createdAt: previous.createdAt,
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(changedFileStats.length > 0 ? { changedFileStats } : {}),
    ...(executionState ? { executionState } : {}),
    ...(previous.turnId && !next.turnId ? { turnId: previous.turnId } : {}),
  };
}

/** Distinct edits coalesced into one row are separate diffs against the same
 *  file, so their +/- counts add up (unlike lifecycle updates of one call,
 *  which replace each other upstream). */
function sumChangedFileStats(
  previous: TimelineWorkEntry["changedFileStats"],
  next: TimelineWorkEntry["changedFileStats"],
): NonNullable<TimelineWorkEntry["changedFileStats"]>[number][] {
  const byPath = new Map<string, NonNullable<TimelineWorkEntry["changedFileStats"]>[number]>();
  for (const stat of previous ?? []) {
    byPath.set(normalizeDiffMatchPath(stat.path), stat);
  }
  for (const stat of next ?? []) {
    const key = normalizeDiffMatchPath(stat.path);
    const existing = byPath.get(key);
    byPath.set(
      key,
      existing
        ? {
            ...existing,
            additions: existing.additions + stat.additions,
            deletions: existing.deletions + stat.deletions,
          }
        : stat,
    );
  }
  return [...byPath.values()];
}

function isFileChangeWorkEntry(
  entry: Pick<TimelineWorkEntry, "changedFiles" | "itemType" | "requestKind">,
): boolean {
  return (
    entry.itemType === "file_change" ||
    entry.requestKind === "file-change" ||
    (entry.changedFiles?.length ?? 0) > 0
  );
}

function dedupeChangedFilePaths(
  paths: ReadonlyArray<string> | undefined,
  workspaceRoot?: string | undefined,
): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const path of paths ?? []) {
    const trimmedPath = path.trim();
    const key =
      workspaceRoot === undefined
        ? normalizeDiffMatchPath(trimmedPath)
        : normalizeFileChangeCoalescePath(trimmedPath, workspaceRoot);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(trimmedPath);
  }
  return deduped;
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  isTurnInProgress,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  isTurnInProgress: boolean;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  if (isTurnInProgress) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const defaultTreeExpanded = useSettings((settings) => settings.chatChangedFilesDefaultExpanded);
  const allDirectoriesExpanded = useUiStateStore(
    (store) =>
      store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId] ??
      defaultTreeExpanded,
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = String(checkpointFiles.length);

  return (
    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
      {/* Wraps rather than overflowing. With the browser and source control
          both open the chat column gets narrow, and a row that cannot wrap
          pushes its buttons out of the card instead of under the label. */}
      <div className="sticky top-2 z-10 mb-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:content-['']">
        <p className="min-w-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55">
          <span>Turn changes ({changedFileCountLabel})</span>
          {hasNonZeroStat(summaryStat) && (
            <>
              <span className="mx-1">/</span>
              <span className="font-mono font-normal tabular-nums tracking-normal">
                <DiffStatLabel
                  additions={summaryStat.additions}
                  deletions={summaryStat.deletions}
                />
              </span>
            </>
          )}
        </p>
        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() =>
              setExpanded(
                routeThreadKey,
                turnSummary.turnId,
                !allDirectoriesExpanded,
                defaultTreeExpanded,
              )
            }
          >
            {allDirectoriesExpanded ? "Collapse tree" : "Expand tree"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() => onOpenTurnDiff(turnSummary.turnId)}
          >
            View turn diff
          </Button>
        </div>
      </div>
      <ChangedFilesTree
        key={`changed-files-tree:${turnSummary.turnId}`}
        turnId={turnSummary.turnId}
        files={checkpointFiles}
        allDirectoriesExpanded={allDirectoriesExpanded}
        resolvedTheme={resolvedTheme}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageTranscriptHighlightInlineLabel = memo(
  function UserMessageTranscriptHighlightInlineLabel(props: {
    context: ParsedTranscriptHighlightContextEntry;
  }) {
    const preview = formatTranscriptHighlightContextPreview(props.context);
    const roleWord = props.context.sourceRole === "assistant" ? "assistant" : "your";

    return (
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={200}
          closeDelay={0}
          render={
            <button
              type="button"
              aria-label={`View note on highlighted ${roleWord} text`}
              className="inline-flex max-w-56 cursor-pointer items-center gap-1 rounded-md border border-border/70 bg-background/55 px-2 py-0.5 text-[11px] leading-5 text-muted-foreground/85 outline-none transition-colors hover:text-foreground focus-ring"
            >
              <SquarePenIcon className="size-3.5 shrink-0 opacity-70" />
              <span className="min-w-0 truncate">{`"${preview}"`}</span>
            </button>
          }
        />
        <PopoverPopup align="start" sideOffset={6} className="w-72 max-w-[calc(100vw-2rem)]">
          <TranscriptHighlightContextCard context={props.context}>
            <div className="flex flex-col gap-1.5">
              <span className={TRANSCRIPT_HIGHLIGHT_CARD_LABEL_CLASS_NAME}>Your note</span>
              <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-snug text-foreground">
                {props.context.note}
              </p>
            </div>
          </TranscriptHighlightContextCard>
        </PopoverPopup>
      </Popover>
    );
  },
);

/** A picked element read back out of a sent message, keyed for rendering. */
interface SentPickedElementEntry {
  id: string;
  createdAt: string;
  context: PickedElementContext;
}

/**
 * The same chip the composer showed for this element, minus what no longer
 * applies: the message is sent, so the note reads as it was said and nothing
 * is removable. The way back to the element on the page stays.
 */
const UserMessagePickedElementChip = memo(function UserMessagePickedElementChip(props: {
  entry: SentPickedElementEntry;
}) {
  const ctx = use(TimelineRowCtx);
  const revealPickedElement = ctx.onRevealPickedElement;
  const threadId = ctx.activeThreadId;
  const { id, createdAt, context } = props.entry;
  const onReveal =
    revealPickedElement === undefined || threadId === null
      ? undefined
      : () => revealPickedElement({ ...context, id, threadId, createdAt });
  return <PickedElementContextChip context={context} chipId={id} onReveal={onReveal} />;
});

/** The group chip on a sent message: read-only, but every member's way back
 *  to the page stays clickable. */
const UserMessagePickedElementGroupChip = memo(function UserMessagePickedElementGroupChip(props: {
  entries: SentPickedElementEntry[];
}) {
  const ctx = use(TimelineRowCtx);
  const revealPickedElement = ctx.onRevealPickedElement;
  const threadId = ctx.activeThreadId;
  const first = props.entries[0];
  if (first === undefined) {
    return null;
  }
  const onRevealMember =
    revealPickedElement === undefined || threadId === null
      ? undefined
      : (index: number) => {
          const entry = props.entries[index];
          if (entry === undefined) {
            return;
          }
          revealPickedElement({
            ...entry.context,
            id: entry.id,
            threadId,
            createdAt: entry.createdAt,
          });
        };
  return (
    <PickedElementContextGroupChip
      contexts={props.entries.map((entry) => entry.context)}
      chipId={first.id}
      onRevealMember={onRevealMember}
    />
  );
});

const UserMessageDrawingInlineLabel = memo(function UserMessageDrawingInlineLabel(props: {
  entry: ParsedDrawingContextEntry;
}) {
  const descriptor = formatParsedDrawingDescriptor(props.entry);
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={200}
        closeDelay={0}
        render={
          <button
            type="button"
            aria-label={`View ${descriptor}`}
            className="inline-flex max-w-56 cursor-pointer items-center gap-1.5 rounded-md border border-border/70 bg-accent/40 py-1 px-2 text-[12px] font-medium leading-tight text-foreground outline-none transition-colors hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring"
          >
            <PencilIcon className="size-3 shrink-0 text-muted-foreground/70" />
            <span className="min-w-0 truncate">{descriptor}</span>
            {props.entry.note === null ? null : (
              <span
                aria-label="Has a note"
                className="size-1 shrink-0 rounded-full bg-primary-readable"
              />
            )}
          </button>
        }
      />
      <PopoverPopup
        className="w-72"
        viewportClassName="p-2 [--viewport-inline-padding:--spacing(2)]"
        side="top"
        align="start"
      >
        <p className="truncate text-xs font-medium text-foreground">{descriptor}</p>
        {props.entry.url.length === 0 ? null : (
          <p className="mb-1.5 truncate font-mono text-[10px] text-muted-foreground/70">
            {props.entry.url}
          </p>
        )}
        {props.entry.circled.length === 0 ? null : (
          <ul className="mb-1.5 flex flex-col gap-0.5">
            {props.entry.circled.map((label) => (
              <li key={label} className="truncate font-mono text-[10px] text-muted-foreground">
                {label}
              </li>
            ))}
          </ul>
        )}
        {props.entry.note === null ? null : (
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-snug text-foreground">
            {props.entry.note}
          </p>
        )}
      </PopoverPopup>
    </Popover>
  );
});

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  transcriptHighlights: ParsedTranscriptHighlightContextEntry[];
  pickedElements: SentPickedElementEntry[];
  drawings: Array<{ id: string; entry: ParsedDrawingContextEntry }>;
  transcriptMessage?: { id: MessageId; role: TranscriptHighlightSourceRole } | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  forceExpanded?: boolean | undefined;
  searchHighlightQuery?: string | undefined;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody =
    props.text.trim().length > 0 ||
    props.terminalContexts.length > 0 ||
    props.transcriptHighlights.length > 0;
  const hasAttachedContextChips = props.pickedElements.length > 0 || props.drawings.length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded && !props.forceExpanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-transcript-message-body={props.transcriptMessage ? "true" : undefined}
          data-transcript-message-id={props.transcriptMessage?.id}
          data-transcript-message-role={props.transcriptMessage?.role}
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={isCollapsed ? COLLAPSED_MESSAGE_FADE_STYLE : undefined}
        >
          <UserMessageBody
            text={props.text}
            terminalContexts={props.terminalContexts}
            transcriptHighlights={props.transcriptHighlights}
            skills={props.skills}
            searchHighlightQuery={props.searchHighlightQuery}
          />
        </div>
      ) : null}
      {hasAttachedContextChips ? (
        // Outside the collapsible region: the chips are the evidence attached
        // to the message, and folding the text should not hide them.
        <div
          className={cn("flex flex-wrap gap-1.5", hasVisibleBody && "mt-2")}
          data-testid="sent-context-chips"
        >
          {/* Elements that were attached as one annotation come back out of
              the message sharing a groupId, and show as the one chip they
              were sent as. */}
          {groupPickedElementContexts(
            props.pickedElements.map((entry) => ({ ...entry.context, entry })),
          ).map((cluster) => {
            const first = cluster[0];
            if (first === undefined) {
              return null;
            }
            return cluster.length === 1 ? (
              <UserMessagePickedElementChip key={first.entry.id} entry={first.entry} />
            ) : (
              <UserMessagePickedElementGroupChip
                key={first.entry.id}
                entries={cluster.map((member) => member.entry)}
              />
            );
          })}
          {props.drawings.map(({ id, entry }) => (
            <UserMessageDrawingInlineLabel key={id} entry={entry} />
          ))}
        </div>
      ) : null}
      {canCollapse || props.footer ? (
        <div
          className={cn(
            "mt-1.5 flex items-center gap-2",
            canCollapse && props.footer ? "justify-between" : "justify-end",
          )}
          data-user-message-footer="true"
        >
          {canCollapse ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={expanded}
              data-scroll-anchor-ignore
              onClick={() => setExpanded((value) => !value)}
              className="-ml-1 h-6 rounded-md px-1.5 text-xs text-muted-foreground/72 hover:bg-muted/55 hover:text-foreground/85"
            >
              {expanded ? "Show less" : "Show full message"}
            </Button>
          ) : null}
          {props.footer ? (
            <div className="ml-auto flex items-center gap-2">{props.footer}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  transcriptHighlights: ParsedTranscriptHighlightContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  searchHighlightQuery?: string | undefined;
}) {
  const transcriptHighlightNodes =
    props.transcriptHighlights.length > 0 ? (
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {props.transcriptHighlights.map((context) => (
          <UserMessageTranscriptHighlightInlineLabel
            key={`user-transcript-highlight:${context.sourceRole}:${context.sourceMessageId}:${context.selectedText}:${context.note}`}
            context={context}
          />
        ))}
      </div>
    ) : null;

  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              <SkillInlineText
                text={props.text.slice(cursor, matchIndex)}
                skills={props.skills}
                searchHighlightQuery={props.searchHighlightQuery}
              />
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              <SkillInlineText
                text={props.text.slice(cursor)}
                skills={props.skills}
                searchHighlightQuery={props.searchHighlightQuery}
              />
            </span>,
          );
        }

        return (
          <>
            {transcriptHighlightNodes}
            <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
              {inlineNodes}
            </div>
          </>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        <span key="user-message-terminal-context-inline-text">
          <SkillInlineText
            text={props.text}
            skills={props.skills}
            searchHighlightQuery={props.searchHighlightQuery}
          />
        </span>,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <>
        {transcriptHighlightNodes}
        <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
          {inlineNodes}
        </div>
      </>
    );
  }

  if (props.text.length === 0 && transcriptHighlightNodes === null) {
    return null;
  }

  return (
    <>
      {transcriptHighlightNodes}
      {props.text.length > 0 ? (
        <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
          <SkillInlineText
            text={props.text}
            skills={props.skills}
            searchHighlightQuery={props.searchHighlightQuery}
          />
        </div>
      ) : null}
    </>
  );
});

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** "45s", "3m 35s", "1h 12m". */
function formatWorkingDuration(elapsedMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatWorkingTimerNow(startIso: string): string {
  const startedAtMs = Date.parse(startIso);
  return Number.isFinite(startedAtMs) ? formatWorkingDuration(Date.now() - startedAtMs) : "0s";
}

function normalizeDiffMatchPath(filePath: string): string {
  return filePath
    .replaceAll("\\", "/")
    .replace(/^\/([A-Za-z]:\/)/, "$1")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function diffPathsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeDiffMatchPath(left);
  const normalizedRight = normalizeDiffMatchPath(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
}

function summarizeWorkEntryDiffStat(
  workEntry: Pick<TimelineWorkEntry, "changedFiles" | "changedFileStats" | "turnId">,
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>,
): { additions: number; deletions: number } | null {
  // Provider-reported stats are exact for the edits in this entry; the
  // checkpoint turn diff below is only a fallback (it can lag or be missing).
  const providerStats = workEntry.changedFileStats ?? [];
  if (providerStats.length > 0) {
    let additions = 0;
    let deletions = 0;
    for (const stat of providerStats) {
      additions += stat.additions;
      deletions += stat.deletions;
    }
    return { additions, deletions };
  }

  if ((workEntry.changedFiles?.length ?? 0) === 0) {
    return null;
  }
  const turnSummary = resolveWorkEntryTurnDiffSummary(workEntry, turnDiffSummaryByTurnId);
  if (!turnSummary) {
    return null;
  }

  const matchedDiffPaths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const diffFile of turnSummary.files) {
    if (
      !workEntry.changedFiles?.some((changedFile) => diffPathsMatch(changedFile, diffFile.path))
    ) {
      continue;
    }
    const matchKey = normalizeDiffMatchPath(diffFile.path);
    if (matchedDiffPaths.has(matchKey)) {
      continue;
    }
    matchedDiffPaths.add(matchKey);
    additions += diffFile.additions ?? 0;
    deletions += diffFile.deletions ?? 0;
  }

  return matchedDiffPaths.size > 0 ? { additions, deletions } : null;
}

function resolveWorkEntryTurnDiffSummary(
  workEntry: Pick<TimelineWorkEntry, "changedFiles" | "turnId">,
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>,
): TurnDiffSummary | null {
  if (workEntry.turnId) {
    return turnDiffSummaryByTurnId.get(workEntry.turnId) ?? null;
  }
  return null;
}

function providerAuthReconnectProviderLabel(provider: ProviderDriverKind): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? formatProviderDriverKindLabel(provider);
}

const ProviderAuthReconnectCard = memo(function ProviderAuthReconnectCard({
  action,
  onRun,
  className,
  resolved = false,
}: {
  action: ProviderAuthReconnectAction;
  onRun?: (action: ProviderAuthReconnectAction) => void;
  className?: string;
  resolved?: boolean;
}) {
  const providerLabel = providerAuthReconnectProviderLabel(action.provider);

  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2",
        resolved ? "border-success/25 bg-success/5" : "border-destructive/25 bg-destructive/5",
        className,
      )}
      data-provider-auth-reconnect="true"
      data-provider-auth-reconnect-resolved={resolved ? "true" : "false"}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm",
            resolved ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
          )}
        >
          {resolved ? (
            <CheckIcon className="size-3.5" aria-hidden />
          ) : (
            <LogInIcon className="size-3.5" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-medium leading-5 text-foreground">
            {resolved ? `${providerLabel} sign-in refreshed` : `${providerLabel} needs sign in`}
          </p>
          <p className="text-[11px] leading-5 text-muted-foreground/80">
            {resolved ? (
              <>A later response succeeded. Retry the failed message if you still need it.</>
            ) : (
              <>
                Run <code className="font-mono text-foreground/85">{action.command}</code>, complete
                the browser sign-in, then retry this message.
              </>
            )}
          </p>
          <p className="line-clamp-2 text-[10px] leading-4 text-muted-foreground/55">
            Last error: {action.message}
          </p>
        </div>
        {resolved ? (
          <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-success/20 bg-success/5 px-2 text-xs font-medium text-success">
            <CheckIcon className="size-3" aria-hidden />
            Resolved
          </span>
        ) : (
          <Button
            type="button"
            size="xs"
            className="shrink-0"
            disabled={!onRun}
            onClick={(event) => {
              event.stopPropagation();
              onRun?.(action);
            }}
          >
            <TerminalIcon className="size-3" />
            Sign in in terminal
          </Button>
        )}
      </div>
    </div>
  );
});

const McpAuthReconnectCard = memo(function McpAuthReconnectCard({
  action,
  onRun,
  className,
  status,
}: {
  action: McpAuthReconnectAction;
  onRun?: (action: McpAuthReconnectAction) => void;
  className?: string;
  status?: McpAuthReconnectStatus | undefined;
}) {
  const resolved = status === "completed";
  const running = status === "running";

  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2",
        resolved ? "border-success/25 bg-success/5" : "border-warning/25 bg-warning/5",
        className,
      )}
      data-mcp-auth-reconnect="true"
      data-mcp-auth-reconnect-status={status ?? "idle"}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm",
            resolved ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
          )}
        >
          {resolved ? (
            <CheckIcon className="size-3.5" aria-hidden />
          ) : running ? (
            <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <KeyRoundIcon className="size-3.5" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs font-medium leading-5 text-foreground">
            {resolved
              ? `${action.serverLabel} MCP authorized`
              : `${action.serverLabel} MCP needs login`}
          </p>
          <p className="text-[11px] leading-5 text-muted-foreground/80">
            {resolved
              ? "Authorization completed. Retry the failed message if this turn needed the MCP server."
              : "This MCP server did not start for this thread. Authorize it, then retry if this turn needed it."}
          </p>
          <p className="line-clamp-2 text-[10px] leading-4 text-muted-foreground/55">
            Last error: {action.message}
          </p>
        </div>
        {resolved ? (
          <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-success/20 bg-success/5 px-2 text-xs font-medium text-success">
            <CheckIcon className="size-3" aria-hidden />
            Authorized
          </span>
        ) : (
          <Button
            type="button"
            size="xs"
            className="shrink-0"
            disabled={!onRun || running}
            onClick={(event) => {
              event.stopPropagation();
              onRun?.(action);
            }}
          >
            {running ? (
              <LoaderIcon className="size-3 animate-spin" />
            ) : (
              <KeyRoundIcon className="size-3" />
            )}
            {running ? "Authorizing..." : action.actionLabel}
          </Button>
        )}
      </div>
    </div>
  );
});

/** Who wrote this stretch of a room: provider icon, name, and the model it runs. */
function RoomAuthorLine({ label }: { label: RoomAgentLabel | undefined }) {
  if (!label) {
    return (
      <div className="mb-1 font-mono text-[10.5px] text-muted-foreground">an agent that left</div>
    );
  }
  return (
    <div className="mb-1 flex items-center gap-1.5 text-xs">
      {label.entry ? (
        <ProviderInstanceIcon
          driverKind={label.entry.driverKind}
          displayName={label.entry.displayName}
          accentColor={label.entry.accentColor}
          showBadge={false}
          className="size-3.5"
          iconClassName="size-3.5"
        />
      ) : null}
      <span className="font-medium text-foreground">{label.name}</span>
    </div>
  );
}

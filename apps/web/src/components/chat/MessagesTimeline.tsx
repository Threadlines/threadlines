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
  formatElapsed,
  formatSubagentDisplayName,
  shouldShowSubagentDisplayChip,
  type McpAuthReconnectAction,
  type ProviderAuthReconnectAction,
} from "../../session-logic";
import { DEFAULT_SCROLL_END_TOLERANCE_PX, isScrollMetricsAtEnd } from "../ChatView.logic";
import { type ChatAttachment, type TurnDiffSummary } from "../../types";
import { chatAttachmentPreviewQueryOptions } from "../../lib/attachmentPreviewQuery";
import { environmentUsesRelayTransport } from "../../environments/runtime";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  CopyIcon,
  EyeIcon,
  FileTextIcon,
  GlobeIcon,
  HammerIcon,
  KeyRoundIcon,
  LoaderIcon,
  LogInIcon,
  SearchIcon,
  ShieldCheckIcon,
  SplitIcon,
  SquarePenIcon,
  TerminalIcon,
  type LucideIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { LiveNode, SpineRow } from "../ui/threadline";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import type { FilePreviewRequest } from "./FilePreviewDialog";
import { loadChatAttachmentBlob } from "../../lib/attachmentPreviewQuery";
import { ProposedPlanCard, type ProposedPlanCardStatus } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeStableMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
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
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@threadlines/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";
import { useSettings } from "../../hooks/useSettings";
import { findSearchTextHighlightSpans } from "../../lib/searchTextHighlight";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { SkillInlineText } from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import type {
  ParsedTranscriptHighlightContextEntry,
  TranscriptHighlightContextSelection,
  TranscriptHighlightSourceRole,
} from "~/lib/transcriptHighlightContext";
import { formatTranscriptHighlightContextPreview } from "~/lib/transcriptHighlightContext";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via Context.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  activeThreadEnvironmentId: EnvironmentId;
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>;
  providerAuthReconnect: ProviderAuthReconnectAction | null;
  resolvedProviderAuthReconnectIds: ReadonlySet<string>;
  mcpAuthReconnectStatusByServerName: ReadonlyMap<string, McpAuthReconnectStatus>;
  onRevertUserMessage: (messageId: MessageId) => void;
  onContinueInNewThread?: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onPreviewFile: (request: FilePreviewRequest) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onRunProviderAuthReconnect?: (action: ProviderAuthReconnectAction) => void;
  onRunMcpAuthReconnect?: (action: McpAuthReconnectAction) => void;
  searchTargetMessageId: MessageId | null;
  searchTargetQuery: string;
  activeSearchTargetMessageId: MessageId | null;
  proposedPlanState: TimelineProposedPlanState | null;
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
const LIVE_WORK_LOG_ENTRY_COUNT = 3;
const INITIAL_STICK_TO_BOTTOM_FRAME_COUNT = 3;
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
const MAINTAIN_SCROLL_AT_END = { animated: false } as const;
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

function isTimelineListAtEnd(list: LegendListRef | null): boolean {
  const scrollableNode = list?.getScrollableNode?.();
  if (!scrollableNode || typeof scrollableNode !== "object") {
    return Boolean(list?.getState?.().isAtEnd);
  }

  const metrics = scrollableNode as {
    readonly scrollTop?: number | null;
    readonly scrollHeight?: number | null;
    readonly clientHeight?: number | null;
  };
  const viewportLength = finiteScrollMetric(metrics.clientHeight);
  const contentLength = finiteScrollMetric(metrics.scrollHeight);
  if (viewportLength === null || contentLength === null) {
    return Boolean(list?.getState?.().isAtEnd);
  }

  return isScrollMetricsAtEnd({
    scrollOffset: finiteScrollMetric(metrics.scrollTop) ?? 0,
    viewportLength,
    contentLength,
    tolerancePx: DEFAULT_SCROLL_END_TOLERANCE_PX,
  });
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
  isWorking: boolean;
  activeStatusLabel?: string | undefined;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  stickToBottomRequestKey?: number;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  onContinueInNewThread?: (messageId: MessageId) => void;
  onAddTranscriptHighlightContext?: (selection: TranscriptHighlightContextSelection) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onPreviewFile: (request: FilePreviewRequest) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  providerAuthReconnect?: ProviderAuthReconnectAction | null;
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
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  activeStatusLabel,
  activeTurnInProgress,
  activeTurnId,
  activeTurnStartedAt,
  listRef,
  stickToBottomRequestKey = 0,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  onContinueInNewThread,
  onAddTranscriptHighlightContext,
  isRevertingCheckpoint,
  onImageExpand,
  onPreviewFile,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  providerAuthReconnect = null,
  onRunProviderAuthReconnect,
  mcpAuthReconnectStatusByServerName = EMPTY_MCP_AUTH_RECONNECT_STATUS,
  onRunMcpAuthReconnect,
  onIsAtEndChange,
  searchTarget = null,
  planScrollTarget = null,
  proposedPlanState = null,
}: MessagesTimelineProps) {
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        completionSummary,
        isWorking,
        activeStatusLabel,
        activeTurnInProgress,
        activeTurnId: activeTurnId ?? null,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      completionDividerBeforeEntryId,
      completionSummary,
      isWorking,
      activeStatusLabel,
      activeTurnInProgress,
      activeTurnId,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);
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
  const lastHandledStickToBottomRequestKeyRef = useRef(stickToBottomRequestKey);
  const userScrollLockTimerRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const timelineContainerRef = useRef<HTMLDivElement | null>(null);
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

  const enableAutoStickIfAtEnd = useCallback(() => {
    if (!isTimelineListAtEnd(listRef.current)) {
      return;
    }
    setAutoStickToBottomState(true);
    onIsAtEndChange(true);
  }, [listRef, onIsAtEndChange, setAutoStickToBottomState]);

  const markUserScrollIntent = useCallback(
    (options?: { notifyAwayFromEnd?: boolean }) => {
      clearUserScrollLockTimer();
      setAutoStickToBottomState(false);
      if (options?.notifyAwayFromEnd) {
        onIsAtEndChange(false);
      }
      userScrollLockTimerRef.current = window.setTimeout(() => {
        userScrollLockTimerRef.current = null;
        enableAutoStickIfAtEnd();
      }, USER_SCROLL_STICK_LOCK_MS);
    },
    [clearUserScrollLockTimer, enableAutoStickIfAtEnd, onIsAtEndChange, setAutoStickToBottomState],
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
      const eventAtEnd = isTimelineScrollEventAtEnd(event);
      const nextIsAtEnd =
        eventAtEnd !== null ? eventAtEnd : Boolean(listRef.current?.getState?.().isAtEnd);
      if (!nextIsAtEnd && (autoStickToBottomRef.current || stickToBottomRequestPending)) {
        onIsAtEndChange(true);
        return;
      }
      if (nextIsAtEnd) {
        clearUserScrollLockTimer();
        setAutoStickToBottomState(true);
      }
      onIsAtEndChange(nextIsAtEnd);
    },
    [
      clearUserScrollLockTimer,
      listRef,
      onIsAtEndChange,
      refreshTranscriptNoteHighlightRects,
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

  const handleTouchStartCapture = useCallback((event: ReactTouchEvent) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

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

  const handleTouchEndCapture = useCallback(() => {
    touchStartYRef.current = null;
  }, []);

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
  const lastRow = hasRows ? rows[rows.length - 1] : null;

  useEffect(() => {
    if (!hasRows || searchTargetRowIndex >= 0) {
      return;
    }

    const frameIds: number[] = [];
    const stickToBottom = () => {
      clearUserScrollLockTimer();
      setAutoStickToBottomState(true);
      onIsAtEndChange(true);
      void listRef.current?.scrollToEnd?.({ animated: false });
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

    scheduleFrame(INITIAL_STICK_TO_BOTTOM_FRAME_COUNT);

    return () => {
      for (const frameId of frameIds) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [
    clearUserScrollLockTimer,
    hasRows,
    listRef,
    onIsAtEndChange,
    routeThreadKey,
    searchTargetRowIndex,
    setAutoStickToBottomState,
  ]);

  useEffect(() => {
    if (!hasRows || stickToBottomRequestKey === lastHandledStickToBottomRequestKeyRef.current) {
      return;
    }

    lastHandledStickToBottomRequestKeyRef.current = stickToBottomRequestKey;

    const frameIds: number[] = [];
    const stickToBottom = () => {
      clearUserScrollLockTimer();
      setAutoStickToBottomState(true);
      onIsAtEndChange(true);
      void listRef.current?.scrollToEnd?.({ animated: false });
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

    scheduleFrame(INITIAL_STICK_TO_BOTTOM_FRAME_COUNT);

    return () => {
      for (const frameId of frameIds) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [
    clearUserScrollLockTimer,
    hasRows,
    listRef,
    onIsAtEndChange,
    setAutoStickToBottomState,
    stickToBottomRequestKey,
  ]);

  useEffect(() => {
    if (!lastRow || (!activeTurnInProgress && !stickToBottomRequestPending)) {
      return;
    }
    if (!autoStickToBottomRef.current && !stickToBottomRequestPending) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (!autoStickToBottomRef.current && !stickToBottomRequestPending) {
        return;
      }
      void listRef.current?.scrollToEnd?.({ animated: false });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [activeTurnInProgress, lastRow, listRef, stickToBottomRequestPending]);

  useEffect(() => {
    return () => {
      clearUserScrollLockTimer();
    };
  }, [clearUserScrollLockTimer]);

  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      turnDiffSummaryByTurnId,
      providerAuthReconnect,
      resolvedProviderAuthReconnectIds,
      mcpAuthReconnectStatusByServerName,
      onRevertUserMessage,
      ...(onContinueInNewThread ? { onContinueInNewThread } : {}),
      onImageExpand,
      onPreviewFile,
      onOpenTurnDiff,
      ...(onRunProviderAuthReconnect ? { onRunProviderAuthReconnect } : {}),
      ...(onRunMcpAuthReconnect ? { onRunMcpAuthReconnect } : {}),
      searchTargetMessageId: searchTarget?.messageId ?? null,
      searchTargetQuery: searchTarget?.query ?? "",
      activeSearchTargetMessageId,
      proposedPlanState,
    }),
    [
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      activeThreadEnvironmentId,
      turnDiffSummaryByTurnId,
      providerAuthReconnect,
      resolvedProviderAuthReconnectIds,
      mcpAuthReconnectStatusByServerName,
      onRevertUserMessage,
      onContinueInNewThread,
      onImageExpand,
      onPreviewFile,
      onOpenTurnDiff,
      onRunProviderAuthReconnect,
      onRunMcpAuthReconnect,
      searchTarget?.messageId,
      searchTarget?.query,
      activeSearchTargetMessageId,
      proposedPlanState,
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
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-4xl overflow-x-clip" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
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
            ref={assignLegendListRef}
            data={rows}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            estimatedItemSize={90}
            initialScrollAtEnd={searchTargetRowIndex < 0}
            {...(searchTargetRowIndex >= 0
              ? { initialScrollIndex: { index: searchTargetRowIndex, viewPosition: 0.35 } }
              : {})}
            maintainScrollAtEnd={
              searchTargetRowIndex < 0 && (autoStickToBottom || stickToBottomRequestPending)
                ? MAINTAIN_SCROLL_AT_END
                : false
            }
            maintainScrollAtEndThreshold={TIMELINE_MAINTAIN_END_THRESHOLD_RATIO}
            maintainVisibleContentPosition
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
};

const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const ctx = use(TimelineRowCtx);
  const isActiveSearchTarget =
    row.kind === "message" && row.message.id === ctx.activeSearchTargetMessageId;
  return (
    <div
      className={cn("pb-4", isActiveSearchTarget && "thread-search-target-pulse")}
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
      {row.kind === "subagent-result" ? <SubagentResultTimelineRow row={row} /> : null}
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
 * URL. Relay-paired environments (phonelink) can't reach that route — the
 * relay tunnels only the WebSocket — so swap those previews for data URLs
 * fetched over the RPC channel. Locally-echoed blob/data previews (composer
 * handoff) pass through untouched. Only chat attachments belong here: work
 * entry images may carry foreign http URLs that are not stored attachments.
 */
function useResolvedAttachmentPreviews(
  images: ReadonlyArray<TimelineImagePreviewItem>,
): ReadonlyArray<TimelineImagePreviewItem> {
  const ctx = use(TimelineRowCtx);
  const environmentId = ctx.activeThreadEnvironmentId;
  const rpcImages =
    images.length > 0 && environmentUsesRelayTransport(environmentId)
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
  const canRevertAgentWork = typeof row.revertTurnCount === "number";

  return (
    <div className="flex justify-end">
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
              <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                {displayedUserMessage.copyText && (
                  <MessageCopyButton text={displayedUserMessage.copyText} />
                )}
                {displayedUserMessage.copyText && (
                  <ContinueInNewThreadButton messageId={row.message.id} />
                )}
                {canRevertAgentWork && <RevertUserMessageButton messageId={row.message.id} />}
              </div>
              <p className="text-right text-xs tracking-tight tabular-nums text-muted-foreground/50">
                {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
              </p>
            </>
          }
        />
      </div>
    </div>
  );
}

const TimelineImagePreviewGrid = memo(function TimelineImagePreviewGrid(props: {
  images: ReadonlyArray<TimelineImagePreviewItem>;
  className?: string | undefined;
  imageClassName?: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);
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
        <div
          key={image.id}
          className="overflow-hidden rounded-lg border border-border/80 bg-background/70"
        >
          {image.previewUrl ? (
            <button
              type="button"
              className="h-full w-full cursor-zoom-in"
              aria-label={`Preview ${image.name}`}
              onClick={() => {
                const preview = buildExpandedImagePreview(props.images, image.id);
                if (!preview) return;
                ctx.onImageExpand(preview);
              }}
            >
              <img
                src={image.previewUrl}
                alt={image.name}
                className={cn("block h-auto w-full", props.imageClassName)}
              />
            </button>
          ) : (
            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
              {image.name}
            </div>
          )}
        </div>
      ))}
    </div>
  );
});

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
      aria-label="Continue in new thread"
      tooltip="Continue in new thread"
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
  const authReconnect =
    ctx.providerAuthReconnect && isProviderAuthErrorMessage(messageText)
      ? ctx.providerAuthReconnect
      : null;

  return (
    <>
      {row.showCompletionDivider && (
        <AssistantCompletionDivider completionSummary={row.completionSummary} />
      )}
      <div className="min-w-0 px-1 py-0.5">
        <div
          className="group/assistant-message block w-full max-w-full align-top"
          data-assistant-message-section="true"
        >
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
          <AssistantChangedFilesSection
            turnSummary={row.assistantTurnDiffSummary}
            isTurnInProgress={row.assistantTurnInProgress}
            routeThreadKey={ctx.routeThreadKey}
            resolvedTheme={ctx.resolvedTheme}
            onOpenTurnDiff={ctx.onOpenTurnDiff}
          />
          <div className="mt-1.5 flex items-center gap-2">
            <p className="text-[10px] tracking-tight tabular-nums text-muted-foreground/30">
              {row.message.streaming ? (
                <LiveMessageMeta
                  createdAt={row.message.createdAt}
                  durationStart={row.durationStart}
                  timestampFormat={ctx.timestampFormat}
                />
              ) : (
                formatMessageMeta(
                  row.message.createdAt,
                  formatElapsed(row.durationStart, row.message.completedAt),
                  ctx.timestampFormat,
                )
              )}
            </p>
            {!row.message.streaming && row.message.text.trim().length > 0 ? (
              <ContinueInNewThreadButton
                messageId={row.message.id}
                className="pointer-events-none border-border/50 bg-background/35 text-muted-foreground/45 opacity-0 shadow-none transition-opacity duration-200 hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70 group-hover/assistant-message:pointer-events-auto group-hover/assistant-message:opacity-100 group-focus-within/assistant-message:pointer-events-auto group-focus-within/assistant-message:opacity-100"
              />
            ) : null}
            <AssistantCopyButton row={row} />
          </div>
        </div>
      </div>
    </>
  );
}

function AssistantCompletionDivider({ completionSummary }: { completionSummary: string | null }) {
  return (
    <div className="my-3 flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
        {completionSummary ? `Response • ${completionSummary}` : "Response"}
      </span>
      <span className="h-px flex-1 bg-border" />
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

/** Shared auto-collapse mechanics for long chat content: user messages and
 *  subagent results use the same threshold shape and bottom fade. */
function shouldCollapseMessageText(
  text: string,
  limits: { maxLength: number; maxLines: number },
): boolean {
  if (text.trim().length === 0) {
    return false;
  }
  return text.length > limits.maxLength || text.split("\n").length > limits.maxLines;
}

const COLLAPSED_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;
const COLLAPSED_MESSAGE_FADE_STYLE: CSSProperties = {
  WebkitMaskImage: COLLAPSED_MESSAGE_FADE_MASK,
  maskImage: COLLAPSED_MESSAGE_FADE_MASK,
};

const MAX_COLLAPSED_SUBAGENT_RESULT_LINES = 12;
const MAX_COLLAPSED_SUBAGENT_RESULT_LENGTH = 900;

function SubagentResultTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "subagent-result" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  const metaChips = [row.result.model, row.result.reasoningEffort].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  const displayName = formatSubagentDisplayName(row.result);
  const showSubagentChip = shouldShowSubagentDisplayChip(row.result);
  const canCollapse = shouldCollapseMessageText(row.result.body, {
    maxLength: MAX_COLLAPSED_SUBAGENT_RESULT_LENGTH,
    maxLines: MAX_COLLAPSED_SUBAGENT_RESULT_LINES,
  });
  const isCollapsed = canCollapse && !expanded;

  return (
    <div className="min-w-0 px-1 py-0.5" data-subagent-result-row="true">
      <div className="max-w-2xl rounded-lg border border-border/65 bg-muted/20 px-3 py-2.5">
        <div className="mb-2 flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary-readable">
              <BotIcon className="size-3" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-1.5">
                <p
                  className="truncate text-xs font-medium text-foreground"
                  title={row.result.label}
                >
                  {displayName}
                </p>
                {showSubagentChip ? (
                  <span className="shrink-0 rounded border border-border/55 bg-background/55 px-1 py-px text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55">
                    Subagent
                  </span>
                ) : null}
              </div>
              {row.result.objective ? (
                <ExpandableSubagentInstructionText text={row.result.objective} />
              ) : null}
            </div>
          </div>
          <span className="shrink-0 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
            Done
          </span>
        </div>
        <div
          className={cn(
            "relative min-w-0 border-l border-border/60 pl-3",
            isCollapsed && "max-h-56 overflow-hidden",
          )}
          data-subagent-result-body="true"
          data-subagent-result-collapsed={isCollapsed ? "true" : "false"}
          data-subagent-result-collapsible={canCollapse ? "true" : "false"}
          style={isCollapsed ? COLLAPSED_MESSAGE_FADE_STYLE : undefined}
        >
          <ChatMarkdown
            text={row.result.body}
            cwd={ctx.markdownCwd}
            environmentId={ctx.activeThreadEnvironmentId}
            isStreaming={false}
            skills={ctx.skills}
          />
        </div>
        <div
          className="mt-2 flex items-center justify-between gap-2"
          data-subagent-result-footer="true"
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
              {expanded ? "Show less" : "Show full result"}
            </Button>
          ) : (
            <p className="truncate text-[10px] text-muted-foreground/40">Subagent result</p>
          )}
          <div className="flex shrink-0 items-center gap-1.5">
            {metaChips.map((chip) => (
              <span
                key={chip}
                className="rounded border border-border/55 bg-background/55 px-1.5 py-0.5 text-[9px] leading-none tracking-[0.08em] text-muted-foreground/70 uppercase"
                data-subagent-result-meta-chip="true"
              >
                {chip}
              </span>
            ))}
            <p className="shrink-0 text-[10px] tracking-tight tabular-nums text-muted-foreground/30">
              {formatTimestamp(row.createdAt, ctx.timestampFormat)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ExpandableSubagentInstructionText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const textElementRef = useRef<HTMLElement | null>(null);
  const setParagraphRef = useCallback((node: HTMLParagraphElement | null) => {
    textElementRef.current = node;
  }, []);
  const setButtonRef = useCallback((node: HTMLButtonElement | null) => {
    textElementRef.current = node;
  }, []);
  const measureTruncation = useCallback(() => {
    if (expanded) {
      return;
    }
    const element = textElementRef.current;
    if (!element) {
      return;
    }
    const nextTruncated =
      element.scrollHeight > element.clientHeight + 1 ||
      element.scrollWidth > element.clientWidth + 1;
    setTruncated((current) => (current === nextTruncated ? current : nextTruncated));
  }, [expanded]);

  useEffect(() => {
    setExpanded(false);
    setTruncated(false);
  }, [text]);

  useEffect(() => {
    if (expanded) {
      return;
    }

    const element = textElementRef.current;
    if (!element) {
      return;
    }

    const animationFrameId = window.requestAnimationFrame(measureTruncation);
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measureTruncation);
      return () => {
        window.cancelAnimationFrame(animationFrameId);
        window.removeEventListener("resize", measureTruncation);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      measureTruncation();
    });
    resizeObserver.observe(element);
    return () => {
      window.cancelAnimationFrame(animationFrameId);
      resizeObserver.disconnect();
    };
  }, [expanded, measureTruncation, text]);

  const className = cn(
    "mt-0.5 w-full text-left text-[11px] leading-4 text-muted-foreground/70",
    !expanded && "line-clamp-2",
    (truncated || expanded) &&
      "cursor-pointer rounded-sm transition-colors hover:text-muted-foreground/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/45",
  );

  if (truncated || expanded) {
    return (
      <button
        type="button"
        ref={setButtonRef}
        className={className}
        title={expanded ? "Collapse subagent instructions" : text}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse subagent instructions" : "Expand subagent instructions"}
        data-subagent-result-objective="true"
        data-subagent-result-objective-expanded={expanded ? "true" : "false"}
        data-subagent-result-objective-truncated={truncated ? "true" : "false"}
        onClick={() => setExpanded((current) => !current)}
      >
        {text}
      </button>
    );
  }

  return (
    <p
      ref={setParagraphRef}
      className={className}
      title={text}
      data-subagent-result-objective="true"
      data-subagent-result-objective-expanded="false"
      data-subagent-result-objective-truncated="false"
    >
      {text}
    </p>
  );
}

function WorkingTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "working" }> }) {
  return (
    <div className="py-0.5 pl-1.5">
      <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70">
        {/* The chat surface's one live node: the thread is being worked right now. */}
        <LiveNode className="size-1.5 [--thread-halo-delay:0.2s]" />
        <span>
          {row.createdAt ? (
            <>
              {row.label} <span className="text-muted-foreground/40">·</span>{" "}
              <WorkingTimer createdAt={row.createdAt} />
            </>
          ) : (
            `${row.label}...`
          )}
        </span>
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

function RunningCommandTimer({ createdAt }: { createdAt: string }) {
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

/** Live timestamp + elapsed duration for a streaming assistant message. */
function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string | null | undefined;
  timestampFormat: TimestampFormat;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialText = formatLiveMessageMetaNow(createdAt, durationStart, timestampFormat);

  useEffect(() => {
    const updateText = () => {
      if (textRef.current) {
        textRef.current.textContent = formatLiveMessageMetaNow(
          createdAt,
          durationStart,
          timestampFormat,
        );
      }
    };
    updateText();
    if (!durationStart) {
      return;
    }
    const id = setInterval(updateText, 1000);
    return () => clearInterval(id);
  }, [createdAt, durationStart, timestampFormat]);

  return <span ref={textRef}>{initialText}</span>;
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Owns its own expand/collapse state so toggling re-renders only this row.
 *  State resets on unmount which is fine — work groups start collapsed. */
type SpineNodeKind = "done" | "live" | "warning" | "error" | "group";

const TONE_SPINE_DOT_CLASS_NAME = {
  warning: "size-[6px] rounded-full bg-warning",
  error: "size-[6px] rounded-full bg-destructive",
} as const satisfies Record<"warning" | "error", string>;

/** The glyph that sits on the activity spine for one row. The accent halo is
 *  reserved for the single live terminus; settled steps are quiet solid dots,
 *  warnings/errors are compact tone dots, and a collapsed group of steps is a
 *  hollow ring (same family, reads as "openable"). */
function SpineNode({ kind }: { kind: SpineNodeKind }) {
  if (kind === "live") {
    return <LiveNode className="size-1.5 [--thread-halo-delay:0.2s]" />;
  }
  if (kind === "warning" || kind === "error") {
    return <span aria-hidden="true" className={TONE_SPINE_DOT_CLASS_NAME[kind]} />;
  }
  if (kind === "group") {
    return (
      <span
        aria-hidden="true"
        className="size-[7px] rounded-full border border-muted-foreground/45 bg-background"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="relative z-10 size-[5px] rounded-full bg-[color-mix(in_oklab,var(--muted-foreground)_42%,var(--background))]"
    />
  );
}

function workEntryNodeKind(entry: TimelineWorkEntry): SpineNodeKind {
  if (entry.tone === "error") {
    return "error";
  }
  if (entry.tone === "warning") {
    return "warning";
  }
  return "done";
}

// Completed steps fade as they recede above the live terminus; the floor keeps
// the oldest step legible. Index 0 is the row nearest the live node.
const LIVE_SPINE_DIM = ["opacity-100", "opacity-80", "opacity-65"] as const;
function liveSpineDimClass(indexFromBottom: number): string {
  return LIVE_SPINE_DIM[indexFromBottom] ?? "opacity-50";
}

function liveSpineColor(distanceFromCurrent: number): string {
  if (distanceFromCurrent >= 1.5) {
    return "var(--border)";
  }

  const primaryMix = Math.round(82 - distanceFromCurrent * 48);
  return `color-mix(in oklab, var(--primary-graph) ${primaryMix}%, var(--border))`;
}

function liveSpineSegment(fromDistance: number, toDistance: number): string {
  const from = liveSpineColor(fromDistance);
  const to = liveSpineColor(toDistance);
  return from === to ? from : `linear-gradient(to bottom, ${from}, ${to})`;
}

function liveSpineRowStyle(index: number, lastIndex: number): CSSProperties {
  const distanceFromCurrent = lastIndex - index;
  return {
    ["--spine-top"]: liveSpineSegment(distanceFromCurrent + 0.5, distanceFromCurrent),
    ["--spine-bottom"]: liveSpineSegment(
      distanceFromCurrent,
      Math.max(0, distanceFromCurrent - 0.5),
    ),
  } as CSSProperties;
}

function spineStyle(): CSSProperties {
  return {
    ["--spine"]: "var(--border)",
  } as CSSProperties;
}

const WorkGroupSection = memo(function WorkGroupSection({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "work" }>;
}) {
  const { workspaceRoot, turnDiffSummaryByTurnId } = use(TimelineRowCtx);
  const { isWorking } = use(TimelineRowActivityCtx);
  const [isExpanded, setIsExpanded] = useState(false);
  const previousIsWorkingRef = useRef(isWorking);
  const groupedEntries = useMemo(
    () => coalesceFileChangeWorkEntries(row.groupedEntries, turnDiffSummaryByTurnId, workspaceRoot),
    [row.groupedEntries, turnDiffSummaryByTurnId, workspaceRoot],
  );
  const isLiveActivity = isWorking && row.isLive;

  useEffect(() => {
    const wasWorking = previousIsWorkingRef.current;
    previousIsWorkingRef.current = isWorking;

    if (!wasWorking && isWorking) {
      setIsExpanded(false);
    }
  }, [isWorking]);

  if (isLiveActivity) {
    return (
      <LiveActivitySpine
        entries={groupedEntries}
        liveStartedAt={row.liveStartedAt}
        workspaceRoot={workspaceRoot}
      />
    );
  }

  const summarizedEntries = summarizeSemanticActivityEntries(groupedEntries);
  const hasCompactedEntries = summarizedEntries.length < groupedEntries.length;
  const hasOverflow = summarizedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const shouldRenderReceipt = hasCompactedEntries || hasOverflow;
  const transcriptEntries = isExpanded
    ? groupedEntries
    : hasOverflow
      ? summarizedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : summarizedEntries;

  if (!shouldRenderReceipt) {
    return (
      <div data-work-activity-inline="true" style={spineStyle()}>
        {transcriptEntries.map((workEntry, index) => (
          <SpineRow
            key={`work-row:${workEntry.id}`}
            node={<SpineNode kind={workEntryNodeKind(workEntry)} />}
            connectTop={index > 0}
            connectBottom={index < transcriptEntries.length - 1}
          >
            <SimpleWorkEntryRow
              isLiveActivity={false}
              workEntry={workEntry}
              workspaceRoot={workspaceRoot}
              inSpine
            />
          </SpineRow>
        ))}
      </div>
    );
  }

  const hiddenCount = isExpanded
    ? 0
    : Math.max(0, groupedEntries.length - transcriptEntries.length);
  return (
    <div
      data-work-activity-receipt="true"
      data-work-activity-expanded={isExpanded ? "true" : "false"}
      style={spineStyle()}
    >
      <SpineRow node={<SpineNode kind="group" />} connectTop={false} connectBottom={isExpanded}>
        <ActivityReceipt
          entries={groupedEntries}
          isExpanded={isExpanded}
          onToggle={() => setIsExpanded((value) => !value)}
        />
      </SpineRow>
      {isExpanded ? (
        <div data-activity-transcript="true">
          {transcriptEntries.map((workEntry, index) => (
            <SpineRow
              key={`work-row:${workEntry.id}`}
              node={<SpineNode kind={workEntryNodeKind(workEntry)} />}
              connectBottom={index < transcriptEntries.length - 1}
            >
              <SimpleWorkEntryRow
                isLiveActivity={false}
                workEntry={workEntry}
                workspaceRoot={workspaceRoot}
                inSpine
              />
            </SpineRow>
          ))}
        </div>
      ) : hiddenCount > 0 && !hasCompactedEntries ? (
        <p className="mt-0.5 truncate pl-6 text-[10px] leading-4 text-muted-foreground/45">
          {summarizeHiddenWorkEntries(groupedEntries.slice(0, hiddenCount))}
        </p>
      ) : null}
    </div>
  );
});

/** The live turn rendered as an accent spine: the recent steps dim as they
 *  recede upward toward the single live node — the halo sits directly on the
 *  most recent activity (the running tool, the current reasoning) and ends the
 *  thread, so there is no detached dot and the standalone working row is
 *  absorbed here. */
function LiveActivitySpine({
  entries,
  liveStartedAt,
  workspaceRoot,
}: {
  entries: ReadonlyArray<TimelineWorkEntry>;
  liveStartedAt: string | null;
  workspaceRoot: string | undefined;
}) {
  const liveEntries = deriveLiveActivityEntries(entries);
  const hiddenSummary = summarizeLiveHiddenWorkEntries(entries, liveEntries);
  const lastIndex = liveEntries.length - 1;

  return (
    <div data-live-activity-strip="true" style={spineStyle()}>
      {hiddenSummary ? (
        <p className="truncate pb-0.5 pl-6 text-[10px] leading-4 text-muted-foreground/45">
          {hiddenSummary}
        </p>
      ) : null}
      {liveEntries.map((workEntry, index) => {
        const isCurrent = index === lastIndex;
        return (
          <SpineRow
            key={`work-row:${workEntry.id}`}
            node={<SpineNode kind={isCurrent ? "live" : workEntryNodeKind(workEntry)} />}
            connectTop={index > 0}
            connectBottom={!isCurrent}
            className={isCurrent ? undefined : liveSpineDimClass(lastIndex - index)}
            style={liveSpineRowStyle(index, lastIndex)}
          >
            <>
              <SimpleWorkEntryRow
                isLiveActivity
                workEntry={workEntry}
                workspaceRoot={workspaceRoot}
                inSpine
              />
              {isCurrent && liveStartedAt ? (
                <LiveTurnElapsedTimer createdAt={liveStartedAt} />
              ) : null}
            </>
          </SpineRow>
        );
      })}
    </div>
  );
}

function LiveTurnElapsedTimer({ createdAt }: { createdAt: string }) {
  return (
    <span
      className="-mt-0.5 ml-1 block text-[11px] leading-4 text-muted-foreground/55 tabular-nums"
      data-live-turn-elapsed="true"
      title="Total turn elapsed time"
    >
      Working <span className="text-muted-foreground/35">·</span>{" "}
      <WorkingTimer createdAt={createdAt} />
    </span>
  );
}

function ActivityReceipt({
  entries,
  isExpanded,
  onToggle,
}: {
  entries: ReadonlyArray<TimelineWorkEntry>;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const summary = summarizeActivityReceipt(entries);
  const actionCount = entries.length;
  const duration = formatActivityDuration(entries);

  return (
    <div className="flex min-w-0 items-start justify-between gap-3 py-1">
      <div className="min-w-0">
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-5 text-muted-foreground/80">
          <span className="font-medium text-foreground/75">Activity</span>
          <span className="text-muted-foreground/35">·</span>
          <span>{formatActivityCount(actionCount, "action", "actions")}</span>
          {duration ? (
            <>
              <span className="text-muted-foreground/35">·</span>
              <span>{duration}</span>
            </>
          ) : null}
        </p>
        {summary ? (
          <p className="truncate text-[10px] leading-4 text-muted-foreground/45">{summary}</p>
        ) : null}
      </div>
      <button
        type="button"
        className="shrink-0 text-[10px] font-medium text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
        aria-expanded={isExpanded}
        aria-label={isExpanded ? "Hide activity" : "Show activity"}
        data-activity-transcript-toggle="true"
        onClick={onToggle}
      >
        {isExpanded ? "Hide activity" : "Show activity"}
      </button>
    </div>
  );
}

function summarizeActivityReceipt(entries: ReadonlyArray<TimelineWorkEntry>): string | null {
  const summarizedEntries = summarizeSemanticActivityEntries(entries);
  const parts = summarizedEntries
    .map((entry) => [entry.label, entry.detail].filter(Boolean).join(" · "))
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const visibleParts = parts.slice(0, 2);
  const hiddenCount = parts.length - visibleParts.length;
  return hiddenCount > 0
    ? `${visibleParts.join(" · ")} · +${hiddenCount.toLocaleString()}`
    : visibleParts.join(" · ");
}

function formatActivityDuration(entries: ReadonlyArray<TimelineWorkEntry>): string | null {
  const firstEntry = entries[0];
  const lastEntry = entries.at(-1);
  if (!firstEntry || !lastEntry || firstEntry.id === lastEntry.id) {
    return null;
  }
  const duration = formatWorkingTimer(firstEntry.createdAt, lastEntry.createdAt);
  return duration === "0s" ? null : duration;
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

function deriveLiveActivityEntries(entries: ReadonlyArray<TimelineWorkEntry>): TimelineWorkEntry[] {
  const dedupedEntries = dedupeLiveActivityEntries(entries);
  const selected: TimelineWorkEntry[] = [];

  for (let index = dedupedEntries.length - 1; index >= 0; index -= 1) {
    const entry = dedupedEntries[index];
    if (!entry || !isLivePrimaryWorkEntry(entry)) {
      continue;
    }
    selected.push(entry);
    if (selected.length >= LIVE_WORK_LOG_ENTRY_COUNT) {
      return selected.toReversed();
    }
  }

  for (let index = dedupedEntries.length - 1; index >= 0; index -= 1) {
    const entry = dedupedEntries[index];
    if (!entry || selected.includes(entry) || !isLiveFallbackWorkEntry(entry)) {
      continue;
    }
    selected.push(entry);
    if (selected.length >= LIVE_WORK_LOG_ENTRY_COUNT) {
      break;
    }
  }

  return selected
    .toReversed()
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function dedupeLiveActivityEntries(entries: ReadonlyArray<TimelineWorkEntry>): TimelineWorkEntry[] {
  const seen = new Set<string>();
  const deduped: TimelineWorkEntry[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const key = liveActivityDedupeKey(entry);
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    deduped.push(entry);
  }

  return deduped.toReversed();
}

function liveActivityDedupeKey(entry: TimelineWorkEntry): string | null {
  const subject =
    entry.command ??
    entry.detail ??
    entry.changedFiles?.join("\u001e") ??
    entry.toolTitle ??
    entry.label;
  const normalizedSubject = subject.trim().replace(/\s+/gu, " ").toLowerCase();
  if (!normalizedSubject) {
    return null;
  }
  return [entry.turnId ?? "", entry.itemType ?? "", normalizeCompactToolLabel(normalizedSubject)]
    .join("\u001f")
    .toLowerCase();
}

function isLivePrimaryWorkEntry(entry: TimelineWorkEntry): boolean {
  return (
    entry.executionState === "running" ||
    entry.executionState === "failed" ||
    entry.itemType === "collab_agent_tool_call"
  );
}

function isLiveFallbackWorkEntry(entry: TimelineWorkEntry): boolean {
  if (entry.tone === "thinking" || entry.tone === "warning" || entry.tone === "error") {
    return true;
  }
  return entry.tone === "tool" || entry.tone === "info";
}

function summarizeLiveHiddenWorkEntries(
  allEntries: ReadonlyArray<TimelineWorkEntry>,
  visibleEntries: ReadonlyArray<TimelineWorkEntry>,
): string | null {
  const visibleIds = new Set(visibleEntries.map((entry) => entry.id));
  const hiddenEntries = allEntries.filter((entry) => !visibleIds.has(entry.id));
  const hiddenCount = hiddenEntries.length;
  if (hiddenCount <= 0) {
    return null;
  }
  const runningCount = hiddenEntries.filter((entry) => entry.executionState === "running").length;
  const delegatedCount = hiddenEntries.filter(isSubagentDelegationEntry).length;
  const parts = [
    runningCount > 0 ? formatActivityCount(runningCount, "active item", "active items") : null,
    delegatedCount > 0
      ? formatActivityCount(delegatedCount, "delegated task", "delegated tasks")
      : null,
    `${hiddenCount.toLocaleString()} earlier ${hiddenCount === 1 ? "event" : "events"}`,
  ].filter((part): part is string => part !== null);
  return parts.join(", ");
}

type SemanticActivityKind = "explore" | "verify" | "command" | "tool" | "agent";
type SemanticActivitySignal =
  | "search"
  | "read"
  | "list"
  | "git"
  | "environment"
  | "verify"
  | "command"
  | "agent"
  | "tool";

interface SemanticActivitySummary {
  kind: SemanticActivityKind;
  signal: SemanticActivitySignal;
  commandName: string | null;
}

interface SemanticActivityBuffer {
  kind: SemanticActivityKind;
  entries: TimelineWorkEntry[];
  signals: Map<SemanticActivitySignal, number>;
  commandNames: string[];
}

function summarizeSemanticActivityEntries(
  entries: ReadonlyArray<TimelineWorkEntry>,
): TimelineWorkEntry[] {
  const summarizedEntries: TimelineWorkEntry[] = [];
  let buffer: SemanticActivityBuffer | null = null;

  const flushBuffer = () => {
    if (!buffer) {
      return;
    }

    const summaryEntry = buildSemanticActivitySummaryEntry(buffer);
    if (summaryEntry) {
      summarizedEntries.push(summaryEntry);
    } else {
      summarizedEntries.push(...buffer.entries);
    }
    buffer = null;
  };

  for (const entry of entries) {
    const summary = classifySummarizableActivityEntry(entry);
    if (!summary) {
      flushBuffer();
      summarizedEntries.push(entry);
      continue;
    }

    if (!buffer || buffer.kind !== summary.kind) {
      flushBuffer();
      buffer = {
        kind: summary.kind,
        entries: [],
        signals: new Map(),
        commandNames: [],
      };
    }

    buffer.entries.push(entry);
    buffer.signals.set(summary.signal, (buffer.signals.get(summary.signal) ?? 0) + 1);
    if (summary.commandName) {
      addUniqueString(buffer.commandNames, summary.commandName);
    }
  }

  flushBuffer();
  return summarizedEntries;
}

function classifySummarizableActivityEntry(
  entry: TimelineWorkEntry,
): SemanticActivitySummary | null {
  if (
    entry.executionState === "running" ||
    entry.executionState === "failed" ||
    entry.outputPreview ||
    (entry.changedFiles?.length ?? 0) > 0 ||
    (entry.images?.length ?? 0) > 0
  ) {
    return null;
  }

  if (isCommandWorkEntry(entry) && entry.command) {
    const summary = classifyCommandActivity(entry.command);
    // Consequential commands (anything that isn't routine exploration or
    // verification) keep their verbatim rows; "Ran 2 commands - rm" hides
    // exactly the arguments a developer needs to trust the feed.
    if (summary.kind === "command") {
      return null;
    }
    return summary;
  }

  if (entry.itemType === "collab_agent_tool_call") {
    if (!isSubagentDelegationEntry(entry)) {
      return {
        kind: "tool",
        signal: "tool",
        commandName: normalizedToolName(entry),
      };
    }
    return {
      kind: "agent",
      signal: "agent",
      commandName: normalizedToolName(entry),
    };
  }

  const toolText = `${entry.toolTitle ?? ""} ${entry.label} ${entry.detail ?? ""}`.toLowerCase();
  if (entry.requestKind === "file-read" || /^read file$/i.test(entry.toolTitle ?? entry.label)) {
    return { kind: "explore", signal: "read", commandName: null };
  }
  if (entry.itemType === "web_search" || /search|grep|find/.test(toolText)) {
    return { kind: "explore", signal: "search", commandName: null };
  }
  if (/list files|directory|folder/.test(toolText)) {
    return { kind: "explore", signal: "list", commandName: null };
  }
  if (entry.tone === "tool") {
    return {
      kind: "tool",
      signal: "tool",
      commandName: normalizedToolName(entry),
    };
  }
  return null;
}

function classifyCommandActivity(command: string): SemanticActivitySummary {
  const name = commandDisplayName(command);
  const normalizedName = name?.toLowerCase() ?? "";
  const normalizedCommand = command.toLowerCase();

  if (isSearchCommandName(normalizedName)) {
    return { kind: "explore", signal: "search", commandName: name };
  }
  if (isReadCommandName(normalizedName)) {
    return { kind: "explore", signal: "read", commandName: name };
  }
  if (isListCommandName(normalizedName)) {
    return { kind: "explore", signal: "list", commandName: name };
  }
  if (isGitInspectionCommand(normalizedName, normalizedCommand)) {
    return { kind: "explore", signal: "git", commandName: name };
  }
  if (isEnvironmentInspectionCommandName(normalizedName)) {
    return { kind: "explore", signal: "environment", commandName: name };
  }
  if (isVerificationCommand(normalizedName, normalizedCommand)) {
    return {
      kind: "verify",
      signal: "verify",
      commandName: verificationCommandLabel(command, name),
    };
  }
  return { kind: "command", signal: "command", commandName: name };
}

function isSearchCommandName(name: string): boolean {
  return ["rg", "grep", "findstr", "select-string"].includes(name);
}

function isReadCommandName(name: string): boolean {
  return ["cat", "gc", "get-content", "head", "less", "more", "sed", "tail", "type"].includes(name);
}

function isListCommandName(name: string): boolean {
  return ["dir", "gci", "get-childitem", "ls", "tree"].includes(name);
}

function isGitInspectionCommand(name: string, command: string): boolean {
  if (name !== "git") {
    return false;
  }
  return /\bgit\s+(?:branch|diff|log|ls-files|rev-parse|show|status)\b/u.test(command);
}

function isEnvironmentInspectionCommandName(name: string): boolean {
  return [
    "get-nettcpconnection",
    "get-process",
    "invoke-webrequest",
    "resolve-path",
    "test-netconnection",
    "test-path",
  ].includes(name);
}

function isVerificationCommand(name: string, command: string): boolean {
  if (
    [
      "eslint",
      "jest",
      "oxfmt",
      "oxlint",
      "playwright",
      "prettier",
      "pytest",
      "tsc",
      "vitest",
    ].includes(name)
  ) {
    return true;
  }
  if (
    /\b(?:bun|npm|pnpm|yarn|cargo|dotnet|go|uv)\s+(?:run\s+)?(?:build|check|fmt|format|lint|test|typecheck)\b/u.test(
      command,
    )
  ) {
    return true;
  }
  if (
    /\b(?:build|check|fmt|format|lint|test|typecheck)\b/u.test(command) &&
    /\b(?:bun|npm|pnpm|yarn|turbo|vitest|tsc)\b/u.test(command)
  ) {
    return true;
  }
  return false;
}

function buildSemanticActivitySummaryEntry(
  buffer: SemanticActivityBuffer,
): TimelineWorkEntry | null {
  // A lone entry reads better as itself than as "Used 1 tool".
  if (
    (buffer.kind === "command" || buffer.kind === "agent" || buffer.kind === "tool") &&
    buffer.entries.length < 2
  ) {
    return null;
  }

  const entries = buffer.entries;
  const firstEntry = entries[0];
  const lastEntry = entries.at(-1);
  if (!firstEntry || !lastEntry) {
    return null;
  }

  const count = entries.length;
  const detail = formatSemanticActivitySummaryDetail(buffer);
  return {
    id: `activity-summary:${buffer.kind}:${firstEntry.id}:${lastEntry.id}:${count}`,
    createdAt: firstEntry.createdAt,
    label: semanticActivityLabel(buffer),
    ...(detail ? { detail } : {}),
    tone: "tool",
    ...(buffer.kind === "command" || buffer.kind === "verify"
      ? { requestKind: "command" as const }
      : {}),
    executionState: "completed",
    turnId: firstEntry.turnId ?? lastEntry.turnId ?? null,
  };
}

function semanticActivityLabel(buffer: SemanticActivityBuffer): string {
  const count = buffer.entries.length;
  if (buffer.kind === "explore") {
    return "Explored project";
  }
  if (buffer.kind === "verify") {
    return "Verified changes";
  }
  if (buffer.kind === "tool") {
    return `Used ${count.toLocaleString()} ${count === 1 ? "tool" : "tools"}`;
  }
  if (buffer.kind === "agent") {
    return "Delegated work";
  }
  return `Ran ${count.toLocaleString()} ${count === 1 ? "command" : "commands"}`;
}

function formatSemanticActivitySummaryDetail(buffer: SemanticActivityBuffer): string | null {
  if (buffer.kind === "explore") {
    const parts = [
      formatActivityCount(buffer.signals.get("search") ?? 0, "search", "searches"),
      formatActivityCount(buffer.signals.get("read") ?? 0, "file read", "file reads"),
      formatActivityCount(buffer.signals.get("list") ?? 0, "directory list", "directory lists"),
      formatActivityCount(buffer.signals.get("git") ?? 0, "git check", "git checks"),
      formatActivityCount(
        buffer.signals.get("environment") ?? 0,
        "environment check",
        "environment checks",
      ),
    ].filter((part): part is string => part !== null);
    return parts.join(", ") || null;
  }

  if (buffer.kind === "verify" || buffer.kind === "command") {
    return formatCommandNameList(buffer.commandNames);
  }

  if (buffer.kind === "tool") {
    return formatCommandNameList(buffer.commandNames);
  }

  if (buffer.kind === "agent") {
    const count = buffer.signals.get("agent") ?? buffer.entries.length;
    const countLabel = formatActivityCount(count, "subagent task", "subagent tasks");
    const names = formatCommandNameList(buffer.commandNames);
    return [countLabel, names].filter((part): part is string => part !== null).join(", ") || null;
  }

  return null;
}

function formatActivityCount(count: number, singular: string, plural: string): string | null {
  if (count <= 0) {
    return null;
  }
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function formatCommandNameList(names: ReadonlyArray<string>): string | null {
  if (names.length === 0) {
    return null;
  }

  const visibleNames = names.slice(0, 3);
  const hiddenCount = names.length - visibleNames.length;
  return hiddenCount > 0
    ? `${visibleNames.join(", ")} +${hiddenCount.toLocaleString()}`
    : visibleNames.join(", ");
}

function addUniqueString(values: string[], value: string) {
  const key = value.toLowerCase();
  if (values.some((existing) => existing.toLowerCase() === key)) {
    return;
  }
  values.push(value);
}

function normalizedToolName(entry: TimelineWorkEntry): string | null {
  const label = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  return label || null;
}

function verificationCommandLabel(command: string, fallbackName: string | null): string | null {
  const normalizedCommand = command.trim().replace(/\s+/gu, " ");
  const scriptMatch =
    /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?([A-Za-z0-9:_./-]+)/u.exec(normalizedCommand) ??
    /\bturbo\s+run\s+([A-Za-z0-9:_./-]+)/u.exec(normalizedCommand);
  const scriptName = scriptMatch?.[1];
  if (scriptName) {
    return fallbackName ? `${fallbackName} ${scriptName}` : scriptName;
  }
  return fallbackName;
}

function commandDisplayName(command: string | undefined): string | null {
  const trimmedCommand = firstShellPipelineSegment(command);
  if (!trimmedCommand) {
    return null;
  }

  const match = /^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|([^\s|;]+))/u.exec(trimmedCommand);
  const token = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!token) {
    return null;
  }

  const normalizedToken = token.replaceAll("\\", "/");
  const name = normalizedToken
    .split("/")
    .at(-1)
    ?.replace(/\.(?:exe|cmd|ps1)$/iu, "");
  return name?.trim() || null;
}

function firstShellPipelineSegment(command: string | undefined): string | null {
  const trimmedCommand = command?.trim();
  if (!trimmedCommand) {
    return null;
  }
  return trimmedCommand.split("|")[0]?.trim() || trimmedCommand;
}

function tokenizeShellSegment(command: string | undefined): string[] {
  const segment = firstShellPipelineSegment(command);
  if (!segment) {
    return [];
  }

  const tokens: string[] = [];
  const tokenPattern = /"([^"]*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of segment.matchAll(tokenPattern)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token) {
      tokens.push(token);
    }
  }
  return tokens;
}

function summarizeHiddenWorkEntries(entries: ReadonlyArray<TimelineWorkEntry>): string | null {
  if (entries.length === 0) {
    return null;
  }

  let commandCount = 0;
  let readCount = 0;
  let searchCount = 0;
  let imageCount = 0;
  let otherToolCount = 0;
  const editedFiles = new Set<string>();
  let editFallbackCount = 0;

  for (const entry of entries) {
    if (isCommandWorkEntry(entry)) {
      commandCount += 1;
      continue;
    }
    if (entry.itemType === "file_change" || (entry.changedFiles?.length ?? 0) > 0) {
      if ((entry.changedFiles?.length ?? 0) === 0) {
        editFallbackCount += 1;
      }
      for (const filePath of entry.changedFiles ?? []) {
        editedFiles.add(filePath);
      }
      continue;
    }
    if (entry.requestKind === "file-read" || /^read file$/i.test(entry.toolTitle ?? entry.label)) {
      readCount += 1;
      continue;
    }
    if (
      entry.itemType === "web_search" ||
      /search|grep|find/i.test(entry.toolTitle ?? entry.label)
    ) {
      searchCount += 1;
      continue;
    }
    if (entry.itemType === "image_view" || (entry.images?.length ?? 0) > 0) {
      imageCount += Math.max(1, entry.images?.length ?? 0);
      continue;
    }
    if (entry.tone === "tool") {
      otherToolCount += 1;
    }
  }

  const editCount = editedFiles.size + editFallbackCount;
  const parts = [
    formatHiddenSummaryPart(commandCount, "Ran", "command"),
    formatHiddenSummaryPart(readCount, "Read", "file"),
    formatHiddenSummaryPart(editCount, "Edited", "file"),
    formatHiddenSummaryPart(searchCount, "Searched", "time", "times"),
    formatHiddenSummaryPart(imageCount, "Viewed", "image"),
    formatHiddenSummaryPart(otherToolCount, "Used", "tool"),
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatHiddenSummaryPart(
  count: number,
  verb: string,
  singular: string,
  plural = `${singular}s`,
): string | null {
  if (count <= 0) {
    return null;
  }
  return `${verb} ${count.toLocaleString()} ${count === 1 ? singular : plural}`;
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
      <div className="sticky top-2 z-10 mb-1.5 flex items-center justify-between gap-2 bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-[color-mix(in_srgb,var(--card)_45%,var(--background))] before:content-['']">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55">
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
        <div className="flex items-center gap-1.5">
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
            onClick={() => onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)}
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
              className="inline-flex max-w-56 cursor-pointer items-center gap-1 rounded-md border border-border/70 bg-background/55 px-2 py-0.5 text-[11px] leading-5 text-muted-foreground/85 outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
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

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;

function shouldCollapseUserMessage(text: string): boolean {
  return shouldCollapseMessageText(text, {
    maxLength: MAX_COLLAPSED_USER_MESSAGE_LENGTH,
    maxLines: MAX_COLLAPSED_USER_MESSAGE_LINES,
  });
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  transcriptHighlights: ParsedTranscriptHighlightContextEntry[];
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

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
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
  return formatWorkingTimer(startIso, new Date().toISOString()) ?? "0s";
}

function formatLiveMessageMetaNow(
  createdAt: string,
  durationStart: string | null | undefined,
  timestampFormat: TimestampFormat,
): string {
  const elapsed = durationStart ? formatElapsed(durationStart, new Date().toISOString()) : null;
  return formatMessageMeta(createdAt, elapsed, timestampFormat);
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} • ${duration}`;
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "warning") {
    return {
      icon: CircleAlertIcon,
      className: "text-amber-400/80",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "warning" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "warning") return "text-amber-300/60 dark:text-amber-300/60";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/70";
  return "text-muted-foreground/40";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
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

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

/** First meaningful output line of a failed command, surfaced inline so
 *  "why did it fail" needs zero clicks. */
function commandFailureLine(workEntry: TimelineWorkEntry): string | null {
  if (workEntry.executionState !== "failed" || !isCommandWorkEntry(workEntry)) {
    return null;
  }
  const firstLine = workEntry.outputPreview
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line !== "...");
  if (!firstLine) {
    return workEntry.exitCode !== undefined ? `Exit code ${workEntry.exitCode}` : null;
  }
  return firstLine.length > 160 ? `${firstLine.slice(0, 159).trimEnd()}…` : firstLine;
}

/** Last lines of the retained output, terminal-style. The projection
 *  upstream already keeps only the tail (~1.2 KB) of long streams. */
function commandOutputTail(output: string, maxLines = 20): string {
  const lines = output.replace(/\r\n/gu, "\n").split("\n");
  return lines.slice(-maxLines).join("\n").trimEnd();
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (isSubagentWorkEntry(workEntry)) return BotIcon;
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;
  if (workEntry.requestKind === "permissions") return ShieldCheckIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  const normalizedTitle = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label);
  if (/^read file$/i.test(normalizedTitle)) return EyeIcon;
  if (/^(?:search|tool search)$/i.test(normalizedTitle)) return SearchIcon;
  if (/^web fetch$/i.test(normalizedTitle)) return GlobeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function isCommandWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return (
    workEntry.requestKind === "command" ||
    workEntry.itemType === "command_execution" ||
    !!workEntry.command
  );
}

function isRunningToolWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return workEntry.executionState === "running";
}

function isSubagentWorkEntry(workEntry: TimelineWorkEntry): boolean {
  return (
    workEntry.itemType === "collab_agent_tool_call" ||
    /sub-?agent|delegat/i.test(`${workEntry.toolTitle ?? ""} ${workEntry.label}`)
  );
}

function isSubagentDelegationEntry(workEntry: TimelineWorkEntry): boolean {
  if (workEntry.itemType !== "collab_agent_tool_call") {
    return false;
  }
  // Older persisted rows predate this discriminator and represented actual
  // spawn calls, so retain their existing presentation. Newly projected wait,
  // send, resume, and close calls are explicitly marked as coordination.
  return workEntry.subagentOperation !== "coordination";
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): string {
  const actionHeading = workEntryActionHeading(workEntry, workspaceRoot);
  if (actionHeading) {
    return actionHeading;
  }

  const rawHeading = workEntry.toolTitle ?? workEntry.label;
  const normalizedHeading = normalizeCompactToolLabel(rawHeading);
  if (
    workEntry.executionState === "failed" &&
    isCommandWorkEntry(workEntry) &&
    /^(ran command|command)$/i.test(normalizedHeading)
  ) {
    return "Command failed";
  }
  return capitalizePhrase(normalizedHeading);
}

function workEntryActionHeading(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
): string | null {
  if (workEntry.executionState === "failed" && isCommandWorkEntry(workEntry)) {
    return "Command failed";
  }

  if (isCommandWorkEntry(workEntry) && workEntry.command) {
    return commandActionHeading(workEntry.command, workEntry.executionState, workspaceRoot);
  }

  if (workEntry.itemType === "command_execution") {
    return formatActionHeading(workEntry.executionState, "Running", "Ran", "command");
  }

  if (isSubagentWorkEntry(workEntry)) {
    return formatActionHeading(
      workEntry.executionState,
      "Running",
      "Finished",
      subagentSubjectLabel(workEntry),
    );
  }

  if (
    workEntry.requestKind === "file-read" ||
    /^read file$/i.test(workEntry.toolTitle ?? workEntry.label)
  ) {
    return formatActionHeading(
      workEntry.executionState,
      "Reading",
      "Read",
      workEntrySubjectFromDetail(workEntry, workspaceRoot) ?? "file",
    );
  }
  if (workEntry.itemType === "web_search") {
    return formatActionHeading(workEntry.executionState, "Searching", "Searched", "web");
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return formatActionHeading(
      workEntry.executionState,
      "Editing",
      "Edited",
      workEntrySubjectFromChangedFiles(workEntry, workspaceRoot) ?? "files",
    );
  }
  if (workEntry.itemType === "image_view" || (workEntry.images?.length ?? 0) > 0) {
    return formatActionHeading(workEntry.executionState, "Viewing", "Viewed", "image");
  }

  const normalizedTitle = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label);
  if (/^search$/i.test(normalizedTitle)) {
    return formatActionHeading(workEntry.executionState, "Searching", "Searched", "code");
  }
  if (/^web fetch$/i.test(normalizedTitle)) {
    return formatActionHeading(
      workEntry.executionState,
      "Fetching",
      "Fetched",
      urlHostFromDetail(workEntry.detail) ?? "page",
    );
  }

  return null;
}

function urlHostFromDetail(detail: string | undefined): string | null {
  if (!detail) {
    return null;
  }
  try {
    return new URL(detail.trim()).host || null;
  } catch {
    return null;
  }
}

function subagentSubjectLabel(workEntry: TimelineWorkEntry): string {
  const title = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label);
  if (/^delegated work$/iu.test(title)) {
    return "delegated work";
  }
  if (title && !/^subagent task$/iu.test(title)) {
    return title.toLowerCase().includes("subagent") ? title : `${title} subagent`;
  }

  const role = subagentRoleLabel(workEntry);
  if (role) {
    return `${role} subagent`;
  }

  return "subagent task";
}

function subagentRoleLabel(workEntry: TimelineWorkEntry): string | null {
  const detailParts = splitSubagentDetail(workEntry.detail);
  if (detailParts?.role) {
    return detailParts.role;
  }
  return null;
}

function subagentObjectiveText(workEntry: TimelineWorkEntry): string | null {
  const detailParts = splitSubagentDetail(workEntry.detail);
  if (detailParts?.objective) {
    return detailParts.objective;
  }

  const detail = workEntry.detail?.trim();
  if (detail) {
    return detail;
  }

  return null;
}

function splitSubagentDetail(
  detail: string | undefined,
): { role: string; objective: string } | null {
  const [prefix, ...restParts] = detail?.split(":") ?? [];
  const rawRole = prefix?.trim();
  const objective = restParts.join(":").trim();
  if (!rawRole || !objective || !/^[A-Za-z][A-Za-z0-9_-]{1,32}$/u.test(rawRole)) {
    return null;
  }

  return {
    role: rawRole.replace(/[_-]+/gu, " ").toLowerCase(),
    objective,
  };
}

function commandActionHeading(
  command: string,
  executionState: TimelineWorkEntry["executionState"],
  workspaceRoot: string | undefined,
): string {
  const summary = classifyCommandActivity(command);
  if (summary.kind === "explore") {
    if (summary.signal === "search") {
      return formatActionHeading(
        executionState,
        "Searching",
        "Searched",
        commandSubjectLabel(command, "search", workspaceRoot) ?? "project",
      );
    }
    if (summary.signal === "read") {
      return formatActionHeading(
        executionState,
        "Reading",
        "Read",
        commandSubjectLabel(command, "read", workspaceRoot) ?? "file",
      );
    }
    if (summary.signal === "list") {
      return formatActionHeading(
        executionState,
        "Listing",
        "Listed",
        commandSubjectLabel(command, "list", workspaceRoot) ?? "directory",
      );
    }
    if (summary.signal === "git") {
      return formatActionHeading(executionState, "Checking", "Checked", "git state");
    }
    if (summary.signal === "environment") {
      return formatActionHeading(executionState, "Checking", "Checked", "environment");
    }
  }

  if (summary.kind === "verify") {
    return formatActionHeading(
      executionState,
      "Verifying",
      "Verified",
      summary.commandName ?? "changes",
    );
  }

  return formatActionHeading(executionState, "Running", "Ran", "command");
}

function formatActionHeading(
  executionState: TimelineWorkEntry["executionState"],
  activeVerb: string,
  completedVerb: string,
  subject: string,
): string {
  const verb = executionState === "running" ? activeVerb : completedVerb;
  return `${verb} ${subject}`;
}

function commandSubjectLabel(
  command: string,
  signal: "search" | "read" | "list",
  workspaceRoot: string | undefined,
): string | null {
  const target = extractCommandPathTarget(command);
  if (!target) {
    return null;
  }

  const formattedTarget = formatWorkspaceRelativePath(target, workspaceRoot);
  if (signal === "read") {
    return lastPathSegment(formattedTarget) ?? formattedTarget;
  }
  return formattedTarget;
}

function extractCommandPathTarget(command: string): string | null {
  const tokens = tokenizeShellSegment(command);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (/^-(?:literalpath|path)$/iu.test(tokens[index]!)) {
      return cleanCommandPathToken(tokens[index + 1]);
    }
  }

  for (let index = tokens.length - 1; index >= 1; index -= 1) {
    const token = cleanCommandPathToken(tokens[index]);
    if (token && isPathLikeCommandToken(token)) {
      return token;
    }
  }
  return null;
}

function cleanCommandPathToken(token: string | undefined): string | null {
  const cleaned = token
    ?.trim()
    .replace(/^["']|["']$/gu, "")
    .replace(/[),;]+$/gu, "");
  return cleaned || null;
}

function isPathLikeCommandToken(token: string): boolean {
  if (token.startsWith("-")) {
    return false;
  }
  return (
    /[\\/]/u.test(token) ||
    /^[A-Za-z]:/u.test(token) ||
    /^\.\.?$/u.test(token) ||
    /^\.\.?[\\/]/u.test(token) ||
    /\.[A-Za-z0-9]{1,8}$/u.test(token)
  );
}

function workEntrySubjectFromDetail(
  workEntry: Pick<TimelineWorkEntry, "detail" | "changedFiles">,
  workspaceRoot: string | undefined,
): string | null {
  if ((workEntry.changedFiles?.length ?? 0) > 0) {
    return workEntrySubjectFromChangedFiles(workEntry, workspaceRoot);
  }
  if (!workEntry.detail) {
    return null;
  }
  const detail = workEntry.detail.trim();
  return isPathLikeCommandToken(detail)
    ? (lastPathSegment(formatWorkspaceRelativePath(detail, workspaceRoot)) ?? detail)
    : null;
}

function workEntrySubjectFromChangedFiles(
  workEntry: Pick<TimelineWorkEntry, "changedFiles">,
  workspaceRoot: string | undefined,
): string | null {
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) {
    return null;
  }
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? (lastPathSegment(displayPath) ?? displayPath)
    : `${lastPathSegment(displayPath) ?? displayPath} +${workEntry.changedFiles!.length - 1}`;
}

function lastPathSegment(pathValue: string): string | null {
  const parts = pathValue.replaceAll("\\", "/").split("/");
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]?.trim();
    if (part) {
      return part;
    }
  }
  return null;
}

function RunningToolIndicator({ className }: { className?: string }) {
  // A single accent tick; the halo stays reserved for the working row.
  return (
    <span className={cn("inline-flex items-center", className)} aria-label="Tool still running">
      <span className="size-1 animate-status-pulse rounded-full bg-primary-graph/80" />
    </span>
  );
}

function InlineDiffStatLabel({ stat }: { stat: { additions: number; deletions: number } }) {
  return (
    <span className="ml-1.5 font-mono text-[10px]">
      <DiffStatLabel additions={stat.additions} deletions={stat.deletions} />
    </span>
  );
}

function WorkEntryPreviewText({ preview }: { preview: string }) {
  return (
    <>
      <span className="shrink-0 px-1 text-muted-foreground/40">-</span>
      <span className="min-w-0 truncate">{preview}</span>
    </>
  );
}

function WorkEntrySummaryLine({
  heading,
  isRunningTool,
  preview,
  rawCommand,
  runningStartedAt,
  tone,
  visibleDiffStat,
  className,
  inSpine = false,
}: {
  heading: string;
  isRunningTool: boolean;
  preview: string | null;
  rawCommand: string | null;
  runningStartedAt?: string | null;
  tone: TimelineWorkEntry["tone"];
  visibleDiffStat: { additions: number; deletions: number } | null;
  className?: string;
  inSpine?: boolean;
}) {
  const previewClassName =
    "flex min-w-0 flex-1 items-center self-center overflow-hidden leading-5 text-muted-foreground/55 transition-colors hover:text-muted-foreground/75 focus-visible:text-muted-foreground/75";

  return (
    <p
      className={cn(
        "flex min-w-0 items-center overflow-hidden leading-5",
        workToneClass(tone),
        preview ? "text-muted-foreground/70" : "",
        className,
      )}
    >
      {isRunningTool && !inSpine ? <RunningToolIndicator className="mr-1.5 shrink-0" /> : null}
      <span
        className={cn(
          "min-w-0 shrink-0 truncate leading-5 text-foreground/80",
          workToneClass(tone),
        )}
        data-work-entry-heading="true"
      >
        {heading}
        {visibleDiffStat ? <InlineDiffStatLabel stat={visibleDiffStat} /> : null}
      </span>
      {runningStartedAt ? (
        <span className="ml-1.5 shrink-0 text-[10px] leading-5 text-muted-foreground/45">
          <span aria-hidden>· </span>
          <RunningCommandTimer createdAt={runningStartedAt} />
        </span>
      ) : null}
      {preview ? (
        rawCommand ? (
          <Tooltip>
            <TooltipTrigger
              closeDelay={0}
              delay={75}
              render={
                <span className={previewClassName} data-work-entry-preview="true">
                  <WorkEntryPreviewText preview={preview} />
                </span>
              }
            />
            <TooltipPopup
              align="start"
              className="max-w-[min(56rem,calc(100vw-2rem))] px-0 py-0"
              side="top"
            >
              <div className="max-w-[min(56rem,calc(100vw-2rem))] overflow-x-auto px-1.5 py-1 font-mono text-[11px] leading-4 whitespace-nowrap">
                {rawCommand}
              </div>
            </TooltipPopup>
          </Tooltip>
        ) : (
          <span className={previewClassName} data-work-entry-preview="true">
            <WorkEntryPreviewText preview={preview} />
          </span>
        )
      ) : null}
    </p>
  );
}

const SubagentWorkEntryRow = memo(function SubagentWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  compact: boolean;
  inSpine?: boolean;
}) {
  const { workEntry, workspaceRoot, compact, inSpine = false } = props;
  const [isExpanded, setIsExpanded] = useState(false);
  const isRunningTool = isRunningToolWorkEntry(workEntry);
  const heading = toolWorkEntryHeading(workEntry, workspaceRoot);
  const objective = subagentObjectiveText(workEntry);
  const rawCommand = workEntryRawCommand(workEntry);
  const command = workEntry.command?.trim();
  const detail = workEntry.detail?.trim();
  const hasDetailBody =
    !compact &&
    Boolean(detail || command || rawCommand || (workEntry.changedFiles?.length ?? 0) > 0);
  const displayText = objective ? `${heading} - ${objective}` : heading;

  useEffect(() => {
    if (compact && isExpanded) {
      setIsExpanded(false);
    }
  }, [compact, isExpanded]);

  return (
    <div className="rounded-lg px-1 py-1" data-subagent-activity-row="true">
      <div className="flex items-start gap-2 transition-[opacity,translate] duration-200">
        <span className="flex size-5 shrink-0 items-center justify-center text-foreground/85">
          <BotIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 items-center gap-1.5">
            <p
              className={cn(
                "min-w-0 truncate text-[11px] leading-5 text-muted-foreground/70",
                compact ? "text-xs" : "",
              )}
              title={displayText}
            >
              <span className="inline-flex items-center text-foreground/80">
                {isRunningTool && !inSpine ? <RunningToolIndicator className="mr-1.5" /> : null}
                {heading}
              </span>
              {objective ? <span className="text-muted-foreground/55"> - {objective}</span> : null}
            </p>
            {!compact ? (
              <span className="shrink-0 rounded border border-border/55 bg-background/55 px-1 py-px text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55">
                Subagent
              </span>
            ) : null}
          </div>
        </div>
        {hasDetailBody ? (
          <button
            type="button"
            className="mt-0.5 shrink-0 text-[9px] uppercase tracking-[0.12em] text-muted-foreground/50 transition-colors duration-150 hover:text-foreground/75"
            aria-expanded={isExpanded}
            onClick={() => setIsExpanded((value) => !value)}
          >
            {isExpanded ? "Hide" : "Details"}
          </button>
        ) : null}
      </div>
      {hasDetailBody && isExpanded ? (
        <div
          className="mt-1.5 ml-7 space-y-1.5 border-l border-border/45 pl-3 text-[11px] leading-5 text-muted-foreground/70"
          data-subagent-activity-details="true"
        >
          {detail ? <p className="whitespace-pre-wrap wrap-break-word">{detail}</p> : null}
          {command ? (
            <p className="overflow-x-auto font-mono whitespace-nowrap text-muted-foreground/65">
              {command}
            </p>
          ) : null}
          {rawCommand ? (
            <p className="overflow-x-auto font-mono whitespace-nowrap text-muted-foreground/55">
              {rawCommand}
            </p>
          ) : null}
          {(workEntry.changedFiles?.length ?? 0) > 0 ? (
            <div className="flex flex-wrap gap-1">
              {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
                const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
                return (
                  <span
                    key={`${workEntry.id}:subagent-file:${filePath}`}
                    className="rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                    title={displayPath}
                  >
                    {displayPath}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

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

const CommandOutputCopyButton = memo(function CommandOutputCopyButton({ text }: { text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 1000 });

  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label="Copy command output"
      tooltip={isCopied ? "Copied" : "Copy command output"}
      className="absolute top-1.5 right-3 size-5 rounded-md border border-border/45 bg-background/85 text-muted-foreground/70 opacity-80 shadow-sm hover:bg-accent/75 hover:text-foreground hover:opacity-100 focus-visible:opacity-100 group-hover/command-output:opacity-100"
      disabled={isCopied || text.length === 0}
      onClick={(event) => {
        event.stopPropagation();
        copyToClipboard(text);
      }}
    >
      {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
    </Button>
  );
});

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  isLiveActivity: boolean;
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  inSpine?: boolean;
}) {
  const {
    turnDiffSummaryByTurnId,
    onRunProviderAuthReconnect,
    resolvedProviderAuthReconnectIds,
    mcpAuthReconnectStatusByServerName,
    onRunMcpAuthReconnect,
  } = use(TimelineRowCtx);
  const [isOutputExpanded, setIsOutputExpanded] = useState(false);
  const { isLiveActivity, workspaceRoot, inSpine = false } = props;
  const workEntry = resolveDisplayedWorkEntry(props.workEntry, isLiveActivity);

  if (isSubagentWorkEntry(workEntry)) {
    return (
      <SubagentWorkEntryRow
        workEntry={workEntry}
        workspaceRoot={workspaceRoot}
        compact={isLiveActivity}
        inSpine={inSpine}
      />
    );
  }

  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const isRunningTool = isLiveActivity && isRunningToolWorkEntry(workEntry);
  const heading = toolWorkEntryHeading(workEntry, workspaceRoot);
  const rawPreview =
    workEntry.authReconnect || workEntry.mcpAuthReconnect
      ? null
      : workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const rawCommand = workEntryRawCommand(workEntry);
  const diffStat = summarizeWorkEntryDiffStat(workEntry, turnDiffSummaryByTurnId);
  const visibleDiffStat = diffStat && hasNonZeroStat(diffStat) ? diffStat : null;
  const diffStatText = visibleDiffStat
    ? ` +${visibleDiffStat.additions} / -${visibleDiffStat.deletions}`
    : "";
  const displayText = preview
    ? `${heading}${diffStatText} - ${preview}`
    : `${heading}${diffStatText}`;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  // A single-file edit whose detail is already that file's path needs no
  // chip row repeating it.
  const detailMatchesSoleChangedFile =
    hasChangedFiles &&
    workEntry.changedFiles?.length === 1 &&
    !workEntry.command &&
    !!workEntry.detail &&
    diffPathsMatch(workEntry.detail, workEntry.changedFiles[0] ?? "");
  const previewIsChangedFiles =
    hasChangedFiles && !workEntry.command && (!workEntry.detail || detailMatchesSoleChangedFile);
  const imagePreviews = workEntry.images ?? [];
  // "View into the terminal": command rows with retained output expand in
  // place on click; failures additionally surface their first error line.
  const outputPreview = isCommandWorkEntry(workEntry) ? workEntry.outputPreview : undefined;
  const hasExpandableOutput = Boolean(outputPreview) && !isLiveActivity;
  const commandOutputText = hasExpandableOutput ? commandOutputTail(outputPreview ?? "") : "";
  const failureLine = isOutputExpanded ? null : commandFailureLine(workEntry);
  const showExpandedDetails = !isLiveActivity;
  // On the spine the gutter owns the leading node, so the row drops its own
  // tone icon and the sub-rows align flush under the heading text.
  const detailIndent = inSpine ? "" : "pl-7";
  const cardIndent = inSpine ? "" : "ml-7";
  const chipIndent = inSpine ? "" : "pl-6";
  const isStandaloneImagePreview =
    showExpandedDetails &&
    imagePreviews.length > 0 &&
    workEntry.itemType === "image_view" &&
    !preview &&
    !rawCommand &&
    !hasChangedFiles;

  if (isStandaloneImagePreview) {
    return (
      <div className="rounded-lg px-1 py-1">
        <TimelineImagePreviewGrid
          images={imagePreviews}
          className={cn("max-w-[420px]", detailIndent)}
          imageClassName="max-h-[260px] object-contain"
        />
      </div>
    );
  }

  const summaryContent = (
    <>
      {inSpine ? null : (
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
      )}
      <div className="min-w-0 flex-1 overflow-hidden">
        {rawCommand || hasExpandableOutput ? (
          <div className="max-w-full">
            <WorkEntrySummaryLine
              className={rawCommand ? "text-xs" : "text-[11px]"}
              heading={heading}
              isRunningTool={isRunningTool}
              inSpine={inSpine}
              preview={preview}
              rawCommand={rawCommand}
              runningStartedAt={isRunningTool ? workEntry.createdAt : null}
              tone={workEntry.tone}
              visibleDiffStat={visibleDiffStat}
            />
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger className="block min-w-0 w-full text-left" aria-label={displayText}>
              <WorkEntrySummaryLine
                className="text-[11px]"
                heading={heading}
                isRunningTool={isRunningTool}
                inSpine={inSpine}
                preview={preview}
                rawCommand={null}
                runningStartedAt={isRunningTool ? workEntry.createdAt : null}
                tone={workEntry.tone}
                visibleDiffStat={visibleDiffStat}
              />
            </TooltipTrigger>
            <TooltipPopup className="max-w-[min(720px,calc(100vw-2rem))]">
              <p className="whitespace-pre-wrap wrap-break-word text-xs leading-5">{displayText}</p>
            </TooltipPopup>
          </Tooltip>
        )}
      </div>
      {hasExpandableOutput ? (
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground/45 transition-transform duration-150",
            !isOutputExpanded && "-rotate-90",
          )}
        />
      ) : null}
    </>
  );

  return (
    <div className="rounded-lg px-1 py-1">
      {hasExpandableOutput ? (
        <button
          type="button"
          className="flex w-full cursor-pointer items-center gap-2 rounded-md text-left transition-[opacity,translate] duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          aria-expanded={isOutputExpanded}
          aria-label={isOutputExpanded ? "Hide command output" : "Show command output"}
          onClick={() => setIsOutputExpanded((value) => !value)}
        >
          {summaryContent}
        </button>
      ) : (
        <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
          {summaryContent}
        </div>
      )}
      {failureLine ? (
        <p
          className={cn(
            "mt-0.5 truncate font-mono text-[11px] leading-4 text-destructive/85",
            detailIndent,
          )}
          data-command-failure="true"
          title={failureLine}
        >
          {failureLine}
        </p>
      ) : null}
      {workEntry.authReconnect ? (
        <ProviderAuthReconnectCard
          action={workEntry.authReconnect}
          className={cn("mt-1.5", cardIndent)}
          resolved={resolvedProviderAuthReconnectIds.has(workEntry.id)}
          {...(onRunProviderAuthReconnect ? { onRun: onRunProviderAuthReconnect } : {})}
        />
      ) : null}
      {workEntry.mcpAuthReconnect ? (
        <McpAuthReconnectCard
          action={workEntry.mcpAuthReconnect}
          className={cn("mt-1.5", cardIndent)}
          status={mcpAuthReconnectStatusByServerName.get(workEntry.mcpAuthReconnect.serverName)}
          {...(onRunMcpAuthReconnect ? { onRun: onRunMcpAuthReconnect } : {})}
        />
      ) : null}
      {hasExpandableOutput && isOutputExpanded ? (
        <div className={cn("mt-1", detailIndent)} data-command-output="true">
          <div className="group/command-output relative">
            <pre className="max-h-52 overflow-y-auto rounded-md border border-border/45 bg-background/70 px-2 py-1.5 pr-10 font-mono text-[11px] leading-4 whitespace-pre-wrap wrap-break-word text-muted-foreground/80">
              {commandOutputText}
            </pre>
            <CommandOutputCopyButton text={commandOutputText} />
          </div>
          {workEntry.exitCode !== undefined ? (
            <p className="mt-0.5 text-[10px] tracking-wide text-muted-foreground/55">
              exit {workEntry.exitCode}
            </p>
          ) : null}
        </div>
      ) : null}
      {hasChangedFiles && !previewIsChangedFiles && showExpandedDetails && (
        <div className={cn("mt-1 flex flex-wrap gap-1", chipIndent)}>
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            const fileStat = workEntry.changedFileStats?.find((stat) =>
              diffPathsMatch(stat.path, filePath),
            );
            return (
              <span
                key={`${workEntry.id}:${filePath}`}
                className="inline-flex items-center gap-1 rounded-md border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                title={displayPath}
              >
                {displayPath}
                {fileStat && hasNonZeroStat(fileStat) ? (
                  <span className="shrink-0">
                    <DiffStatLabel additions={fileStat.additions} deletions={fileStat.deletions} />
                  </span>
                ) : null}
              </span>
            );
          })}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
      {imagePreviews.length > 0 && showExpandedDetails && (
        <TimelineImagePreviewGrid
          images={imagePreviews}
          className={cn("mt-2 max-w-[420px]", detailIndent)}
          imageClassName="max-h-[260px] object-contain"
        />
      )}
    </div>
  );
});

function resolveDisplayedWorkEntry(
  workEntry: TimelineWorkEntry,
  isLiveActivity: boolean,
): TimelineWorkEntry {
  if (isLiveActivity || workEntry.executionState !== "running") {
    return workEntry;
  }
  return { ...workEntry, executionState: "completed" };
}

import {
  type EnvironmentId,
  type MessageId,
  type ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  type ServerProviderSkill,
  type TurnId,
} from "@t3tools/contracts";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { isProviderAuthErrorMessage } from "@t3tools/shared/providerAuth";
import {
  deriveTimelineEntries,
  formatElapsed,
  type McpAuthReconnectAction,
  type ProviderAuthReconnectAction,
} from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  KeyRoundIcon,
  type LucideIcon,
  LoaderIcon,
  LogInIcon,
  SearchIcon,
  ShieldCheckIcon,
  SplitIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { LiveNode, SectionLabel } from "../ui/threadline";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";
import { useSettings } from "../../hooks/useSettings";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { SkillInlineText } from "./SkillInlineText";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { formatProviderDriverKindLabel } from "../../providerModels";

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
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onRunProviderAuthReconnect?: (action: ProviderAuthReconnectAction) => void;
  onRunMcpAuthReconnect?: (action: McpAuthReconnectAction) => void;
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
const LIVE_WORK_LOG_ENTRY_COUNT = 2;
const INITIAL_STICK_TO_BOTTOM_FRAME_COUNT = 3;

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
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  onContinueInNewThread?: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
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
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  onContinueInNewThread,
  isRevertingCheckpoint,
  onImageExpand,
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

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (state) {
      onIsAtEndChange(state.isAtEnd);
    }
  }, [listRef, onIsAtEndChange]);

  const hasRows = rows.length > 0;
  useEffect(() => {
    if (!hasRows) {
      return;
    }

    const frameIds: number[] = [];
    const stickToBottom = () => {
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
  }, [hasRows, listRef, onIsAtEndChange, routeThreadKey]);

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
      onOpenTurnDiff,
      ...(onRunProviderAuthReconnect ? { onRunProviderAuthReconnect } : {}),
      ...(onRunMcpAuthReconnect ? { onRunMcpAuthReconnect } : {}),
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
      onOpenTurnDiff,
      onRunProviderAuthReconnect,
      onRunMcpAuthReconnect,
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
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip" data-timeline-root="true">
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
        <LegendList<MessagesTimelineRow>
          ref={listRef}
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          estimatedItemSize={90}
          initialScrollAtEnd
          maintainScrollAtEnd
          maintainScrollAtEndThreshold={0.1}
          maintainVisibleContentPosition
          onScroll={handleScroll}
          className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
          ListHeaderComponent={TIMELINE_LIST_HEADER}
          ListFooterComponent={TIMELINE_LIST_FOOTER}
        />
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
});

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
  return (
    <div
      className="pb-4"
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? <WorkGroupSection row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "subagent-result" ? <SubagentResultTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
    </div>
  );
});

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const userImages = row.message.attachments ?? [];
  const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
  const terminalContexts = displayedUserMessage.contexts;
  const canRevertAgentWork = typeof row.revertTurnCount === "number";

  return (
    <div className="flex justify-end">
      <div className="group relative max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
        <TimelineImagePreviewGrid
          images={userImages}
          className="mb-2 max-w-[420px]"
          imageClassName="max-h-[220px] object-cover"
        />
        <CollapsibleUserMessageBody
          text={displayedUserMessage.visibleText}
          terminalContexts={terminalContexts}
          skills={ctx.skills}
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
      title="Revert to this message"
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
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => ctx.onContinueInNewThread?.(messageId)}
            aria-label="Continue in new thread"
            className={cn("enabled:cursor-pointer", className)}
          />
        }
      >
        <SplitIcon className="size-3 rotate-90" />
      </TooltipTrigger>
      <TooltipPopup>
        <p>Continue in new thread</p>
      </TooltipPopup>
    </Tooltip>
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
          className="group/assistant-message inline-block max-w-full align-top"
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
            <div data-agent-response-body="true" data-assistant-message-body="true">
              <ChatMarkdown
                text={messageText}
                cwd={ctx.markdownCwd}
                isStreaming={Boolean(row.message.streaming)}
                skills={ctx.skills}
              />
            </div>
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

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
      />
    </div>
  );
}

function SubagentResultTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "subagent-result" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const meta = [row.result.model, row.result.reasoningEffort].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );

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
                  {row.result.label}
                </p>
                <span className="shrink-0 rounded border border-border/55 bg-background/55 px-1 py-px text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55">
                  Subagent
                </span>
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
        <div className="min-w-0 border-l border-border/60 pl-3" data-subagent-result-body="true">
          <ChatMarkdown
            text={row.result.body}
            cwd={ctx.markdownCwd}
            isStreaming={false}
            skills={ctx.skills}
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="truncate text-[10px] text-muted-foreground/40">
            {meta.length > 0 ? meta.join(" / ") : "Subagent result"}
          </p>
          <p className="shrink-0 text-[10px] tracking-tight tabular-nums text-muted-foreground/30">
            {formatTimestamp(row.createdAt, ctx.timestampFormat)}
          </p>
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

  const isShowingLiveHistory = isLiveActivity && isExpanded;
  const isShowingFullLog = !isLiveActivity && isExpanded;
  const liveActivityEntries = isLiveActivity ? deriveLiveActivityEntries(groupedEntries) : [];
  const activityEntries = isLiveActivity
    ? isShowingLiveHistory
      ? groupedEntries
      : liveActivityEntries
    : isShowingFullLog
      ? groupedEntries
      : summarizeSemanticActivityEntries(groupedEntries);
  const visibleLimit = isLiveActivity ? LIVE_WORK_LOG_ENTRY_COUNT : MAX_VISIBLE_WORK_LOG_ENTRIES;
  const hasOverflow = activityEntries.length > visibleLimit;
  const visibleEntries =
    hasOverflow && !isShowingFullLog && !isShowingLiveHistory
      ? activityEntries.slice(-visibleLimit)
      : activityEntries;
  const hasCompactedEntries = !isLiveActivity && activityEntries.length < groupedEntries.length;
  const liveHiddenCount = isLiveActivity
    ? Math.max(0, groupedEntries.length - liveActivityEntries.length)
    : 0;
  const hiddenCount = isLiveActivity
    ? liveHiddenCount
    : isShowingFullLog
      ? 0
      : Math.max(0, groupedEntries.length - visibleEntries.length);
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const hiddenSummary =
    hasOverflow && !hasCompactedEntries && !isShowingFullLog && !isLiveActivity
      ? summarizeHiddenWorkEntries(groupedEntries.slice(0, hiddenCount))
      : null;
  const liveHiddenSummary =
    isLiveActivity && !isShowingLiveHistory
      ? summarizeLiveHiddenWorkEntries(groupedEntries, liveActivityEntries)
      : null;
  const canToggleLiveHistory = isLiveActivity && liveHiddenCount > 0;
  const canToggleFullLog = !isLiveActivity && (hasOverflow || hasCompactedEntries);
  const canToggleActivityLog = canToggleLiveHistory || canToggleFullLog;
  const showHeader =
    isLiveActivity ||
    canToggleActivityLog ||
    hasCompactedEntries ||
    hasOverflow ||
    !onlyToolEntries;
  const toggleLabel = isExpanded
    ? isLiveActivity
      ? "Hide previous"
      : "Hide transcript"
    : isLiveActivity
      ? "Show previous"
      : hasCompactedEntries
        ? "View transcript"
        : `Show ${hiddenCount} more`;
  const toggleAriaLabel = isExpanded
    ? isLiveActivity
      ? "Hide previous activities"
      : "Hide activity transcript"
    : isLiveActivity
      ? `Show ${liveHiddenCount.toLocaleString()} previous ${
          liveHiddenCount === 1 ? "activity" : "activities"
        }`
      : toggleLabel;

  return (
    <div
      className={cn(
        "rounded-xl border border-border/45 bg-card/25 px-2 py-1.5",
        // Live segments read as "hot" via a heavier accent edge on the thread.
        isLiveActivity && "border-l-2 border-l-primary-graph/40 pl-[7px]",
      )}
    >
      {showHeader && (
        <div className="mb-1.5 flex items-start justify-between gap-2 px-0.5">
          <div className="min-w-0">
            <SectionLabel className="text-[9px] tracking-[0.16em]">
              {isLiveActivity ? "Current activity" : `Activity (${groupedEntries.length})`}
            </SectionLabel>
            {hiddenSummary || liveHiddenSummary ? (
              <p className="mt-0.5 truncate text-[10px] leading-4 text-muted-foreground/45">
                {hiddenSummary ?? liveHiddenSummary}
              </p>
            ) : null}
          </div>
          {canToggleActivityLog && (
            <button
              type="button"
              className="shrink-0 text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
              aria-expanded={isExpanded}
              aria-label={toggleAriaLabel}
              onClick={() => setIsExpanded((v) => !v)}
            >
              {toggleLabel}
            </button>
          )}
        </div>
      )}
      <div className="space-y-0.5" data-live-activity-strip={isLiveActivity ? "true" : undefined}>
        {visibleEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={`work-row:${workEntry.id}`}
            isLiveActivity={isLiveActivity}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
          />
        ))}
      </div>
    </div>
  );
});

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
  const hiddenCount = Math.max(0, allEntries.length - visibleEntries.length);
  if (hiddenCount <= 0) {
    return null;
  }
  const runningCount = allEntries.filter((entry) => entry.executionState === "running").length;
  const delegatedCount = allEntries.filter(
    (entry) => entry.itemType === "collab_agent_tool_call",
  ).length;
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

const MAX_COLLAPSED_USER_MESSAGE_LINES = 8;
const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600;
const COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM = 1.75;
const COLLAPSED_USER_MESSAGE_FADE_MASK = `linear-gradient(to bottom, black calc(100% - ${COLLAPSED_USER_MESSAGE_FADE_HEIGHT_REM}rem), transparent)`;

function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }

  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split("\n").length > MAX_COLLAPSED_USER_MESSAGE_LINES
  );
}

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  footer?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0 || props.terminalContexts.length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;

  return (
    <div>
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody
            text={props.text}
            terminalContexts={props.terminalContexts}
            skills={props.skills}
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
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
}) {
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
              <SkillInlineText text={props.text.slice(cursor, matchIndex)} skills={props.skills} />
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
              <SkillInlineText text={props.text.slice(cursor)} skills={props.skills} />
            </span>,
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
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
          <SkillInlineText text={props.text} skills={props.skills} />
        </span>,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      <SkillInlineText text={props.text} skills={props.skills} />
    </div>
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
      <span className="size-1 animate-pulse rounded-full bg-primary-graph/80" />
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
  displayText,
  heading,
  isRunningTool,
  preview,
  rawCommand,
  runningStartedAt,
  tone,
  visibleDiffStat,
  className,
}: {
  displayText: string;
  heading: string;
  isRunningTool: boolean;
  preview: string | null;
  rawCommand: string | null;
  runningStartedAt?: string | null;
  tone: TimelineWorkEntry["tone"];
  visibleDiffStat: { additions: number; deletions: number } | null;
  className?: string;
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
      title={displayText}
    >
      {isRunningTool ? <RunningToolIndicator className="mr-1.5 shrink-0" /> : null}
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
}) {
  const { workEntry, workspaceRoot, compact } = props;
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
                {isRunningTool ? <RunningToolIndicator className="mr-1.5" /> : null}
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

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  isLiveActivity: boolean;
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const {
    turnDiffSummaryByTurnId,
    onRunProviderAuthReconnect,
    resolvedProviderAuthReconnectIds,
    mcpAuthReconnectStatusByServerName,
    onRunMcpAuthReconnect,
  } = use(TimelineRowCtx);
  const [isOutputExpanded, setIsOutputExpanded] = useState(false);
  const { isLiveActivity, workspaceRoot } = props;
  const workEntry = resolveDisplayedWorkEntry(props.workEntry, isLiveActivity);

  if (isSubagentWorkEntry(workEntry)) {
    return (
      <SubagentWorkEntryRow
        workEntry={workEntry}
        workspaceRoot={workspaceRoot}
        compact={isLiveActivity}
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
  const hasExpandableOutput = Boolean(outputPreview);
  const failureLine = isOutputExpanded ? null : commandFailureLine(workEntry);
  const isStandaloneImagePreview =
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
          className="max-w-[420px] pl-7"
          imageClassName="max-h-[260px] object-contain"
        />
      </div>
    );
  }

  return (
    <div
      className={cn("rounded-lg px-1 py-1", hasExpandableOutput && "cursor-pointer")}
      {...(hasExpandableOutput
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-expanded": isOutputExpanded,
            "aria-label": isOutputExpanded ? "Hide command output" : "Show command output",
            onClick: () => setIsOutputExpanded((value) => !value),
            onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setIsOutputExpanded((value) => !value);
              }
            },
          }
        : {})}
    >
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          {rawCommand ? (
            <div className="max-w-full">
              <WorkEntrySummaryLine
                className="text-xs"
                displayText={displayText}
                heading={heading}
                isRunningTool={isRunningTool}
                preview={preview}
                rawCommand={rawCommand}
                runningStartedAt={isRunningTool ? workEntry.createdAt : null}
                tone={workEntry.tone}
                visibleDiffStat={visibleDiffStat}
              />
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger
                className="block min-w-0 w-full text-left"
                title={displayText}
                aria-label={displayText}
              >
                <WorkEntrySummaryLine
                  className="text-[11px]"
                  displayText={displayText}
                  heading={heading}
                  isRunningTool={isRunningTool}
                  preview={preview}
                  rawCommand={null}
                  runningStartedAt={isRunningTool ? workEntry.createdAt : null}
                  tone={workEntry.tone}
                  visibleDiffStat={visibleDiffStat}
                />
              </TooltipTrigger>
              <TooltipPopup className="max-w-[min(720px,calc(100vw-2rem))]">
                <p className="whitespace-pre-wrap wrap-break-word text-xs leading-5">
                  {displayText}
                </p>
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
      </div>
      {failureLine ? (
        <p
          className="mt-0.5 truncate pl-7 font-mono text-[11px] leading-4 text-destructive/85"
          data-command-failure="true"
          title={failureLine}
        >
          {failureLine}
        </p>
      ) : null}
      {workEntry.authReconnect ? (
        <ProviderAuthReconnectCard
          action={workEntry.authReconnect}
          className="mt-1.5 ml-7"
          resolved={resolvedProviderAuthReconnectIds.has(workEntry.id)}
          {...(onRunProviderAuthReconnect ? { onRun: onRunProviderAuthReconnect } : {})}
        />
      ) : null}
      {workEntry.mcpAuthReconnect ? (
        <McpAuthReconnectCard
          action={workEntry.mcpAuthReconnect}
          className="mt-1.5 ml-7"
          status={mcpAuthReconnectStatusByServerName.get(workEntry.mcpAuthReconnect.serverName)}
          {...(onRunMcpAuthReconnect ? { onRun: onRunMcpAuthReconnect } : {})}
        />
      ) : null}
      {hasExpandableOutput && isOutputExpanded ? (
        <div className="mt-1 pl-7" data-command-output="true">
          <pre className="max-h-52 overflow-y-auto rounded-md border border-border/45 bg-background/70 px-2 py-1.5 font-mono text-[11px] leading-4 whitespace-pre-wrap wrap-break-word text-muted-foreground/80">
            {commandOutputTail(outputPreview ?? "")}
          </pre>
          {workEntry.exitCode !== undefined ? (
            <p className="mt-0.5 text-[10px] tracking-wide text-muted-foreground/55">
              exit {workEntry.exitCode}
            </p>
          ) : null}
        </div>
      ) : null}
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
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
      {imagePreviews.length > 0 && (
        <TimelineImagePreviewGrid
          images={imagePreviews}
          className="mt-2 max-w-[420px] pl-7"
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

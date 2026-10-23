import {
  ArchiveIcon,
  CalendarClockIcon,
  CheckIcon,
  ChevronRightIcon,
  Clock3Icon,
  CloudIcon,
  CornerDownRightIcon,
  LinkIcon,
  MonitorUpIcon,
  GitForkIcon,
  PinIcon,
  TerminalIcon,
  Undo2Icon,
  GitBranchIcon,
  MonitorIcon,
  UsersRoundIcon,
} from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type {
  ComputerLinkPendingRequest,
  EnvironmentId,
  ModelSelection,
  ScopedThreadRef,
  VcsStatusResult,
} from "@threadlines/contracts";
import { scopedThreadKey, scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import { resolveThreadWorkingCwd } from "@threadlines/shared/threadCwd";
import type { SidebarThreadSummary } from "../../types";
import { cn } from "../../lib/utils";
import { useTouchHoldMenu } from "../../hooks/useTouchHoldMenu";
import type { ThreadRowSwipeHandler } from "../../hooks/useThreadRowSwipes";
import { SwipeableRow, threadRowSwipeAction } from "./SwipeableRow";
import { useGitStatus } from "../../lib/gitStatusState";
import { useScheduledRunTaskName } from "../../lib/scheduledTasksState";
import { isThreadSessionStarting } from "../../lib/threadSort";
import { selectProjectByRef, useStore } from "../../store";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { useRelativeTimeTick } from "../../hooks/useRelativeTimeTick";
import { formatCheckBackCountdownShort } from "../chat/checkBacks";
import { formatRelativeTimeLabel, formatWorkingDurationLabel } from "../../timestampFormat";
import { getPickerModelName } from "../chat/providerIconUtils";
import { ProviderGlyph } from "../chat/ProviderInstanceIcon";
import { isRoom, roomAgentDisplayName } from "../../rooms";
import { useServerProviders } from "../../rpc/serverState";
import { prStatusIndicator, terminalStatusFromRunningIds } from "../ThreadStatusIndicators";
import {
  leadThreadPullRequest,
  pullRequestFromGitStatus,
  withListedLanding,
  type ThreadPullRequest,
} from "../pull-requests/pullRequests.logic";
import {
  formatChildThreadCount,
  formatChildThreadsHighlight,
  inboxStatusWord,
  remoteChildStatusText,
  THREAD_STATUS_DOT_CLASSES,
  type ChildThreadsSummary,
  type InboxRemoteChild,
  type ThreadStatusPill,
} from "../Sidebar.logic";
import { Button } from "../ui/button";
import { useLinkRequestAnswer } from "./linkedComputers";
import { runtimeModeConfig } from "../../runtimeModeOptions";
import { formatThreadMoveAccess, formatThreadMoveChanges } from "../../threadMove";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  ThreadHoverCard,
  useThreadHoverCardHandle,
  type ThreadHoverCardLineage,
} from "./ThreadHoverCard";
import { describedAwaitedTasks, formatBackgroundWaitWord } from "../../session-logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ROW_ITEM_CLASS_NAME = "group/thread-row relative w-full";

export const ROW_SURFACE_CLASS_NAME =
  "relative w-full cursor-pointer select-none text-left outline-hidden focus-ring focus-visible:ring-inset [-webkit-touch-callout:none]";

/** Hover and selection are colour shifts only — nothing moves under the cursor. */
export function resolveRowSurfaceTone(input: { isActive: boolean; isSelected: boolean }): string {
  if (input.isSelected) {
    return "bg-brand-navy/15 dark:bg-brand-navy/22 hover:bg-brand-navy/19 dark:hover:bg-brand-navy/28";
  }
  if (input.isActive) {
    return "bg-sidebar-accent";
  }
  return "hover:bg-sidebar-accent/60";
}

/**
 * The fill of a hovered row, as static classes: the floating actions only show
 * while their row is hovered (or holds focus), so their backdrop can restate
 * the row's hover tone and composite to the identical colour. Must stay in
 * lockstep with {@link resolveRowSurfaceTone}.
 */
function resolveRowHoverFillTone(input: { isActive: boolean; isSelected: boolean }): string {
  if (input.isSelected) {
    return "bg-brand-navy/19 dark:bg-brand-navy/28";
  }
  if (input.isActive) {
    return "bg-sidebar-accent";
  }
  return "bg-sidebar-accent/60";
}

/**
 * Actions float in beside the time rather than reserving space or covering it:
 * anchored just left of the meta text, painted over the row's flexible middle
 * content. Nothing shifts, the time and a live "working · 4m" stay put, and at
 * rest the row gives up no width. Touch has no hover, so there they simply sit
 * in flow beside the time.
 */
const ROW_ACTIONS_CLASS_NAME =
  "flex shrink-0 items-center gap-0.5 sm:pointer-events-none sm:absolute sm:top-1/2 sm:right-full sm:-translate-y-1/2 sm:pl-4 sm:pr-1 sm:opacity-0 sm:transition-opacity sm:duration-150 sm:[mask-image:linear-gradient(to_right,transparent,black_16px)] sm:group-hover/thread-row:pointer-events-auto sm:group-hover/thread-row:opacity-100 sm:group-focus-within/thread-row:pointer-events-auto sm:group-focus-within/thread-row:opacity-100";

/**
 * Every pull request a thread has, its own first, each once: a linked one can
 * be the thread's own after the thread moves onto its branch.
 */
function threadPullRequestList(
  own: ThreadPullRequest | null,
  linked: readonly ThreadPullRequest[],
): readonly ThreadPullRequest[] {
  return own === null ? linked : [own, ...linked.filter((pr) => pr.number !== own.number)];
}

/**
 * The thread's pull requests as one badge: the glyph, colour and number of the
 * one that speaks for them all (see `leadThreadPullRequest`), then how many
 * more there are. The tooltip names every one. Live and wrapped rows share it,
 * so a merged branch reads the same violet wherever the thread ends up.
 * Renders nothing without a pull request.
 */
function ThreadPullRequestBadge({
  pullRequests,
  provider,
  threadRef,
  openPrLink,
}: {
  readonly pullRequests: readonly ThreadPullRequest[];
  readonly provider: VcsStatusResult["sourceControlProvider"] | null | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly openPrLink: (
    event: React.MouseEvent<HTMLElement>,
    pullRequest: Pick<ThreadPullRequest, "number" | "url">,
    threadRef: ScopedThreadRef,
  ) => void;
}) {
  const lead = leadThreadPullRequest(pullRequests);
  const prStatus = prStatusIndicator(lead, provider);
  const cardHandle = useThreadHoverCardHandle();
  if (!prStatus) {
    return null;
  }
  const target = { number: prStatus.number, url: prStatus.url };
  const others = pullRequests.filter((pullRequest) => pullRequest !== lead);
  const tooltipLines = [
    prStatus.tooltip,
    ...others.flatMap((pullRequest) => prStatusIndicator(pullRequest, provider)?.tooltip ?? []),
  ];

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-thread-selection-safe
            data-testid="inbox-thread-pr-badge"
            aria-label={tooltipLines.join("; ")}
            className={cn(
              // 10px type is a small thing to hit with a thumb, so a coarse
              // pointer gets padding around it and the same glyph inside.
              // Underlined on hover like the number in the detail header: it
              // opens the pull request, and should read as the link it is.
              "inline-flex cursor-pointer items-center gap-0.5 rounded-sm font-mono text-[10px] leading-none tabular-nums underline-offset-2 outline-hidden hover:underline focus-ring pointer-coarse:p-1.5",
              prStatus.colorClass,
            )}
            // The badge has a tooltip of its own, so the row's hover card has
            // no business opening over it: it is closed on the way in, and the
            // pointer's movement is kept from the row so it cannot reopen
            // while the pointer stays here.
            onPointerEnter={() => cardHandle?.close()}
            onPointerMove={(event) => event.stopPropagation()}
            onMouseMove={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => openPrLink(event, target, threadRef)}
            // Middle click never reaches onClick, and it is the other half of
            // the browser's "open it over there" gesture openPrLink answers.
            onAuxClick={(event) => {
              if (event.button === 1) openPrLink(event, target, threadRef);
            }}
          >
            <prStatus.Icon className="size-3" />
            {/* The mono digits sit a hair high beside the glyph at this size. */}
            <span className="translate-y-px">#{prStatus.number}</span>
            {others.length > 0 ? (
              <span className="translate-y-px text-muted-foreground">+{others.length}</span>
            ) : null}
          </button>
        }
      />
      <TooltipPopup side="top">
        {tooltipLines.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The slot a row's first line gives to the time, and to the actions. */
const ROW_META_SLOT_CLASS_NAME =
  "relative ml-auto flex flex-none items-center gap-1.5 whitespace-nowrap";

/** `relative` lifts the buttons above their own backdrop layers. */
export const ROW_ACTION_BUTTON_CLASS_NAME =
  "relative inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors pointer-coarse:size-7 hover:text-foreground focus-ring";

/**
 * The floating container for a row's hover actions. The two backdrop layers
 * rebuild the hovered row's exact colour (opaque sidebar base + the row's own
 * hover fill), and the container's mask melts their leading edge so covered
 * text fades out instead of clipping against a seam.
 */
function RowFloatingActions(props: {
  isActive: boolean;
  isSelected: boolean;
  /** For click-initiated states (archive confirm) that must not fade away. */
  alwaysVisible?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        ROW_ACTIONS_CLASS_NAME,
        props.alwaysVisible === true && "sm:pointer-events-auto sm:opacity-100",
      )}
    >
      <span aria-hidden="true" className="absolute inset-0 hidden bg-sidebar sm:block" />
      <span
        aria-hidden="true"
        className={cn("absolute inset-0 hidden sm:block", resolveRowHoverFillTone(props))}
      />
      {props.children}
    </div>
  );
}

/**
 * The thread's own project. Grouped projects put threads from several checkouts
 * under one name, so the row asks for its own rather than the group's -- the
 * favicon, its monogram fallback, and the git status all depend on the right
 * one.
 */
function useThreadProject(thread: SidebarThreadSummary): { cwd: string; name: string } | null {
  return useStore(
    useShallow(
      useMemo(
        () => (state: import("../../store").AppState) => {
          const project = selectProjectByRef(
            state,
            scopeProjectRef(thread.environmentId, thread.projectId),
          );
          return project ? { cwd: project.cwd, name: project.name } : null;
        },
        [thread.environmentId, thread.projectId],
      ),
    ),
  );
}

/**
 * Which machine a thread is running on, when that is a question worth asking.
 *
 * The cloud alone marks anything not on this device: the row's meta strip is
 * contested space, and the machine's name lives one hover away in the tooltip
 * and the hover card, which use the same cloud glyph for the same fact.
 */
export function ThreadEnvironmentBadge(props: { thread: SidebarThreadSummary }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const runtimeLabel = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[props.thread.environmentId]?.descriptor?.label ?? null,
  );
  const savedLabel = useSavedEnvironmentRegistryStore(
    (state) => state.byId[props.thread.environmentId]?.label ?? null,
  );
  if (primaryEnvironmentId === null || props.thread.environmentId === primaryEnvironmentId) {
    return null;
  }

  const label = runtimeLabel ?? savedLabel ?? "Remote";
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span aria-label={label} className="inline-flex items-center justify-center" />}
      >
        <CloudIcon className="block size-3 text-muted-foreground/50" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function formatDiffCount(count: number): string {
  return count >= 1_000 ? `${Math.round(count / 100) / 10}k` : `${count}`;
}

/**
 * The elapsed half of "working · 4m". Its own component so the second-by-second
 * tick re-renders one label instead of every row in the list.
 */
function ThreadElapsedLabel({ startedAt }: { startedAt: string }) {
  const nowMs = useRelativeTimeTick(1_000);
  return <>{formatWorkingDurationLabel(startedAt, nowMs)}</>;
}

/**
 * The dot between parts of a row's status ("working · 4m"): thin spaces in
 * the UI font, under half the width of a mono " · ", so the status stays
 * tight.
 */
function MetaSeparator() {
  // `whitespace-pre` keeps the spaces where the status is a flex row (rooms).
  return <span className="font-sans whitespace-pre opacity-60">{"\u2009·\u2009"}</span>;
}

/**
 * In a room, the agent working or last at work: the name the user gave it,
 * otherwise its model named the way the composer's model picker names it
 * ("GPT-6 Astra · working"). The one part of the status that yields when the
 * row is narrow; the full name is in its tooltip.
 */
function RoomSlotAgentName({
  selection,
  role,
}: {
  selection: ModelSelection;
  /** The user's name for the agent. */
  role?: string | null | undefined;
}) {
  const providers = useServerProviders();
  const name = useMemo(() => {
    const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
    const model = provider?.models.find((entry) => entry.slug === selection.model);
    return provider && model ? getPickerModelName(model, provider.driver) : selection.model;
  }, [providers, selection.instanceId, selection.model]);
  return (
    <span title={roomAgentDisplayName(name, role)} className="min-w-0 truncate font-sans">
      {role || name}
    </span>
  );
}

export function ThreadProviderGlyph({ thread }: { thread: SidebarThreadSummary }) {
  const session = thread.session;
  if (!session) {
    return null;
  }
  return (
    <ProviderGlyph
      instanceId={session.providerInstanceId}
      driverKind={session.provider}
      className="size-3 shrink-0 text-muted-foreground/45"
    />
  );
}

/**
 * What a row's status slot says. A thread that stopped for the user spends
 * one word on it ("input"); one at work reads as its live word and a clock
 * ("working · 4m"); anything else rests with a time. Live rows and child
 * rows read it the same way, so a thread says the same thing wherever it sits.
 */
function resolveRowStatusParts(thread: SidebarThreadSummary, status: ThreadStatusPill | null) {
  // Moving to a linked computer, or moved there: frozen here either way, so
  // the one quiet word wins the slot over whatever it last did.
  const moveWord = thread.moveStatus ?? null;
  const statusWord = moveWord ?? inboxStatusWord(status);
  const isInFlight = status?.label === "Working" || status?.label === "Starting";
  // In a room, an agent answering on the side while the others are idle: its
  // own name, and a clock from when it was asked.
  const isAnswering = status?.label === "Answering";
  // A follow-up starts its session before the new turn's row lands in the
  // projection, so for a beat `latestTurn` is still the previous, finished
  // turn -- its clock must not run under the new label, which is "Working"
  // unless the agent's program is starting up. That is the only stale
  // window: once work is under way the pill and the timestamps describe the
  // same turn, and mid-turn session wobbles (tool waits, reconnects) must not
  // blank the timer, so a running turn is trusted as-is.
  const inFlightTurn =
    (status?.label === "Starting" || (isInFlight && isThreadSessionStarting(thread))) &&
    thread.latestTurn?.state !== "running"
      ? null
      : thread.latestTurn;
  const inFlightStartedAt = inFlightTurn
    ? (inFlightTurn.startedAt ?? inFlightTurn.requestedAt)
    : null;
  // "Waiting" is a wait, not work: the turn has settled and a provider task,
  // or an answer from a thread its agent started, will start the thread back
  // up on its own. Its clock anchors to the turn's settle time -- the moment
  // the waiting began. The pill only exists while the latest turn is
  // settled, so completedAt is always there.
  const isWaiting = status?.label === "Waiting";
  // Agents still at work say so ("2 agents"), and so do threads ("3
  // threads"); a command keeps "waiting".
  const waitWord = !isWaiting
    ? null
    : status.childThreadCount !== undefined
      ? formatChildThreadCount(status.childThreadCount)
      : formatBackgroundWaitWord(describedAwaitedTasks(thread.session));
  const liveClockStartedAt = isInFlight
    ? inFlightStartedAt
    : isWaiting
      ? (thread.latestTurn?.completedAt ?? null)
      : isAnswering
        ? (thread.sideTurn?.startedAt ?? null)
        : null;
  const isLive = isInFlight || isWaiting || isAnswering;
  // An agent will come back: a countdown to when.
  const checkBackAt = status?.label === "Checking back" ? (status.checkBackAt ?? null) : null;
  return {
    statusWord,
    /** The status slot's colour while it says something; null leaves the resting tone. */
    statusTone: moveWord !== null ? "text-muted-foreground" : (status?.colorClass ?? null),
    checkBackAt,
    isAnswering,
    isLive,
    liveWord: isAnswering
      ? "answering"
      : (waitWord ?? (status?.label === "Starting" ? "starting" : "working")),
    liveClockStartedAt,
    hasStatusLabel: statusWord !== null || isLive || checkBackAt !== null,
  };
}

/** The jump shortcut a row shows in its status slot while the modifier is held. */
function ThreadJumpLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex h-4 items-center rounded-full border border-border/80 bg-background/90 px-1.5 text-[10px] font-medium tracking-tight text-foreground">
      {label}
    </span>
  );
}

/** The live half of a status slot: its word, then the clock. */
/** "◷ 14m": how long until an agent comes back by itself. */
function RowCheckBackStatus({ at }: { at: string }) {
  const nowMs = useRelativeTimeTick(30_000);
  return (
    <span className="inline-flex shrink-0 items-center gap-1" data-row-check-back="true">
      <Clock3Icon aria-hidden className="size-3" />
      {formatCheckBackCountdownShort(at, nowMs)}
    </span>
  );
}

function RowLiveStatus({ word, clockStartedAt }: { word: string; clockStartedAt: string | null }) {
  return (
    <>
      <span className="shrink-0">{word}</span>
      {clockStartedAt ? (
        <>
          <MetaSeparator />
          <span className="shrink-0">
            <ThreadElapsedLabel startedAt={clockStartedAt} />
          </span>
        </>
      ) : null}
    </>
  );
}

/**
 * A thread's status words the way the inbox writes them ("input", "working ·
 * 4m"), in its status colour, for a thread shown outside its own row. At rest
 * it shows `resting`, or else when it was last at work, in `restingClassName`
 * (the inbox's faded meta unless a surface asks for the opaque muted tone).
 */
export function ThreadStatusText({
  thread,
  status,
  resting,
  restingClassName = "text-muted-foreground/50",
  testId,
}: {
  thread: SidebarThreadSummary;
  status: ThreadStatusPill | null;
  resting?: React.ReactNode;
  restingClassName?: string;
  testId?: string | undefined;
}) {
  const {
    statusWord,
    statusTone,
    checkBackAt,
    isLive,
    liveWord,
    liveClockStartedAt,
    hasStatusLabel,
  } = resolveRowStatusParts(thread, status);
  return (
    <span
      data-testid={testId}
      className={cn(
        "shrink-0 font-mono text-[11px] leading-none tabular-nums",
        hasStatusLabel ? (statusTone ?? restingClassName) : restingClassName,
      )}
    >
      {statusWord !== null ? (
        statusWord
      ) : checkBackAt !== null ? (
        <RowCheckBackStatus at={checkBackAt} />
      ) : isLive ? (
        <RowLiveStatus word={liveWord} clockStartedAt={liveClockStartedAt} />
      ) : (
        (resting ??
        formatRelativeTimeLabel(thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt))
      )}
    </span>
  );
}

const CHILD_SUMMARY_HIGHLIGHT_TONES: Record<
  NonNullable<ChildThreadsSummary["highlight"]>["kind"],
  string | undefined
> = {
  "needs-you": "text-amber-600 dark:text-amber-300/90",
  failed: "text-red-600 dark:text-red-400/90",
  working: undefined,
};

/** A family the parent row heads, as the row needs it. */
export interface InboxThreadFamily {
  readonly summary: ChildThreadsSummary;
  readonly open: boolean;
}

/**
 * A family's summary line under its parent: a dot per child in its status
 * colour (grey once finished or wrapped), then what matters most, then the
 * chevron. The line is the family's own button, outside the row's hover-card
 * trigger, and opens the children in place under it.
 */
function ChildFamilySummaryLine({
  threadId,
  family,
  onToggle,
}: {
  threadId: string;
  family: InboxThreadFamily;
  onToggle: () => void;
}) {
  const { summary, open } = family;
  return (
    <button
      type="button"
      data-thread-selection-safe
      data-testid={`thread-family-${threadId}`}
      aria-expanded={open}
      className="group/family flex w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 pt-[3px] pb-2 text-left text-[11px] text-muted-foreground/60 outline-hidden transition-colors hover:text-foreground focus-ring focus-visible:ring-inset pointer-coarse:pt-1.5 pointer-coarse:pb-3"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <span aria-hidden="true" className="flex shrink-0 items-center gap-0.5">
        {summary.dots.map((dot, index) => (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- children keep creation order, so a dot's place is its identity
            key={index}
            className={cn("block size-[5px] rounded-full", dot ?? "bg-muted-foreground/45")}
          />
        ))}
        {summary.hiddenDotCount > 0 ? (
          <span className="ps-0.5 font-mono text-[10px] leading-none">
            +{summary.hiddenDotCount}
          </span>
        ) : null}
      </span>
      <span className="min-w-0 truncate" data-testid={`thread-family-text-${threadId}`}>
        {formatChildThreadCount(summary.count)}
        {summary.highlight === null ? (
          " finished"
        ) : (
          <>
            <MetaSeparator />
            <span className={CHILD_SUMMARY_HIGHLIGHT_TONES[summary.highlight.kind]}>
              {formatChildThreadsHighlight(summary.highlight)}
            </span>
          </>
        )}
      </span>
      <ChevronRightIcon
        aria-hidden="true"
        className={cn(
          "ms-auto size-3 shrink-0 text-muted-foreground/45 group-hover/family:text-foreground",
          open && "rotate-90",
        )}
      />
    </button>
  );
}

export interface InboxThreadRowProps {
  thread: SidebarThreadSummary;
  status: ThreadStatusPill | null;
  /** Null only when the thread's project is unknown here. The name shows even
   *  while the list is scoped: the scope menu is out of sight, and a row
   *  should say where its work lives on its own. */
  projectLabel: string | null;
  /**
   * Whether the row draws its project's mark. Off under a project group's
   * header, which already names the project. Default on.
   */
  showProjectMark?: boolean | undefined;
  isActive: boolean;
  jumpLabel: string | null;
  /** False while the thread is moving, blocked, or pinned: live work can't be
   *  waved away, and a pin means keep it here. */
  canMarkDone: boolean;
  orderedThreadKeys: readonly string[];
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  markThreadDone: (threadKey: string) => void;
  /**
   * The pull request the listings know about for this thread, read once for
   * the whole inbox. Only consulted when the checkout is standing on some
   * other branch, where its own status has nothing to say.
   */
  listPullRequest: ThreadPullRequest | null;
  /** The pull requests the thread's agent opened on other branches, as the listings see them. */
  linkedPullRequests: readonly ThreadPullRequest[];
  openPrLink: (
    event: React.MouseEvent<HTMLElement>,
    pullRequest: Pick<ThreadPullRequest, "number" | "url">,
    threadRef: ScopedThreadRef,
  ) => void;
  /** The family of child threads this thread heads, while it is live. */
  family?: InboxThreadFamily | null | undefined;
  /** Opens or closes this thread's family, by its thread key. */
  onToggleFamily?: ((threadKey: string) => void) | undefined;
  /**
   * A live child whose parent is wrapped: the parent's title, shown where the
   * project name usually sits ("↳ Ship the 0.6 release").
   */
  wrappedParentTitle?: string | null | undefined;
  /**
   * A thread an agent on another computer started, standing on its own (the
   * machine filter hides its parent, or the app can't see that computer):
   * the parent and its computer, shown where the project name usually sits
   * ("from Ship the 0.6 release on Mac mini").
   */
  remoteParent?: RemoteParentLine | null | undefined;
  /** See ThreadHoverCardPayload.lineage. */
  lineage?: ThreadHoverCardLineage | undefined;
  /**
   * Runs what a sideways swipe on the row asks for (touch only). Absent, the
   * row doesn't swipe.
   */
  onSwipeAction?: ThreadRowSwipeHandler | undefined;
}

/** See InboxThreadRowProps.remoteParent. */
export interface RemoteParentLine {
  readonly title: string;
  readonly computerLabel: string;
}

/**
 * One live thread in the inbox: two lines, ~46px, no card.
 *
 * Line one carries identity and state (dot, title, status); line two carries
 * where the work lives (project, branch) and what it has produced (diffstat,
 * provider). The row's actions float in beside the status on hover, covering
 * only the line's truncatable middle — never the status, and never blank
 * reserved width.
 */
/** "Scheduled · <task>" for a scheduled task's run, else null. */
function useScheduledRunLabel(
  thread: Pick<SidebarThreadSummary, "environmentId" | "scheduledRun">,
): string | null {
  const taskName = useScheduledRunTaskName(thread.environmentId, thread.scheduledRun);
  return taskName === null ? null : `Scheduled · ${taskName}`;
}

export const InboxThreadRow = memo(function InboxThreadRow(props: InboxThreadRowProps) {
  const {
    thread,
    status,
    projectLabel,
    showProjectMark = true,
    isActive,
    jumpLabel,
    canMarkDone,
    orderedThreadKeys,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    renamingInputRef,
    renamingCommittedRef,
    handleThreadClick,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    markThreadDone,
    listPullRequest,
    linkedPullRequests,
    openPrLink,
    family = null,
    onToggleFamily,
    wrappedParentTitle = null,
    remoteParent = null,
    lineage,
    onSwipeAction,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
  const threadProject = useThreadProject(thread);
  const scheduledRunLabel = useScheduledRunLabel(thread);
  const gitCwd = resolveThreadWorkingCwd({
    projectCwd: threadProject?.cwd ?? null,
    worktreePath: thread.worktreePath,
    effectiveCwd: thread.effectiveCwd,
  });
  // Only rows with a pinned branch ask: the git status feeds the change
  // request badge alone, and that badge never renders without a pinned branch.
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch !== null ? gitCwd : null,
  });
  // The +/- is the thread's own running total, summed by the server across the
  // turns it has taken -- not the checkout's working tree, which several
  // threads can share and which would print the same numbers on each of them.
  // Nothing to report reads as nothing shown, so a thread that has not touched
  // a file yet stays quiet rather than claiming a clean tree.
  const diffStat = thread.cumulativeDiffStat;
  const showDiffStat = diffStat !== null && (diffStat.additions > 0 || diffStat.deletions > 0);
  // Both the branch name and the change request badge key off the branch the
  // thread pinned, never the checkout's current ref: a checkout is shared by
  // every thread in it, so its ref (and that ref's change request) says
  // nothing about this thread. The hover card is where the current ref gets
  // its say.
  // The checkout's own status wins on this branch, because it is the only one
  // that knows a merge or a close; the listing covers a thread whose checkout
  // has moved on, and dates a landing the status cannot.
  const statusPullRequest = pullRequestFromGitStatus(thread.branch, gitStatus.data);
  const pullRequests = threadPullRequestList(
    statusPullRequest ? withListedLanding(statusPullRequest, listPullRequest) : listPullRequest,
    linkedPullRequests,
  );
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isPinned = thread.pinnedAt !== null;
  const isRenaming = renamingThreadKey === threadKey;
  const {
    statusWord,
    statusTone,
    checkBackAt,
    isAnswering,
    isLive,
    liveWord,
    liveClockStartedAt,
    hasStatusLabel,
  } = resolveRowStatusParts(thread, status);
  // A completion nobody has looked at yet keeps the title bright until the
  // thread is opened.
  const isUnseen = status?.label === "Completed";
  // Line one has one hard rule: the status slot on the right always fits
  // whole, and the left cluster yields to it in a fixed order. The branch goes
  // first and goes completely -- half a branch name is worse than none, and a
  // row that is *doing* something has more to say than which ref it is on.
  // Who the status names in a room: the agent answering, or the one at work.
  const roomAgentSelection = isAnswering
    ? thread.roomSideModelSelection
    : thread.roomSlotModelSelection;
  const roomAgentRole = isAnswering ? thread.roomSideRole : thread.roomSlotRole;
  const showBranch = thread.branch !== null && !hasStatusLabel;
  // A room's live status also names the agent, which needs the width: the
  // project name yields first, then the agent's name, never the state or
  // the clock.
  const namesRoomAgent = roomAgentSelection != null && !jumpLabel && statusWord === null && isLive;
  const handleToggleFamily = useCallback(() => {
    onToggleFamily?.(threadKey);
  }, [onToggleFamily, threadKey]);

  const handleRowClick = useCallback(
    (event: React.MouseEvent) => {
      handleThreadClick(event, threadRef, orderedThreadKeys);
    },
    [handleThreadClick, orderedThreadKeys, threadRef],
  );
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigateToThread(threadRef);
    },
    [navigateToThread, threadRef],
  );
  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const hasSelection = useThreadSelectionStore.getState().hasSelection();
      if (hasSelection && isSelected) {
        void handleMultiSelectContextMenu({ x: event.clientX, y: event.clientY });
        return;
      }

      if (hasSelection) {
        clearSelection();
      }
      void handleThreadContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [clearSelection, handleMultiSelectContextMenu, handleThreadContextMenu, isSelected, threadRef],
  );
  // On a touch screen, holding the row opens the same menu.
  const openTouchMenu = useCallback(
    (position: { readonly x: number; readonly y: number }) => {
      clearSelection();
      void handleThreadContextMenu(threadRef, position);
    },
    [clearSelection, handleThreadContextMenu, threadRef],
  );
  const touchHold = useTouchHoldMenu<HTMLDivElement>({
    open: openTouchMenu,
    onContextMenu: handleRowContextMenu,
  });
  const handleRenameInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      if (element && renamingInputRef.current !== element) {
        renamingInputRef.current = element;
        element.focus();
        element.select();
      }
    },
    [renamingInputRef],
  );
  const handleRenameInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setRenamingTitle(event.target.value);
    },
    [setRenamingTitle],
  );
  const handleRenameInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        void commitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        cancelRename();
      }
    },
    [cancelRename, commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef],
  );
  const handleRenameInputBlur = useCallback(() => {
    if (!renamingCommittedRef.current) {
      void commitRename(threadRef, renamingTitle, thread.title);
    }
  }, [commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef]);
  const handleRenameInputClick = useCallback((event: React.MouseEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );
  const handleMarkDoneClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      markThreadDone(threadKey);
    },
    [markThreadDone, threadKey],
  );

  return (
    <li className={ROW_ITEM_CLASS_NAME} data-thread-item>
      {/* Swiped right it pins (or unpins); swiped left it wraps up, when the
          Wrap up button would. */}
      <SwipeableRow
        leading={threadRowSwipeAction(
          onSwipeAction,
          { threadKey, title: thread.title },
          isPinned ? "unpin" : "pin",
        )}
        trailing={
          canMarkDone
            ? threadRowSwipeAction(onSwipeAction, { threadKey, title: thread.title }, "wrap-up")
            : null
        }
        disabled={isRenaming}
      >
        {/* The surface holds the row and its family's summary line, so the two
          read, hover and highlight as one row. */}
        <div className={resolveRowSurfaceTone({ isActive, isSelected })}>
          <ThreadHoverCard thread={thread} status={status} lineage={lineage}>
            <div
              role="button"
              tabIndex={0}
              data-testid={`thread-row-${thread.id}`}
              data-thread-key={threadKey}
              data-active={isActive ? "true" : undefined}
              className={cn(ROW_SURFACE_CLASS_NAME, "px-3 pt-1.5", family ? "pb-0" : "pb-2")}
              onClick={handleRowClick}
              onKeyDown={handleRowKeyDown}
              {...touchHold}
            >
              {/* Line one: where the work lives, and what it is doing. */}
              <div
                data-testid={`thread-detail-${thread.id}`}
                className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground/45"
              >
                {status ? (
                  <span
                    aria-label={status.label}
                    className={cn("size-[7px] shrink-0 rounded-full", status.dotClass)}
                  />
                ) : null}
                {/* Pinned is persistent state, not activity: it stays visible even
                while the status dot occupies the leading slot. */}
                {isPinned ? (
                  <span
                    aria-label="Pinned thread"
                    className="inline-flex shrink-0 items-center justify-center text-muted-foreground/50"
                  >
                    <PinIcon className="size-2.5" />
                  </span>
                ) : null}
                {threadProject && showProjectMark ? (
                  <ProjectFavicon
                    cwd={threadProject.cwd}
                    environmentId={thread.environmentId}
                    name={threadProject.name}
                    className="size-3 shrink-0"
                  />
                ) : null}
                {scheduledRunLabel !== null ? (
                  // A scheduled task's run says which task, in the project name's place.
                  <span
                    className="flex min-w-0 items-center gap-1 text-muted-foreground/60"
                    data-testid={`thread-scheduled-run-${thread.id}`}
                  >
                    <CalendarClockIcon aria-hidden className="size-2.5 shrink-0" />
                    <span className="min-w-0 truncate">{scheduledRunLabel}</span>
                  </span>
                ) : remoteParent !== null ? (
                  // Started from another computer and standing on its own: the
                  // thread that started it, and where that thread runs.
                  <span
                    className="flex min-w-0 items-center gap-1 text-muted-foreground/60"
                    data-testid={`thread-remote-parent-${thread.id}`}
                  >
                    <CornerDownRightIcon aria-hidden className="size-2.5 shrink-0" />
                    <span className="min-w-0 truncate">
                      from {remoteParent.title} on {remoteParent.computerLabel}
                    </span>
                  </span>
                ) : wrappedParentTitle !== null ? (
                  // A child whose parent is wrapped says where it came from, in
                  // the project name's place.
                  <span
                    className="flex min-w-0 items-center gap-1 text-muted-foreground/60"
                    data-testid={`thread-wrapped-parent-${thread.id}`}
                  >
                    <CornerDownRightIcon aria-hidden className="size-2.5 shrink-0" />
                    <span className="min-w-0 truncate">{wrappedParentTitle}</span>
                  </span>
                ) : projectLabel ? (
                  <span
                    className={cn(
                      "min-w-0 truncate text-muted-foreground/60",
                      // Takes only the width the status leaves (no basis of its
                      // own), so it is gone before the agent's name gives up a
                      // pixel. Its gap goes with it: the spacing before the name
                      // is inside it, so a name shrunk to nothing leaves no double
                      // gap.
                      namesRoomAgent &&
                        "-ml-1.5 flex-1 before:inline-block before:w-1.5 before:content-['']",
                    )}
                  >
                    {projectLabel}
                  </span>
                ) : null}
                {showBranch ? (
                  <span className="flex min-w-0 items-center gap-1">
                    <GitBranchIcon aria-hidden className="size-2.5 shrink-0 opacity-60" />
                    <span className="min-w-0 truncate font-mono text-[10px]">{thread.branch}</span>
                  </span>
                ) : null}
                <span
                  className={cn(ROW_META_SLOT_CLASS_NAME, namesRoomAgent && "min-w-0 flex-initial")}
                >
                  <span
                    data-testid={`thread-meta-${thread.id}`}
                    className={cn(
                      "shrink-0 font-mono text-[11px] leading-none tabular-nums",
                      namesRoomAgent && "flex min-w-0 shrink items-baseline",
                      hasStatusLabel
                        ? (statusTone ?? "text-muted-foreground/50")
                        : "text-muted-foreground/50",
                    )}
                  >
                    {jumpLabel ? (
                      <ThreadJumpLabel label={jumpLabel} />
                    ) : statusWord !== null ? (
                      statusWord
                    ) : checkBackAt !== null ? (
                      <RowCheckBackStatus at={checkBackAt} />
                    ) : isLive ? (
                      <>
                        {namesRoomAgent && roomAgentSelection ? (
                          <>
                            <RoomSlotAgentName
                              selection={roomAgentSelection}
                              role={roomAgentRole}
                            />
                            <MetaSeparator />
                          </>
                        ) : null}
                        <RowLiveStatus word={liveWord} clockStartedAt={liveClockStartedAt} />
                      </>
                    ) : (
                      formatRelativeTimeLabel(
                        thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                      )
                    )}
                  </span>
                  {/* Wrap up is the only hover action; pin lives in the row's
                  context menu so a cursor sweeping the row can't hit it. The
                  wrapper only mounts alongside the button -- empty, it would
                  still paint its backdrop smear over the timestamp. */}
                  {canMarkDone ? (
                    <RowFloatingActions isActive={isActive} isSelected={isSelected}>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              data-thread-selection-safe
                              data-testid={`thread-done-${thread.id}`}
                              aria-label={`Wrap up ${thread.title}`}
                              className={ROW_ACTION_BUTTON_CLASS_NAME}
                              onPointerDown={stopPropagationOnPointerDown}
                              onClick={handleMarkDoneClick}
                            >
                              <CheckIcon className="size-3.5" />
                            </button>
                          }
                        />
                        <TooltipPopup side="top">Wrap up</TooltipPopup>
                      </Tooltip>
                    </RowFloatingActions>
                  ) : null}
                </span>
              </div>
              {/* Line two: which thread, and what it has produced. */}
              <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                {isRenaming ? (
                  <input
                    ref={handleRenameInputRef}
                    className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-base outline-none sm:text-xs"
                    value={renamingTitle}
                    onChange={handleRenameInputChange}
                    onKeyDown={handleRenameInputKeyDown}
                    onBlur={handleRenameInputBlur}
                    onClick={handleRenameInputClick}
                  />
                ) : (
                  // No tooltip on the title: the hover card already carries the
                  // full one, and two popups racing the same hover is the bug.
                  <>
                    {isRoom(thread) ? (
                      <UsersRoundIcon
                        aria-label="Room"
                        className="size-3 shrink-0 text-muted-foreground/70"
                      />
                    ) : null}
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-xs font-medium",
                        isUnseen ? "text-foreground" : "text-foreground/90",
                      )}
                      data-testid={`thread-title-${thread.id}`}
                    >
                      {thread.title}
                    </span>
                  </>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {terminalStatus ? (
                    <span
                      role="img"
                      aria-label={terminalStatus.label}
                      className={cn(
                        "inline-flex items-center justify-center",
                        terminalStatus.colorClass,
                      )}
                    >
                      <TerminalIcon
                        className={cn("size-3", terminalStatus.pulse && "animate-status-pulse")}
                      />
                    </span>
                  ) : null}
                  <ThreadEnvironmentBadge thread={thread} />
                  <ThreadPullRequestBadge
                    pullRequests={pullRequests}
                    provider={gitStatus.data?.sourceControlProvider}
                    threadRef={threadRef}
                    openPrLink={openPrLink}
                  />
                  {showDiffStat && diffStat ? (
                    <span className="font-mono text-[10px] leading-none">
                      <span className="text-success">+{formatDiffCount(diffStat.additions)}</span>
                      <span className="ps-1 text-destructive">
                        −{formatDiffCount(diffStat.deletions)}
                      </span>
                    </span>
                  ) : null}
                  <ThreadProviderGlyph thread={thread} />
                </span>
              </div>
            </div>
          </ThreadHoverCard>
          {family ? (
            <ChildFamilySummaryLine
              threadId={thread.id}
              family={family}
              onToggle={handleToggleFamily}
            />
          ) : null}
        </div>
      </SwipeableRow>
    </li>
  );
});

export interface InboxChildRowProps {
  thread: SidebarThreadSummary;
  status: ThreadStatusPill | null;
  /** Filed under Wrapped: a grey check, the time it was wrapped, and reopen on hover. */
  isDone: boolean;
  doneAt: string | null;
  isActive: boolean;
  /** See InboxThreadRowProps.jumpLabel. */
  jumpLabel: string | null;
  /** See InboxThreadRowProps.canMarkDone. */
  canMarkDone: boolean;
  orderedThreadKeys: readonly string[];
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  handleThreadClick: InboxThreadRowProps["handleThreadClick"];
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  handleMultiSelectContextMenu: InboxThreadRowProps["handleMultiSelectContextMenu"];
  handleThreadContextMenu: InboxThreadRowProps["handleThreadContextMenu"];
  clearSelection: () => void;
  commitRename: InboxThreadRowProps["commitRename"];
  cancelRename: () => void;
  markThreadDone: (threadKey: string) => void;
  reopenThread: (threadKey: string) => void;
  lineage?: ThreadHoverCardLineage | undefined;
  /**
   * The computer it runs on, when that isn't its parent's: a computer glyph
   * marks the row (the hover card names the computer).
   */
  computerLabel?: string | null | undefined;
  /** See InboxThreadRowProps.onSwipeAction. */
  onSwipeAction?: ThreadRowSwipeHandler | undefined;
}

/**
 * One thread in a family, under its parent: one line, ~26px. The status dot
 * (a grey check once wrapped), the title, the same status words and colours a
 * live row uses, and the agent. Where the work lives is the parent's to say,
 * and the branch is in the hover card; a child on another computer than its
 * parent says so with a computer glyph.
 */
export const InboxChildRow = memo(function InboxChildRow(props: InboxChildRowProps) {
  const {
    thread,
    status,
    isDone,
    doneAt,
    isActive,
    jumpLabel,
    canMarkDone,
    orderedThreadKeys,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    renamingInputRef,
    renamingCommittedRef,
    handleThreadClick,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    markThreadDone,
    reopenThread,
    lineage,
    computerLabel = null,
    onSwipeAction,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const isRenaming = renamingThreadKey === threadKey;
  const shownStatus = isDone ? null : status;
  const needsYou =
    shownStatus?.label === "Pending Approval" || shownStatus?.label === "Awaiting Input";

  const handleRowClick = useCallback(
    (event: React.MouseEvent) => {
      handleThreadClick(event, threadRef, orderedThreadKeys);
    },
    [handleThreadClick, orderedThreadKeys, threadRef],
  );
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigateToThread(threadRef);
    },
    [navigateToThread, threadRef],
  );
  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const hasSelection = useThreadSelectionStore.getState().hasSelection();
      if (hasSelection && isSelected) {
        void handleMultiSelectContextMenu({ x: event.clientX, y: event.clientY });
        return;
      }
      if (hasSelection) {
        clearSelection();
      }
      void handleThreadContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [clearSelection, handleMultiSelectContextMenu, handleThreadContextMenu, isSelected, threadRef],
  );
  // On a touch screen, holding the row opens the same menu.
  const openTouchMenu = useCallback(
    (position: { readonly x: number; readonly y: number }) => {
      clearSelection();
      void handleThreadContextMenu(threadRef, position);
    },
    [clearSelection, handleThreadContextMenu, threadRef],
  );
  const touchHold = useTouchHoldMenu<HTMLDivElement>({
    open: openTouchMenu,
    onContextMenu: handleRowContextMenu,
  });
  const handleRenameInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      if (element && renamingInputRef.current !== element) {
        renamingInputRef.current = element;
        element.focus();
        element.select();
      }
    },
    [renamingInputRef],
  );
  const handleRenameInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        void commitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        cancelRename();
      }
    },
    [cancelRename, commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef],
  );
  const handleRenameInputBlur = useCallback(() => {
    if (!renamingCommittedRef.current) {
      void commitRename(threadRef, renamingTitle, thread.title);
    }
  }, [commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef]);
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );
  const handleWrapClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (isDone) {
        reopenThread(threadKey);
      } else {
        markThreadDone(threadKey);
      }
    },
    [isDone, markThreadDone, reopenThread, threadKey],
  );
  const showAction = isDone || canMarkDone;

  return (
    <li className={ROW_ITEM_CLASS_NAME} data-thread-item>
      {/* The same action as its button: Reopen once wrapped (swiped right),
          Wrap up while it can be (swiped left). */}
      <SwipeableRow
        leading={
          isDone
            ? threadRowSwipeAction(onSwipeAction, { threadKey, title: thread.title }, "reopen")
            : null
        }
        trailing={
          !isDone && canMarkDone
            ? threadRowSwipeAction(onSwipeAction, { threadKey, title: thread.title }, "wrap-up")
            : null
        }
        disabled={isRenaming}
      >
        <ThreadHoverCard thread={thread} status={shownStatus} lineage={lineage}>
          <div
            role="button"
            tabIndex={0}
            data-testid={`child-row-${thread.id}`}
            data-thread-key={threadKey}
            data-active={isActive ? "true" : undefined}
            data-wrapped={isDone ? "true" : undefined}
            className={cn(
              ROW_SURFACE_CLASS_NAME,
              "flex min-w-0 items-center gap-1.5 px-3 py-[5px] pointer-coarse:py-2",
              resolveRowSurfaceTone({ isActive, isSelected }),
            )}
            onClick={handleRowClick}
            onKeyDown={handleRowKeyDown}
            {...touchHold}
          >
            {isDone ? (
              <CheckIcon
                aria-label="Wrapped"
                className="size-2.5 shrink-0 text-muted-foreground/50"
              />
            ) : (
              <span
                aria-label={shownStatus?.label ?? "Idle"}
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  shownStatus?.dotClass ?? "bg-muted-foreground/45",
                )}
              />
            )}
            {isRenaming ? (
              <input
                ref={handleRenameInputRef}
                className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-base outline-none sm:text-xs"
                value={renamingTitle}
                onChange={(event) => setRenamingTitle(event.target.value)}
                onKeyDown={handleRenameInputKeyDown}
                onBlur={handleRenameInputBlur}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs leading-4",
                  isDone
                    ? "text-muted-foreground/80"
                    : needsYou
                      ? "text-foreground"
                      : "text-foreground/85",
                )}
                data-testid={`child-title-${thread.id}`}
              >
                {thread.title}
              </span>
            )}
            <span className={ROW_META_SLOT_CLASS_NAME}>
              {jumpLabel ? (
                <span
                  data-testid={`child-meta-${thread.id}`}
                  className="shrink-0 font-mono text-[11px] leading-none tabular-nums"
                >
                  <ThreadJumpLabel label={jumpLabel} />
                </span>
              ) : (
                <ThreadStatusText
                  thread={thread}
                  status={shownStatus}
                  testId={`child-meta-${thread.id}`}
                  {...(isDone ? { resting: doneAt ? formatRelativeTimeLabel(doneAt) : null } : {})}
                />
              )}
              {showAction ? (
                <RowFloatingActions isActive={isActive} isSelected={isSelected}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={
                            isDone ? `child-reopen-${thread.id}` : `child-done-${thread.id}`
                          }
                          aria-label={`${isDone ? "Reopen" : "Wrap up"} ${thread.title}`}
                          className={ROW_ACTION_BUTTON_CLASS_NAME}
                          onPointerDown={stopPropagationOnPointerDown}
                          onClick={handleWrapClick}
                        >
                          {isDone ? (
                            <Undo2Icon className="size-3.5" />
                          ) : (
                            <CheckIcon className="size-3.5" />
                          )}
                        </button>
                      }
                    />
                    <TooltipPopup side="top">{isDone ? "Reopen" : "Wrap up"}</TooltipPopup>
                  </Tooltip>
                </RowFloatingActions>
              ) : null}
            </span>
            {computerLabel !== null ? (
              <span
                role="img"
                aria-label={`On ${computerLabel}`}
                data-testid={`child-computer-${thread.id}`}
                className="inline-flex shrink-0 items-center"
              >
                <MonitorIcon aria-hidden className="size-3 text-muted-foreground/45" />
              </span>
            ) : null}
            <ThreadProviderGlyph thread={thread} />
          </div>
        </ThreadHoverCard>
      </SwipeableRow>
    </li>
  );
});

/**
 * A thread in a family that runs on a computer this app can't see, or a start
 * that has no thread there yet, from the parent's own record. The status dot
 * and title as a child row has them, then under the title a computer glyph
 * with where it stands ("Mac mini · working", "Waiting for Mac mini to allow
 * it"): a second line, so a narrow list keeps both the title and the
 * computer. The app has no thread to open, so the row only explains itself
 * on hover.
 */
export const InboxRemoteChildRow = memo(function InboxRemoteChildRow({
  child,
}: {
  child: InboxRemoteChild;
}) {
  const statusText = remoteChildStatusText(child);
  const isStart = child.threadId === null;
  const tone = child.isDone ? undefined : child.status?.colorClass;
  return (
    <li className={ROW_ITEM_CLASS_NAME}>
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              data-testid={`remote-child-row-${child.threadKey}`}
              data-wrapped={child.isDone ? "true" : undefined}
              className="cursor-default px-3 py-[5px] select-none pointer-coarse:py-2"
            />
          }
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {child.isDone ? (
              <CheckIcon
                aria-label="Wrapped"
                className="size-2.5 shrink-0 text-muted-foreground/50"
              />
            ) : (
              <span
                aria-label={child.status?.label ?? "Idle"}
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  child.status?.dotClass ?? "bg-muted-foreground/45",
                )}
              />
            )}
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs leading-4",
                child.isDone ? "text-muted-foreground/80" : "text-foreground/85",
              )}
            >
              {child.title}
            </span>
          </span>
          <span
            data-testid={`remote-child-meta-${child.threadKey}`}
            // Under the title: the dot's width plus the gap.
            className="mt-0.5 flex min-w-0 items-center gap-1 ps-3 text-[11px] leading-4 text-muted-foreground/60"
          >
            <MonitorIcon aria-hidden className="size-3 shrink-0" />
            {isStart ? (
              <span className={cn("min-w-0 truncate", tone)}>{statusText}</span>
            ) : (
              <>
                <span className="min-w-0 truncate">{child.computerLabel}</span>
                <MetaSeparator />
                <span className={cn("shrink-0 font-mono", tone)}>{statusText}</span>
              </>
            )}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {isStart
            ? statusText
            : `Its last known status. Connect to ${child.computerLabel} to open it.`}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
});

export interface InboxLinkRequestRowProps {
  /** The computer the thread would run on, whose Allow it waits for. */
  readonly environmentId: EnvironmentId;
  /** That computer's name. */
  readonly computerLabel: string;
  /** The asking computer's name. */
  readonly askerLabel: string;
  readonly request: ComputerLinkPendingRequest;
  /** Opens where the request can be read in full: the thread that asked, else Fleet. */
  readonly onOpen: () => void;
}

/**
 * A thread another computer's agent asked to start, waiting for the user
 * (docs/design/fleet.md, Part 2 "Ask first"). Marked as a request, not a
 * thread: it leads with what would start, then which thread on which
 * computer asked, with Deny and Allow. A move (Part 3) leads with the thread,
 * then which computer wants to move it where, what goes with it and where it
 * lands. Clicking it opens the thread that
 * asked, where a card above the message box shows everything (the full
 * instructions, the agent, the access it would get). The answer goes to the
 * computer it would run on; the row leaves when that computer drops the
 * request. Its buttons are plain like every list control but always showing,
 * so a touch screen reaches them too.
 */
export const InboxLinkRequestRow = memo(function InboxLinkRequestRow({
  environmentId,
  computerLabel,
  askerLabel,
  request,
  onOpen,
}: InboxLinkRequestRowProps) {
  // Shared with the card in the thread that asked: an answer sent from either
  // holds both, and stays until the computer's next snapshot drops the request.
  const pending = useMemo(() => ({ environmentId, request }), [environmentId, request]);
  const { answering, respond } = useLinkRequestAnswer(pending, computerLabel);
  const answer = (allow: boolean) => (event: React.MouseEvent) => {
    event.stopPropagation();
    void respond(allow);
  };
  const isMove = request.kind === "move";
  return (
    <li
      role="button"
      tabIndex={0}
      className={cn(
        ROW_ITEM_CLASS_NAME,
        "cursor-pointer px-3 pt-1.5 pb-1 hover:bg-sidebar-accent/60 focus-ring",
      )}
      data-testid={`link-request-${request.requestId}`}
      aria-label={
        isMove
          ? `${askerLabel} wants to move ${request.title} to ${computerLabel}. Open it.`
          : `Request from ${askerLabel}: ${request.title}. Open it.`
      }
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <span
          aria-label="Needs you"
          className={cn(
            "mt-[5px] size-[7px] shrink-0 rounded-full",
            THREAD_STATUS_DOT_CLASSES.amber,
          )}
        />
        <span
          className="line-clamp-2 min-w-0 flex-1 text-xs leading-4 font-medium text-foreground"
          data-testid={`link-request-title-${request.requestId}`}
        >
          {request.title}
        </span>
        {/* The same word-and-color a thread waiting on an approval shows. */}
        <span className="mt-0.5 shrink-0 font-mono text-[11px] leading-none text-amber-600 dark:text-amber-300/90">
          request
        </span>
      </div>
      <div
        className={cn(
          "mt-0.5 flex min-w-0 items-center gap-1 ps-[13px] text-[11px]",
          // A move's lines below are opaque: this one reads with them.
          isMove ? "text-muted-foreground" : "text-muted-foreground/60",
        )}
        data-testid={`link-request-where-${request.requestId}`}
      >
        {isMove ? (
          <MonitorUpIcon aria-hidden className="size-2.5 shrink-0" />
        ) : (
          <LinkIcon aria-hidden className="size-2.5 shrink-0" />
        )}
        <span className="min-w-0 truncate">
          {isMove
            ? `${askerLabel} wants to move a thread to ${computerLabel}`
            : `Asked by “${request.parentThreadTitle}” on ${askerLabel}`}
        </span>
      </div>
      {isMove ? (
        <div
          className="ps-[13px] text-[11px] text-muted-foreground"
          data-testid={`link-request-move-${request.requestId}`}
        >
          {request.move ? (
            <p className="truncate">{formatThreadMoveChanges(request.move)}</p>
          ) : null}
          <p className="truncate">
            Lands in {request.projectName} with up to{" "}
            {formatThreadMoveAccess(runtimeModeConfig[request.runtimeMode].label)}
          </p>
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-1 ps-[13px]">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/50 tabular-nums">
          {formatRelativeTimeLabel(request.createdAt)}
        </span>
        <Button
          variant="ghost"
          size="xs"
          data-thread-selection-safe
          data-testid={`link-request-deny-${request.requestId}`}
          aria-label={`Deny ${request.title}`}
          className="text-muted-foreground"
          disabled={answering !== null}
          onClick={answer(false)}
        >
          Deny
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-thread-selection-safe
          data-testid={`link-request-allow-${request.requestId}`}
          aria-label={`Allow ${request.title}`}
          className="text-primary-readable"
          disabled={answering !== null}
          onClick={answer(true)}
        >
          Allow
        </Button>
      </div>
    </li>
  );
});

export interface InboxDoneRowProps {
  thread: SidebarThreadSummary;
  projectLabel: string | null;
  doneAt: string | null;
  isActive: boolean;
  appSettingsConfirmThreadArchive: boolean;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  reopenThread: (threadKey: string) => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  /**
   * The pull request the listings found for this thread. A merged or closed
   * one is often why the thread is down here at all, so the badge stays with
   * it and keeps the reason visible.
   */
  listPullRequest: ThreadPullRequest | null;
  /** See InboxThreadRowProps.linkedPullRequests. */
  linkedPullRequests: readonly ThreadPullRequest[];
  openPrLink: (
    event: React.MouseEvent<HTMLElement>,
    pullRequest: Pick<ThreadPullRequest, "number" | "url">,
    threadRef: ScopedThreadRef,
  ) => void;
  /** How many threads its agent started that are still in its family; they wrap inside it. */
  childCount?: number | undefined;
  /** See ThreadHoverCardPayload.lineage. */
  lineage?: ThreadHoverCardLineage | undefined;
  /** See InboxThreadRowProps.onSwipeAction. */
  onSwipeAction?: ThreadRowSwipeHandler | undefined;
}

/**
 * A settled thread in the Done tail: one line, still readable. Flattening the
 * whole tail to one grey turns it into texture — the section header already
 * says done, so each row keeps its name and its project.
 */
export const InboxDoneRow = memo(function InboxDoneRow(props: InboxDoneRowProps) {
  const {
    thread,
    projectLabel,
    doneAt,
    isActive,
    appSettingsConfirmThreadArchive,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    navigateToThread,
    handleThreadContextMenu,
    reopenThread,
    attemptArchiveThread,
    listPullRequest,
    linkedPullRequests,
    openPrLink,
    childCount = 0,
    lineage,
    onSwipeAction,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const threadProject = useThreadProject(thread);
  const scheduledRunLabel = useScheduledRunLabel(thread);
  // Wrapping a thread settles the conversation, not its terminals: a dev
  // server started there keeps running, and this is the icon that finds it.
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadKey, threadRef).runningTerminalIds,
  );
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  const handleClick = useCallback(() => {
    navigateToThread(threadRef);
  }, [navigateToThread, threadRef]);
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigateToThread(threadRef);
    },
    [navigateToThread, threadRef],
  );
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      void handleThreadContextMenu(threadRef, { x: event.clientX, y: event.clientY });
    },
    [handleThreadContextMenu, threadRef],
  );
  // On a touch screen, holding the row opens the same menu.
  const openTouchMenu = useCallback(
    (position: { readonly x: number; readonly y: number }) =>
      void handleThreadContextMenu(threadRef, position),
    [handleThreadContextMenu, threadRef],
  );
  const touchHold = useTouchHoldMenu<HTMLDivElement>({
    open: openTouchMenu,
    onContextMenu: handleContextMenu,
  });
  const handleReopenClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      reopenThread(threadKey);
    },
    [reopenThread, threadKey],
  );
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );
  const clearConfirmingArchive = useCallback(() => {
    setConfirmingArchiveThreadKey((current) => (current === threadKey ? null : current));
  }, [setConfirmingArchiveThreadKey, threadKey]);
  const handleMouseLeave = useCallback(() => {
    clearConfirmingArchive();
  }, [clearConfirmingArchive]);
  const handleBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLLIElement>) => {
      const currentTarget = event.currentTarget;
      requestAnimationFrame(() => {
        if (currentTarget.contains(document.activeElement)) {
          return;
        }
        clearConfirmingArchive();
      });
    },
    [clearConfirmingArchive],
  );
  const handleConfirmArchiveRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (element) {
        confirmArchiveButtonRefs.current.set(threadKey, element);
      } else {
        confirmArchiveButtonRefs.current.delete(threadKey);
      }
    },
    [confirmArchiveButtonRefs, threadKey],
  );
  const handleConfirmArchiveClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      clearConfirmingArchive();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, clearConfirmingArchive, threadRef],
  );
  const handleStartArchiveConfirmation = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setConfirmingArchiveThreadKey(threadKey);
      requestAnimationFrame(() => {
        confirmArchiveButtonRefs.current.get(threadKey)?.focus();
      });
    },
    [confirmArchiveButtonRefs, setConfirmingArchiveThreadKey, threadKey],
  );
  const handleArchiveImmediateClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, threadRef],
  );
  const isConfirmingArchive = confirmingArchiveThreadKey === threadKey;

  return (
    <li
      className={ROW_ITEM_CLASS_NAME}
      data-thread-item
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
    >
      {/* Its two buttons as swipes: right reopens it, left archives it (asking
          first when Settings says to, as the menu does). */}
      <SwipeableRow
        leading={threadRowSwipeAction(onSwipeAction, { threadKey, title: thread.title }, "reopen")}
        trailing={threadRowSwipeAction(
          onSwipeAction,
          { threadKey, title: thread.title },
          "archive",
        )}
      >
        {/* Same card the live rows carry: a wrapped thread's detail is no less
          worth a hover, and status={null} reads as its idle state. */}
        <ThreadHoverCard thread={thread} status={null} lineage={lineage}>
          <div
            role="button"
            tabIndex={0}
            data-testid={`done-row-${thread.id}`}
            data-thread-key={threadKey}
            className={cn(
              ROW_SURFACE_CLASS_NAME,
              "flex items-center gap-2 px-3 py-1.5",
              resolveRowSurfaceTone({ isActive, isSelected: false }),
            )}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            {...touchHold}
          >
            {/* The project leads the row as an icon, not a name: a one-line row
              has one thing worth reading whole, and spelling out the project
              on every row cost the title half its width to repeat what a glyph
              says at a glance. The name still lives in the hover card, and in
              the accessible label here. */}
            {projectLabel && threadProject ? (
              <span
                role="img"
                aria-label={projectLabel}
                className="inline-flex shrink-0 items-center opacity-70"
              >
                <ProjectFavicon
                  cwd={threadProject.cwd}
                  environmentId={thread.environmentId}
                  name={threadProject.name}
                  className="size-3.5 shrink-0"
                />
              </span>
            ) : null}
            {scheduledRunLabel !== null ? (
              <span
                role="img"
                aria-label={scheduledRunLabel}
                data-testid={`done-scheduled-run-${thread.id}`}
                className="inline-flex shrink-0 items-center text-muted-foreground/60"
              >
                <CalendarClockIcon aria-hidden className="size-3" />
              </span>
            ) : null}
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              data-testid={`done-title-${thread.id}`}
            >
              {thread.title}
            </span>
            <span className={ROW_META_SLOT_CLASS_NAME}>
              {/* It had threads of its own: they wrapped inside it, and the
                fork says how many. */}
              {childCount > 0 ? (
                <span
                  role="img"
                  aria-label={`${formatChildThreadCount(childCount)} started here`}
                  data-testid={`done-children-${thread.id}`}
                  className="inline-flex shrink-0 items-center gap-[3px] font-mono text-[10px] leading-none text-muted-foreground/55"
                >
                  <GitForkIcon aria-hidden className="size-2.5" />
                  {childCount}
                </span>
              ) : null}
              <ThreadEnvironmentBadge thread={thread} />
              {/* A wrapped thread's checkout has usually moved on, so the badge
                answers from the listings rather than from a git status this
                row never subscribes to. */}
              <ThreadPullRequestBadge
                pullRequests={threadPullRequestList(listPullRequest, linkedPullRequests)}
                provider={null}
                threadRef={threadRef}
                openPrLink={openPrLink}
              />
              {terminalStatus ? (
                <span
                  role="img"
                  aria-label={terminalStatus.label}
                  className={cn(
                    "inline-flex items-center justify-center",
                    terminalStatus.colorClass,
                  )}
                >
                  <TerminalIcon
                    className={cn("size-3", terminalStatus.pulse && "animate-status-pulse")}
                  />
                </span>
              ) : null}
              {/* A thread that moved away says so instead of when it wrapped. */}
              <span
                className={cn(
                  "shrink-0 font-mono text-[11px] tabular-nums",
                  thread.moveStatus ? "text-muted-foreground" : "text-muted-foreground/45",
                )}
              >
                {thread.moveStatus ?? (doneAt ? formatRelativeTimeLabel(doneAt) : null)}
              </span>
              {isConfirmingArchive ? (
                <RowFloatingActions isActive={isActive} isSelected={false} alwaysVisible>
                  <button
                    ref={handleConfirmArchiveRef}
                    type="button"
                    data-thread-selection-safe
                    data-testid={`thread-archive-confirm-${thread.id}`}
                    aria-label={`Confirm archive ${thread.title}`}
                    className="relative inline-flex h-5 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-ring"
                    onPointerDown={stopPropagationOnPointerDown}
                    onClick={handleConfirmArchiveClick}
                  >
                    Confirm
                  </button>
                </RowFloatingActions>
              ) : (
                // A done thread is settled by definition, so archive is always
                // available here -- the "running" guard the live rows needed is
                // exactly the state that keeps a thread out of this list.
                <RowFloatingActions isActive={isActive} isSelected={false}>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`done-reopen-${thread.id}`}
                          aria-label={`Reopen ${thread.title}`}
                          className={ROW_ACTION_BUTTON_CLASS_NAME}
                          onPointerDown={stopPropagationOnPointerDown}
                          onClick={handleReopenClick}
                        >
                          <Undo2Icon className="size-3.5" />
                        </button>
                      }
                    />
                    <TooltipPopup side="top">Reopen</TooltipPopup>
                  </Tooltip>
                  {appSettingsConfirmThreadArchive ? (
                    <button
                      type="button"
                      data-thread-selection-safe
                      data-testid={`thread-archive-${thread.id}`}
                      aria-label={`Archive ${thread.title}`}
                      className={ROW_ACTION_BUTTON_CLASS_NAME}
                      onPointerDown={stopPropagationOnPointerDown}
                      onClick={handleStartArchiveConfirmation}
                    >
                      <ArchiveIcon className="size-3.5" />
                    </button>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            data-thread-selection-safe
                            data-testid={`thread-archive-${thread.id}`}
                            aria-label={`Archive ${thread.title}`}
                            className={ROW_ACTION_BUTTON_CLASS_NAME}
                            onPointerDown={stopPropagationOnPointerDown}
                            onClick={handleArchiveImmediateClick}
                          >
                            <ArchiveIcon className="size-3.5" />
                          </button>
                        }
                      />
                      <TooltipPopup side="top">Archive</TooltipPopup>
                    </Tooltip>
                  )}
                </RowFloatingActions>
              )}
            </span>
          </div>
        </ThreadHoverCard>
      </SwipeableRow>
    </li>
  );
});

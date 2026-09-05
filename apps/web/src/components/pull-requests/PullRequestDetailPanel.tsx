import { scopeThreadRef, scopedThreadKey } from "@threadlines/client-runtime";
import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
  PullRequestReviewThread,
  PullRequestUpdateMethod,
  ScopedThreadRef,
  SourceControlProviderKind,
} from "@threadlines/contracts";
import { PullRequestMergeMethod as PullRequestMergeMethodSchema } from "@threadlines/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArrowDownUpIcon,
  ArrowLeftIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitBranchPlusIcon,
  LayersIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { openExternalUrl } from "../../lib/externalLinks";
import {
  pullRequestActionMutationOptions,
  pullRequestActivityQueryOptions,
  pullRequestDetailQueryOptions,
  pullRequestDiffQueryOptions,
  pullRequestUpdateMutationOptions,
  refreshPullRequest,
} from "../../lib/pullRequestsReactQuery";
import { cn, pluralize } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { PageTabButton, pageTabId } from "../ui/page-tabs";
import { Textarea } from "../ui/textarea";
import { TooltipWrapper } from "../ui/tooltip";
import { PullRequestCodeTab } from "./PullRequestCodeTab";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestTimelineTab, type PullRequestTimelineOrder } from "./PullRequestTimelineTab";
import {
  buildAskQuestionHandoff,
  buildExplainPullRequestHandoff,
  buildFixAllFindingsHandoff,
  buildFixFindingHandoff,
  buildResolveConflictsHandoff,
  collectPullRequestFindings,
  failingCheckFinding,
  reviewCommentFinding,
  reviewThreadFinding,
} from "./pullRequestHandoffs.logic";
import {
  BackToListButton,
  CloseDetailButton,
  MetaSeparator,
  PullRequestActorLabel,
  PullRequestDetailSkeleton,
  TEXT_BUTTON_CLASS,
  pullRequestChecksTone,
  pullRequestHostName,
  scrollPullRequestSummaryTo,
  changeRequestWord,
} from "./pullRequestPresentation";
import {
  PULL_REQUEST_MERGE_METHOD_LABELS,
  PULL_REQUEST_MERGE_METHOD_WORDS,
  appendHandoffToDraft,
  buildReviewCommentHandoff,
  formatPullRequestBaseFreshness,
  formatPullRequestBehindLabel,
  formatPullRequestChecksHeadline,
  pullRequestBadgeTone,
  pullRequestUpdateMethodLabel,
  resolveDefaultMergeMethod,
  resolvePullRequestMergeBlock,
  summarizePullRequestChecks,
  type PullRequestChecksSummary,
} from "./pullRequests.logic";

/** The header actions are the main controls on a phone, so they grow to a touch size below md. */
const PHONE_ACTION_CLASS = "max-md:h-8 max-md:px-3";

/**
 * The last hand-off written into each composer, so the next one can take its
 * place rather than stack under it. Module level because a panel that is
 * unmounted and reopened is still writing into the same draft.
 */
const lastHandoffByComposer = new Map<string, string>();

/**
 * Writes a hand-off into a composer, under whatever the user was typing and
 * over whatever the last hand-off left there.
 */
function writeHandoffToComposer(target: ScopedThreadRef, handoff: string): void {
  const key = scopedThreadKey(target);
  const drafts = useComposerDraftStore.getState();
  const existing = drafts.getComposerDraft(target)?.prompt ?? "";
  drafts.setPrompt(target, appendHandoffToDraft(existing, handoff, lastHandoffByComposer.get(key)));
  lastHandoffByComposer.set(key, handoff);
}

/** Where the panel is standing, which decides only what chrome it carries. */
export type PullRequestDetailContext = "page" | "thread";

/** Where a checkout puts the branch: its own worktree, or the repository itself. */
export type PullRequestCheckoutMode = "worktree" | "local";

/** What the Check out menu, and a hand-off with nowhere else to land, ask for. */
export interface PullRequestCheckoutRequest {
  /** The prompt the new thread's composer opens with, when a hand-off started it. */
  readonly initialPrompt?: string;
  /** The button the checkout dialog opens on. Omitted leaves the dialog's own default. */
  readonly mode?: PullRequestCheckoutMode;
}

export interface PullRequestDetailPanelProps {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly context: PullRequestDetailContext;
  /** The thread working this pull request, on the page. Null beside a thread,
   *  where the thread is the surrounding chrome. */
  readonly linkedThread?: SidebarThreadSummary | null;
  /** The composer a hand-off writes into beside a thread. The page finds its
   *  own from {@link linkedThread}. */
  readonly composerTarget?: ScopedThreadRef;
  /** Moves the cursor onto the title once it is read, for a surface that opened
   *  this panel from a press of the user's own. */
  readonly autoFocusTitle?: boolean;
  readonly onClose?: () => void;
  /** Opens the checkout dialog, carrying the prompt the new draft should open
   *  with and the way the branch should be taken. Absent where the surface
   *  cannot start a thread. */
  readonly onReviewInThread?: (request?: PullRequestCheckoutRequest) => void;
  /** Called after a hand-off lands beside a thread, so the route can put the
   *  cursor in the composer the user is about to send from. */
  readonly onComposerHandoff?: () => void;
}

type DetailTab = "summary" | "code" | "timeline";

/** The word on each tab, which is also what names its panel. */
const DETAIL_TAB_LABELS: Readonly<Record<DetailTab, string>> = {
  summary: "Summary",
  code: "Code",
  timeline: "Timeline",
};

/**
 * The hand-offs that belong to the pull request as a whole. Each one writes a
 * prompt into a composer; the two that only make sense sometimes are null the
 * rest of the time.
 */
interface PullRequestHandoffActions {
  readonly fixAll: (() => void) | null;
  readonly explain: () => void;
  readonly ask: () => void;
  readonly resolveConflicts: (() => void) | null;
}

/**
 * One pull request, read and reviewed: a header, a Summary tab of description,
 * checks, reviewers and conversation, a Code tab of the patch with the review
 * written against it, and a Timeline of everything that happened.
 *
 * The same component serves the pull requests page and a thread's Pull request
 * tab. Only the chrome differs — the page can close it and offer a checkout,
 * the thread's tab strip already owns both — so `context` decides nothing
 * about the reads.
 */
export function PullRequestDetailPanel({
  environmentId,
  reference,
  context,
  linkedThread = null,
  composerTarget,
  autoFocusTitle = false,
  onClose,
  onReviewInThread,
  onComposerHandoff,
}: PullRequestDetailPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>("summary");
  // The patch is the costly read, so it is only asked for once the user has
  // actually gone to the Code tab; after that it stays mounted with the rest.
  const [codeOpened, setCodeOpened] = useState(false);
  const [timelineOpened, setTimelineOpened] = useState(false);
  const [timelineOrder, setTimelineOrder] = useState<PullRequestTimelineOrder>("newest");
  const [isRefreshing, setIsRefreshing] = useState(false);
  // The Summary's Checks section, which the header's rollup scrolls to. Found
  // through the panel rather than a ref passed down, because the tab that owns
  // it is unmounted until it is opened.
  const panelRoot = useRef<HTMLDivElement | null>(null);

  const detail = useQuery(pullRequestDetailQueryOptions({ environmentId, reference }));
  const activity = useQuery(pullRequestActivityQueryOptions({ environmentId, reference }));
  const diff = useQuery({
    ...pullRequestDiffQueryOptions({ environmentId, reference }),
    // A host with no patch to give has no Code tab to open, and asking it for
    // one would only fail.
    enabled: codeOpened && detail.data?.capabilities.diff === true,
  });

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    void refreshPullRequest(queryClient, { environmentId, reference }).finally(() => {
      setIsRefreshing(false);
    });
  }, [environmentId, queryClient, reference]);

  const openThread = useCallback(() => {
    if (!linkedThread) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(linkedThread.environmentId, linkedThread.id)),
    });
  }, [linkedThread, navigate]);

  // The composer a hand-off writes into. Beside a thread that is the thread
  // itself; on the page it is whichever thread is working the branch, if any.
  const handoffTarget = useMemo<ScopedThreadRef | null>(() => {
    if (context === "thread") {
      return composerTarget ?? null;
    }
    return linkedThread ? scopeThreadRef(linkedThread.environmentId, linkedThread.id) : null;
  }, [composerTarget, context, linkedThread]);

  /**
   * Where a hand-off lands: the composer beside this panel, the thread already
   * working the branch (which the page then opens), or a new draft off the
   * checkout dialog when no thread has this branch yet.
   */
  const runHandoff = useCallback(
    (handoff: string) => {
      if (handoffTarget) {
        writeHandoffToComposer(handoffTarget, handoff);
        if (context === "thread") {
          onComposerHandoff?.();
          return;
        }
        openThread();
        return;
      }
      onReviewInThread?.({ initialPrompt: handoff });
    },
    [context, handoffTarget, onComposerHandoff, onReviewInThread, openThread],
  );
  const canHandoff = handoffTarget !== null || onReviewInThread !== undefined;

  const sendCommentToThread = useCallback(
    (comment: PullRequestComment) => {
      const data = detail.data;
      // A review's remark is a finding an agent can act on; a plain comment is
      // only a remark, so it goes over as the quoted words it is.
      runHandoff(
        comment.kind === "review" && data
          ? buildFixFindingHandoff(data, reviewCommentFinding(comment))
          : buildReviewCommentHandoff({
              number: reference.number,
              author: comment.author?.login ?? null,
              body: comment.body,
            }),
      );
    },
    [detail.data, reference.number, runHandoff],
  );

  const fixThread = useCallback(
    (thread: PullRequestReviewThread) => {
      const data = detail.data;
      if (!data) return;
      runHandoff(buildFixFindingHandoff(data, reviewThreadFinding(thread)));
    },
    [detail.data, runHandoff],
  );

  const fixCheck = useCallback(
    (check: PullRequestCheck) => {
      const data = detail.data;
      if (!data) return;
      runHandoff(buildFixFindingHandoff(data, failingCheckFinding(check)));
    },
    [detail.data, runHandoff],
  );

  const findings = useMemo(
    () => collectPullRequestFindings(activity.data ?? null, detail.data?.checks ?? []),
    [activity.data, detail.data?.checks],
  );

  // The hand-offs the whole pull request offers, as opposed to the ones a
  // single finding does. Null where there is nowhere to write them.
  const handoffs = useMemo<PullRequestHandoffActions | null>(() => {
    const data = detail.data;
    if (!canHandoff || !data) {
      return null;
    }
    return {
      fixAll:
        findings.length === 0 ? null : () => runHandoff(buildFixAllFindingsHandoff(data, findings)),
      explain: () => runHandoff(buildExplainPullRequestHandoff(data)),
      ask: () => runHandoff(buildAskQuestionHandoff(data)),
      resolveConflicts:
        data.mergeability === "conflicting"
          ? () => runHandoff(buildResolveConflictsHandoff(data))
          : null,
    };
  }, [canHandoff, detail.data, findings, runHandoff]);

  const panelId = `pull-request-${reference.projectId}-${reference.number}`;

  // The check rollup in the tab strip and the Checks section it scrolls to are
  // the same list read twice, so the strip's words are found here rather than
  // reported up from the tab that draws the rows.
  const checksSummary = useMemo(
    () => summarizePullRequestChecks(detail.data?.checks ?? []),
    [detail.data?.checks],
  );
  const scrollToChecks = useCallback(() => {
    scrollPullRequestSummaryTo(
      panelRoot.current?.querySelector<HTMLElement>("[data-pull-request-checks]") ?? null,
    );
  }, []);

  // Below the two-column width the detail stands in for the list, so even a
  // panel with nothing to show yet has to carry the way back.
  const closeControl =
    context === "page" && onClose ? (
      <div className="flex shrink-0 items-center px-2 pt-2">
        <BackToListButton onClick={onClose} />
        <CloseDetailButton className="ml-auto" onClick={onClose} />
      </div>
    ) : null;

  if (detail.isPending) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="pull-request-detail">
        <PullRequestDetailSkeleton {...(context === "page" && onClose ? { onClose } : {})} />
      </div>
    );
  }

  if (detail.isError || !detail.data) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="pull-request-detail">
        {closeControl}
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              {detail.error instanceof Error && detail.error.message.trim().length > 0
                ? detail.error.message
                : "This pull request could not be read."}
            </EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>
            Retry
          </Button>
        </Empty>
      </div>
    );
  }

  const data = detail.data;
  const retryActivity = () => void activity.refetch();
  // A host that cannot produce a patch has no Code tab at all, so a selection
  // left on it from another pull request falls back to the Summary.
  const showCode = data.capabilities.diff;
  const activeTab: DetailTab = !showCode && tab === "code" ? "summary" : tab;

  return (
    <div
      ref={panelRoot}
      // The header and tabs answer to this panel's own width rather than the
      // window's: beside a thread it is a sidebar 272px wide on a wide screen,
      // and the phone layout is what fits there.
      className="@container/pr flex h-full min-h-0 min-w-0 flex-col"
      data-testid="pull-request-detail"
    >
      <PullRequestDetailHeader
        environmentId={environmentId}
        reference={reference}
        detail={data}
        context={context}
        linkedThread={linkedThread}
        autoFocusTitle={autoFocusTitle}
        isRefreshing={isRefreshing || detail.isFetching}
        onRefresh={handleRefresh}
        {...(onClose ? { onClose } : {})}
        {...(onReviewInThread ? { onCheckout: onReviewInThread } : {})}
        onOpenThread={openThread}
        handoffs={handoffs}
      />

      {/* The order toggle shares the row but not the tablist: it is not a tab,
          and inside one it would answer to the arrow keys as though it were.
          The tabs are drawn whole at every width; in a narrow panel they close
          ranks and the control beside them keeps its glyph and loses its words,
          so nothing is pushed past the edge. */}
      <div className="flex shrink-0 items-center border-b border-border px-4">
        <div
          role="tablist"
          aria-label="Pull request"
          className="flex shrink-0 items-center gap-5 @max-md/pr:gap-3"
        >
          <PageTabButton
            label={DETAIL_TAB_LABELS.summary}
            active={activeTab === "summary"}
            panelId={panelId}
            onClick={() => setTab("summary")}
          />
          {showCode ? (
            <PageTabButton
              label={DETAIL_TAB_LABELS.code}
              count={data.changedFiles}
              active={activeTab === "code"}
              panelId={panelId}
              onClick={() => {
                setCodeOpened(true);
                setTab("code");
              }}
            />
          ) : null}
          <PageTabButton
            label={DETAIL_TAB_LABELS.timeline}
            active={activeTab === "timeline"}
            panelId={panelId}
            onClick={() => {
              setTimelineOpened(true);
              setTab("timeline");
            }}
          />
        </div>
        {activeTab === "timeline" ? (
          <TooltipWrapper
            tooltip={timelineOrder === "newest" ? "Show oldest first" : "Show newest first"}
          >
            <button
              type="button"
              className={cn(
                TEXT_BUTTON_CLASS,
                "ml-auto inline-flex shrink-0 items-center gap-1 pb-2 text-xs",
              )}
              aria-label={timelineOrder === "newest" ? "Show oldest first" : "Show newest first"}
              data-testid="pull-request-timeline-order"
              onClick={() => setTimelineOrder(timelineOrder === "newest" ? "oldest" : "newest")}
            >
              <ArrowDownUpIcon aria-hidden className="size-3" />
              <span className="@max-md/pr:sr-only">
                {timelineOrder === "newest" ? "Newest first" : "Oldest first"}
              </span>
            </button>
          </TooltipWrapper>
        ) : null}
        {/* The rollup the header used to spell out on a line of its own. It is
            a way into the Summary's Checks section rather than a label, so it
            is a button wherever that section is what the tab is showing. */}
        {activeTab === "summary" ? (
          <PullRequestChecksRollup summary={checksSummary} onShowChecks={scrollToChecks} />
        ) : null}
      </div>

      <DiffViewerWarmup enabled={showCode}>
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={pageTabId(panelId, DETAIL_TAB_LABELS[activeTab])}
          className="min-h-0 min-w-0 flex-1"
        >
          <div className={cn("h-full min-h-0", activeTab === "summary" ? "block" : "hidden")}>
            <PullRequestSummaryTab
              environmentId={environmentId}
              reference={reference}
              detail={data}
              activity={activity.data ?? null}
              activityPending={activity.isPending}
              activityError={activity.isError}
              onRetryActivity={retryActivity}
              {...(canHandoff ? { onSendToThread: sendCommentToThread, onFixCheck: fixCheck } : {})}
            />
          </div>
          {codeOpened && showCode ? (
            <div className={cn("h-full min-h-0", activeTab === "code" ? "block" : "hidden")}>
              <PullRequestCodeTab
                environmentId={environmentId}
                reference={reference}
                detail={data}
                patch={diff.data?.patch ?? null}
                truncated={diff.data?.truncated ?? false}
                isPending={diff.isPending}
                isError={diff.isError}
                onRetry={() => void diff.refetch()}
                threads={activity.data?.reviewThreads ?? null}
                activityError={activity.isError}
                onRetryActivity={retryActivity}
                {...(canHandoff ? { onFixThread: fixThread } : {})}
              />
            </div>
          ) : null}
          {timelineOpened ? (
            <div className={cn("h-full min-h-0", activeTab === "timeline" ? "block" : "hidden")}>
              <PullRequestTimelineTab
                environmentId={environmentId}
                reference={reference}
                detail={data}
                activity={activity.data ?? null}
                order={timelineOrder}
                isPending={activity.isPending}
                isError={activity.isError}
                onRetry={retryActivity}
              />
            </div>
          ) : null}
        </div>
      </DiffViewerWarmup>
    </div>
  );
}

/**
 * Starts the diff viewer's worker pool the moment a pull request with a patch
 * opens, rather than when its Code tab is pressed. The pool begins fetching
 * its worker and syntax files as soon as it mounts, so by the time the tab is
 * opened they are usually already here; the patch itself stays lazy.
 */
function DiffViewerWarmup({
  enabled,
  children,
}: {
  readonly enabled: boolean;
  readonly children: ReactNode;
}) {
  return enabled ? <DiffWorkerPoolProvider>{children}</DiffWorkerPoolProvider> : children;
}

/**
 * Everything above the tabs, in five rows: where this pull request lives and
 * what can be done to it, its title, who wrote it and when it last moved, the
 * branches it joins and how big it is, and the tabs themselves (drawn by the
 * panel, since only it knows which one is open).
 *
 * The same five rows serve the page and a thread's Pull request tab. Only the
 * first row differs: the page can check the branch out and can close the panel,
 * and a thread's own chrome already owns both.
 */
function PullRequestDetailHeader({
  environmentId,
  reference,
  detail,
  context,
  linkedThread,
  autoFocusTitle,
  isRefreshing,
  onRefresh,
  onClose,
  onCheckout,
  onOpenThread,
  handoffs,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetail;
  readonly context: PullRequestDetailContext;
  readonly linkedThread: SidebarThreadSummary | null;
  readonly autoFocusTitle: boolean;
  readonly isRefreshing: boolean;
  readonly onRefresh: () => void;
  readonly onClose?: () => void;
  readonly onCheckout?: (request?: PullRequestCheckoutRequest) => void;
  readonly onOpenThread: () => void;
  readonly handoffs: PullRequestHandoffActions | null;
}) {
  const tone = pullRequestBadgeTone(detail.state, detail.isDraft);
  const actions = usePullRequestActions({ environmentId, reference, detail, handoffs });
  // A branch that no longer merges, said where the branches are named rather
  // than on a line of its own.
  const conflictLabel =
    detail.state === "open" && !detail.isDraft && detail.mergeability === "conflicting"
      ? `Conflicts with ${detail.baseBranch}`
      : null;
  const behindLabel = formatPullRequestBehindLabel(detail);
  const freshness = formatPullRequestBaseFreshness(detail);
  // Open is the resting state and the glyph already says it; the other three
  // are news, so they get a word.
  const stateWord = detail.state === "open" && !detail.isDraft ? null : tone.label;
  // The page's way to start work on the branch, and to get back to the thread
  // already doing it. A thread's own tab is standing in that thread already.
  const showCheckout = context === "page" && (onCheckout !== undefined || linkedThread !== null);

  return (
    <div className="shrink-0 px-4 pt-2 pb-3">
      {/* Row 1: where it lives, and what can be done to it. */}
      <div className="flex min-w-0 items-start gap-2 @max-md/pr:flex-wrap">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 font-mono text-xs text-muted-foreground">
          {/* On a phone the list is not on screen, so the way back sits where
              a back arrow belongs: first, at the top left. */}
          {context === "page" && onClose ? <BackToListButton onClick={onClose} /> : null}
          <span className={cn("shrink-0", tone.className)}>
            <tone.Icon aria-hidden className="size-3.5" />
            <span className="sr-only">{tone.label}</span>
          </span>
          <span className="min-w-0 truncate">{detail.repository}</span>
          <button
            type="button"
            className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm underline-offset-2 transition-colors hover:text-foreground hover:underline focus-ring"
            aria-label={`Open ${changeRequestWord(detail.provider)} #${detail.number} on ${pullRequestHostName(detail.provider)}`}
            onClick={() => openExternalUrl(detail.url)}
          >
            #{detail.number}
            <ExternalLinkIcon aria-hidden className="size-3 opacity-70" />
          </button>
          {stateWord ? <span className={cn("shrink-0", tone.className)}>{stateWord}</span> : null}
          {detail.autoMergeEnabled === true ? (
            <span className="shrink-0">Auto-merge on</span>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 @max-md/pr:w-full">
          {showCheckout ? (
            <PullRequestCheckoutMenu
              detail={detail}
              linkedThread={linkedThread}
              {...(onCheckout ? { onCheckout } : {})}
              onOpenThread={onOpenThread}
            />
          ) : null}
          {actions.controls}
          <Button
            variant="ghost"
            size="icon-sm"
            tooltip="Refresh"
            aria-label="Refresh"
            data-testid="pull-request-detail-refresh"
            onClick={onRefresh}
          >
            <RefreshCwIcon
              className={cn("size-3.5", isRefreshing && "animate-spin motion-reduce:animate-none")}
            />
          </Button>
          {/* Beside a thread the tab strip owns the dismissal; a second ✕ next
              to it would be two controls for one action. Below the two-column
              width the back arrow at the row's start stands in for it. */}
          {context === "page" && onClose ? <CloseDetailButton onClick={onClose} /> : null}
        </div>
      </div>

      {/* Row 2: the title. */}
      <div className="mt-1 flex min-w-0">
        <PullRequestTitle
          environmentId={environmentId}
          reference={reference}
          detail={detail}
          autoFocus={autoFocusTitle}
        />
      </div>

      {/* Row 3: who wrote it, when it last moved, and the one command that
          takes the branch on a machine this app is not running on. The command
          drops to a line of its own before it can squeeze the author out. */}
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="flex min-w-0 flex-auto items-center gap-1.5">
          {detail.author ? (
            <>
              <PullRequestActorLabel actor={detail.author} className="font-medium" />
              <MetaSeparator />
            </>
          ) : null}
          <span className="shrink-0">updated {formatRelativeTimeLabel(detail.updatedAt)}</span>
        </span>
        <PullRequestCheckoutCommand provider={detail.provider} number={detail.number} />
      </div>

      {/* Row 4: the branches this joins, and how much it changes. In a narrow
          panel the counts drop to a line of their own: the branch names are
          what the row is for, and sharing the line leaves them a letter each. */}
      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground/70">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <BranchCopyButton branch={detail.baseBranch} />
          {conflictLabel ? (
            <TooltipWrapper tooltip={conflictLabel}>
              <span className="shrink-0 text-destructive">
                <TriangleAlertIcon aria-hidden className="size-3.5" />
                <span className="sr-only">{conflictLabel}</span>
              </span>
            </TooltipWrapper>
          ) : null}
          {/* A base that is not the default branch means this sits on other
              work, which changes how its diff should be read. */}
          {detail.isStacked ? (
            <TooltipWrapper tooltip={`Stacked on ${detail.baseBranch}`}>
              <span className="shrink-0 text-muted-foreground/45">
                <LayersIcon aria-hidden className="size-3" />
                <span className="sr-only">Stacked on {detail.baseBranch}</span>
              </span>
            </TooltipWrapper>
          ) : null}
          <ArrowLeftIcon
            aria-label="receives changes from"
            className="size-3.5 shrink-0 opacity-60"
          />
          <BranchCopyButton branch={detail.headBranch} />
          {/* Being behind the base is the reason a merge is refused or a check
              is stale, so the branch line says so where it names the branch. */}
          {behindLabel ? (
            <TooltipWrapper tooltip={freshness ?? behindLabel}>
              <span className="shrink-0" data-testid="pull-request-behind">
                {behindLabel}
              </span>
            </TooltipWrapper>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2 @max-md/pr:w-full">
          <span className="flex items-center gap-1">
            <FileDiffIcon aria-hidden className="size-3.5" />
            {pluralize(detail.changedFiles, "file")}
          </span>
          {detail.additions > 0 || detail.deletions > 0 ? (
            <DiffStatLabel additions={detail.additions} deletions={detail.deletions} />
          ) : null}
        </span>
      </div>

      {actions.notices}
      {actions.dialog}
    </div>
  );
}

/**
 * The page's way onto the branch: a thread already working it, or the checkout
 * dialog opened on one of its two ways in. Both ways stay in the menu whichever
 * one is preset, because a worktree and the repository itself are choices a
 * user changes their mind about at the dialog.
 */
function PullRequestCheckoutMenu({
  detail,
  linkedThread,
  onCheckout,
  onOpenThread,
}: {
  readonly detail: PullRequestDetail;
  readonly linkedThread: SidebarThreadSummary | null;
  readonly onCheckout?: (request?: PullRequestCheckoutRequest) => void;
  readonly onOpenThread: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="outline"
            size="xs"
            className={PHONE_ACTION_CLASS}
            data-testid="pull-request-checkout"
          />
        }
      >
        Check out
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="end" className="w-72">
        {linkedThread ? (
          <MenuItem data-testid="pull-request-open-thread" onClick={onOpenThread}>
            <MessagesSquareIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
            <span className="flex min-w-0 flex-col">
              <span>Open the thread</span>
              <span className="truncate text-xs text-muted-foreground">{linkedThread.title}</span>
            </span>
          </MenuItem>
        ) : null}
        {linkedThread && onCheckout ? <MenuSeparator /> : null}
        {onCheckout ? (
          <>
            <MenuItem
              data-testid="pull-request-checkout-worktree"
              onClick={() => onCheckout({ mode: "worktree" })}
            >
              <GitBranchPlusIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
              <span className="flex min-w-0 flex-col">
                <span>In a worktree</span>
                <span className="text-xs text-muted-foreground">
                  Takes the branch into its own folder, leaving this one alone.
                </span>
              </span>
            </MenuItem>
            <MenuItem
              data-testid="pull-request-checkout-local"
              onClick={() => onCheckout({ mode: "local" })}
            >
              <FolderGit2Icon className="mt-0.5 size-3.5 shrink-0 self-start" />
              <span className="flex min-w-0 flex-col">
                <span>In this repository</span>
                <span className="text-xs text-muted-foreground">
                  Switches the branch you are working in, the way{" "}
                  {checkoutCommand(detail.provider, detail.number) ?? "a checkout"} does.
                </span>
              </span>
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/**
 * The rollup of the checks, beside the tabs: a glyph, a phrase, and a way down
 * to the rows it counts. The glyph is drawn here rather than taken whole from
 * the presentation module, because inside a button a second tooltip trigger
 * would fight the button for the pointer. In a narrow panel the phrase is for
 * screen readers and the tooltip only, and the glyph stands for it.
 */
function PullRequestChecksRollup({
  summary,
  onShowChecks,
}: {
  readonly summary: PullRequestChecksSummary;
  readonly onShowChecks: () => void;
}) {
  const tone = pullRequestChecksTone(summary.state);
  const headline = formatPullRequestChecksHeadline(summary);
  return (
    <TooltipWrapper tooltip={headline}>
      <button
        type="button"
        className={cn(
          TEXT_BUTTON_CLASS,
          "ml-auto inline-flex shrink-0 items-center gap-1.5 pb-2 text-xs",
        )}
        data-testid="pull-request-checks-rollup"
        onClick={onShowChecks}
      >
        {tone ? (
          <span className={cn("shrink-0", tone.className)}>
            <tone.Icon aria-hidden className="size-3.5" />
          </span>
        ) : null}
        <span className="@max-md/pr:sr-only">{headline}</span>
      </button>
    </TooltipWrapper>
  );
}

/**
 * The command that takes this branch on a machine Threadlines is not running
 * on, as a button that copies it. Only where the host's own tool has one: `gh`
 * is GitHub's, and spelling it for a host that does not answer to it would be
 * a command that fails when it is pasted.
 */
function checkoutCommand(provider: SourceControlProviderKind, number: number): string | null {
  if (provider === "github") return `gh pr checkout ${number}`;
  if (provider === "gitlab") return `glab mr checkout ${number}`;
  return null;
}

function PullRequestCheckoutCommand({
  provider,
  number,
}: {
  readonly provider: SourceControlProviderKind;
  readonly number: number;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1200 });
  const command = checkoutCommand(provider, number);
  if (command === null) {
    return null;
  }
  return (
    <TooltipWrapper tooltip="Copy">
      <button
        type="button"
        className={cn(TEXT_BUTTON_CLASS, "shrink-0 font-mono text-xs")}
        // The word on the button is the only sign the copy worked, so the name
        // says it too rather than staying "Copy" while the button reads Copied.
        aria-label={isCopied ? `Copied ${command}` : `Copy ${command}`}
        data-testid="pull-request-checkout-command"
        onClick={() => copyToClipboard(command, undefined)}
      >
        {isCopied ? "Copied" : command}
      </button>
    </TooltipWrapper>
  );
}

/** The title, rewritten in place by whoever the host lets rewrite it. */
function PullRequestTitle({
  environmentId,
  reference,
  detail,
  autoFocus,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetail;
  /** Takes the cursor once the title is on screen; see `autoFocusTitle`. */
  readonly autoFocus: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(detail.title);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const update = useMutation(
    pullRequestUpdateMutationOptions({ environmentId, reference, queryClient }),
  );
  const canEdit = detail.capabilities.edit.pullRequest && detail.viewer.canManage;

  // The panel replaces the list on a press, so the cursor follows it here
  // rather than staying on a row that is no longer under it.
  useEffect(() => {
    if (autoFocus) heading.current?.focus();
  }, [autoFocus]);

  const save = () => {
    const title = draft.trim();
    if (title.length === 0 || title === detail.title) {
      setEditing(false);
      return;
    }
    update.mutate({ title }, { onSuccess: () => setEditing(false) });
  };

  if (editing) {
    return (
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <Textarea
            autoFocus
            size="sm"
            rows={1}
            className="[&_[data-slot=textarea]]:min-h-7 [&_[data-slot=textarea]]:resize-none"
            value={draft}
            aria-label="Pull request title"
            data-testid="pull-request-title-input"
            disabled={update.isPending}
            onChange={(event) => setDraft(event.target.value.replace(/\n/gu, ""))}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
                return;
              }
              // A title is one line, so Enter is the send gesture rather than a
              // newline, and Ctrl or Cmd with it lands here too.
              if (event.key === "Enter") {
                event.preventDefault();
                save();
              }
            }}
          />
          <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="xs" disabled={update.isPending} onClick={save}>
            Save
          </Button>
        </span>
        {/* The box keeps the words on a refusal, so the reason belongs under
            them rather than in place of the whole editor. */}
        {update.isError ? (
          <span role="alert" className="break-words text-xs text-destructive">
            {update.error instanceof Error && update.error.message.trim().length > 0
              ? update.error.message
              : "That title could not be saved."}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <h2
      ref={heading}
      tabIndex={-1}
      className="group/title flex min-w-0 flex-1 items-center gap-1.5 rounded-sm focus-ring"
    >
      {/* A phone's column, and a sidebar's, are narrow enough that one truncated
          line says almost nothing, so there it wraps to two before it gives
          up. */}
      <span
        className="min-w-0 text-base font-semibold leading-snug @max-lg/pr:line-clamp-2 @lg/pr:truncate"
        title={detail.title}
      >
        {detail.title}
      </span>
      {canEdit ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-within/title:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          tooltip="Edit title"
          aria-label="Edit title"
          data-testid="pull-request-edit-title"
          onClick={() => {
            setDraft(detail.title);
            setEditing(true);
          }}
        >
          <PencilIcon />
        </Button>
      ) : null}
    </h2>
  );
}

/** The label a running action wears while the host works on it. */
const RUNNING_ACTION_WORDS: Readonly<Record<PullRequestAction, string>> = {
  merge: "Merging…",
  close: "Closing…",
  reopen: "Reopening…",
  "update-branch": "Updating…",
  ready: "Marking as ready…",
  draft: "Converting to draft…",
  "enable-auto-merge": "Enabling auto-merge…",
  "disable-auto-merge": "Disabling auto-merge…",
};

/**
 * The writes that run out of the More menu. The menu is closed by the time the
 * host answers, so their word goes on a line of its own rather than on a button
 * nobody can see.
 */
const MENU_ACTIONS: ReadonlySet<PullRequestAction> = new Set([
  "ready",
  "draft",
  "enable-auto-merge",
  "disable-auto-merge",
]);

type PullRequestConfirmation =
  | { readonly action: "merge"; readonly mergeMethod: PullRequestMergeMethod }
  | { readonly action: "close" };

/** Remembered per computer: whoever deletes merged branches always does. */
const DELETE_BRANCH_STORAGE_PREFIX = "threadlines:pull-requests:delete-branch:v1";

/** Remembered per repository: the merge method last run on it becomes the
 *  Merge button's own, as the host's site does. */
const MERGE_METHOD_STORAGE_PREFIX = "threadlines:pull-requests:merge-method:v1";
const REMEMBERED_MERGE_METHOD_SCHEMA = Schema.NullOr(PullRequestMergeMethodSchema);

/** The three pieces the header hangs in three different places. */
interface PullRequestActionsView {
  /** The buttons, for the right of the header's first row. */
  readonly controls: ReactNode;
  /** What a running or refused action has to say, under the header's rows. */
  readonly notices: ReactNode;
  readonly dialog: ReactNode;
}

/**
 * What the viewer may do to this pull request, as the header's own controls.
 *
 * A write is offered only where the host says it takes that action and the
 * viewer's own permission covers it, so this hides what it knows cannot work
 * and never refuses on its own. The two irreversible ones ask first, by name
 * and by method; the rest simply run. The hand-offs are not writes to the host
 * at all, so a reader with no rights over this pull request still gets them.
 *
 * A hook rather than a component because its three parts land in three rows of
 * the header, and the running action, the refusal and the confirmation are one
 * piece of state between them.
 */
function usePullRequestActions({
  environmentId,
  reference,
  detail,
  handoffs,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetail;
  readonly handoffs: PullRequestHandoffActions | null;
}): PullRequestActionsView {
  const queryClient = useQueryClient();
  const mutation = useMutation(
    pullRequestActionMutationOptions({ environmentId, reference, queryClient }),
  );
  const [confirming, setConfirming] = useState<PullRequestConfirmation | null>(null);
  const [deleteBranch, setDeleteBranch] = useLocalStorage(
    `${DELETE_BRANCH_STORAGE_PREFIX}:${environmentId}`,
    false,
    Schema.Boolean,
  );
  const [rememberedMergeMethod, setRememberedMergeMethod] = useLocalStorage(
    `${MERGE_METHOD_STORAGE_PREFIX}:${detail.provider}:${detail.repository}`,
    null,
    REMEMBERED_MERGE_METHOD_SCHEMA,
  );

  const isRunning = mutation.isPending;
  const runningAction = isRunning ? (mutation.variables?.action ?? null) : null;
  const run = useCallback(
    (
      action: PullRequestAction,
      extra?: {
        readonly mergeMethod?: PullRequestMergeMethod;
        readonly updateMethod?: PullRequestUpdateMethod;
        readonly deleteBranch?: boolean;
      },
    ) => {
      mutation.mutate({ action, ...extra });
    },
    [mutation],
  );

  // Landing a branch on someone else's repository needs push access; the state
  // of your own pull request is yours to change wherever you opened it.
  const canWrite = detail.viewer.canWrite;
  const canManage = detail.viewer.canManage;
  const isOpen = detail.state === "open";
  const isReopenable = detail.state === "closed" && detail.mergedAt === null;

  // Every write is offered only where the viewer may make it and the host takes
  // it at all: a Bitbucket that merges and closes but knows nothing of drafts
  // or auto-merge must not be asked about either.
  const allows = (action: PullRequestAction) => detail.capabilities.actions.includes(action);
  const showMerge = canWrite && isOpen && allows("merge");
  const showClose = canManage && isOpen && allows("close");
  const showReopen = canManage && isReopenable && allows("reopen");
  const showDraftToggle = canManage && isOpen && allows(detail.isDraft ? "ready" : "draft");
  const showDisableAutoMerge =
    canWrite && isOpen && detail.autoMergeEnabled === true && allows("disable-auto-merge");
  const showEnableAutoMerge =
    canWrite && isOpen && detail.autoMergeEnabled !== true && allows("enable-auto-merge");

  const updateMethods = detail.capabilities.updateMethods;
  const mergeBlock = resolvePullRequestMergeBlock(detail);
  const mergeDisabled = isRunning || mergeBlock !== null;
  const defaultMergeMethod = resolveDefaultMergeMethod(detail.mergeMethods, rememberedMergeMethod);
  const canUpdateBranch = canWrite && isOpen && allows("update-branch");
  const isBehind = detail.baseComparison === "behind";

  // One primary action for the state the branch is in: work it cannot merge
  // through first, then bringing it up to date, then the merge itself. The
  // displaced merge is not lost — it moves into the menu beside the rest.
  const primary: "resolve-conflicts" | "update-branch" | "merge" | null =
    isOpen && !detail.isDraft && detail.mergeability === "conflicting" && handoffs?.resolveConflicts
      ? "resolve-conflicts"
      : canUpdateBranch && isBehind && detail.mergeability !== "conflicting"
        ? "update-branch"
        : showMerge
          ? "merge"
          : null;
  const showMergeInMenu = showMerge && primary !== "merge" && mergeBlock === null;
  const hasMenuWrites =
    showDraftToggle || showDisableAutoMerge || showEnableAutoMerge || showMergeInMenu;
  // The two menu halves: the hand-offs, and the writes that are not buttons.
  const hasMenu = handoffs !== null || hasMenuWrites;

  const menuRunningWord =
    runningAction !== null && MENU_ACTIONS.has(runningAction)
      ? RUNNING_ACTION_WORDS[runningAction]
      : null;
  // A hairline between the two halves would be a colour this app does not
  // have, so the split is a one pixel gap of the surface behind it instead.
  const mergeControl = (
    <span className="flex items-center gap-px">
      <Button
        size="xs"
        className={cn(PHONE_ACTION_CLASS, detail.mergeMethods.length > 1 && "rounded-e-none")}
        disabled={mergeDisabled}
        data-testid="pull-request-merge"
        onClick={() => setConfirming({ action: "merge", mergeMethod: defaultMergeMethod })}
      >
        {runningAction === "merge"
          ? RUNNING_ACTION_WORDS.merge
          : PULL_REQUEST_MERGE_METHOD_WORDS[defaultMergeMethod]}
      </Button>
      {detail.mergeMethods.length > 1 ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                className={cn(PHONE_ACTION_CLASS, "rounded-s-none px-1 max-md:px-2")}
                aria-label="Choose a merge method"
                disabled={mergeDisabled}
              />
            }
          >
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="end" className="w-56">
            {detail.mergeMethods.map((method) => (
              <MenuItem
                key={method}
                onClick={() => setConfirming({ action: "merge", mergeMethod: method })}
              >
                {PULL_REQUEST_MERGE_METHOD_LABELS[method]}
              </MenuItem>
            ))}
          </MenuPopup>
        </Menu>
      ) : null}
    </span>
  );

  const updateBranchControl =
    updateMethods.length > 1 ? (
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="xs"
              className={PHONE_ACTION_CLASS}
              disabled={isRunning}
              data-testid="pull-request-update-branch"
            />
          }
        >
          {runningAction === "update-branch"
            ? RUNNING_ACTION_WORDS["update-branch"]
            : "Update branch"}
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end" className="w-56">
          {updateMethods.map((method) => (
            <MenuItem key={method} onClick={() => run("update-branch", { updateMethod: method })}>
              {pullRequestUpdateMethodLabel(method, detail.baseBranch)}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    ) : (
      <Button
        size="xs"
        className={PHONE_ACTION_CLASS}
        disabled={isRunning}
        data-testid="pull-request-update-branch"
        onClick={() =>
          run("update-branch", updateMethods[0] ? { updateMethod: updateMethods[0] } : undefined)
        }
      >
        {runningAction === "update-branch"
          ? RUNNING_ACTION_WORDS["update-branch"]
          : "Update branch"}
      </Button>
    );

  const controls =
    primary === null && !showClose && !showReopen && !hasMenu ? null : (
      <>
        {primary === "resolve-conflicts" && handoffs?.resolveConflicts ? (
          // A branch the host cannot merge is work for an agent, not for the
          // host's own buttons, so the way out stands where the merge would.
          <Button
            size="xs"
            className={PHONE_ACTION_CLASS}
            data-testid="pull-request-resolve-conflicts"
            onClick={handoffs.resolveConflicts}
          >
            Resolve conflicts
          </Button>
        ) : null}
        {primary === "update-branch" ? updateBranchControl : null}
        {primary === "merge" ? (
          // A blocked merge stays on screen and says what is in the way: the
          // fix is on the host, and a vanished button explains nothing.
          mergeBlock === null ? (
            mergeControl
          ) : (
            <TooltipWrapper tooltip={mergeBlock}>
              <span className="inline-flex">{mergeControl}</span>
            </TooltipWrapper>
          )
        ) : null}
        {showClose ? (
          <Button
            variant="outline"
            size="xs"
            className={PHONE_ACTION_CLASS}
            disabled={isRunning}
            onClick={() => setConfirming({ action: "close" })}
          >
            {runningAction === "close" ? RUNNING_ACTION_WORDS.close : "Close"}
          </Button>
        ) : null}
        {showReopen ? (
          <Button
            variant="outline"
            size="xs"
            className={PHONE_ACTION_CLASS}
            disabled={isRunning}
            onClick={() => run("reopen")}
          >
            {runningAction === "reopen" ? RUNNING_ACTION_WORDS.reopen : "Reopen"}
          </Button>
        ) : null}
        {/* Nothing to offer means no control at all, rather than a menu that
            opens on an empty popup. */}
        {hasMenu ? (
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="max-md:size-8"
                  aria-label={`More ${changeRequestWord(detail.provider)} actions`}
                  disabled={isRunning}
                />
              }
            >
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end" className="w-60">
              {/* Only where another action took the primary slot: the merge is
                  still available, it is simply no longer the thing to do. */}
              {showMergeInMenu ? (
                <MenuItem
                  data-testid="pull-request-merge-menu-item"
                  onClick={() =>
                    setConfirming({ action: "merge", mergeMethod: defaultMergeMethod })
                  }
                >
                  {PULL_REQUEST_MERGE_METHOD_LABELS[defaultMergeMethod]}
                </MenuItem>
              ) : null}
              {handoffs ? (
                <>
                  {showMergeInMenu ? <MenuSeparator /> : null}
                  {handoffs.fixAll ? (
                    <MenuItem data-testid="pull-request-fix-all" onClick={handoffs.fixAll}>
                      Fix all findings
                    </MenuItem>
                  ) : null}
                  <MenuItem data-testid="pull-request-explain" onClick={handoffs.explain}>
                    Explain this {changeRequestWord(detail.provider)}
                  </MenuItem>
                  <MenuItem data-testid="pull-request-ask" onClick={handoffs.ask}>
                    Ask a question
                  </MenuItem>
                </>
              ) : null}
              {(handoffs || showMergeInMenu) &&
              (showDraftToggle || showDisableAutoMerge || showEnableAutoMerge) ? (
                <MenuSeparator />
              ) : null}
              {showDraftToggle ? (
                detail.isDraft ? (
                  <MenuItem onClick={() => run("ready")}>Mark as ready</MenuItem>
                ) : (
                  <MenuItem onClick={() => run("draft")}>Convert to draft</MenuItem>
                )
              ) : null}
              {showDisableAutoMerge ? (
                <MenuItem
                  data-testid="pull-request-disable-auto-merge"
                  onClick={() => run("disable-auto-merge")}
                >
                  Disable auto-merge
                </MenuItem>
              ) : null}
              {showEnableAutoMerge ? (
                <MenuItem
                  data-testid="pull-request-enable-auto-merge"
                  onClick={() => run("enable-auto-merge", { mergeMethod: defaultMergeMethod })}
                >
                  Enable auto-merge (
                  {PULL_REQUEST_MERGE_METHOD_LABELS[defaultMergeMethod].toLowerCase()})
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
      </>
    );

  const notices = (
    <>
      {/* The menu is gone by the time the host answers, so its running action
          says so here instead of on the item that started it. */}
      <p
        aria-live="polite"
        className={cn(
          "text-right text-xs text-muted-foreground/60",
          menuRunningWord !== null && "mt-1",
        )}
        data-testid="pull-request-menu-action-status"
      >
        {menuRunningWord}
      </p>
      {/* A disabled button cannot be focused, so the reason it is disabled is
          written out as well as tucked in its tooltip. */}
      {primary === "merge" && mergeBlock !== null ? (
        <p className="mt-1 text-right text-xs text-muted-foreground/60">{mergeBlock}</p>
      ) : null}
      {mutation.isError ? (
        <p className="mt-1.5 break-words text-right text-xs text-destructive">
          {mutation.error instanceof Error && mutation.error.message.trim().length > 0
            ? mutation.error.message
            : "The host refused that action."}
        </p>
      ) : null}
    </>
  );

  const dialog = confirming ? (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) setConfirming(null);
      }}
    >
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {confirming.action === "merge"
              ? `Merge #${detail.number} into ${detail.baseBranch}?`
              : `Close #${detail.number} without merging?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirming.action === "merge"
              ? `${PULL_REQUEST_MERGE_METHOD_LABELS[confirming.mergeMethod]}.`
              : `The ${changeRequestWord(detail.provider)} stays on the host, and you can reopen it later.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {/* Between the header and the footer, which each carry their own
            padding, so the row has to bring its own to line up with them. */}
        {confirming.action === "merge" ? (
          <label className="flex cursor-pointer items-center gap-2 px-6 pb-4 text-sm text-foreground/85">
            <Checkbox
              checked={deleteBranch}
              data-testid="pull-request-delete-branch"
              onCheckedChange={(checked) => setDeleteBranch(checked === true)}
            />
            Delete branch after merge
          </label>
        ) : null}
        <AlertDialogFooter>
          {/* Cancel takes the focus: neither a merge nor a close can be
              taken back, so a stray Enter must not run one. */}
          <AlertDialogClose
            render={<Button data-alert-dialog-primary-action="true" variant="outline" />}
          >
            Cancel
          </AlertDialogClose>
          <Button
            variant={confirming.action === "close" ? "destructive" : "default"}
            onClick={() => {
              setConfirming(null);
              if (confirming.action === "merge") {
                setRememberedMergeMethod(confirming.mergeMethod);
                run("merge", {
                  mergeMethod: confirming.mergeMethod,
                  ...(deleteBranch ? { deleteBranch: true } : {}),
                });
              } else {
                run("close");
              }
            }}
          >
            {confirming.action === "merge" ? "Merge" : "Close"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  ) : null;

  return { controls, notices, dialog };
}

/** A branch name that copies itself, the way branch chips do elsewhere. */
function BranchCopyButton({ branch }: { readonly branch: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1200 });
  return (
    <button
      type="button"
      className="min-w-0 max-w-[14rem] shrink cursor-pointer truncate rounded-sm text-left transition-colors hover:text-foreground focus-ring"
      aria-label={isCopied ? `Copied ${branch}` : `Copy ${branch}`}
      onClick={() => copyToClipboard(branch, undefined)}
    >
      {isCopied ? "Copied" : branch}
    </button>
  );
}

/**
 * The pull request the thread is working on, docked to the top of the
 * composer.
 *
 * The sidebar badge says a pull request exists and the Pull request tab says
 * everything about it; neither is in view while you are writing the next
 * message, which is exactly when "did the checks pass" decides what you type.
 * The row is one line: which pull request, on which branch, how big, and how
 * its checks are going, with the switches that decide what happens when they
 * pass, and what happens when they do not.
 *
 * @module ComposerPullRequestRow
 */
import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestMergeQueueRemoval,
  PullRequestRef,
} from "@threadlines/contracts";
import type { PullRequestAutomationHold } from "@threadlines/shared/pullRequestAutoMerge";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ExternalLinkIcon, WrenchIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import {
  pullRequestActionMutationOptions,
  pullRequestQueryKeys,
  usePullRequestDetail,
  type PullRequestDetailRead,
} from "../../lib/pullRequestsReactQuery";
import { cn } from "../../lib/utils";
import {
  PullRequestHoverCard,
  type PullRequestHoverCardPayload,
} from "../pull-requests/PullRequestHoverCard";
import { CHECK_TONES, pullRequestHostName } from "../pull-requests/pullRequestPresentation";
import {
  pullRequestBadgeTone,
  resolveDefaultMergeMethod,
  type ThreadPullRequest,
} from "../pull-requests/pullRequests.logic";
import { useRememberedMergeMethod } from "../pull-requests/useRememberedMergeMethod";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DiffStatLabel } from "./DiffStatLabel";
import {
  composerAutoFixOffered,
  composerAutoMergeControl,
  composerAutoMergePendingLabel,
  composerPullRequestCheckBuckets,
  composerPullRequestChecksFootnote,
  composerPullRequestChecksNotice,
  composerPullRequestRow,
  pullRequestChecksUrl,
  type ComposerPendingAutoMergeAction,
  type ComposerPullRequestChipTone,
} from "./composerPullRequest.logic";

/** Said the same way on the marker and its tooltip, so they read as one thing. */
const AUTO_FIX_MARKER_LABEL = "Fixes failing checks and review comments on its own";

/** Under the server-held switch while it is off: who does the merge, and the catch. */
const SERVER_AUTO_MERGE_HINT = "Threadlines merges it while the app is running";

/**
 * Everything the thread route hands the composer about one of its pull
 * requests: the one on its own branch, or one its agent opened elsewhere.
 */
export interface ComposerPullRequest {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  /** What the sidebar badge and the tab already resolved, until the row's own read lands. */
  readonly pullRequest: ThreadPullRequest;
  /**
   * The commit the thread's checkout last saw this pull request's branch
   * pushed at, so the row can tell a read from before the push. Null for a
   * linked pull request, or where the checkout does not know.
   */
  readonly pushedHead: string | null;
  /** The thread's project, which is the pull request's too. */
  readonly projectTitle: string | null;
  /** Opens this pull request in the Pull request tab. */
  readonly onOpen: () => void;
  /** Closes the row for this pull request in this thread. */
  readonly onDismiss: () => void;
  /**
   * "Fix failing checks and review comments" for this pull request. The
   * server tells the agent which folder its branch is checked out in when it
   * is not the thread's own.
   */
  readonly autoFix: {
    readonly checked: boolean;
    readonly onChange: (next: boolean) => void;
  };
  /**
   * How the server merges this pull request once its checks pass, for a host
   * that cannot hold that itself; null while the thread has not asked.
   */
  readonly autoMerge: PullRequestMergeMethod | null;
  readonly onAutoMergeChange: (next: PullRequestMergeMethod | null) => void;
  /**
   * What about the thread holds a server merge back: the agent mid-turn (it
   * may push) or waiting on the user. See `composerPullRequestThreadHold`.
   */
  readonly threadHold: PullRequestAutomationHold | null;
  /** Commits on the thread's branch the host has not seen; the server waits for them too. */
  readonly unpushedCommits: number;
  /**
   * Whether this thread files itself under Wrapped once the pull request
   * merges or closes: the thread's own word, or the app setting until it
   * gives one.
   */
  readonly wrapUpOnSettled: boolean;
  readonly onWrapUpOnSettledChange: (next: boolean) => void;
}

/** One empty list for every surface with no rows, so it never reads as a change. */
export const NO_COMPOSER_PULL_REQUESTS: ReadonlyArray<ComposerPullRequest> = [];

const CHIP_TONE_CLASS: Readonly<
  Record<ComposerPullRequestChipTone, { readonly chip: string; readonly dot: string }>
> = {
  unknown: { chip: "", dot: "border-[1.5px] border-muted-foreground/70" },
  // The popover's "In progress" colour, still: a chip on screen for the whole
  // run should not pulse the way the popover's icon does.
  pending: { chip: "", dot: "bg-amber-600/90 dark:bg-amber-400/80" },
  success: { chip: "", dot: "bg-success" },
  failure: { chip: "", dot: "bg-destructive" },
  none: { chip: "text-muted-foreground", dot: "border-[1.5px] border-muted-foreground/70" },
  queued: { chip: "text-amber-600/90 dark:text-amber-400/80", dot: "bg-current" },
  merged: { chip: "text-violet-600 dark:text-violet-300/90", dot: "bg-current" },
  closed: { chip: "text-zinc-500 dark:text-zinc-400/80", dot: "bg-current" },
};

/** The host-side auto-merge write owned by the row so closing the popover keeps it alive. */
interface ComposerAutoMergeMutation {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly pendingAction: ComposerPendingAutoMergeAction | null;
  readonly mutate: (variables: {
    readonly action: PullRequestAction;
    readonly mergeMethod?: PullRequestMergeMethod;
  }) => void;
  readonly reset: () => void;
}

export function ComposerPullRequestRow({
  pullRequest,
  divided,
}: {
  readonly pullRequest: ComposerPullRequest;
  /** Another row or a notice sits under this one, so the two are ruled apart. */
  readonly divided: boolean;
}) {
  const queryClient = useQueryClient();
  // The same read the Pull request tab makes, on the same key, so one poll
  // serves both while checks run.
  const read = usePullRequestDetail({
    environmentId: pullRequest.environmentId,
    reference: pullRequest.reference,
    pushedHead: pullRequest.pushedHead,
  });
  const detailQueryKey = pullRequestQueryKeys.detail(
    pullRequest.environmentId,
    pullRequest.reference,
  );
  const actionOptions = pullRequestActionMutationOptions({
    environmentId: pullRequest.environmentId,
    reference: pullRequest.reference,
    queryClient,
  });
  // Owned by the row rather than the popover body so closing and reopening the
  // popover while GitHub is working keeps both the in-flight state and any
  // refusal in view. Optimistic state is overlaid from `pendingAction` rather
  // than written into the query cache, where a newer observation record would
  // overwrite it and kick off a competing refresh mid-write.
  const action = useMutation({
    ...actionOptions,
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: detailQueryKey, exact: true });
    },
  });
  const pendingAction: ComposerPendingAutoMergeAction | null =
    action.isPending &&
    (action.variables?.action === "enable-auto-merge" ||
      action.variables?.action === "disable-auto-merge")
      ? action.variables.action
      : null;
  const autoMergeMutation: ComposerAutoMergeMutation = {
    isPending: action.isPending,
    isError: action.isError,
    error: action.error,
    pendingAction,
    mutate: action.mutate,
    reset: action.reset,
  };
  const row = composerPullRequestRow({
    pullRequest: pullRequest.pullRequest,
    projectTitle: pullRequest.projectTitle,
    detail: read.detail,
    threadAutoMerge: pullRequest.autoMerge !== null,
    pendingAction,
    waitingFor: read.waitingFor,
    detailCurrent: read.lastKnown === null,
  });
  const tone = pullRequestBadgeTone(row.state, row.isDraft, row.autoMergeEnabled);
  const hoverCardPayload: PullRequestHoverCardPayload = {
    environmentId: pullRequest.environmentId,
    reference: pullRequest.reference,
    state: row.state,
    isDraft: row.isDraft,
    autoMergeEnabled: row.autoMergeEnabled,
    observedAt: row.observedAt,
  };

  // The number, the checks chip and the close button always stay. As the
  // composer narrows, the project title (the thread's own) goes first, then
  // the branch truncates, and then the diffstat and the branch step out.
  return (
    <div
      data-composer-pull-request-row="true"
      className={cn(
        "@container/pr-row flex h-8 min-w-0 items-center gap-2.5 px-3 text-xs",
        divided && "border-b border-border/60",
      )}
    >
      <PullRequestHoverCard payload={hoverCardPayload}>
        <button
          type="button"
          aria-label={`Open pull request #${row.number}`}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-sm transition-colors hover:text-primary-readable focus-ring"
          onClick={pullRequest.onOpen}
        >
          <tone.Icon aria-hidden className={cn("size-3.5", tone.className)} />
          <span className="font-mono">#{row.number}</span>
        </button>
      </PullRequestHoverCard>
      {row.projectTitle ? (
        <span className="min-w-0 truncate text-muted-foreground @max-sm/pr-row:hidden">
          {row.projectTitle}
        </span>
      ) : null}
      {/* The branch and the diffstat share what is left, each only at a size
          worth reading: the branch truncates down to 3rem, and the diffstat
          shows whole, since a cut-off count reads as a different number. What
          does not fit wraps onto a second line this one-line slot clips. The
          empty first item is what lets the branch wrap away too. */}
      <div className="flex h-4 min-w-0 flex-1 flex-wrap content-start items-center justify-end overflow-hidden">
        <span aria-hidden />
        {row.headBranch ? (
          <span className="min-w-0 flex-[1_1_3rem] truncate font-mono text-muted-foreground">
            {row.headBranch}
          </span>
        ) : null}
        {row.diffStat ? (
          <span className="ml-2.5 shrink-0 font-mono">
            <DiffStatLabel
              additions={row.diffStat.additions}
              deletions={row.diffStat.deletions}
              separator="space"
            />
          </span>
        ) : null}
      </div>
      {pullRequest.autoFix.checked ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={AUTO_FIX_MARKER_LABEL}
                className="inline-flex shrink-0 items-center text-muted-foreground"
              >
                <WrenchIcon aria-hidden className="size-3.5" />
              </span>
            }
          />
          <TooltipPopup side="top" sideOffset={6} className="max-w-72">
            {AUTO_FIX_MARKER_LABEL}
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <ComposerPullRequestChecksChip
        pullRequest={pullRequest}
        read={read}
        chip={row.chip}
        checksUrl={pullRequestChecksUrl(row.url)}
        autoMergeMutation={autoMergeMutation}
      />
      <button
        type="button"
        aria-label={`Hide pull request #${row.number} from the composer`}
        className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:text-foreground focus-ring"
        onClick={pullRequest.onDismiss}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** The dot every chip and popover row leads with, filled or hollow. */
function ChipDot({ className }: { readonly className: string }) {
  return <span aria-hidden className={cn("size-[7px] shrink-0 rounded-full", className)} />;
}

/**
 * The popover's checkboxes, 14px like its icons at every width. The shared
 * checkbox grows to 16px from `sm` up, so a plain `size-3.5` is not enough.
 */
const POPOVER_CHECKBOX_CLASS = "size-3.5 sm:size-3.5";

/**
 * A status dot at the start of a popover row, in the same 14px slot as the
 * icons and checkboxes in the rows around it, so it sits centred over them.
 */
function PopoverRowDot({ className }: { readonly className: string }) {
  return (
    <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
      <ChipDot className={className} />
    </span>
  );
}

/**
 * An address on the host, opened in the browser from the end of a popover
 * row. Outside Electron there is no shell to hand the address to, so the same
 * affordance is an ordinary link the browser opens itself.
 */
function OpenInBrowserButton({
  url,
  label,
  onOpen,
}: {
  readonly url: string;
  readonly label: string;
  /** Called as the shell takes the address, so the popover can close. */
  readonly onOpen: () => void;
}) {
  const className =
    "ml-auto inline-flex size-5 items-center justify-center rounded-md transition-colors hover:text-foreground focus-ring";
  return isElectron ? (
    <button
      type="button"
      aria-label={label}
      className={cn(className, "cursor-pointer")}
      onClick={() => {
        onOpen();
        void readLocalApi()?.shell.openExternal(url);
      }}
    >
      <ExternalLinkIcon aria-hidden className="size-3.5" />
    </button>
  ) : (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className={className}
    >
      <ExternalLinkIcon aria-hidden className="size-3.5" />
    </a>
  );
}

/**
 * What failed when the merge queue last tested this pull request, while the
 * queue has given it back. Those runs are the queue's, not the pull request's
 * own, so the counts above leave them out.
 */
function ComposerPullRequestQueueFailure({
  removal,
  onOpenExternal,
}: {
  readonly removal: PullRequestMergeQueueRemoval;
  readonly onOpenExternal: () => void;
}) {
  const failed = CHECK_TONES.failure;
  return (
    <>
      <p className="flex items-center gap-2 px-3 py-1 text-muted-foreground">
        <PopoverRowDot className={CHIP_TONE_CLASS.failure.dot} />
        Failed in the merge queue
      </p>
      {removal.failedChecks.map((check) => (
        <div key={check.name} className="flex items-center gap-2 px-3 py-1">
          <failed.Icon aria-hidden className={cn("size-3.5 shrink-0", failed.className)} />
          <span className="min-w-0 truncate">{check.name}</span>
          {check.url ? (
            <OpenInBrowserButton
              url={check.url}
              label={`Open ${check.name} in browser`}
              onOpen={onOpenExternal}
            />
          ) : null}
        </div>
      ))}
    </>
  );
}

function ComposerPullRequestChecksChip({
  pullRequest,
  read,
  chip,
  checksUrl,
  autoMergeMutation,
}: {
  readonly pullRequest: ComposerPullRequest;
  readonly read: PullRequestDetailRead;
  readonly chip: ReturnType<typeof composerPullRequestRow>["chip"];
  readonly checksUrl: string;
  readonly autoMergeMutation: ComposerAutoMergeMutation;
}) {
  const [open, setOpen] = useState(false);
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    // Once a refusal has been shown and dismissed, clear it so the next open
    // starts clean; a failure that lands while closed stays visible next time.
    if (!nextOpen && !autoMergeMutation.isPending && autoMergeMutation.isError) {
      autoMergeMutation.reset();
    }
  };
  const toneClass = CHIP_TONE_CLASS[chip.tone];
  const chipClass = cn(
    "inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-md border border-border px-1.5 text-xs",
    toneClass.chip,
  );

  // A settled pull request has no checks left to wait on and nothing to arm,
  // so its chip states the fact and is not a control.
  if (!chip.interactive) {
    return (
      <span className={chipClass}>
        <ChipDot className={toneClass.dot} />
        {chip.label}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Checks"
            className={cn(chipClass, "cursor-pointer transition-colors hover:bg-accent focus-ring")}
          >
            {/* Dimmed while it is the last known state rather than a current read. */}
            <ChipDot className={cn(toneClass.dot, read.lastKnown !== null && "opacity-50")} />
            {chip.label}
            <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground" />
          </button>
        }
      />
      <PopoverPopup
        side="top"
        align="end"
        className="w-75"
        viewportClassName="p-0 [--viewport-inline-padding:0px]"
      >
        <ComposerPullRequestChecksPopover
          pullRequest={pullRequest}
          read={read}
          checksUrl={checksUrl}
          autoMergeMutation={autoMergeMutation}
          onOpenExternal={() => handleOpenChange(false)}
        />
      </PopoverPopup>
    </Popover>
  );
}

function ComposerPullRequestChecksPopover({
  pullRequest,
  read,
  checksUrl,
  autoMergeMutation,
  onOpenExternal,
}: {
  readonly pullRequest: ComposerPullRequest;
  /** The row's read of this pull request. */
  readonly read: PullRequestDetailRead;
  readonly checksUrl: string;
  readonly autoMergeMutation: ComposerAutoMergeMutation;
  readonly onOpenExternal: () => void;
}) {
  const { detail } = read;
  const notice = composerPullRequestChecksNotice({
    detail,
    failed: read.error !== null,
    waitingFor: read.waitingFor,
    hostName: pullRequestHostName(detail?.provider ?? "unknown"),
  });
  const buckets = composerPullRequestCheckBuckets(detail?.checks ?? []);
  const footnote = composerPullRequestChecksFootnote({
    lastKnown: read.lastKnown,
    countsShown: notice === null,
  });

  return (
    <div className="w-full py-2 text-xs">
      <div className="flex items-center gap-2 px-3 pb-1 text-muted-foreground">
        <span>Checks</span>
        <OpenInBrowserButton
          url={checksUrl}
          label="Open checks in browser"
          onOpen={onOpenExternal}
        />
      </div>
      {notice !== null ? (
        <p className="px-3 py-1 text-muted-foreground">{notice}</p>
      ) : buckets.length === 0 ? (
        <p className="px-3 py-1 text-muted-foreground">No checks on this pull request</p>
      ) : (
        buckets.map((bucket) => {
          const checkTone = CHECK_TONES[bucket.id];
          return (
            <div key={bucket.id} className="flex items-center gap-2 px-3 py-1">
              <checkTone.Icon
                aria-hidden
                className={cn("size-3.5 shrink-0", checkTone.className)}
              />
              <span>{bucket.label}</span>
              <span className="ml-auto font-mono text-muted-foreground">{bucket.count}</span>
            </div>
          );
        })
      )}
      {footnote !== null ? (
        <p className="px-3 pt-1 text-[11px] text-muted-foreground">{footnote}</p>
      ) : null}
      <div className="my-1.5 border-border border-t" />
      {detail ? (
        <ComposerPullRequestAutoMergeSection
          pullRequest={pullRequest}
          detail={detail}
          action={autoMergeMutation}
          onOpenExternal={onOpenExternal}
        />
      ) : null}
      {composerAutoFixOffered(detail) ? (
        <ComposerPullRequestThreadSwitch
          checked={pullRequest.autoFix.checked}
          onCheckedChange={pullRequest.autoFix.onChange}
          label="Fix failing checks and review comments"
        />
      ) : null}
      {/* This thread's own choice. The link goes to the app-wide default it
          stands in for until the box is clicked, and sits outside the label so
          following it does not also flip the box. */}
      <div className="flex items-center gap-2 px-3 py-1 transition-colors hover:bg-accent">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
          <Checkbox
            className={POPOVER_CHECKBOX_CLASS}
            checked={pullRequest.wrapUpOnSettled}
            onCheckedChange={(checked) => {
              pullRequest.onWrapUpOnSettledChange(Boolean(checked));
            }}
          />
          Wrap up thread after merge or close
        </label>
        <Link
          to="/settings/threads"
          hash="wrap-up-merged-threads"
          className="shrink-0 rounded-sm text-[11px] text-muted-foreground transition-colors hover:text-foreground focus-ring"
        >
          Settings
        </Link>
      </div>
    </div>
  );
}

/**
 * "Merge when checks pass", in whichever form this pull request allows: the
 * host's own standing instruction, the same switch held by this thread's
 * server where the host cannot hold it, the merge queue it already sits in, or
 * the reason none of those is on offer. Above it, what failed when the queue
 * last gave the pull request back, until something queues it again.
 */
function ComposerPullRequestAutoMergeSection({
  pullRequest,
  detail,
  action,
  onOpenExternal,
}: {
  readonly pullRequest: ComposerPullRequest;
  readonly detail: PullRequestDetail;
  readonly action: ComposerAutoMergeMutation;
  readonly onOpenExternal: () => void;
}) {
  const [rememberedMergeMethod] = useRememberedMergeMethod(detail.provider, detail.repository);
  const mergeMethod = resolveDefaultMergeMethod(detail.mergeMethods, rememberedMergeMethod);
  // Read once as the popover opens. Only the "waiting for checks" wording
  // right after a push hangs on it, and the next opening reads it again.
  const [openedAt] = useState(() => Date.now());
  const autoMergeControl = composerAutoMergeControl({
    detail,
    threadAutoMerge: pullRequest.autoMerge,
    autoFix: pullRequest.autoFix.checked,
    threadHold: pullRequest.threadHold,
    unpushedCommits: pullRequest.unpushedCommits,
    pushedHead: pullRequest.pushedHead,
    pendingAction: action.pendingAction,
    now: openedAt,
  });
  const pendingLabel = composerAutoMergePendingLabel({
    detail,
    pendingAction: action.pendingAction,
  });

  return (
    <>
      {detail.mergeQueue?.removal ? (
        <ComposerPullRequestQueueFailure
          removal={detail.mergeQueue.removal}
          onOpenExternal={onOpenExternal}
        />
      ) : null}
      {autoMergeControl.kind === "toggle" ? (
        <div className="flex items-center gap-2 px-3 py-1 transition-colors hover:bg-accent">
          <label
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2",
              action.isPending ? "cursor-default" : "cursor-pointer",
            )}
          >
            <Checkbox
              className={POPOVER_CHECKBOX_CLASS}
              checked={autoMergeControl.checked}
              disabled={action.isPending}
              onCheckedChange={(checked) => {
                const next: PullRequestAction = checked
                  ? "enable-auto-merge"
                  : "disable-auto-merge";
                action.mutate(checked ? { action: next, mergeMethod } : { action: next });
              }}
            />
            Merge when checks pass
          </label>
          {pendingLabel !== null ? (
            <span aria-live="polite" className="shrink-0 text-[11px] text-muted-foreground">
              {pendingLabel}
            </span>
          ) : null}
        </div>
      ) : null}
      {autoMergeControl.kind === "server" ? (
        <ComposerPullRequestThreadSwitch
          checked={autoMergeControl.checked}
          onCheckedChange={(next) => pullRequest.onAutoMergeChange(next ? mergeMethod : null)}
          label="Merge when checks pass"
          hint={autoMergeControl.status ?? SERVER_AUTO_MERGE_HINT}
        />
      ) : null}
      {autoMergeControl.kind === "unavailable" ? (
        <div className="px-3 py-1">
          <p className="text-muted-foreground">{autoMergeControl.reason}</p>
          <button
            type="button"
            className="mt-1 cursor-pointer rounded-sm text-primary-readable hover:text-foreground focus-ring"
            onClick={() => {
              onOpenExternal();
              pullRequest.onOpen();
            }}
          >
            Open merge controls
          </button>
        </div>
      ) : null}
      {autoMergeControl.kind === "queued" ? (
        // The host has taken it: there is no instruction left to switch off,
        // and the queue lands it on its own.
        <p className="flex items-center gap-2 px-3 py-1 text-muted-foreground">
          <PopoverRowDot className={cn(CHIP_TONE_CLASS.queued.dot, CHIP_TONE_CLASS.queued.chip)} />
          In the merge queue
          {detail.viewer.canWrite && detail.capabilities.actions.includes("disable-auto-merge") ? (
            <button
              type="button"
              disabled={action.isPending}
              className="ml-auto cursor-pointer rounded-sm hover:text-foreground disabled:cursor-default disabled:opacity-60 focus-ring"
              onClick={() => action.mutate({ action: "disable-auto-merge" })}
            >
              {action.pendingAction === "disable-auto-merge" ? "Leaving…" : "Leave queue"}
            </button>
          ) : null}
        </p>
      ) : null}
      {action.isError ? (
        <p role="alert" className="break-words px-3 py-1 text-destructive">
          {action.error instanceof Error && action.error.message.trim().length > 0
            ? action.error.message
            : "The host refused that action."}
        </p>
      ) : null}
    </>
  );
}

/**
 * One of the thread's own switches, held optimistically. The command is a
 * round trip to the server and back through the read model, and a switch that
 * waits for both reads as one that did not take the click; the read model wins
 * again as soon as it says something different from what was clicked.
 */
function ComposerPullRequestThreadSwitch({
  checked,
  onCheckedChange,
  label,
  hint,
}: {
  readonly checked: boolean;
  readonly onCheckedChange: (next: boolean) => void;
  readonly label: string;
  /** A muted line under the label: what the switch is doing while it is on. */
  readonly hint?: string;
}) {
  // `from` is what the read model said when the click happened. Once it says
  // anything else the round trip has landed, so the click stops standing in.
  const [pending, setPending] = useState<{ next: boolean; from: boolean } | null>(null);
  if (pending !== null && pending.from !== checked) {
    setPending(null);
  }

  return (
    <label className="flex cursor-pointer items-start gap-2 px-3 py-1 transition-colors hover:bg-accent">
      <Checkbox
        className={cn("mt-px", POPOVER_CHECKBOX_CLASS)}
        checked={pending?.next ?? checked}
        onCheckedChange={(value) => {
          const next = Boolean(value);
          setPending({ next, from: checked });
          onCheckedChange(next);
        }}
      />
      <span className="min-w-0">
        {label}
        {hint ? <span className="block text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

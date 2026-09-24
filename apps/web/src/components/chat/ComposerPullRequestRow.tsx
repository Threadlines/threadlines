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
} from "../../lib/pullRequestsReactQuery";
import { cn } from "../../lib/utils";
import {
  PullRequestHoverCard,
  type PullRequestHoverCardPayload,
} from "../pull-requests/PullRequestHoverCard";
import { CHECK_TONES } from "../pull-requests/pullRequestPresentation";
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
  composerPullRequestCheckBuckets,
  composerPullRequestRow,
  pullRequestChecksUrl,
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
  /** The thread's project, which is the pull request's too. */
  readonly projectTitle: string | null;
  /** Opens this pull request in the Pull request tab. */
  readonly onOpen: () => void;
  /** Closes the row for this pull request in this thread. */
  readonly onDismiss: () => void;
  /**
   * The thread's auto-fix watch, which only the pull request on the thread's
   * own branch has: the thread's checkout cannot push to another branch. Null
   * for a linked one.
   */
  readonly autoFix: {
    readonly checked: boolean;
    readonly onChange: (next: boolean) => void;
  } | null;
  /**
   * How the server merges this pull request once its checks pass, for a host
   * that cannot hold that itself; null while the thread has not asked.
   */
  readonly autoMerge: PullRequestMergeMethod | null;
  readonly onAutoMergeChange: (next: PullRequestMergeMethod | null) => void;
  /** The agent is mid-turn. The server holds a merge until it finishes, since it may push. */
  readonly agentWorking: boolean;
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
  pending: { chip: "", dot: "border-[1.5px] border-muted-foreground/70" },
  success: { chip: "", dot: "bg-success" },
  failure: { chip: "", dot: "bg-destructive" },
  none: { chip: "text-muted-foreground", dot: "border-[1.5px] border-muted-foreground/70" },
  queued: { chip: "text-amber-600/90 dark:text-amber-400/80", dot: "bg-current" },
  merged: { chip: "text-violet-600 dark:text-violet-300/90", dot: "bg-current" },
  closed: { chip: "text-zinc-500 dark:text-zinc-400/80", dot: "bg-current" },
};

export function ComposerPullRequestRow({
  pullRequest,
  divided,
}: {
  readonly pullRequest: ComposerPullRequest;
  /** Another row or a notice sits under this one, so the two are ruled apart. */
  readonly divided: boolean;
}) {
  // The same read the Pull request tab makes, on the same key, so one poll
  // serves both while checks run.
  const detail = usePullRequestDetail({
    environmentId: pullRequest.environmentId,
    reference: pullRequest.reference,
  });
  const row = composerPullRequestRow({
    pullRequest: pullRequest.pullRequest,
    projectTitle: pullRequest.projectTitle,
    detail,
    threadAutoMerge: pullRequest.autoMerge !== null,
  });
  const tone = pullRequestBadgeTone(row.state, row.isDraft, row.autoMergeEnabled);
  const hoverCardPayload: PullRequestHoverCardPayload = {
    environmentId: pullRequest.environmentId,
    reference: pullRequest.reference,
    state: row.state,
    isDraft: row.isDraft,
    autoMergeEnabled: row.autoMergeEnabled,
  };

  return (
    <div
      data-composer-pull-request-row="true"
      className={cn(
        "flex h-8 min-w-0 items-center gap-2.5 px-3 text-xs",
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
        <span className="shrink-0 truncate text-muted-foreground">{row.projectTitle}</span>
      ) : null}
      {row.headBranch ? (
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
          {row.headBranch}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {row.diffStat ? (
        <span className="shrink-0 font-mono">
          <DiffStatLabel
            additions={row.diffStat.additions}
            deletions={row.diffStat.deletions}
            separator="space"
          />
        </span>
      ) : null}
      {pullRequest.autoFix?.checked ? (
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
        detail={detail}
        chip={row.chip}
        checksUrl={pullRequestChecksUrl(row.url)}
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
        <ChipDot className={CHIP_TONE_CLASS.failure.dot} />
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
  detail,
  chip,
  checksUrl,
}: {
  readonly pullRequest: ComposerPullRequest;
  readonly detail: PullRequestDetail | undefined;
  readonly chip: ReturnType<typeof composerPullRequestRow>["chip"];
  readonly checksUrl: string;
}) {
  const [open, setOpen] = useState(false);
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Checks"
            className={cn(chipClass, "cursor-pointer transition-colors hover:bg-accent focus-ring")}
          >
            <ChipDot className={toneClass.dot} />
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
          detail={detail}
          checksUrl={checksUrl}
          onOpenExternal={() => setOpen(false)}
        />
      </PopoverPopup>
    </Popover>
  );
}

function ComposerPullRequestChecksPopover({
  pullRequest,
  detail,
  checksUrl,
  onOpenExternal,
}: {
  readonly pullRequest: ComposerPullRequest;
  /** The row's read of this pull request; absent until it lands. */
  readonly detail: PullRequestDetail | undefined;
  readonly checksUrl: string;
  readonly onOpenExternal: () => void;
}) {
  const buckets = composerPullRequestCheckBuckets(detail?.checks ?? []);

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
      {buckets.length === 0 ? (
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
      <div className="my-1.5 border-border border-t" />
      {detail ? (
        <ComposerPullRequestAutoMergeSection
          pullRequest={pullRequest}
          detail={detail}
          onOpenExternal={onOpenExternal}
        />
      ) : null}
      {pullRequest.autoFix !== null && composerAutoFixOffered(detail) ? (
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
            className="size-3.5"
            checked={pullRequest.wrapUpOnSettled}
            onCheckedChange={(checked) => {
              pullRequest.onWrapUpOnSettledChange(Boolean(checked));
            }}
          />
          Wrap up thread after merge or close
        </label>
        <Link
          to="/settings/general"
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
  onOpenExternal,
}: {
  readonly pullRequest: ComposerPullRequest;
  readonly detail: PullRequestDetail;
  readonly onOpenExternal: () => void;
}) {
  const queryClient = useQueryClient();
  const [rememberedMergeMethod] = useRememberedMergeMethod(detail.provider, detail.repository);
  const mergeMethod = resolveDefaultMergeMethod(detail.mergeMethods, rememberedMergeMethod);
  // Read once as the popover opens. Only the "waiting for checks" wording
  // right after a push hangs on it, and the next opening reads it again.
  const [openedAt] = useState(() => Date.now());
  const autoMergeControl = composerAutoMergeControl({
    detail,
    threadAutoMerge: pullRequest.autoMerge,
    autoFix: pullRequest.autoFix?.checked ?? false,
    agentWorking: pullRequest.agentWorking,
    unpushedCommits: pullRequest.unpushedCommits,
    now: openedAt,
  });
  const detailQueryKey = pullRequestQueryKeys.detail(
    pullRequest.environmentId,
    pullRequest.reference.projectId,
    pullRequest.reference.number,
  );
  const actionOptions = pullRequestActionMutationOptions({
    environmentId: pullRequest.environmentId,
    reference: pullRequest.reference,
    queryClient,
  });
  const action = useMutation({
    ...actionOptions,
    // The switch flips the moment it is clicked. The host takes seconds to arm
    // the merge and seconds more to be re-read, and a switch that waits for
    // both reads as one that did not take the click. If the host refuses, the
    // detail it was read from comes back.
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: detailQueryKey });
      const previous = queryClient.getQueryData<PullRequestDetail>(detailQueryKey);
      if (
        previous &&
        previous.mergeQueue?.position == null &&
        variables.action.endsWith("auto-merge")
      ) {
        queryClient.setQueryData<PullRequestDetail>(detailQueryKey, {
          ...previous,
          autoMergeEnabled: variables.action === "enable-auto-merge",
        });
      }
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(detailQueryKey, context.previous);
      }
    },
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
        <label className="flex cursor-pointer items-center gap-2 px-3 py-1 transition-colors hover:bg-accent">
          <Checkbox
            className="size-3.5"
            checked={autoMergeControl.checked}
            disabled={action.isPending}
            onCheckedChange={(checked) => {
              const next: PullRequestAction = checked ? "enable-auto-merge" : "disable-auto-merge";
              action.mutate(checked ? { action: next, mergeMethod } : { action: next });
            }}
          />
          Merge when checks pass
        </label>
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
          <ChipDot className={CHIP_TONE_CLASS.queued.dot + " " + CHIP_TONE_CLASS.queued.chip} />
          In the merge queue
          {detail.viewer.canWrite && detail.capabilities.actions.includes("disable-auto-merge") ? (
            <button
              type="button"
              disabled={action.isPending}
              className="ml-auto cursor-pointer rounded-sm hover:text-foreground disabled:cursor-default disabled:opacity-60 focus-ring"
              onClick={() => action.mutate({ action: "disable-auto-merge" })}
            >
              {action.isPending ? "Leaving…" : "Leave queue"}
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
        className="mt-px size-3.5"
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

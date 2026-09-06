/**
 * The pull request the thread is working on, docked to the top of the
 * composer.
 *
 * The sidebar badge says a pull request exists and the Pull request tab says
 * everything about it; neither is in view while you are writing the next
 * message, which is exactly when "did the checks pass" decides what you type.
 * The row is one line: which pull request, on which branch, how big, and how
 * its checks are going, with the two switches that decide what happens when
 * they pass.
 *
 * @module ComposerPullRequestRow
 */
import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestDetail,
  PullRequestRef,
} from "@threadlines/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ExternalLinkIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "../../env";
import { useSettings, updateSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import {
  pullRequestActionMutationOptions,
  pullRequestQueryKeys,
} from "../../lib/pullRequestsReactQuery";
import { cn } from "../../lib/utils";
import {
  PullRequestHoverCard,
  type PullRequestHoverCardPayload,
} from "../pull-requests/PullRequestHoverCard";
import { CHECK_TONES } from "../pull-requests/pullRequestPresentation";
import { pullRequestBadgeTone, type ThreadPullRequest } from "../pull-requests/pullRequests.logic";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { DiffStatLabel } from "./DiffStatLabel";
import {
  composerAutoMergeControl,
  composerPullRequestCheckBuckets,
  composerPullRequestRow,
  pullRequestChecksUrl,
  type ComposerPullRequestChipTone,
} from "./composerPullRequest.logic";

/** Everything the thread route hands the composer about its pull request. */
export interface ComposerPullRequest {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  /** What the sidebar badge and the tab already resolved. */
  readonly pullRequest: ThreadPullRequest;
  /** The thread's project, which is the pull request's too. */
  readonly projectTitle: string | null;
  /** The shared read behind the Pull request tab; absent until it lands. */
  readonly detail: PullRequestDetail | undefined;
  /** Opens the Pull request tab, the same place the sidebar badge goes. */
  readonly onOpen: () => void;
  /** Closes the row for this pull request in this thread. */
  readonly onDismiss: () => void;
}

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
  /** A notice sits under this row, so the two are ruled apart. */
  readonly divided: boolean;
}) {
  const row = composerPullRequestRow({
    pullRequest: pullRequest.pullRequest,
    projectTitle: pullRequest.projectTitle,
    detail: pullRequest.detail,
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
      <ComposerPullRequestChecksChip
        pullRequest={pullRequest}
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

function ComposerPullRequestChecksChip({
  pullRequest,
  chip,
  checksUrl,
}: {
  readonly pullRequest: ComposerPullRequest;
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
          checksUrl={checksUrl}
          onOpenExternal={() => setOpen(false)}
        />
      </PopoverPopup>
    </Popover>
  );
}

function ComposerPullRequestChecksPopover({
  pullRequest,
  checksUrl,
  onOpenExternal,
}: {
  readonly pullRequest: ComposerPullRequest;
  readonly checksUrl: string;
  readonly onOpenExternal: () => void;
}) {
  const queryClient = useQueryClient();
  const detail = pullRequest.detail;
  const buckets = composerPullRequestCheckBuckets(detail?.checks ?? []);
  const wrapUpOnSettled = useSettings((settings) => settings.wrapUpThreadsOnPullRequestSettled);
  const autoMergeControl = composerAutoMergeControl(detail);
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
    onMutate: (variables) => {
      const previous = queryClient.getQueryData<PullRequestDetail>(detailQueryKey);
      if (previous && variables.action.endsWith("auto-merge")) {
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
    <div className="w-full py-2 text-xs">
      <div className="flex items-center gap-2 px-3 pb-1 text-muted-foreground">
        <span>Checks</span>
        {/* Outside Electron there is no shell to hand the address to, so the
            same affordance is an ordinary link the browser opens itself. */}
        {isElectron ? (
          <button
            type="button"
            aria-label="Open checks in browser"
            className="ml-auto inline-flex size-5 cursor-pointer items-center justify-center rounded-md transition-colors hover:text-foreground focus-ring"
            onClick={() => {
              onOpenExternal();
              void readLocalApi()?.shell.openExternal(checksUrl);
            }}
          >
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </button>
        ) : (
          <a
            href={checksUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open checks in browser"
            className="ml-auto inline-flex size-5 items-center justify-center rounded-md transition-colors hover:text-foreground focus-ring"
          >
            <ExternalLinkIcon aria-hidden className="size-3.5" />
          </a>
        )}
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
      {autoMergeControl.kind === "toggle" ? (
        <label className="flex cursor-pointer items-center gap-2 px-3 py-1 transition-colors hover:bg-accent">
          <Checkbox
            className="size-3.5"
            checked={autoMergeControl.checked}
            onCheckedChange={(checked) => {
              const next: PullRequestAction = checked ? "enable-auto-merge" : "disable-auto-merge";
              action.mutate({ action: next });
            }}
          />
          Merge when checks pass
        </label>
      ) : null}
      {autoMergeControl.kind === "queued" ? (
        // The host has taken it: there is no instruction left to switch off,
        // and the queue lands it on its own.
        <p className="flex items-center gap-2 px-3 py-1 text-muted-foreground">
          <ChipDot className={CHIP_TONE_CLASS.queued.dot + " " + CHIP_TONE_CLASS.queued.chip} />
          In the merge queue
        </p>
      ) : null}
      <label className="flex cursor-pointer items-center gap-2 px-3 py-1 transition-colors hover:bg-accent">
        <Checkbox
          className="size-3.5"
          checked={wrapUpOnSettled}
          onCheckedChange={(checked) => {
            updateSettings({ wrapUpThreadsOnPullRequestSettled: Boolean(checked) });
          }}
        />
        Wrap up thread after merge or close
        {/* This one switch is not about this pull request: it is the app-wide
            setting, and the hint says so before it is flipped. */}
        <span className="ml-auto text-[11px] text-muted-foreground">Settings</span>
      </label>
    </div>
  );
}

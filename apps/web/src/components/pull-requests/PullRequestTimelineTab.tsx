/**
 * Everything that happened to the pull request, in order: opened, each commit,
 * the conversation, the verdicts, and how it ended.
 *
 * Consecutive remarks fold into one group so the work between two review
 * rounds stays readable; a verdict never folds, because whether the change was
 * approved is the question the tab is opened with.
 */
import type { EnvironmentId, PullRequestDetail, PullRequestRef } from "@threadlines/contracts";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { openExternalUrl } from "../../lib/externalLinks";
import { cn, pluralize } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { PullRequestReactionBar } from "./PullRequestReactions";
import { MetaSeparator, REVIEW_STATE_WORDS, TEXT_BUTTON_CLASS } from "./pullRequestPresentation";
import {
  buildPullRequestTimeline,
  groupTimelineRows,
  type PullRequestTimelineEvent,
} from "./pullRequests.logic";

export type PullRequestTimelineOrder = "newest" | "oldest";

const LIFECYCLE_ROWS = {
  opened: { Icon: GitPullRequestIcon, label: "opened this pull request" },
  merged: { Icon: GitMergeIcon, label: "Merged" },
  closed: { Icon: GitPullRequestClosedIcon, label: "Closed without merging" },
} as const;

export function PullRequestTimelineTab({
  environmentId,
  reference,
  detail,
  activity,
  order,
  isPending,
  isError,
  onRetry,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetail;
  readonly activity: Parameters<typeof buildPullRequestTimeline>[1];
  readonly order: PullRequestTimelineOrder;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
}) {
  const events = buildPullRequestTimeline(detail, activity);
  const rows = groupTimelineRows(order === "newest" ? events : events.toReversed());

  return (
    <div className="h-full min-h-0 overflow-y-auto px-4 py-4">
      {isError ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground/60">
          The conversation could not be read, so only the header's own facts are listed.
          <button type="button" className={TEXT_BUTTON_CLASS} onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-label="Loading the timeline">
          <Skeleton className="h-2.5 w-40 rounded-full" />
          <Skeleton className="h-2.5 w-full rounded-full" />
        </div>
      ) : null}
      <div className="mt-2 flex flex-col divide-y divide-border/50">
        {rows.map((row) =>
          row.kind === "comments" ? (
            <TimelineCommentGroup
              key={`comments:${row.events[0]?.id ?? "empty"}`}
              events={row.events}
              environmentId={environmentId}
              reference={reference}
              detail={detail}
            />
          ) : (
            <TimelineEventRow
              key={row.event.id}
              event={row.event}
              environmentId={environmentId}
              reference={reference}
              detail={detail}
            />
          ),
        )}
      </div>
    </div>
  );
}

/** The one line every row leads with: who, what, and when. */
function TimelineHeading({
  icon,
  children,
  at,
  url,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly at: string;
  readonly url: string | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/60">
      <span aria-hidden className="shrink-0 text-muted-foreground/45">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
      <span className="shrink-0 font-mono text-[11px] tabular-nums">
        {formatRelativeTimeLabel(at)}
      </span>
      {url === null ? null : (
        <Button
          variant="ghost"
          size="icon-xs"
          tooltip="Open on the host"
          aria-label="Open on the host"
          onClick={() => openExternalUrl(url)}
        >
          <ExternalLinkIcon />
        </Button>
      )}
    </div>
  );
}

function TimelineEventRow({
  event,
  environmentId,
  reference,
  detail,
}: {
  readonly event: PullRequestTimelineEvent;
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetail;
}) {
  if (event.kind === "commit") {
    return (
      <article className="py-2.5">
        <TimelineHeading
          icon={<GitCommitHorizontalIcon className="size-3.5" />}
          at={event.at}
          url={event.url}
        >
          <span className="min-w-0 truncate text-foreground/85">
            {event.body ?? "Untitled commit"}
          </span>
          <MetaSeparator />
          <span className="shrink-0 font-mono text-[11px]">{event.id.slice(0, 7)}</span>
          {event.actor ? (
            <>
              <MetaSeparator />
              <span className="shrink-0">{event.actor.login}</span>
            </>
          ) : null}
        </TimelineHeading>
      </article>
    );
  }

  if (event.kind === "opened" || event.kind === "merged" || event.kind === "closed") {
    const row = LIFECYCLE_ROWS[event.kind];
    // "opened this pull request" needs the name in front of it; a host that
    // does not say who opened it gets the fact on its own instead.
    const label = event.kind === "opened" && event.actor === null ? "Opened" : row.label;
    return (
      <article className="py-2.5">
        <TimelineHeading icon={<row.Icon className="size-3.5" />} at={event.at} url={event.url}>
          {event.actor ? (
            <span className="shrink-0 text-foreground/85">{event.actor.login}</span>
          ) : null}
          <span className="min-w-0 truncate">{label}</span>
        </TimelineHeading>
      </article>
    );
  }

  return (
    <TimelineComment
      event={event}
      environmentId={environmentId}
      reference={reference}
      detail={detail}
    />
  );
}

/** One remark or verdict, with its words and its reactions. */
function TimelineComment({
  event,
  environmentId,
  reference,
  detail,
}: {
  readonly event: PullRequestTimelineEvent;
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetail;
}) {
  return (
    <article className="group/reactions py-2.5">
      <TimelineHeading
        icon={<MessagesSquareIcon className="size-3.5" />}
        at={event.at}
        url={event.url}
      >
        <span className="shrink-0 text-foreground/85">{event.actor?.login ?? "Unknown"}</span>
        {event.reviewState ? (
          <>
            <MetaSeparator />
            <span className="shrink-0">{REVIEW_STATE_WORDS[event.reviewState]}</span>
          </>
        ) : null}
      </TimelineHeading>
      {/* A remark written on a diff line says nothing away from that line, so
          the timeline carries where it was written. */}
      {event.path === null ? null : (
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/55">
          {event.path}
          {event.line === null ? "" : `:${event.line}`}
        </p>
      )}
      {event.body === null ? null : (
        <div className="mt-1">
          {event.markdown ? (
            <ChatMarkdown
              text={event.body}
              cwd={detail.workspaceRoot}
              environmentId={environmentId}
              html="github"
            />
          ) : (
            <p className="whitespace-pre-wrap text-xs text-muted-foreground/75">{event.body}</p>
          )}
        </div>
      )}
      <PullRequestReactionBar
        className="mt-1.5"
        reactions={event.reactions}
        canReact={detail.capabilities.reactions}
        subjectId={event.id}
        environmentId={environmentId}
        reference={reference}
      />
    </article>
  );
}

/** A run of remarks, folded to one line until asked for. */
function TimelineCommentGroup({
  events,
  environmentId,
  reference,
  detail,
}: {
  readonly events: readonly PullRequestTimelineEvent[];
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetail;
}) {
  const [open, setOpen] = useState(false);
  const first = events[0];
  if (first === undefined) return null;
  // One remark on its own is not a group; folding it would only hide it.
  if (events.length === 1) {
    return (
      <TimelineComment
        event={first}
        environmentId={environmentId}
        reference={reference}
        detail={detail}
      />
    );
  }

  const authors = new Set(events.map((event) => event.actor?.login ?? "Unknown"));

  return (
    <div className="py-2.5" data-testid="pull-request-timeline-group">
      <button
        type="button"
        className={cn(TEXT_BUTTON_CLASS, "flex w-full min-w-0 items-center gap-1.5 text-xs")}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")}
        />
        <span className="shrink-0 text-foreground/85">{pluralize(events.length, "comment")}</span>
        <MetaSeparator />
        <span className="min-w-0 truncate">{pluralize(authors.size, "author")}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums">
          {formatRelativeTimeLabel(first.at)}
        </span>
      </button>
      {open ? (
        <div className="mt-1 flex flex-col divide-y divide-border/40 ps-5">
          {events.map((event) => (
            <TimelineComment
              key={event.id}
              event={event}
              environmentId={environmentId}
              reference={reference}
              detail={detail}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

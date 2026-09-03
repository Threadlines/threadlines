/**
 * What the pull request says about itself: the description, the check rollup,
 * who is reviewing, the conversation, and the box the reader answers in.
 */
import type {
  EnvironmentId,
  PullRequestActivity,
  PullRequestCapabilities,
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetail,
  PullRequestReaction,
  PullRequestRef,
  PullRequestReviewVerdict,
  PullRequestReviewer,
  PullRequestReviewerState,
} from "@threadlines/contracts";
import { PULL_REQUEST_COMMENT_MAX_LENGTH } from "@threadlines/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  MessagesSquareIcon,
  PencilIcon,
  TagIcon,
  UsersIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import {
  pullRequestCommentMutationOptions,
  pullRequestCommentUpdateMutationOptions,
  pullRequestReviewMutationOptions,
  pullRequestUpdateMutationOptions,
} from "../../lib/pullRequestsReactQuery";
import { openExternalUrl } from "../../lib/externalLinks";
import { cn, pluralize } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Textarea } from "../ui/textarea";
import { TooltipWrapper } from "../ui/tooltip";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import { PullRequestReviewerPicker } from "./PullRequestReviewerPicker";
import {
  CHECK_TONES,
  MetaSeparator,
  PullRequestActorAvatar,
  PullRequestLabelPill,
  REVIEW_STATE_WORDS,
  SECTION_LABEL_CLASS,
  TEXT_BUTTON_CLASS,
  TextChoice,
} from "./pullRequestPresentation";
import { formatPullRequestChecksSummary, summarizePullRequestChecks } from "./pullRequests.logic";

/** One identity for "no reactions", so a re-read does not look like a change. */
const EMPTY_REACTIONS: readonly PullRequestReaction[] = [];

export function PullRequestSummaryTab({
  environmentId,
  reference,
  detail,
  activity,
  activityPending,
  activityError,
  onRetryActivity,
  onSendToThread,
  onFixCheck,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetail;
  readonly activity: PullRequestActivity | null;
  readonly activityPending: boolean;
  readonly activityError: boolean;
  readonly onRetryActivity: () => void;
  /** Absent when a hand-off has nowhere to land, which hides the action. */
  readonly onSendToThread?: (comment: PullRequestComment) => void;
  /** Hands a failing check to an agent. Absent for the same reason. */
  readonly onFixCheck?: (check: PullRequestCheck) => void;
}) {
  const comments = activity?.comments ?? null;
  const conversation = useRef<HTMLElement | null>(null);
  const scrollToConversation = useCallback(() => {
    conversation.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  return (
    <div className="h-full min-h-0 overflow-y-auto" data-pull-request-summary-scroll>
      {/* What the host knows about this pull request, before what anyone said
          about it: who is reading it, what it is filed under, how loud the
          conversation is. */}
      <section className="px-4 py-3">
        <PullRequestMetaRow icon={<UsersIcon aria-hidden className="size-3.5" />} label="Reviewers">
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            {detail.reviewers.length === 0 ? (
              <span className="text-muted-foreground/55">No reviewers</span>
            ) : (
              detail.reviewers.map((reviewer) => (
                <PullRequestReviewerLabel key={`${reviewer.kind}:${reviewer.id}`} {...reviewer} />
              ))
            )}
          </span>
          {detail.capabilities.reviewers.request && detail.viewer.canWrite ? (
            <PullRequestReviewerPicker environmentId={environmentId} reference={reference} />
          ) : null}
        </PullRequestMetaRow>
        {/* Nothing filed under nothing is not a row worth a line of its own. */}
        {detail.labels.length > 0 ? (
          <PullRequestMetaRow icon={<TagIcon aria-hidden className="size-3.5" />} label="Labels">
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {detail.labels.map((label) => (
                <PullRequestLabelPill
                  key={label.name}
                  name={label.name}
                  color={label.color}
                  className="text-xs leading-4"
                />
              ))}
            </span>
          </PullRequestMetaRow>
        ) : null}
        <PullRequestMetaRow
          icon={<MessagesSquareIcon aria-hidden className="size-3.5" />}
          label="Comments"
        >
          <button
            type="button"
            className={cn(TEXT_BUTTON_CLASS, "min-w-0 text-left")}
            data-testid="pull-request-comment-count"
            onClick={scrollToConversation}
          >
            {comments === null ? "—" : pluralize(comments.length, "comment")}
          </button>
        </PullRequestMetaRow>
      </section>

      <PullRequestDescription
        environmentId={environmentId}
        reference={reference}
        detail={detail}
        reactions={activity?.reactions ?? EMPTY_REACTIONS}
      />

      <div className="px-4 pb-4">
        <PullRequestChecksSection checks={detail.checks} {...(onFixCheck ? { onFixCheck } : {})} />

        <section className="mt-6" ref={conversation}>
          <h3 className={SECTION_LABEL_CLASS}>Comments · {comments?.length ?? 0}</h3>
          {activityError ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground/60">
              The conversation could not be read.
              <button type="button" className={TEXT_BUTTON_CLASS} onClick={onRetryActivity}>
                Retry
              </button>
            </p>
          ) : activityPending ? (
            <div className="flex flex-col gap-2" role="status" aria-label="Loading comments">
              <Skeleton className="h-2.5 w-32 rounded-full" />
              <Skeleton className="h-2.5 w-full rounded-full" />
            </div>
          ) : comments && comments.length > 0 ? (
            <div className="flex flex-col divide-y divide-border/50">
              {comments.map((comment) => (
                <PullRequestCommentRow
                  key={comment.id}
                  comment={comment}
                  environmentId={environmentId}
                  reference={reference}
                  detail={detail}
                  {...(onSendToThread ? { onSendToThread } : {})}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground/55">No comments yet.</p>
          )}
          <PullRequestCommentComposer
            environmentId={environmentId}
            reference={reference}
            capabilities={detail.capabilities}
            canReview={detail.viewer.canReview}
          />
        </section>
      </div>
    </div>
  );
}

/**
 * One fact about the pull request as a labelled row: the icon and the word in
 * a fixed first column, so Reviewers, Labels and Comments read as a list of
 * facts rather than three sections that happen to sit together.
 */
function PullRequestMetaRow({
  icon,
  label,
  children,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid min-h-8 grid-cols-[6rem_minmax(0,1fr)] items-center gap-2 py-1.5 text-xs">
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground/70">
        {icon}
        {label}
      </span>
      <span className="flex min-w-0 items-center gap-2">{children}</span>
    </div>
  );
}

/** The colour a reviewer's verdict wears, as the dot beside their name. */
const REVIEWER_STATE_DOTS: Readonly<Record<PullRequestReviewerState, string>> = {
  approved: "bg-emerald-600 dark:bg-emerald-300/90",
  "changes-requested": "bg-destructive",
  commented: "bg-muted-foreground/60",
  dismissed: "bg-muted-foreground/40",
  pending: "bg-amber-600/90 dark:bg-amber-400/80",
};

/** A reviewer, their picture, and where they have got to, as one dot. */
function PullRequestReviewerLabel({
  login,
  kind,
  state,
  avatarUrl,
}: {
  readonly login: string;
  readonly kind: PullRequestReviewer["kind"];
  readonly state: PullRequestReviewerState;
  readonly avatarUrl: string | null;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <PullRequestActorAvatar actor={{ login, isBot: false, avatarUrl }} />
      <span className="min-w-0 truncate text-foreground/85">{login}</span>
      {kind === "team" ? <span className="shrink-0 text-muted-foreground/55">team</span> : null}
      <TooltipWrapper tooltip={REVIEW_STATE_WORDS[state]}>
        <span className="shrink-0">
          <span
            aria-hidden
            className={cn("block size-2 rounded-full", REVIEWER_STATE_DOTS[state])}
          />
          <span className="sr-only">{REVIEW_STATE_WORDS[state]}</span>
        </span>
      </TooltipWrapper>
    </span>
  );
}

/**
 * Whether each pull request's description is folded away, for as long as this
 * page is loaded. Module level because the panel is unmounted and remounted by
 * every tab press, and a section that reopened each time would be a section
 * that cannot be closed.
 */
const descriptionOpenByPullRequest = new Map<string, boolean>();

/**
 * The description, and the pencil that rewrites it. Offered to whoever the host
 * lets rewrite it: its author, and anyone with push access on the repository.
 * Open to begin with and foldable, because a long template pushes the checks
 * and the conversation off the screen.
 */
function PullRequestDescription({
  environmentId,
  reference,
  detail,
  reactions,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetail;
  /** The description's own reactions, which the host files under the pull request. */
  readonly reactions: readonly PullRequestReaction[];
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const sectionKey = `${environmentId}/${reference.projectId}/${reference.repository}#${reference.number}`;
  const [open, setOpen] = useState(() => descriptionOpenByPullRequest.get(sectionKey) ?? true);
  const update = useMutation(
    pullRequestUpdateMutationOptions({ environmentId, reference, queryClient }),
  );
  const canEdit = detail.capabilities.edit.pullRequest && detail.viewer.canManage;

  return (
    <section className="group/description group/reactions border-t border-border/60 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium">
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm transition-colors hover:text-foreground focus-ring"
            aria-expanded={open}
            data-testid="pull-request-description-toggle"
            onClick={() => {
              descriptionOpenByPullRequest.set(sectionKey, !open);
              setOpen(!open);
            }}
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3.5 transition-transform", open ? "" : "-rotate-90")}
            />
            Description
          </button>
        </h3>
        {canEdit && !editing ? (
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 transition-opacity group-hover/description:opacity-100 group-focus-within/description:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
            tooltip="Edit description"
            aria-label="Edit description"
            data-testid="pull-request-edit-description"
            onClick={() => setEditing(true)}
          >
            <PencilIcon />
          </Button>
        ) : null}
      </div>
      {/* Folded away, the heading is the whole section. An edit in flight
          keeps it open: nobody folds away the words they are writing. */}
      {open || editing ? (
        <>
          {editing ? (
            <PullRequestMarkdownEditor
              className="mt-2"
              allowEmpty
              value={detail.body}
              cwd={detail.workspaceRoot}
              environmentId={environmentId}
              label="Edit description"
              placeholder="Say what this change does"
              saving={update.isPending}
              onCancel={() => setEditing(false)}
              onSave={(body) => update.mutate({ body }, { onSuccess: () => setEditing(false) })}
            />
          ) : (
            <div className="mt-2">
              <ChatMarkdown
                text={detail.body.trim().length > 0 ? detail.body : "_No description._"}
                cwd={detail.workspaceRoot}
                environmentId={environmentId}
                html="github"
              />
            </div>
          )}
          {/* The editor above stays open on a refusal, so the words are still there
          to try again with; this says why the host would not take them. */}
          {update.isError ? (
            <p role="alert" className="mt-1.5 break-words text-xs text-destructive">
              {update.error instanceof Error && update.error.message.trim().length > 0
                ? update.error.message
                : "That could not be saved."}
            </p>
          ) : null}
          <PullRequestReactionBar
            className="mt-2"
            reactions={reactions}
            canReact={detail.capabilities.reactions}
            environmentId={environmentId}
            reference={reference}
          />
        </>
      ) : null}
    </section>
  );
}

/**
 * Sixteen green checks are one line, not sixteen rows. Only what is failing or
 * still running earns a row of its own; the whole list is a toggle away. While
 * anything runs the detail query polls, so the rows update on their own.
 */
function PullRequestChecksSection({
  checks,
  onFixCheck,
}: {
  readonly checks: readonly PullRequestCheck[];
  readonly onFixCheck?: (check: PullRequestCheck) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const summary = useMemo(() => summarizePullRequestChecks(checks), [checks]);
  const tone =
    summary.state === "none"
      ? null
      : CHECK_TONES[summary.state === "success" ? "success" : summary.state];
  const rows = showAll ? checks : summary.attention;

  return (
    // Named so the header's rollup, which counts the same checks, can bring
    // the reader down to the rows behind its phrase.
    <section className="mt-6" data-pull-request-checks>
      <h3 className={SECTION_LABEL_CLASS}>Checks · {summary.total}</h3>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {tone ? (
          <span className={cn("shrink-0", tone.className)}>
            <tone.Icon aria-hidden className="size-3.5" />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-muted-foreground/70">
          {formatPullRequestChecksSummary(summary)}
        </span>
        {summary.total > summary.attention.length ? (
          <button
            type="button"
            className={cn(TEXT_BUTTON_CLASS, "shrink-0 text-xs")}
            aria-expanded={showAll}
            onClick={() => setShowAll((previous) => !previous)}
          >
            {showAll ? "Hide" : `Show all ${summary.total}`}
          </button>
        ) : null}
      </div>
      {rows.length > 0 ? (
        <div className="mt-1 flex flex-col divide-y divide-border/50">
          {rows.map((check) => (
            <PullRequestCheckRow
              key={check.name}
              check={check}
              {...(onFixCheck ? { onFixCheck } : {})}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function PullRequestCheckRow({
  check,
  onFixCheck,
}: {
  readonly check: PullRequestCheck;
  readonly onFixCheck?: (check: PullRequestCheck) => void;
}) {
  const tone = CHECK_TONES[check.status];
  return (
    <div className="group/pr-check flex min-w-0 items-center gap-2 py-1.5 text-xs">
      <span className={cn("shrink-0", tone.className)}>
        <tone.Icon aria-hidden className="size-3.5" />
        <span className="sr-only">{check.status}</span>
      </span>
      <span className="min-w-0 max-w-[60%] truncate text-foreground/85">{check.name}</span>
      {check.description ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground/55">
          {check.description}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      {/* Only a red row: a passing check is not a finding to hand anyone. */}
      {onFixCheck && check.status === "failure" ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="opacity-0 transition-opacity group-hover/pr-check:opacity-100 group-focus-within/pr-check:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          tooltip="Fix this finding"
          aria-label={`Fix ${check.name} with an agent`}
          data-testid="pull-request-fix-check"
          onClick={() => onFixCheck(check)}
        >
          <WandSparklesIcon />
        </Button>
      ) : null}
      {check.url ? (
        <Button
          variant="ghost"
          size="icon-xs"
          tooltip="Open check"
          aria-label={`Open ${check.name}`}
          onClick={() => openExternalUrl(check.url ?? "")}
        >
          <ExternalLinkIcon />
        </Button>
      ) : null}
    </div>
  );
}

function PullRequestCommentRow({
  comment,
  environmentId,
  reference,
  detail,
  onSendToThread,
}: {
  readonly comment: PullRequestComment;
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetail;
  readonly onSendToThread?: (comment: PullRequestComment) => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const update = useMutation(
    pullRequestCommentUpdateMutationOptions({ environmentId, reference, queryClient }),
  );
  // A review's summary is not a kind any host rewrites; only a plain remark is.
  const canEdit =
    detail.capabilities.edit.comment && comment.viewerIsAuthor && comment.kind === "issue-comment";

  return (
    <article className="group/pr-comment group/reactions py-3 first:pt-0">
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/60">
        <span className="min-w-0 truncate text-foreground/85">
          {comment.author?.login ?? "Unknown"}
        </span>
        <MetaSeparator />
        <span className="shrink-0 font-mono text-[11px] tabular-nums">
          {formatRelativeTimeLabel(comment.createdAt)}
        </span>
        {comment.reviewState ? (
          <>
            <MetaSeparator />
            <span className="shrink-0">{REVIEW_STATE_WORDS[comment.reviewState]}</span>
          </>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center">
          {canEdit && !editing ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 transition-opacity group-hover/pr-comment:opacity-100 group-focus-within/pr-comment:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              tooltip="Edit"
              aria-label="Edit comment"
              onClick={() => setEditing(true)}
            >
              <PencilIcon />
            </Button>
          ) : null}
          {/* Touch has no hover, and there is room at the end of the line here,
              so the action simply stays visible there. A review is a finding an
              agent can act on; a plain remark is only words to pass along. */}
          {onSendToThread ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 transition-opacity group-hover/pr-comment:opacity-100 group-focus-within/pr-comment:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              tooltip={comment.kind === "review" ? "Fix this finding" : "Send to thread"}
              aria-label={comment.kind === "review" ? "Fix this finding" : "Send to thread"}
              data-testid={
                comment.kind === "review" ? "pull-request-fix-comment" : "pull-request-send-comment"
              }
              onClick={() => onSendToThread(comment)}
            >
              {comment.kind === "review" ? <WandSparklesIcon /> : <MessagesSquareIcon />}
            </Button>
          ) : null}
        </span>
      </div>
      {editing ? (
        <PullRequestMarkdownEditor
          className="mt-1.5"
          rows={4}
          value={comment.body}
          cwd={detail.workspaceRoot}
          environmentId={environmentId}
          label="Edit comment"
          saving={update.isPending}
          onCancel={() => setEditing(false)}
          onSave={(body) =>
            update.mutate(
              { commentId: comment.id, kind: "issue-comment", body },
              { onSuccess: () => setEditing(false) },
            )
          }
        />
      ) : null}
      {/* A refused rewrite leaves the editor open with the words in it, so the
          reason belongs beside them rather than in place of them. */}
      {update.isError ? (
        <p role="alert" className="mt-1.5 break-words text-xs text-destructive">
          {update.error instanceof Error && update.error.message.trim().length > 0
            ? update.error.message
            : "That could not be saved."}
        </p>
      ) : null}
      {editing ? null : comment.body.trim().length > 0 ? (
        <div className="mt-1">
          <ChatMarkdown
            text={comment.body}
            cwd={detail.workspaceRoot}
            environmentId={environmentId}
            html="github"
          />
        </div>
      ) : null}
      <PullRequestReactionBar
        className="mt-1.5"
        reactions={comment.reactions}
        canReact={detail.capabilities.reactions}
        subjectId={comment.id}
        environmentId={environmentId}
        reference={reference}
      />
    </article>
  );
}

/** The verdict's word on the submit button, and what the box asks for. */
const VERDICT_WORDS: Readonly<Record<PullRequestReviewVerdict, string>> = {
  comment: "Comment",
  approve: "Approve",
  "request-changes": "Request changes",
};

const VERDICT_PLACEHOLDERS: Readonly<Record<PullRequestReviewVerdict, string>> = {
  comment: "Leave a comment",
  approve: "Add a note, or approve without one",
  "request-changes": "Say what needs to change",
};

/**
 * One box for both writes. A plain comment goes through the comment call; a
 * verdict goes through the review call, which the host records as a review
 * with no line comments. Approving may be silent, so only that verdict submits
 * with an empty box.
 */
function PullRequestCommentComposer({
  environmentId,
  reference,
  capabilities,
  canReview,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly capabilities: PullRequestCapabilities;
  readonly canReview: boolean;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [verdict, setVerdict] = useState<PullRequestReviewVerdict>("comment");
  const comment = useMutation(
    pullRequestCommentMutationOptions({ environmentId, reference, queryClient }),
  );
  const review = useMutation(
    pullRequestReviewMutationOptions({ environmentId, reference, queryClient }),
  );

  // Every way this host lets the reader answer: a plain comment where it takes
  // one, and the verdicts it named, minus the ones a self-review would be
  // refused for. A single option needs no toggle to pick it.
  const options: readonly PullRequestReviewVerdict[] = [
    ...(capabilities.comment ? (["comment"] as const) : []),
    ...(canReview ? capabilities.review.verdicts.filter((entry) => entry !== "comment") : []),
  ];
  const effectiveVerdict = options.includes(verdict) ? verdict : (options[0] ?? "comment");
  const isPending = comment.isPending || review.isPending;
  const canSubmit = !isPending && (effectiveVerdict === "approve" || body.trim().length > 0);
  const submit = useCallback(() => {
    if (isPending) return;
    const trimmed = body.trim();
    if (effectiveVerdict !== "approve" && trimmed.length === 0) return;
    // Clearing on this call rather than in the shared options: the box belongs
    // to this composer, the invalidation belongs to everyone.
    const onSuccess = () => {
      setBody("");
      setVerdict("comment");
    };
    if (effectiveVerdict === "comment") {
      comment.mutate(trimmed, { onSuccess });
      return;
    }
    review.mutate({ verdict: effectiveVerdict, body: trimmed }, { onSuccess });
  }, [body, comment, effectiveVerdict, isPending, review]);

  const failure = comment.isError ? comment.error : review.isError ? review.error : null;

  // Nothing to write with: this host takes neither a comment nor a verdict.
  if (options.length === 0) {
    return null;
  }

  return (
    <div className="mt-4">
      {options.length > 1 ? (
        <TextChoice
          className="mb-2"
          label="Review verdict"
          value={effectiveVerdict}
          options={options.map((entry) => ({ value: entry, label: VERDICT_WORDS[entry] }))}
          onChange={setVerdict}
          testIdPrefix="pull-request-verdict"
        />
      ) : null}
      <Textarea
        rows={3}
        value={body}
        maxLength={PULL_REQUEST_COMMENT_MAX_LENGTH}
        placeholder={VERDICT_PLACEHOLDERS[effectiveVerdict]}
        aria-label={VERDICT_WORDS[effectiveVerdict]}
        data-testid="pull-request-comment-input"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        {failure ? (
          <span className="min-w-0 flex-1 break-words text-xs text-destructive">
            {failure instanceof Error && failure.message.trim().length > 0
              ? failure.message
              : "That could not be posted."}
          </span>
        ) : null}
        <Button
          size="xs"
          disabled={!canSubmit}
          data-testid="pull-request-comment-submit"
          onClick={submit}
        >
          {VERDICT_WORDS[effectiveVerdict]}
        </Button>
      </div>
    </div>
  );
}

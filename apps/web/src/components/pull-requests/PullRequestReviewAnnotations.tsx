/**
 * What sits on a diff line: a conversation already on the host, and a comment
 * queued for the review being written. Composing a new one uses the shared
 * diff draft box.
 */
import type {
  EnvironmentId,
  PullRequestCapabilities,
  PullRequestRef,
  PullRequestReviewThread,
} from "@threadlines/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  CircleDashedIcon,
  PencilIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { useState } from "react";

import {
  pullRequestCommentUpdateMutationOptions,
  pullRequestThreadReplyMutationOptions,
  pullRequestThreadResolutionMutationOptions,
} from "../../lib/pullRequestsReactQuery";
import { cn, pluralize } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { DiffCommentAnnotation, isCommentSubmitShortcut } from "../diffs/DiffCommentAnnotation";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { PullRequestReactionBar } from "./PullRequestReactions";
import { MetaSeparator, TEXT_BUTTON_CLASS } from "./pullRequestPresentation";
import type { PendingReviewComment } from "./pullRequestReviewStore";

/** A comment waiting to go with the rest of the review. */
export function PendingReviewCommentCard({
  comment,
  rangeLabel,
  onEdit,
  onRemove,
}: {
  readonly comment: PendingReviewComment;
  readonly rangeLabel: string;
  readonly onEdit: (body: string) => void;
  readonly onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);

  return (
    <DiffCommentAnnotation
      heading={
        <>
          <span className="shrink-0 text-foreground/70">Pending</span>
          <MetaSeparator />
          <span className="min-w-0 truncate">sent when you submit the review</span>
        </>
      }
      actions={
        editing ? null : (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              tooltip="Edit"
              aria-label="Edit this comment"
              onClick={() => {
                setDraft(comment.body);
                setEditing(true);
              }}
            >
              <PencilIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              tooltip="Discard"
              aria-label="Discard this comment"
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          </>
        )
      }
    >
      {editing ? (
        <div className="mt-1.5">
          <Textarea
            autoFocus
            size="sm"
            rows={3}
            value={draft}
            aria-label={`Comment on ${rangeLabel}`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
                return;
              }
              if (isCommentSubmitShortcut(event) && draft.trim().length > 0) {
                event.preventDefault();
                onEdit(draft.trim());
                setEditing(false);
              }
            }}
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <Button variant="ghost" size="xs" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={draft.trim().length === 0}
              onClick={() => {
                onEdit(draft.trim());
                setEditing(false);
              }}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <p className="mt-1 whitespace-pre-wrap text-[13px] leading-5">{comment.body}</p>
      )}
    </DiffCommentAnnotation>
  );
}

/**
 * One conversation on a line, with whatever this host lets the reader do to
 * it. A resolved thread is finished work, so it opens as one line and stays
 * that way until asked for.
 */
export function ReviewThreadCard({
  thread,
  environmentId,
  reference,
  workspaceRoot,
  capabilities,
  /** Shown above the conversation where it is listed away from its line. */
  showLocation = false,
  onFix,
}: {
  readonly thread: PullRequestReviewThread;
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly workspaceRoot: string;
  readonly capabilities: PullRequestCapabilities;
  readonly showLocation?: boolean;
  /** Hands this conversation to an agent. Absent where it has nowhere to land. */
  readonly onFix?: () => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(!thread.isResolved);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);

  const write = { environmentId, reference, queryClient };
  const resolution = useMutation(pullRequestThreadResolutionMutationOptions(write));
  const replyMutation = useMutation(pullRequestThreadReplyMutationOptions(write));
  const commentUpdate = useMutation(pullRequestCommentUpdateMutationOptions(write));

  const sendReply = () => {
    const body = reply.trim();
    if (body.length === 0 || replyMutation.isPending) return;
    // Cleared only once the host has it: a failed reply leaves an error and an
    // empty box otherwise, and the words have to be written again.
    replyMutation.mutate(
      { threadId: thread.id, body },
      {
        onSuccess: () => {
          setReply("");
          setReplying(false);
        },
      },
    );
  };

  const failure = resolution.error ?? replyMutation.error ?? commentUpdate.error;

  return (
    <DiffCommentAnnotation
      heading={
        <>
          <span className={cn("shrink-0", thread.isResolved && "text-success")}>
            {thread.isResolved ? (
              <CheckCircle2Icon aria-hidden className="size-3.5" />
            ) : (
              <CircleDashedIcon aria-hidden className="size-3.5" />
            )}
          </span>
          <button
            type="button"
            className={cn(TEXT_BUTTON_CLASS, "min-w-0 truncate")}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {thread.isResolved ? "Resolved" : "Open"} ·{" "}
            {pluralize(thread.comments.length, "comment")}
          </button>
          {thread.isOutdated ? (
            <>
              <MetaSeparator />
              <span className="shrink-0">outdated</span>
            </>
          ) : null}
          {showLocation ? (
            <>
              <MetaSeparator />
              <span className="min-w-0 truncate font-mono text-[11px]">
                {thread.path}
                {thread.line === null ? "" : `:${thread.line}`}
              </span>
            </>
          ) : null}
        </>
      }
      actions={
        <>
          {onFix ? (
            <Button
              variant="ghost"
              size="icon-xs"
              tooltip="Fix this finding"
              aria-label="Fix this finding with an agent"
              data-testid="pull-request-fix-thread"
              onClick={onFix}
            >
              <WandSparklesIcon />
            </Button>
          ) : null}
          {capabilities.review.resolve ? (
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground/70"
              disabled={resolution.isPending}
              data-testid="pull-request-thread-resolve"
              onClick={() =>
                resolution.mutate({ threadId: thread.id, resolved: !thread.isResolved })
              }
            >
              {thread.isResolved ? "Unresolve" : "Resolve"}
            </Button>
          ) : null}
        </>
      }
    >
      {expanded ? (
        <>
          <div className="mt-1.5 flex flex-col divide-y divide-border/40">
            {thread.comments.map((comment) => (
              <article key={comment.id} className="group/reactions py-2 first:pt-0">
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/60">
                  <span className="min-w-0 truncate text-foreground/85">
                    {comment.author?.login ?? "Unknown"}
                  </span>
                  <MetaSeparator />
                  <span className="shrink-0 font-mono text-[11px] tabular-nums">
                    {formatRelativeTimeLabel(comment.createdAt)}
                  </span>
                  {capabilities.edit.comment &&
                  comment.viewerIsAuthor &&
                  editingId !== comment.id ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="ml-auto opacity-0 transition-opacity group-hover/diff-comment:opacity-100 group-focus-within/diff-comment:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                      tooltip="Edit"
                      aria-label="Edit comment"
                      onClick={() => setEditingId(comment.id)}
                    >
                      <PencilIcon />
                    </Button>
                  ) : null}
                </div>
                {editingId === comment.id ? (
                  <PullRequestMarkdownEditor
                    className="mt-1.5"
                    rows={3}
                    value={comment.body}
                    cwd={workspaceRoot}
                    environmentId={environmentId}
                    label="Edit comment"
                    saving={commentUpdate.isPending}
                    onCancel={() => setEditingId(null)}
                    onSave={(body) =>
                      commentUpdate.mutate(
                        { commentId: comment.id, kind: "review-comment", body },
                        { onSuccess: () => setEditingId(null) },
                      )
                    }
                  />
                ) : (
                  <div className="mt-1 text-[13px]">
                    <ChatMarkdown
                      text={comment.body}
                      cwd={workspaceRoot}
                      environmentId={environmentId}
                      html="github"
                    />
                  </div>
                )}
                <PullRequestReactionBar
                  className="mt-1.5"
                  reactions={comment.reactions}
                  canReact={capabilities.reactions}
                  subjectId={comment.id}
                  environmentId={environmentId}
                  reference={reference}
                />
              </article>
            ))}
          </div>

          {capabilities.review.reply ? (
            replying ? (
              <div className="mt-2">
                <Textarea
                  autoFocus
                  size="sm"
                  rows={2}
                  value={reply}
                  placeholder="Reply"
                  aria-label="Reply to this conversation"
                  data-testid="pull-request-thread-reply-input"
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setReplying(false);
                      return;
                    }
                    if (isCommentSubmitShortcut(event)) {
                      event.preventDefault();
                      sendReply();
                    }
                  }}
                />
                <div className="mt-1.5 flex justify-end gap-1.5">
                  <Button variant="ghost" size="xs" onClick={() => setReplying(false)}>
                    Cancel
                  </Button>
                  <Button
                    size="xs"
                    disabled={replyMutation.isPending || reply.trim().length === 0}
                    onClick={sendReply}
                  >
                    Reply
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                className="mt-1.5 px-1 text-muted-foreground/70"
                onClick={() => setReplying(true)}
              >
                Reply
              </Button>
            )
          ) : null}
        </>
      ) : null}
      {/* The reply box and the comment editor both stay open on a refusal, so
          the words survive it and this says what went wrong beside them. */}
      {failure ? (
        <p role="alert" className="mt-1.5 break-words text-xs text-destructive">
          {failure instanceof Error && failure.message.trim().length > 0
            ? failure.message
            : "The host refused that."}
        </p>
      ) : null}
    </DiffCommentAnnotation>
  );
}

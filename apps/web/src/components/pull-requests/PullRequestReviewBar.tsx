/**
 * The review being written, at the foot of the Code tab: how many line
 * comments it is holding, its summary, and the verdict that sends the lot in
 * one request. It appears once there is something to send and goes away again
 * when the host has taken it.
 */
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewVerdict,
} from "@threadlines/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { pullRequestReviewMutationOptions } from "../../lib/pullRequestsReactQuery";
import { pluralize } from "../../lib/utils";
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
import { Textarea } from "../ui/textarea";
import {
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
} from "./pullRequestReviewStore";

/** The verdict's word on its own button, in the order a reviewer meets them. */
const VERDICT_ORDER: readonly PullRequestReviewVerdict[] = [
  "comment",
  "approve",
  "request-changes",
];

const VERDICT_WORDS: Readonly<Record<PullRequestReviewVerdict, string>> = {
  comment: "Comment",
  approve: "Approve",
  "request-changes": "Request changes",
};

export function PullRequestReviewBar({
  environmentId,
  reference,
  verdicts,
  canReview,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  /** What the host takes at all; the viewer's own permission narrows it further. */
  readonly verdicts: readonly PullRequestReviewVerdict[];
  readonly canReview: boolean;
}) {
  const queryClient = useQueryClient();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const reviewKey = pullRequestReviewKey(environmentId, reference);
  const comments = usePendingReviewComments(environmentId, reference);
  // Keyed beside the comments rather than held as state, so the panel showing
  // another pull request draws the right summary on its first render.
  const summary = usePullRequestReviewStore((store) => store.summaries[reviewKey] ?? "");
  const setSummary = usePullRequestReviewStore((store) => store.setSummary);
  const clearSubmitted = usePullRequestReviewStore((store) => store.clearSubmitted);
  const discard = usePullRequestReviewStore((store) => store.discard);
  const review = useMutation(
    pullRequestReviewMutationOptions({ environmentId, reference, queryClient }),
  );

  // A host refuses a self-review, so an author may still leave remarks but not
  // a verdict on them.
  const offered = VERDICT_ORDER.filter(
    (verdict) => verdicts.includes(verdict) && (canReview || verdict === "comment"),
  );
  if (offered.length === 0 || (comments.length === 0 && summary.trim().length === 0)) {
    return null;
  }

  const submit = (verdict: PullRequestReviewVerdict) => {
    if (review.isPending) return;
    const submittedSummary = summary;
    const submittedComments = comments;
    review.mutate(
      { verdict, body: submittedSummary, comments: submittedComments },
      {
        onSuccess: () => {
          // More remarks may have been added while the host was accepting this
          // snapshot; those, and a summary revised since, are the next review.
          clearSubmitted(
            reviewKey,
            submittedComments.map((comment) => comment.id),
            submittedSummary,
          );
        },
      },
    );
  };

  // An approval needs no words; anything else does, unless it carries line
  // comments instead.
  const canSubmit = (verdict: PullRequestReviewVerdict) =>
    !review.isPending &&
    (verdict === "approve" || summary.trim().length > 0 || comments.length > 0);

  // Unsent work with no way back, so the dialog names what goes rather than
  // asking to confirm in the abstract.
  const discardWarning =
    comments.length === 0
      ? "Your summary will be lost."
      : summary.trim().length === 0
        ? `${pluralize(comments.length, "line comment")} will be lost.`
        : `${pluralize(comments.length, "line comment")} and your summary will be lost.`;

  return (
    <div
      className="shrink-0 border-t border-border bg-background px-4 py-2.5"
      data-testid="pull-request-review-bar"
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground/70">
        <span data-testid="pull-request-review-bar-count">
          {comments.length === 0 ? "No line comments" : pluralize(comments.length, "comment")}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto text-muted-foreground/70"
          disabled={review.isPending}
          data-testid="pull-request-review-bar-discard"
          onClick={() => setConfirmingDiscard(true)}
        >
          Discard
        </Button>
      </div>
      <Textarea
        size="sm"
        rows={1}
        className="mt-1.5 [&_[data-slot=textarea]]:min-h-8"
        value={summary}
        placeholder="Summarize your review"
        aria-label="Review summary"
        data-testid="pull-request-review-summary"
        onChange={(event) => setSummary(reviewKey, event.target.value)}
      />
      <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        {review.isError ? (
          <span className="min-w-0 flex-1 break-words text-xs text-destructive">
            {review.error instanceof Error && review.error.message.trim().length > 0
              ? review.error.message
              : "That review could not be sent."}
          </span>
        ) : null}
        {offered.map((verdict) => (
          <Button
            key={verdict}
            size="xs"
            variant={verdict === "comment" ? "outline" : "default"}
            disabled={!canSubmit(verdict)}
            data-testid={`pull-request-review-bar-${verdict}`}
            onClick={() => submit(verdict)}
          >
            {VERDICT_WORDS[verdict]}
          </Button>
        ))}
      </div>

      {confirmingDiscard ? (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirmingDiscard(false);
          }}
        >
          <AlertDialogPopup className="max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle>Discard this review?</AlertDialogTitle>
              <AlertDialogDescription>{discardWarning}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              {/* Cancel takes the focus, so a stray Enter on the dialog keeps
                  the review rather than throwing it away. */}
              <AlertDialogClose
                render={<Button data-alert-dialog-primary-action="true" variant="outline" />}
              >
                Cancel
              </AlertDialogClose>
              <Button
                variant="destructive"
                data-testid="pull-request-review-bar-discard-confirm"
                onClick={() => {
                  setConfirmingDiscard(false);
                  discard(reviewKey);
                }}
              >
                Discard
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
    </div>
  );
}

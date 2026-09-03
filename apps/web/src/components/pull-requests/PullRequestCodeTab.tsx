/**
 * The pull request's patch, with the review written against it.
 *
 * Conversations already on the host sit under the line they were written on,
 * and a new remark joins the review being drafted rather than being posted as
 * it is typed: a review is one send, so nothing here is visible to anyone else
 * until the bar at the foot of the tab goes.
 */
import type { CodeViewDiffItem, CodeViewItem, SelectedLineRange } from "@pierre/diffs";
import type {
  EnvironmentId,
  PullRequestDetail,
  PullRequestDiffSide,
  PullRequestRef,
  PullRequestReviewPosition,
  PullRequestReviewThread,
} from "@threadlines/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { fnv1a32, getRenderablePatch } from "../../lib/diffRendering";
import { openExternalUrl } from "../../lib/externalLinks";
import { pullRequestReviewMutationOptions } from "../../lib/pullRequestsReactQuery";
import { AnnotatedDiffView } from "../diffs/AnnotatedDiffView";
import { DiffCommentDraft } from "../diffs/DiffCommentAnnotation";
import { useDiffWorkerReady } from "../diffs/useDiffWorkerReady";
import {
  buildFileDiffRenderKey,
  resolveFileDiffPath,
  resolveFileDiffPrevPath,
} from "../diffs/fileDiffPresentation";
import { PendingReviewCommentCard, ReviewThreadCard } from "./PullRequestReviewAnnotations";
import { PullRequestReviewBar } from "./PullRequestReviewBar";
import {
  PullRequestDiffSkeleton,
  SECTION_LABEL_CLASS,
  TEXT_BUTTON_CLASS,
  pullRequestHostName,
  changeRequestWord,
} from "./pullRequestPresentation";
import {
  formatPullRequestLineRangeLabel,
  pullRequestReviewPositionAnchor,
  resolvePullRequestReviewPosition,
} from "./pullRequests.logic";
import {
  nextPendingReviewCommentId,
  pullRequestReviewKey,
  usePendingReviewComments,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";

/** Everything pinned to one line of one file: what is there, and what is being added. */
interface ReviewAnnotationGroup {
  readonly threads: readonly PullRequestReviewThread[];
  readonly pending: readonly PendingReviewComment[];
  readonly draft: boolean;
}

/** The one open draft: where it hangs, and how its line reads. */
interface ReviewDraftAnchor {
  readonly fileId: string;
  readonly path: string;
  /** The path before a rename, where the host needs both to place a left-side line. */
  readonly oldPath: string | null;
  readonly position: PullRequestReviewPosition;
  readonly rangeLabel: string;
}

/** The contract's sides as the viewer names them. */
function toViewerSide(side: PullRequestDiffSide) {
  return side === "left" ? ("deletions" as const) : ("additions" as const);
}

function fromViewerSide(side: SelectedLineRange["side"]): PullRequestDiffSide {
  return side === "deletions" ? "left" : "right";
}

export function PullRequestCodeTab({
  environmentId,
  reference,
  detail,
  patch,
  truncated,
  isPending,
  isError,
  onRetry,
  threads,
  activityError,
  onRetryActivity,
  onFixThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetail;
  readonly patch: string | null;
  readonly truncated: boolean;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  /** Null while the conversation has not been read, or could not be. */
  readonly threads: readonly PullRequestReviewThread[] | null;
  readonly activityError: boolean;
  readonly onRetryActivity: () => void;
  /** Hands one conversation to an agent. Absent where it has nowhere to land. */
  readonly onFixThread?: (thread: PullRequestReviewThread) => void;
}) {
  const reviewKey = pullRequestReviewKey(environmentId, reference);
  const pendingComments = usePendingReviewComments(environmentId, reference);
  const addComment = usePullRequestReviewStore((store) => store.addComment);
  const editComment = usePullRequestReviewStore((store) => store.editComment);
  const removeComment = usePullRequestReviewStore((store) => store.removeComment);

  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedLines, setSelectedLines] = useState<{
    readonly id: string;
    readonly range: SelectedLineRange;
  } | null>(null);
  const [draft, setDraft] = useState<ReviewDraftAnchor | null>(null);

  const renderable = useMemo(() => getRenderablePatch(patch ?? undefined, "pull-request"), [patch]);
  const files = useMemo(() => (renderable?.kind === "files" ? renderable.files : []), [renderable]);
  // The pool started loading when the detail opened; on a slow connection it
  // can still be behind the patch, and the viewer draws nothing until it lands.
  const viewerReady = useDiffWorkerReady();

  const canComment =
    detail.capabilities.review.inlineComment && detail.capabilities.review.verdicts.length > 0;

  // Placing a conversation takes more than its file being in the diff: its
  // line has to fall inside a hunk that was rendered. One that does not is
  // drawn nowhere, so it is listed under the files rather than disappearing.
  const placedThreadIds = useMemo(() => {
    const placed = new Set<string>();
    if (!threads) return placed;
    for (const fileDiff of files) {
      const path = resolveFileDiffPath(fileDiff);
      for (const thread of threads) {
        if (thread.path !== path || thread.line === null || thread.isOutdated) continue;
        if (resolvePullRequestReviewPosition(fileDiff, thread.line, thread.side) !== null) {
          placed.add(thread.id);
        }
      }
    }
    return placed;
  }, [files, threads]);

  // Two different reasons a conversation is not on a line, and a reader can act
  // on only one of them: an outdated thread hung on code that has since
  // changed, while the rest are threads this patch simply did not carry (a
  // truncated diff, a file the host left out). Lumping them together would
  // call a missing file outdated.
  const strandedThreads = useMemo(() => {
    const stranded = (threads ?? []).filter((thread) => !placedThreadIds.has(thread.id));
    return {
      outdated: stranded.filter((thread) => thread.isOutdated),
      unplaced: stranded.filter((thread) => !thread.isOutdated),
    };
  }, [placedThreadIds, threads]);

  const items = useMemo<CodeViewDiffItem<ReviewAnnotationGroup>[]>(
    () =>
      files.map((fileDiff) => {
        const fileId = buildFileDiffRenderKey(fileDiff);
        const path = resolveFileDiffPath(fileDiff);
        // One annotation per line, so a line that already carries a
        // conversation shows a new comment under it rather than in place of it.
        const groups = new Map<
          string,
          { side: PullRequestDiffSide; line: number } & {
            threads: PullRequestReviewThread[];
            pending: PendingReviewComment[];
            draft: boolean;
          }
        >();
        const groupAt = (side: PullRequestDiffSide, line: number) => {
          const key = `${side}:${line}`;
          const existing = groups.get(key);
          if (existing) return existing;
          const created = { side, line, threads: [], pending: [], draft: false };
          groups.set(key, created);
          return created;
        };

        for (const thread of threads ?? []) {
          if (thread.path !== path || thread.line === null) continue;
          if (!placedThreadIds.has(thread.id)) continue;
          groupAt(thread.side, thread.line).threads.push(thread);
        }
        for (const comment of pendingComments) {
          if (comment.path !== path) continue;
          const anchor = pullRequestReviewPositionAnchor(comment.position);
          groupAt(anchor.side, anchor.line).pending.push(comment);
        }
        if (draft?.fileId === fileId) {
          const anchor = pullRequestReviewPositionAnchor(draft.position);
          groupAt(anchor.side, anchor.line).draft = true;
        }

        const collapsed = collapsedIds.has(fileId);
        const annotations = [...groups.values()].map((group) => ({
          side: toViewerSide(group.side),
          lineNumber: group.line,
          metadata: {
            threads: group.threads,
            pending: group.pending,
            draft: group.draft,
          } satisfies ReviewAnnotationGroup,
        }));
        return {
          id: fileId,
          type: "diff" as const,
          fileDiff,
          annotations,
          collapsed,
          // The viewer redraws an item only when its version changes, so
          // everything its annotations show has to be part of it. The draft's
          // words are not: that card owns them, and folding them in here would
          // rebuild the file on every keystroke.
          version: fnv1a32(
            `${collapsed ? "1" : "0"}|${annotations
              .map(
                ({ side, lineNumber, metadata }) =>
                  `${side}:${lineNumber}:${metadata.draft ? "d" : ""}:${metadata.pending
                    .map((comment) => `${comment.id}:${comment.body}`)
                    .join(",")}:${metadata.threads
                    .map(
                      (thread) =>
                        `${thread.id}:${thread.isResolved ? "r" : ""}:${thread.comments
                          .map(
                            (comment) =>
                              `${comment.id}:${comment.body}:${comment.reactions
                                .map(
                                  (reaction) =>
                                    `${reaction.content}${reaction.count}${reaction.viewerReacted ? "v" : ""}`,
                                )
                                .join("")}`,
                          )
                          .join(";")}`,
                    )
                    .join(",")}`,
              )
              .join("|")}`,
          ),
        };
      }),
    [collapsedIds, draft, files, pendingComments, placedThreadIds, threads],
  );

  const onToggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const closeDraft = useCallback(() => {
    setDraft(null);
    setSelectedLines(null);
  }, []);

  const beginComment = useCallback(
    (
      range: SelectedLineRange | null,
      context: { readonly item: CodeViewItem<ReviewAnnotationGroup> },
    ) => {
      if (!range || !canComment) return;
      const item = context.item;
      if (item.type !== "diff") return;
      const fileDiff = files.find((candidate) => buildFileDiffRenderKey(candidate) === item.id);
      if (!fileDiff) return;
      // The remark hangs on the last line of the run: the host takes one line,
      // and a range that silently lost its first line would be worse.
      const side = fromViewerSide(range.endSide ?? range.side);
      const position = resolvePullRequestReviewPosition(fileDiff, range.end, side);
      if (position === null) return;
      const path = resolveFileDiffPath(fileDiff);
      const previousPath = resolveFileDiffPrevPath(fileDiff);
      setDraft({
        fileId: item.id,
        path,
        oldPath: previousPath,
        position,
        rangeLabel: formatPullRequestLineRangeLabel(range.start, range.end),
      });
    },
    [canComment, files],
  );

  const submitDraft = useCallback(
    (body: string) => {
      if (!draft) return;
      addComment(reviewKey, {
        id: nextPendingReviewCommentId(),
        path: draft.path,
        ...(draft.oldPath === null ? {} : { oldPath: draft.oldPath }),
        position: draft.position,
        body,
      });
      closeDraft();
    },
    [addComment, closeDraft, draft, reviewKey],
  );

  const renderAnnotation = useCallback(
    (annotation: { readonly metadata: ReviewAnnotationGroup }) => (
      <div className="font-sans text-foreground">
        {annotation.metadata.threads.map((thread) => (
          <ReviewThreadCard
            // Named with the pull request too: a thread id is the host's own,
            // and two pull requests can hand out the same one.
            key={`${reference.projectId}#${reference.number}:${thread.id}`}
            thread={thread}
            environmentId={environmentId}
            reference={reference}
            workspaceRoot={detail.workspaceRoot}
            capabilities={detail.capabilities}
            {...(onFixThread ? { onFix: () => onFixThread(thread) } : {})}
          />
        ))}
        {annotation.metadata.pending.map((comment) => (
          <PendingReviewCommentCard
            key={comment.id}
            comment={comment}
            rangeLabel={`${comment.path}:${pullRequestReviewPositionAnchor(comment.position).line}`}
            onEdit={(body) => editComment(reviewKey, comment.id, body)}
            onRemove={() => removeComment(reviewKey, comment.id)}
          />
        ))}
        {annotation.metadata.draft && draft ? (
          <ReviewDraftCard
            anchor={draft}
            environmentId={environmentId}
            reference={reference}
            onCancel={closeDraft}
            onSubmit={submitDraft}
            onSent={closeDraft}
          />
        ) : null}
      </div>
    ),
    [
      closeDraft,
      detail.capabilities,
      detail.workspaceRoot,
      draft,
      editComment,
      environmentId,
      onFixThread,
      reference,
      removeComment,
      reviewKey,
      submitDraft,
    ],
  );

  const renderStrandedSection = useCallback(
    (heading: string, list: readonly PullRequestReviewThread[]) =>
      list.length === 0 ? null : (
        <section className="px-4 pt-4 pb-2">
          <h3 className={SECTION_LABEL_CLASS}>
            {heading} · {list.length}
          </h3>
          {list.map((thread) => (
            <ReviewThreadCard
              key={`${reference.projectId}#${reference.number}:${thread.id}`}
              thread={thread}
              environmentId={environmentId}
              reference={reference}
              workspaceRoot={detail.workspaceRoot}
              capabilities={detail.capabilities}
              showLocation
              {...(onFixThread ? { onFix: () => onFixThread(thread) } : {})}
            />
          ))}
        </section>
      ),
    [detail.capabilities, detail.workspaceRoot, environmentId, onFixThread, reference],
  );

  const renderFooter = useCallback(
    () =>
      strandedThreads.outdated.length === 0 && strandedThreads.unplaced.length === 0 ? null : (
        <>
          {renderStrandedSection("Outdated conversations", strandedThreads.outdated)}
          {renderStrandedSection("Other conversations", strandedThreads.unplaced)}
        </>
      ),
    [renderStrandedSection, strandedThreads],
  );

  const notices = (
    <>
      {truncated ? (
        <p className="shrink-0 px-4 pt-2 text-xs text-muted-foreground/60">
          The diff is too large to show in full.{" "}
          <button
            type="button"
            className={TEXT_BUTTON_CLASS}
            onClick={() => openExternalUrl(detail.url)}
          >
            Open on {pullRequestHostName(detail.provider)}
          </button>{" "}
          for the rest.
        </p>
      ) : null}
      {activityError ? (
        <p className="flex shrink-0 items-center gap-2 px-4 pt-2 text-xs text-muted-foreground/60">
          The conversations could not be read, so none are shown on the diff.
          <button type="button" className={TEXT_BUTTON_CLASS} onClick={onRetryActivity}>
            Retry
          </button>
        </p>
      ) : null}
    </>
  );

  // The review belongs to the pull request, not to the patch: a diff that
  // cannot be read is still one a reviewer can send remarks about, so the bar
  // survives every branch below.
  return (
    <div className="flex h-full min-h-0 flex-col">
      {isError ? (
        <p className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground/60">
          The diff could not be read.
          <button type="button" className={TEXT_BUTTON_CLASS} onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : isPending ? (
        <PullRequestDiffSkeleton label="Loading diff" />
      ) : !renderable ? (
        <p className="px-4 py-3 text-xs text-muted-foreground/55">
          This {changeRequestWord(detail.provider)} has no changes.
        </p>
      ) : (
        <>
          {notices}
          {renderable.kind === "raw" ? (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
              <p className="text-[11px] text-muted-foreground/75">{renderable.reason}</p>
              <pre className="overflow-x-auto font-mono text-[11px] leading-5 text-foreground/85">
                {renderable.text}
              </pre>
            </div>
          ) : !viewerReady ? (
            <PullRequestDiffSkeleton label="Loading diff viewer" />
          ) : (
            <AnnotatedDiffView<ReviewAnnotationGroup>
              className="min-h-0 flex-1"
              items={items}
              onToggleCollapsed={onToggleCollapsed}
              renderAnnotation={renderAnnotation}
              renderFooter={renderFooter}
              selectedLines={selectedLines}
              onSelectedLinesChange={setSelectedLines}
              onLineSelectionEnd={beginComment}
              // A stray drag must not take the open draft's place, so the
              // gesture is off until it is dealt with.
              enableLineSelection={canComment && draft === null}
            />
          )}
        </>
      )}
      <PullRequestReviewBar
        environmentId={environmentId}
        reference={reference}
        verdicts={detail.capabilities.review.verdicts}
        canReview={detail.viewer.canReview}
      />
    </div>
  );
}

/**
 * The draft on its line. It holds its own words so a keystroke redraws this
 * card rather than the whole file, and offers the one-comment shortcut beside
 * the review it would otherwise join.
 */
function ReviewDraftCard({
  anchor,
  environmentId,
  reference,
  onCancel,
  onSubmit,
  onSent,
}: {
  readonly anchor: ReviewDraftAnchor;
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly onCancel: () => void;
  readonly onSubmit: (body: string) => void;
  readonly onSent: () => void;
}) {
  const [body, setBody] = useState("");
  const queryClient = useQueryClient();
  const review = useMutation(
    pullRequestReviewMutationOptions({ environmentId, reference, queryClient }),
  );

  return (
    <>
      <DiffCommentDraft
        rangeLabel={anchor.rangeLabel}
        value={body}
        onChange={setBody}
        onCancel={onCancel}
        onSubmit={onSubmit}
        submitLabel="Add to review"
        pending={review.isPending}
        secondaryAction={{
          label: "Add single comment",
          onAction: (text) =>
            review.mutate(
              {
                verdict: "comment",
                body: "",
                comments: [
                  {
                    path: anchor.path,
                    ...(anchor.oldPath === null ? {} : { oldPath: anchor.oldPath }),
                    position: anchor.position,
                    body: text,
                  },
                ],
              },
              { onSuccess: onSent },
            ),
        }}
      />
      {review.isError ? (
        <p className="px-3 pb-2 text-xs text-destructive">
          {review.error instanceof Error && review.error.message.trim().length > 0
            ? review.error.message
            : "That comment could not be posted."}
        </p>
      ) : null}
    </>
  );
}

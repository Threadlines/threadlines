/**
 * The body of "Move threads" (MoveThreadsDialog.tsx): the computer they go
 * to, the computer's open threads (working ones first and ticked, idle ones
 * unticked, ones that can't move greyed out with why), one choice for the
 * working ones, and "Move N threads". Its own chunk, loaded the first time
 * the host shows a request.
 */
import type {
  EnvironmentId,
  ThreadId,
  ThreadMovePreviewMany,
  ThreadMovePreviewManyThread,
  ThreadMoveQueueManyResult,
  ThreadPendingMoveMode,
} from "@threadlines/contracts";
import { useEffect, useMemo, useState } from "react";

import { describeComputerLinkFailure } from "../environments/links/computerLinks";
import { requireThreadMovesClient } from "../environments/links/threadMoves";
import { useInboxThreads } from "../hooks/useInboxThreads";
import { rememberMoveBatch } from "../moveBatchProgress";
import { cn } from "../lib/utils";
import { isSidebarThreadRunning } from "../store";
import {
  describeMoveCandidate,
  isThreadMoveTargetPickable,
  listMoveCandidates,
  type MoveCandidate,
  orderMoveCandidates,
  pickDefaultMoveTarget,
  threadMoveStopNowRefusal,
} from "../threadMove";
import type { MoveThreadsDialogRequest } from "./MoveThreadsDialog";
import { closeMoveThreadsDialog } from "./MoveThreadsDialog";
import { useComputerLabel } from "./sidebar/linkedComputers";
import { MoveWhenField, TargetField } from "./ThreadMoveDialogContent";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

type PreviewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: ThreadMovePreviewMany }
  | { readonly status: "failed"; readonly message: string };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function MoveThreadsDialogContent({ request }: { request: MoveThreadsDialogRequest }) {
  const { sourceEnvironmentId } = request;
  const sourceLabel = useComputerLabel()(sourceEnvironmentId, sourceEnvironmentId);
  const { entries } = useInboxThreads();
  // The list as it was when the dialog opened: rows don't jump while the
  // user ticks them, even as threads start and finish.
  const [candidates] = useState(() =>
    listMoveCandidates(entries, sourceEnvironmentId, isSidebarThreadRunning),
  );
  const [previewState, setPreviewState] = useState<PreviewState>({ status: "loading" });
  const [targetId, setTargetId] = useState<EnvironmentId | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<ThreadId>>(() => new Set());
  const [pickedMode, setMode] = useState<ThreadPendingMoveMode>("when-done");
  const [queueing, setQueueing] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [refused, setRefused] = useState<ThreadMoveQueueManyResult["refused"] | null>(null);

  useEffect(() => {
    if (candidates.length === 0) return;
    let active = true;
    void (async () => {
      try {
        const preview = await requireThreadMovesClient(
          sourceEnvironmentId,
          sourceLabel,
        ).previewMany({ threadIds: candidates.map((candidate) => candidate.threadId) });
        if (!active) return;
        const target =
          preview.targets.find(
            (candidate) =>
              candidate.environmentId === request.targetEnvironmentId &&
              isThreadMoveTargetPickable(candidate),
          ) ?? pickDefaultMoveTarget(preview.targets);
        setTargetId(target?.environmentId ?? null);
        // Working ones that can go come ticked; idle ones wait for the user.
        setTicked(
          new Set(
            preview.threads
              .filter(
                (thread) =>
                  (thread.waitsFor ?? []).length > 0 &&
                  describeMoveCandidate(thread, target?.environmentId ?? null).kind !== "refused",
              )
              .map((thread) => thread.threadId),
          ),
        );
        setPreviewState({ status: "ready", preview });
      } catch (error) {
        if (!active) return;
        setPreviewState({
          status: "failed",
          message: describeComputerLinkFailure(error, `${sourceLabel} didn't answer.`),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [candidates, request.targetEnvironmentId, sourceEnvironmentId, sourceLabel]);

  const preview = previewState.status === "ready" ? previewState.preview : null;
  const target = preview?.targets.find((candidate) => candidate.environmentId === targetId) ?? null;
  const previewById = useMemo(
    () =>
      new Map<string, ThreadMovePreviewManyThread>(
        (preview?.threads ?? []).map((thread) => [thread.threadId, thread] as const),
      ),
    [preview],
  );
  const rows = useMemo(
    () =>
      orderMoveCandidates(candidates, previewById).flatMap((candidate) => {
        const threadPreview = previewById.get(candidate.threadId);
        return threadPreview
          ? [
              {
                candidate,
                preview: threadPreview,
                words: describeMoveCandidate(threadPreview, targetId),
              },
            ]
          : [];
      }),
    [candidates, previewById, targetId],
  );
  // What goes: the ticked rows that can go to the computer picked now.
  const chosen = rows.filter(
    (row) => row.words.kind !== "refused" && ticked.has(row.candidate.threadId),
  );
  const chosenWaits = chosen.flatMap((row) => row.preview.waitsFor ?? []);
  const workingCount = chosen.filter((row) => row.words.kind === "wait").length;
  const stopNowRefusal = threadMoveStopNowRefusal(chosenWaits, { many: true });
  const mode: ThreadPendingMoveMode =
    workingCount > 0 && stopNowRefusal === null ? pickedMode : "when-done";
  const canMove =
    target !== null && isThreadMoveTargetPickable(target) && chosen.length > 0 && !queueing;

  const toggle = (threadId: ThreadId, on: boolean) => {
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
  };

  const move = async () => {
    if (!canMove || target === null) return;
    setQueueing(true);
    setQueueError(null);
    try {
      const result = await requireThreadMovesClient(sourceEnvironmentId, sourceLabel).queueMany({
        threadIds: chosen.map((row) => row.candidate.threadId),
        targetEnvironmentId: target.environmentId,
        mode,
      });
      // Its target's Fleet row and page say how it goes, refusals included.
      rememberMoveBatch({
        sourceEnvironmentId,
        batchId: result.batchId,
        targetEnvironmentId: target.environmentId,
        targetLabel: target.label,
      });
      if (result.refused.length === 0) {
        closeMoveThreadsDialog();
        return;
      }
      // The rest are on their way; say which didn't go, and why.
      setRefused(result.refused);
      setQueueing(false);
    } catch (error) {
      setQueueError(describeComputerLinkFailure(error, `${sourceLabel} didn't answer.`));
      setQueueing(false);
    }
  };

  const titleOf = (threadId: ThreadId) =>
    candidates.find((candidate) => candidate.threadId === threadId)?.title ?? "A thread";

  return (
    <DialogPopup className="max-w-lg" data-testid="move-threads-dialog">
      <DialogHeader>
        <DialogTitle>Move threads</DialogTitle>
        <DialogDescription>
          Threads on {sourceLabel} go with their messages and code changes. Your copies here stay,
          read-only.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {refused !== null ? (
          <div className="space-y-1.5" data-testid="move-threads-refused">
            <p className="text-sm text-foreground">
              {chosen.length - refused.length > 0
                ? `${plural(chosen.length - refused.length, "thread is", "threads are")} on the way to ${target?.label ?? "the other computer"}. These didn't go:`
                : "None of them could go:"}
            </p>
            <ul className="space-y-1">
              {refused.map((miss) => (
                <li key={miss.threadId} className="text-[13px] leading-[18px]">
                  <span className="text-foreground">{titleOf(miss.threadId)}</span>
                  <span className="block text-[12.5px] text-muted-foreground">{miss.words}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-foreground" data-testid="move-threads-none">
            {sourceLabel} has no open threads to move.
          </p>
        ) : previewState.status === "loading" ? (
          <p className="text-sm text-muted-foreground" data-testid="move-threads-loading">
            Checking where they can go…
          </p>
        ) : previewState.status === "failed" ? (
          <p role="alert" className="text-sm text-destructive" data-testid="move-threads-error">
            {previewState.message}
          </p>
        ) : preview && preview.targets.length === 0 ? (
          <p className="text-sm text-foreground" data-testid="move-threads-no-target">
            No linked computer can take them right now.
          </p>
        ) : preview ? (
          <>
            <TargetField
              targets={preview.targets}
              target={target}
              disabled={queueing}
              onChange={(next) => {
                setTargetId(next.environmentId);
                setQueueError(null);
              }}
            />
            {target?.refusal !== undefined && target.unreachable !== true ? (
              <p className="text-sm text-foreground" data-testid="move-threads-target-refusal">
                {target.refusal}
              </p>
            ) : (
              <>
                <CandidateList rows={rows} ticked={ticked} disabled={queueing} onToggle={toggle} />
                {workingCount > 0 && target !== null ? (
                  <MoveWhenField
                    many
                    label={target.label}
                    doing={
                      workingCount === 1
                        ? "One of these agents is still working."
                        : `${workingCount} of these agents are still working.`
                    }
                    mode={mode}
                    stopNowRefusal={stopNowRefusal}
                    disabled={queueing}
                    onChange={setMode}
                  />
                ) : null}
                {target?.unreachable === true ? (
                  <p className="text-xs text-muted-foreground" data-testid="move-threads-waits">
                    {target.refusal} The moves wait for it to connect.
                  </p>
                ) : null}
                {target?.access === "ask" ? (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="move-threads-asks-first"
                  >
                    {target.label} asks its user first.
                  </p>
                ) : null}
              </>
            )}
          </>
        ) : null}
        {queueError !== null ? (
          <p
            role="alert"
            className="text-sm text-destructive"
            data-testid="move-threads-queue-error"
          >
            {queueError}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {refused !== null ? (
          <Button onClick={closeMoveThreadsDialog} data-testid="move-threads-done">
            Done
          </Button>
        ) : (
          <>
            <Button variant="outline" onClick={closeMoveThreadsDialog}>
              Cancel
            </Button>
            <Button
              disabled={!canMove}
              onClick={() => void move()}
              data-testid="move-threads-confirm"
            >
              {queueing
                ? "Moving…"
                : chosen.length === 0
                  ? "Move threads"
                  : `Move ${plural(chosen.length, "thread", "threads")}`}
            </Button>
          </>
        )}
      </DialogFooter>
    </DialogPopup>
  );
}

/** The computer's open threads, each with a tick and what moving it means. */
function CandidateList({
  rows,
  ticked,
  disabled,
  onToggle,
}: {
  readonly rows: ReadonlyArray<{
    readonly candidate: MoveCandidate<ThreadId>;
    readonly words: ReturnType<typeof describeMoveCandidate>;
  }>;
  readonly ticked: ReadonlySet<ThreadId>;
  readonly disabled: boolean;
  readonly onToggle: (threadId: ThreadId, on: boolean) => void;
}) {
  return (
    <ul
      className="surface-group max-h-72 overflow-y-auto py-1"
      aria-label="Threads"
      data-testid="move-threads-list"
    >
      {rows.map(({ candidate, words }) => {
        const refused = words.kind === "refused";
        return (
          <li key={candidate.threadId} data-testid={`move-threads-row-${candidate.threadId}`}>
            <label
              className={cn(
                "flex items-start gap-2.5 px-3.5 py-1.5",
                refused ? "cursor-default" : "cursor-pointer",
              )}
            >
              <Checkbox
                className="mt-0.5"
                checked={!refused && ticked.has(candidate.threadId)}
                disabled={refused || disabled}
                onCheckedChange={(checked) => onToggle(candidate.threadId, checked === true)}
                data-testid={`move-threads-tick-${candidate.threadId}`}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate text-[13.5px] leading-[19px]",
                    refused ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {candidate.title}
                </span>
                <span
                  className="block text-[12.5px] leading-[18px] text-muted-foreground"
                  data-testid={`move-threads-words-${candidate.threadId}`}
                >
                  {words.words}
                </span>
                {words.session !== undefined ? (
                  <span
                    className="block text-[12.5px] leading-[18px] text-muted-foreground"
                    data-testid={`move-threads-session-${candidate.threadId}`}
                  >
                    {words.session}
                  </span>
                ) : null}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

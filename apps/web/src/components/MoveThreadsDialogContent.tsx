/**
 * The body of "Move threads" (MoveThreadsDialog.tsx): the computer they go
 * to, the computer's open threads (working ones first and ticked, idle ones
 * unticked, ones that can't move greyed out with why, each with what comes
 * along), one choice for the working ones, and "Move N threads". Its own chunk, loaded the first time
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
import {
  requireThreadMovesClient,
  useThreadMoveStateSupported,
} from "../environments/links/threadMoves";
import { useInboxThreads } from "../hooks/useInboxThreads";
import { rememberMoveBatch } from "../moveBatchProgress";
import { cn } from "../lib/utils";
import { isSidebarThreadRunning } from "../store";
import {
  describeMoveCandidate,
  groupMoveFamilies,
  isThreadMoveTargetPickable,
  listMoveCandidates,
  type MoveCandidate,
  orderMoveCandidates,
  pickDefaultMoveTarget,
  threadMoveStopNowRefusal,
  toggleMoveFamily,
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
  const { entries, generalChatEntries } = useInboxThreads();
  // General Chats threads go too where the computer moves them (Part 3e).
  const movesGeneralChats = useThreadMoveStateSupported(sourceEnvironmentId);
  // The list as it was when the dialog opened: rows don't jump while the
  // user ticks them, even as threads start and finish.
  const [candidates] = useState(() =>
    listMoveCandidates(
      entries,
      movesGeneralChats ? generalChatEntries : [],
      sourceEnvironmentId,
      isSidebarThreadRunning,
    ),
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
        // Working ones that can go come ticked, each with its family (Part
        // 3f, (g)); idle ones wait for the user.
        const canGo = (threadId: ThreadId) => {
          const thread = preview.threads.find((entry) => entry.threadId === threadId);
          return (
            thread !== undefined &&
            describeMoveCandidate(thread, target?.environmentId ?? null).kind !== "refused"
          );
        };
        setTicked(
          preview.threads
            .filter((thread) => (thread.waitsFor ?? []).length > 0 && canGo(thread.threadId))
            .reduce<ReadonlySet<ThreadId>>(
              (ticks, thread) => toggleMoveFamily(ticks, candidates, thread.threadId, true, canGo),
              new Set(),
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
  // Each family together, a parent's children under it (Part 3f, (g)).
  const rows = useMemo(
    () =>
      groupMoveFamilies(orderMoveCandidates(candidates, previewById)).flatMap(
        ({ candidate, depth }) => {
          const threadPreview = previewById.get(candidate.threadId);
          return threadPreview
            ? [
                {
                  candidate,
                  depth,
                  preview: threadPreview,
                  words: describeMoveCandidate(threadPreview, targetId, target?.label),
                },
              ]
            : [];
        },
      ),
    [candidates, previewById, targetId, target?.label],
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

  // A family moves as one group: ticking any member ticks all of it that can
  // go, and its members can be unticked one by one (they stay here).
  const toggle = (threadId: ThreadId, on: boolean) => {
    const canGo = (id: ThreadId) =>
      rows.some((row) => row.candidate.threadId === id && row.words.kind !== "refused");
    setTicked((current) => toggleMoveFamily(current, candidates, threadId, on, canGo));
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
        // Exactly the threads ticked: a parent's unticked children stay here.
        familySelection: "explicit",
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
          Threads on {sourceLabel} go with their messages, and code changes or a chat's files. Your
          copies here stay, read-only.
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
    /** 1: a child, under its parent. */
    readonly depth: 0 | 1;
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
      {rows.map(({ candidate, depth, words }) => {
        const refused = words.kind === "refused";
        return (
          <li key={candidate.threadId} data-testid={`move-threads-row-${candidate.threadId}`}>
            <label
              className={cn(
                "flex items-start gap-2.5 py-1.5 pr-3.5",
                depth === 1 ? "pl-9" : "pl-3.5",
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
                {words.landing !== undefined ? (
                  <span
                    className="block text-[12.5px] leading-[18px] text-muted-foreground"
                    data-testid={`move-threads-landing-${candidate.threadId}`}
                  >
                    {words.landing}
                  </span>
                ) : null}
                {words.session !== undefined ? (
                  <span
                    className="block text-[12.5px] leading-[18px] text-muted-foreground"
                    data-testid={`move-threads-session-${candidate.threadId}`}
                  >
                    {words.session}
                  </span>
                ) : null}
                {(words.brings ?? []).map((line) => (
                  <span
                    key={line}
                    className="block text-[12.5px] leading-[18px] text-muted-foreground"
                    data-testid={`move-threads-brings-${candidate.threadId}`}
                  >
                    {line}
                  </span>
                ))}
                {(words.notes ?? []).map((line) => (
                  <span
                    key={line}
                    className="block text-[12.5px] leading-[18px] text-foreground"
                    data-testid={`move-threads-note-${candidate.threadId}`}
                  >
                    {line}
                  </span>
                ))}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

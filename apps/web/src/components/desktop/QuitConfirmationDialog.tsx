import {
  type DesktopQuitConfirmationRequest,
  type EnvironmentId,
  type ThreadId,
  ThreadMoveBatchId,
  type ThreadMoveBatchStatus,
  type ThreadMoveTargetPreview,
} from "@threadlines/contracts";
import { TriangleAlert } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { describeComputerLinkFailure } from "../../environments/links/computerLinks";
import {
  readThreadMovesClient,
  useThreadMoveBatchSupported,
} from "../../environments/links/threadMoves";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { rememberMoveBatch } from "../../moveBatchProgress";
import {
  type AppState,
  selectRunningSidebarThreadsByLocation,
  selectEnvironmentState,
  useStore,
} from "../../store";
import {
  countMoveBatch,
  describeMoveBatchCounts,
  isMoveBatchDone,
  moveBatchMisses,
  moveBatchNeedsYou,
} from "../../threadMove";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  describeAgentWorkElsewhere,
  describeRunningAgentSessions,
  describeStoppedScheduledTasks,
} from "./agentSessionCopy";
import { BusyTerminalsSentence } from "./BusyTerminalsSentence";
import { useBusyLocalTerminalCommands } from "./useBusyLocalTerminals";
import { useRunningAgentWork } from "./useRunningAgentWork";

/**
 * The counts are the ones the app asked with: threads and busy terminals on
 * this computer, the only work quitting stops (terminals are named from the
 * live list when it still has them), and this computer's scheduled tasks,
 * which don't run while it is closed. Work on other computers is named so
 * nobody keeps the app open for threads that run fine without it.
 */
function QuitConfirmationDescription({
  runningThreadCount,
  busyTerminalCount,
  activeScheduledTaskCount,
}: {
  runningThreadCount: number;
  busyTerminalCount: number;
  activeScheduledTaskCount: number;
}) {
  const { remoteMachineLabels } = useRunningAgentWork();
  const liveTerminals = useBusyLocalTerminalCommands();
  const elsewhere = describeAgentWorkElsewhere(remoteMachineLabels);
  const terminals =
    liveTerminals.length > 0 || busyTerminalCount <= 0
      ? liveTerminals
      : Array.from({ length: busyTerminalCount }, () => null);
  const stoppedCount = runningThreadCount + terminals.length;
  const schedules = describeStoppedScheduledTasks(activeScheduledTaskCount);
  return (
    <AlertDialogDescription>
      {runningThreadCount > 0
        ? `${describeRunningAgentSessions(runningThreadCount, elsewhere !== null)} `
        : null}
      {terminals.length > 0 ? (
        <>
          <BusyTerminalsSentence commands={terminals} onThisComputer={elsewhere !== null} />{" "}
        </>
      ) : null}
      {stoppedCount > 0
        ? `Quitting now will stop ${stoppedCount === 1 ? "it" : "them"} and the local Threadlines server.`
        : "Quitting now will stop the local Threadlines server."}
      {schedules ? ` ${schedules}` : null}
      {elsewhere ? ` ${elsewhere}` : null}
    </AlertDialogDescription>
  );
}

const NO_THREAD_IDS: readonly ThreadId[] = [];

/**
 * This computer's working threads a move can take: running here, not in
 * General Chats (which never move), not moving already.
 */
function selectWorkingMovableThreadIds(
  state: AppState,
  primaryEnvironmentId: EnvironmentId | null,
): readonly ThreadId[] {
  if (primaryEnvironmentId === null) return NO_THREAD_IDS;
  const projectById = selectEnvironmentState(state, primaryEnvironmentId).projectById;
  return selectRunningSidebarThreadsByLocation(state, primaryEnvironmentId)
    .local.filter(
      (thread) =>
        thread.environmentId === primaryEnvironmentId &&
        thread.moveStatus === undefined &&
        projectById[thread.projectId]?.kind !== "general-chat",
    )
    .map((thread) => thread.id);
}

/** The computers the working threads could go to now, as the quit dialog offers them. */
type QuitMoveOffer =
  | { readonly status: "none" }
  | {
      readonly status: "ready";
      readonly threadIds: readonly ThreadId[];
      readonly targets: readonly ThreadMoveTargetPreview[];
    };

/**
 * "Move them to <computer> and quit" (docs/design/fleet.md, Part 3c): offered
 * while this computer's agents work, when it moves several threads at once,
 * the desktop app can wait for them, and a linked computer that takes moves
 * is connected now.
 */
function useQuitMoveOffer(asking: boolean): QuitMoveOffer {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const supportsBatch = useThreadMoveBatchSupported(primaryEnvironmentId);
  const canWait = window.desktopBridge?.quitAfterMoves !== undefined;
  const enabled = asking && supportsBatch && canWait;
  const threadIds = useStore(
    useShallow((state: AppState) =>
      enabled ? selectWorkingMovableThreadIds(state, primaryEnvironmentId) : NO_THREAD_IDS,
    ),
  );
  const [offer, setOffer] = useState<QuitMoveOffer>({ status: "none" });
  // Asked when the question comes, and again when the working threads change.
  const askKey = enabled && threadIds.length > 0 ? threadIds.join("\u0000") : null;
  useEffect(() => {
    if (askKey === null || primaryEnvironmentId === null) {
      setOffer({ status: "none" });
      return;
    }
    const client = readThreadMovesClient(primaryEnvironmentId);
    if (client === null) return;
    const asked = askKey.split("\u0000") as ThreadId[];
    let active = true;
    void client
      .previewMany({ threadIds: asked })
      .then((preview) => {
        if (!active) return;
        // Connected and taking moves: a move to one can start now.
        const targets = preview.targets.filter((target) => target.refusal === undefined);
        setOffer(
          targets.length > 0 ? { status: "ready", threadIds: asked, targets } : { status: "none" },
        );
      })
      .catch(() => {
        if (active) setOffer({ status: "none" });
      });
    return () => {
      active = false;
    };
  }, [askKey, primaryEnvironmentId]);
  return offer;
}

/** The moves a quit waits for: its batch, and where they go. */
interface QuitMoves {
  readonly batchId: ThreadMoveBatchId;
  /** As offered; null for a page that picked up a wait begun before it loaded. */
  readonly target: ThreadMoveTargetPreview | null;
}

/** How often the quit's progress asks how the batch is going. */
const BATCH_STATUS_POLL_MS = 1_000;
/** How long "All moved. Quitting…" shows before the app quits. */
const ALL_MOVED_QUIT_DELAY_MS = 1_200;

/**
 * The quit dialog once the working threads are moving: how they're doing,
 * with "Stop the agents and move now", "Quit anyway" and "Cancel". It quits
 * by itself after "All moved. Quitting…" once every thread has its final
 * answer (one sent and waiting for Allow there counts) and none didn't move;
 * if any didn't, it lists them with why and waits for the user.
 */
function QuitMovesProgress({
  moves,
  onQuit,
  onKeepRunning,
}: {
  readonly moves: QuitMoves;
  readonly onQuit: () => void;
  readonly onKeepRunning: () => void;
}) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [status, setStatus] = useState<ThreadMoveBatchStatus | null>(null);
  const [busy, setBusy] = useState<"stop" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = moves.target?.label ?? status?.target.label ?? "the other computer";

  useEffect(() => {
    if (primaryEnvironmentId === null) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const client = readThreadMovesClient(primaryEnvironmentId);
      try {
        const next = client === null ? null : await client.batchStatus({ batchId: moves.batchId });
        if (!active) return;
        if (next !== null) setStatus(next);
        if (next?.final === true) return;
      } catch {
        // A missed answer is asked again on the next tick.
      }
      if (active) timer = setTimeout(() => void poll(), BATCH_STATUS_POLL_MS);
    };
    void poll();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [moves.batchId, primaryEnvironmentId]);

  const members = status?.members ?? [];
  const counts = countMoveBatch(members.map((member) => member.state));
  const done = status?.final === true && isMoveBatchDone(counts);
  const misses = moveBatchMisses(members);
  const allMoved = done && misses.length === 0;
  const needsYou = done ? [] : moveBatchNeedsYou(members);

  // A thread that didn't move, or one that waits on the user, brings the
  // window back (the wait may have hidden or minimized it), once for each
  // new such list.
  const attention =
    done && misses.length > 0
      ? `missed:${misses.map((miss) => miss.threadId).join(",")}`
      : needsYou.length > 0
        ? `needs:${needsYou.map((entry) => `${entry.threadId}:${entry.words}`).join(",")}`
        : null;
  useEffect(() => {
    if (attention === null) return;
    void window.desktopBridge?.showQuitAfterMoves?.().catch(() => undefined);
  }, [attention]);

  const quitNow = useEffectEvent(onQuit);
  useEffect(() => {
    if (!allMoved) return;
    const timer = setTimeout(() => quitNow(), ALL_MOVED_QUIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [allMoved]);

  const waiting = members.filter((member) => member.state === "waiting" && member.requestId);
  const notStarted = members.filter(
    (member) => (member.state === "waiting" || member.state === "stopping") && member.requestId,
  );

  const stopAndMove = async () => {
    if (primaryEnvironmentId === null) return;
    const client = readThreadMovesClient(primaryEnvironmentId);
    if (client === null) return;
    setBusy("stop");
    setError(null);
    try {
      await Promise.all(
        waiting.map((member) =>
          client.setMode({
            threadId: member.threadId,
            requestId: member.requestId!,
            mode: "stop-now",
          }),
        ),
      );
    } catch (cause) {
      setError(describeComputerLinkFailure(cause, "Couldn't stop the agents."));
    } finally {
      setBusy(null);
    }
  };

  // Cancels the moves that haven't started; ones under way finish.
  const cancel = async () => {
    setBusy("cancel");
    const client =
      primaryEnvironmentId === null ? null : readThreadMovesClient(primaryEnvironmentId);
    if (client !== null) {
      await Promise.allSettled(
        notStarted.map((member) =>
          client.unqueue({ threadId: member.threadId, requestId: member.requestId! }),
        ),
      );
    }
    await window.desktopBridge?.cancelQuitAfterMoves?.().catch(() => undefined);
    onKeepRunning();
  };

  const threads = members.length === 1 ? "1 thread" : `${members.length} threads`;
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>
          {allMoved
            ? "All moved. Quitting…"
            : `Moving ${status === null ? "threads" : threads} to ${label}`}
        </AlertDialogTitle>
        <AlertDialogDescription data-testid="quit-moves-progress">
          {status === null
            ? "Checking on the moves…"
            : done
              ? misses.length > 0
                ? `${counts.moved + counts.sent} of ${threads} moved.`
                : `${threads === "1 thread" ? "It" : "They"} moved to ${label}.`
              : `${describeMoveBatchCounts(counts)}.`}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div className="space-y-2 px-6 pb-2 text-[13px] leading-[19px]">
        {counts.sent > 0 ? (
          <p className="text-muted-foreground" data-testid="quit-moves-sent">
            Sent. {label} will ask its user to allow {counts.sent === 1 ? "it" : "them"}.
          </p>
        ) : null}
        {moves.target?.access === "ask" && moves.target.stagedApproval !== true && !done ? (
          <p className="text-muted-foreground" data-testid="quit-moves-waits-for-allow">
            {label} asks its user first, so quitting waits until they allow the moves there.
          </p>
        ) : null}
        {needsYou.length > 0 ? (
          <ul className="space-y-1" data-testid="quit-moves-needs-you">
            {needsYou.map((entry) => (
              <li key={entry.threadId ?? entry.title}>
                <span className="text-foreground">{entry.title}</span>
                <span className="block text-[12.5px] text-muted-foreground">{entry.words}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {done && misses.length > 0 ? (
          <div data-testid="quit-moves-misses">
            <p className="text-foreground">
              {misses.length === 1 ? "This one didn't move:" : "These didn't move:"}
            </p>
            <ul className="mt-1 space-y-1">
              {misses.map((miss) => (
                <li key={miss.threadId ?? miss.title}>
                  <span className="text-foreground">{miss.title}</span>
                  <span className="block text-[12.5px] text-muted-foreground">{miss.words}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-muted-foreground">
              Quitting stops {misses.length === 1 ? "it" : "them"} here.
            </p>
          </div>
        ) : null}
        {error !== null ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <AlertDialogFooter>
        {allMoved ? null : (
          <>
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => void cancel()}
              data-testid="quit-moves-cancel"
            >
              Cancel
            </Button>
            {!done && waiting.length > 0 ? (
              <Button
                variant="outline"
                disabled={busy !== null}
                onClick={() => void stopAndMove()}
                data-testid="quit-moves-stop-now"
              >
                Stop the agents and move now
              </Button>
            ) : null}
            <Button
              variant="destructive"
              disabled={busy === "cancel"}
              onClick={onQuit}
              data-testid="quit-moves-quit-anyway"
            >
              Quit Anyway
            </Button>
          </>
        )}
      </AlertDialogFooter>
    </>
  );
}

/**
 * Where the working threads would go: the computer (a picker when several
 * take moves), and when it asks its user first without taking the moves
 * before Allow, that quitting waits for that Allow.
 */
function QuitMoveOfferDetails({
  targets,
  target,
  disabled,
  error,
  onPick,
}: {
  readonly targets: readonly ThreadMoveTargetPreview[];
  readonly target: ThreadMoveTargetPreview;
  readonly disabled: boolean;
  readonly error: string | null;
  readonly onPick: (environmentId: EnvironmentId) => void;
}) {
  return (
    <div className="space-y-2 px-6 pb-2 text-[13px] leading-[19px]" data-testid="quit-move-offer">
      {targets.length > 1 ? (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Move them to</span>
          <Select
            value={target.environmentId}
            disabled={disabled}
            onValueChange={(value) => {
              if (value !== null) onPick(value as EnvironmentId);
            }}
          >
            <SelectTrigger size="sm" className="w-auto min-w-40" aria-label="Computer">
              <SelectValue>{target.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {targets.map((candidate) => (
                <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                  {candidate.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      {target.access === "ask" && target.stagedApproval !== true ? (
        <p className="text-muted-foreground" data-testid="quit-move-waits-for-allow">
          {target.label} asks its user first, so quitting waits until they allow the moves there.
        </p>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function QuitConfirmationDialog() {
  const [request, setRequest] = useState<DesktopQuitConfirmationRequest | null>(null);
  // Set once the working threads are on their way: a quit asked again
  // meanwhile (a second ⌘Q) shows the same progress.
  const [moves, setMoves] = useState<QuitMoves | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.onQuitConfirmationRequested) return;
    return bridge.onQuitConfirmationRequested((next) => {
      setRequest(next);
      // The app took the question back: nothing waits on these moves now.
      if (next === null) {
        setMoves(null);
        return;
      }
      // The quit already waits on moves begun before this page loaded (a
      // reload, a crash): show their progress, and answer once they're done.
      const waiting = next.quitAfterMoves;
      if (waiting !== undefined) {
        setMoves((current) =>
          current?.batchId === waiting.batchId
            ? current
            : { batchId: ThreadMoveBatchId.make(waiting.batchId), target: null },
        );
      }
    });
  }, []);

  // Keep the last question rendered while the popup animates closed, so the
  // text doesn't vanish mid-fade.
  const [renderedRequest, setRenderedRequest] = useState(request);
  if (request !== null && request !== renderedRequest) {
    setRenderedRequest(request);
  }
  const shownRequest = request ?? renderedRequest;

  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const offer = useQuitMoveOffer(request !== null && moves === null);
  const [pickedTargetId, setPickedTargetId] = useState<EnvironmentId | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const offerTarget =
    offer.status === "ready"
      ? (offer.targets.find((target) => target.environmentId === pickedTargetId) ??
        offer.targets[0] ??
        null)
      : null;

  const respond = (confirmed: boolean) => {
    if (!request) return;
    setRequest(null);
    setMoves(null);
    void window.desktopBridge?.resolveQuitConfirmation?.(confirmed).catch(() => undefined);
  };

  // Queues the working threads ("when each agent finishes"), then hands the
  // quit's wait to the desktop app and shows the progress.
  const moveAndQuit = async () => {
    const target = offerTarget;
    const bridge = window.desktopBridge;
    if (offer.status !== "ready" || target === null || primaryEnvironmentId === null) return;
    if (!bridge?.quitAfterMoves) return;
    setQueueing(true);
    setQueueError(null);
    try {
      const client = readThreadMovesClient(primaryEnvironmentId);
      if (client === null) throw new Error("This app isn't connected to this computer's server.");
      const result = await client.queueMany({
        threadIds: [...offer.threadIds],
        targetEnvironmentId: target.environmentId,
        mode: "when-done",
      });
      rememberMoveBatch({
        sourceEnvironmentId: primaryEnvironmentId,
        batchId: result.batchId,
        targetEnvironmentId: target.environmentId,
        targetLabel: target.label,
      });
      await bridge.quitAfterMoves({ batchId: result.batchId });
      setMoves({ batchId: result.batchId, target });
    } catch (error) {
      setQueueError(describeComputerLinkFailure(error, "Couldn't start the moves."));
    } finally {
      setQueueing(false);
    }
  };

  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        // While threads move, only the dialog's own buttons answer.
        if (!open && moves === null) respond(false);
      }}
    >
      <AlertDialogPopup
        // Room for a third button when the moves are offered, or run.
        className={moves !== null ? "max-w-lg" : offer.status === "ready" ? "max-w-xl" : "max-w-md"}
        data-testid="quit-confirmation-dialog"
      >
        {moves !== null ? (
          <QuitMovesProgress
            moves={moves}
            onQuit={() => respond(true)}
            onKeepRunning={() => respond(false)}
          />
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <TriangleAlert aria-hidden className="text-destructive" />
                Quit Threadlines?
              </AlertDialogTitle>
              {shownRequest ? (
                <QuitConfirmationDescription
                  runningThreadCount={shownRequest.runningThreadCount}
                  busyTerminalCount={shownRequest.busyTerminalCount ?? 0}
                  activeScheduledTaskCount={shownRequest.activeScheduledTaskCount ?? 0}
                />
              ) : null}
            </AlertDialogHeader>
            {offer.status === "ready" && offerTarget !== null ? (
              <QuitMoveOfferDetails
                targets={offer.targets}
                target={offerTarget}
                disabled={queueing}
                error={queueError}
                onPick={setPickedTargetId}
              />
            ) : null}
            <AlertDialogFooter>
              <AlertDialogClose
                render={
                  <Button data-alert-dialog-primary-action="true" variant="outline">
                    Keep Running
                  </Button>
                }
              />
              {offer.status === "ready" && offerTarget !== null ? (
                <Button
                  variant="outline"
                  disabled={queueing}
                  onClick={() => void moveAndQuit()}
                  data-testid="quit-move-and-quit"
                >
                  {queueing ? "Moving…" : `Move them to ${offerTarget.label} and quit`}
                </Button>
              ) : null}
              <Button variant="destructive" onClick={() => respond(true)}>
                Quit Anyway
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

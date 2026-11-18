/**
 * The body of "Move to another computer": where the thread can go, the agent
 * it continues with, and the move itself. Its own chunk, loaded the first
 * time ThreadMoveDialogHost shows a request (ThreadMoveDialog.tsx).
 */
import type {
  EnvironmentId,
  ModelSelection,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
  ThreadMovePreview,
  ThreadMoveTargetPreview,
  ThreadPendingMoveMode,
} from "@threadlines/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { describeComputerLinkFailure } from "../environments/links/computerLinks";
import {
  requireThreadMovesClient,
  useThreadMoveQueueSupported,
} from "../environments/links/threadMoves";
import {
  useProjectSetupComputerReady,
  useProjectSetupTargets,
} from "../environments/projectSetups/projectSetupTargets";
import { cn } from "../lib/utils";
import { selectSidebarThreadSummaryByRef, useStore } from "../store";
import {
  describeChildFamilyMove,
  describeFamilyComing,
  describeRemoteChildrenStaying,
  describeThreadMoveLanding,
  describeThreadMoveSession,
  describeThreadMoveWaits,
  formatThreadMoveChanges,
  isThreadMoveTargetPickable,
  pickDefaultMoveAgent,
  pickDefaultMoveTarget,
  threadMoveAgentKey,
  threadMoveAgentSelection,
  threadMoveRoomAgentRows,
  threadMoveSessionOutcome,
  threadMoveNotesFor,
  threadMoveStopNowRefusal,
  type ThreadMoveAgentChoice,
  type ThreadMoveRoomAgentRow,
  type ThreadMoveRoomPicks,
} from "../threadMove";
import { openProjectSetupDialog } from "./ProjectSetupDialog";
import { useComputerLabel } from "./sidebar/linkedComputers";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Radio, RadioGroup } from "./ui/radio-group";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { closeThreadMoveDialog } from "./ThreadMoveDialog";

type PreviewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: ThreadMovePreview }
  | { readonly status: "failed"; readonly message: string };

const FIELD_LABEL_CLASS = "text-xs font-medium text-foreground";
const LINE_CLASS = "text-[12.5px] leading-[18px] text-muted-foreground";
const NO_ROOM_PICKS: ThreadMoveRoomPicks = new Map();

export function ThreadMoveDialogContent({ threadRef }: { threadRef: ScopedThreadRef }) {
  const title = useStore(
    (state) => selectSidebarThreadSummaryByRef(state, threadRef)?.title ?? null,
  );
  const projectId = useStore(
    (state) => selectSidebarThreadSummaryByRef(state, threadRef)?.projectId ?? null,
  );
  // The thread's computer queues moves (Part 3b): every move goes through
  // the queue, and a free thread's starts at once. Older servers only start.
  const queues = useThreadMoveQueueSupported(threadRef.environmentId);
  const computerLabel = useComputerLabel()(threadRef.environmentId, threadRef.environmentId);
  const [previewState, setPreviewState] = useState<PreviewState>({ status: "loading" });
  const [targetId, setTargetId] = useState<EnvironmentId | null>(null);
  const [agent, setAgent] = useState<ThreadMoveAgentChoice | null>(null);
  // A room's other agents the user picked for on the computer picked; the rest keep their presets.
  const [roomPicks, setRoomPicks] = useState<ThreadMoveRoomPicks>(NO_ROOM_PICKS);
  // A parent's children the user unticked: they stay here as their own threads.
  const [staying, setStaying] = useState<ReadonlySet<ThreadId>>(() => new Set());
  // A child: it moves on its own (staying its parent's child), or its whole family moves.
  const [pickedChildMove, setChildMove] = useState<ChildMoveChoice>("alone");
  const [pickedMode, setMode] = useState<ThreadPendingMoveMode>("when-done");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  // Asked again when a computer that lacked the project has been set up.
  const [previewRound, setPreviewRound] = useState(0);
  /** A refresh (after a setup there) that failed: the old preview stays, with a way to ask again. */
  const [refreshFailed, setRefreshFailed] = useState<string | null>(null);
  // The computer the user chose, kept through a fresh preview.
  const pickedTargetRef = useRef<EnvironmentId | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const preview = await requireThreadMovesClient(
          threadRef.environmentId,
          computerLabel,
        ).preview({ threadId: threadRef.threadId });
        if (!active) return;
        // A fresh preview keeps the computer the user picked, now that it may take the thread.
        const target =
          preview.targets.find(
            (candidate) =>
              candidate.environmentId === pickedTargetRef.current &&
              isThreadMoveTargetPickable(candidate),
          ) ?? pickDefaultMoveTarget(preview.targets);
        setTargetId(target?.environmentId ?? null);
        setAgent(target ? pickDefaultMoveAgent(target) : null);
        setRoomPicks(NO_ROOM_PICKS);
        setPreviewState({ status: "ready", preview });
        setRefreshFailed(null);
      } catch (error) {
        if (!active) return;
        // A refresh that fails keeps the preview it was refreshing, and says so.
        if (previewRound > 0) {
          setRefreshFailed(describeComputerLinkFailure(error, `${computerLabel} didn't answer.`));
          return;
        }
        setPreviewState({
          status: "failed",
          message: describeComputerLinkFailure(error, `${computerLabel} didn't answer.`),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [computerLabel, previewRound, threadRef.environmentId, threadRef.threadId]);

  const preview = previewState.status === "ready" ? previewState.preview : null;
  const target = preview?.targets.find((candidate) => candidate.environmentId === targetId) ?? null;
  // Still working: the move can wait for the agent to finish, or stop it first.
  const waits = queues ? (preview?.waitsFor ?? []) : [];
  const working = waits.length > 0;
  // Stopping isn't offered while a command runs in the user's terminal.
  const stopNowRefusal = threadMoveStopNowRefusal(waits);
  const mode: ThreadPendingMoveMode = stopNowRefusal === null ? pickedMode : "when-done";
  // Out of reach: a queued move to it waits for it to connect, and runs
  // with the agent it suggests then (no agent sent).
  const unreachable = queues && target?.unreachable === true;
  const agentSelection: ModelSelection | null =
    target !== null && agent !== null ? threadMoveAgentSelection(target, agent) : null;
  // A General Chats thread: its folder goes, with no branch or staged changes.
  const folder = preview?.folder;
  // A parent's family (Part 3f, (g)): the children ticked to come, each that can.
  const family = preview?.family;
  const coming = (family?.children ?? []).filter(
    (child) => child.refusal === undefined && !staying.has(child.threadId),
  );
  // A child (Part 3f, (h)): on its own when that computer keeps it its
  // parent's child, else with its whole family.
  const parent = family?.parent;
  const childMove: ChildMoveChoice =
    parent === undefined
      ? "alone"
      : target?.aloneRefusal !== undefined
        ? "family"
        : pickedChildMove;
  const withFamily = queues && parent !== undefined && childMove === "family";
  // With its whole family, every thread moves with the agent that computer
  // suggests for it, as the parent's move queues them: nothing to pick here.
  const suggestsAgents = unreachable || withFamily;
  // What comes along, then what won't work there as it did, for the agent it gets.
  const pickedInstanceId = unreachable
    ? null
    : withFamily
      ? (target?.suggestedAgent?.instanceId ?? null)
      : (agentSelection?.instanceId ?? null);
  const brings = threadMoveNotesFor(preview?.brings, pickedInstanceId);
  const notes = threadMoveNotesFor(target?.notes, pickedInstanceId);
  // A room's other agents, each with the agent it moves as there or left out.
  // Out of reach or with its family: none sent, and each takes the suggestion.
  const roomRows =
    preview?.room !== undefined && target !== null && !suggestsAgents
      ? threadMoveRoomAgentRows(preview.room, target, roomPicks)
      : null;
  const roomAgents = roomRows?.map((row) => row.choice);
  const canMove =
    preview !== null &&
    preview.refusal === undefined &&
    target !== null &&
    (target.refusal === undefined || unreachable) &&
    (agentSelection !== null || unreachable) &&
    !starting;

  const start = async () => {
    if (!canMove || target === null) return;
    setStarting(true);
    setStartError(null);
    try {
      const client = requireThreadMovesClient(threadRef.environmentId, computerLabel);
      const input = { threadId: threadRef.threadId, targetEnvironmentId: target.environmentId };
      if (withFamily) {
        // The parent with every thread it started: the server's whole family,
        // each with the agent that computer suggests.
        await client.queue({
          threadId: parent.threadId,
          targetEnvironmentId: target.environmentId,
          mode: working ? mode : "when-done",
        });
      } else if (queues) {
        await client.queue({
          ...input,
          ...(unreachable || agentSelection === null ? {} : { agent: agentSelection }),
          mode: working ? mode : "when-done",
          ...(roomAgents === undefined ? {} : { roomAgents }),
          // Exactly the children ticked come; the rest stay here as their own threads.
          ...(family === undefined
            ? {}
            : {
                familySelection: "explicit" as const,
                children: coming.map((child) => child.threadId),
              }),
        });
      } else if (agentSelection !== null) {
        await client.start({
          ...input,
          agent: agentSelection,
          ...(roomAgents === undefined ? {} : { roomAgents }),
        });
      }
      closeThreadMoveDialog();
    } catch (error) {
      setStartError(describeComputerLinkFailure(error, `${target.label} couldn't take it.`));
      setStarting(false);
    }
  };

  return (
    <DialogPopup className="max-w-md" data-testid="thread-move-dialog">
      <DialogHeader>
        <DialogTitle>Move to another computer</DialogTitle>
        <DialogDescription>
          {`${title ? `“${title}”` : "The thread"} goes with its messages and its ${
            folder !== undefined ? "files" : "code changes"
          }.`}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        {previewState.status === "loading" ? (
          <p className="text-sm text-muted-foreground" data-testid="thread-move-loading">
            Checking where it can go…
          </p>
        ) : previewState.status === "failed" ? (
          <p role="alert" className="text-sm text-destructive" data-testid="thread-move-error">
            {previewState.message}
          </p>
        ) : preview?.refusal !== undefined ? (
          <p className="text-sm text-foreground" data-testid="thread-move-refusal">
            {preview.refusal}
          </p>
        ) : preview && preview.targets.length === 0 ? (
          <p className="text-sm text-foreground" data-testid="thread-move-refusal">
            No linked computer can take it right now.
          </p>
        ) : preview ? (
          <>
            <TargetField
              targets={preview.targets}
              target={target}
              disabled={starting}
              onChange={(next) => {
                pickedTargetRef.current = next.environmentId;
                setTargetId(next.environmentId);
                setAgent(pickDefaultMoveAgent(next));
                setRoomPicks(NO_ROOM_PICKS);
                setStartError(null);
              }}
            />
            {target?.refusal !== undefined && !unreachable ? (
              <div className="space-y-2">
                <p className="text-sm text-foreground" data-testid="thread-move-target-refusal">
                  {target.refusal}
                </p>
                {refreshFailed !== null ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p
                      className="text-sm text-muted-foreground"
                      data-testid="thread-move-refresh-failed"
                    >
                      Couldn't check again: {refreshFailed}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="thread-move-check-again"
                      onClick={() => setPreviewRound((round) => round + 1)}
                    >
                      Check again
                    </Button>
                  </div>
                ) : target.refusalCode === "no_project" && projectId !== null ? (
                  <SetUpThereAction
                    project={{ environmentId: threadRef.environmentId, projectId }}
                    target={target}
                    onOpen={() => {
                      pickedTargetRef.current = target.environmentId;
                    }}
                    onSetUp={() => setPreviewRound((round) => round + 1)}
                  />
                ) : null}
              </div>
            ) : target ? (
              <>
                <div
                  className="surface-group space-y-0.5 px-3.5 py-2.5"
                  data-testid="thread-move-preview"
                >
                  <p
                    className="text-[13.5px] leading-[19px] font-medium text-foreground"
                    data-testid="thread-move-landing"
                  >
                    {describeThreadMoveLanding(target, folder)}
                  </p>
                  {folder === undefined && preview.changes ? (
                    <p
                      className="text-[12.5px] leading-[18px] text-muted-foreground"
                      data-testid="thread-move-changes"
                    >
                      {formatThreadMoveChanges(preview.changes)}
                    </p>
                  ) : null}
                  {folder === undefined ? (
                    <p className="text-[12.5px] leading-[18px] text-muted-foreground">
                      Staged changes arrive as unstaged changes.
                    </p>
                  ) : null}
                  <p className="text-[12.5px] leading-[18px] text-muted-foreground">
                    Your copy here stays, read-only.
                  </p>
                </div>
                {unreachable ? (
                  <p
                    className="text-[12.5px] leading-[18px] text-muted-foreground"
                    data-testid="thread-move-waits-to-connect"
                  >
                    {target.refusal} The move waits for it to connect, then uses the agent{" "}
                    {target.label} suggests.
                  </p>
                ) : withFamily ? (
                  <p className={LINE_CLASS} data-testid="thread-move-family-agents">
                    Each thread uses the agent {target.label} suggests for it.
                  </p>
                ) : (
                  <>
                    <AgentField
                      target={target}
                      agent={agent}
                      disabled={starting}
                      onChange={(next) => {
                        setAgent(next);
                        setStartError(null);
                      }}
                    />
                    {target.agents.length > 0 ? (
                      <p className={LINE_CLASS} data-testid="thread-move-session">
                        {describeThreadMoveSession(
                          threadMoveSessionOutcome(target, agentSelection?.instanceId ?? null),
                        )}
                      </p>
                    ) : null}
                    {target.agents.length > 0
                      ? roomRows?.map((row) => (
                          <RoomAgentField
                            key={row.participantId}
                            target={target}
                            row={row}
                            disabled={starting}
                            onChange={(next) => {
                              setRoomPicks((picks) => new Map(picks).set(row.participantId, next));
                              setStartError(null);
                            }}
                          />
                        ))
                      : null}
                  </>
                )}
                {parent !== undefined && queues ? (
                  <ChildMoveField
                    parent={parent}
                    hereLabel={computerLabel}
                    target={target}
                    choice={childMove}
                    disabled={starting}
                    onChange={(next) => {
                      setChildMove(next);
                      setStartError(null);
                    }}
                  />
                ) : null}
                {family !== undefined &&
                (family.children.length > 0 || family.remoteChildren.length > 0) ? (
                  <FamilyField
                    family={family}
                    targetLabel={target.label}
                    staying={staying}
                    comingCount={coming.length}
                    disabled={starting}
                    onToggle={(threadId, comes) => {
                      setStaying((current) => {
                        const next = new Set(current);
                        if (comes) next.delete(threadId);
                        else next.add(threadId);
                        return next;
                      });
                      setStartError(null);
                    }}
                  />
                ) : null}
                {brings.length > 0 || notes.length > 0 ? (
                  <div className="space-y-0.5" data-testid="thread-move-carries">
                    {brings.map((line) => (
                      <p
                        key={line}
                        className="text-[12.5px] leading-[18px] text-muted-foreground"
                        data-testid="thread-move-brings"
                      >
                        {line}
                      </p>
                    ))}
                    {notes.map((line) => (
                      <p
                        key={line}
                        className="text-[12.5px] leading-[18px] text-foreground"
                        data-testid="thread-move-note"
                      >
                        {line}
                      </p>
                    ))}
                  </div>
                ) : null}
                {working ? (
                  <MoveWhenField
                    label={target.label}
                    doing={describeThreadMoveWaits(waits)}
                    mode={mode}
                    stopNowRefusal={stopNowRefusal}
                    disabled={starting}
                    onChange={setMode}
                  />
                ) : null}
                {target.access === "ask" ? (
                  <p className="text-xs text-muted-foreground" data-testid="thread-move-asks-first">
                    {target.label} asks its user first.
                  </p>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}
        {startError !== null ? (
          <p
            role="alert"
            className="text-sm text-destructive"
            data-testid="thread-move-start-error"
          >
            {startError}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={closeThreadMoveDialog}>
          Cancel
        </Button>
        <Button disabled={!canMove} onClick={() => void start()} data-testid="thread-move-confirm">
          {starting
            ? "Moving…"
            : working
              ? mode === "stop-now"
                ? "Stop and move"
                : "Move when it finishes"
              : unreachable
                ? "Move when it connects"
                : "Move"}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}

/**
 * The two ways to move a thread whose agent is still at it (Part 3b): once
 * the agent finishes, or now, after it is stopped. Says first what the agent
 * is doing. `many`: once for several threads (the Move threads dialog,
 * Part 3c), each agent alike.
 */
export function MoveWhenField({
  label,
  doing,
  many = false,
  mode,
  stopNowRefusal,
  disabled,
  onChange,
}: {
  readonly label: string;
  /** What the agent is doing (describeThreadMoveWaits), or how many are working. */
  readonly doing: string;
  readonly many?: boolean;
  readonly mode: ThreadPendingMoveMode;
  /** Why stopping isn't offered now (threadMoveStopNowRefusal); null when it is. */
  readonly stopNowRefusal: string | null;
  readonly disabled: boolean;
  readonly onChange: (mode: ThreadPendingMoveMode) => void;
}) {
  const choices: ReadonlyArray<{
    readonly value: ThreadPendingMoveMode;
    readonly label: string;
    readonly detail: string;
    /** Why it can't be picked, under its own words; null when it can. */
    readonly refusal: string | null;
  }> = [
    {
      value: "when-done",
      label: many ? "Move when each agent finishes" : "Move when the agent finishes",
      detail: many
        ? `Each thread moves to ${label} once its agent finishes.`
        : `Waits for the agent to finish, then moves to ${label}.`,
      refusal: null,
    },
    {
      value: "stop-now",
      label: many ? "Stop the agents and move now" : "Stop the agent and move now",
      detail: many
        ? "Stops the agents and anything they started, then moves."
        : "Stops the agent and anything it started, then moves.",
      refusal: stopNowRefusal,
    },
  ];
  return (
    <div className="grid gap-1.5" data-testid="thread-move-when">
      <p className="text-[13.5px] leading-[19px] text-foreground" data-testid="thread-move-doing">
        {doing}
      </p>
      <RadioGroup
        value={mode}
        disabled={disabled}
        onValueChange={(value) => onChange(value as ThreadPendingMoveMode)}
        aria-label="When it moves"
        className="gap-0.5"
      >
        {choices.map((choice) => (
          <label
            key={choice.value}
            className={cn(
              "flex items-start gap-2.5 rounded-lg px-1 py-1.5",
              choice.refusal === null ? "cursor-pointer" : "cursor-default",
            )}
            data-testid={`thread-move-mode-${choice.value}`}
          >
            <Radio value={choice.value} disabled={choice.refusal !== null} className="mt-0.5" />
            <span className="min-w-0">
              <span
                className={cn(
                  "block text-[13.5px] font-medium",
                  choice.refusal !== null && "text-muted-foreground",
                )}
              >
                {choice.label}
              </span>
              {/* Why it can't be picked, in place of what it would do. */}
              <span
                className="block text-[12.5px] text-muted-foreground"
                data-testid={`thread-move-mode-${choice.value}-detail`}
              >
                {choice.refusal ?? choice.detail}
              </span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}

/** How a child moves: on its own, or with the thread that started it and that thread's others. */
type ChildMoveChoice = "alone" | "family";

/**
 * A child's two ways to move (docs/design/fleet.md, Part 3f, (h)): on its
 * own, staying a thread of its parent, which still reaches it there; or its
 * whole family, parent first. A computer that can't keep it its parent's
 * child takes only the family, and says why.
 */
function ChildMoveField({
  parent,
  hereLabel,
  target,
  choice,
  disabled,
  onChange,
}: {
  readonly parent: NonNullable<NonNullable<ThreadMovePreview["family"]>["parent"]>;
  readonly hereLabel: string;
  readonly target: ThreadMoveTargetPreview;
  readonly choice: ChildMoveChoice;
  readonly disabled: boolean;
  readonly onChange: (choice: ChildMoveChoice) => void;
}) {
  const choices: ReadonlyArray<{
    readonly value: ChildMoveChoice;
    readonly label: string;
    readonly detail: string;
    readonly refusal: string | null;
  }> = [
    {
      value: "alone",
      label: "Move just this thread",
      detail: `It stays a thread of ${parent.title} on ${hereLabel}, which can still send to it.`,
      refusal: target.aloneRefusal ?? null,
    },
    {
      value: "family",
      label: describeChildFamilyMove(parent.familySize),
      detail: `${parent.title} and the threads it started move to ${target.label} together.`,
      refusal: null,
    },
  ];
  return (
    <RadioGroup
      value={choice}
      disabled={disabled}
      onValueChange={(value) => onChange(value as ChildMoveChoice)}
      aria-label="What moves"
      className="gap-0.5"
      data-testid="thread-move-child"
    >
      {choices.map((entry) => (
        <label
          key={entry.value}
          className={cn(
            "flex items-start gap-2.5 rounded-lg px-1 py-1.5",
            entry.refusal === null ? "cursor-pointer" : "cursor-default",
          )}
          data-testid={`thread-move-child-${entry.value}`}
        >
          <Radio value={entry.value} disabled={entry.refusal !== null} className="mt-0.5" />
          <span className="min-w-0">
            <span
              className={cn(
                "block text-[13.5px] font-medium",
                entry.refusal !== null && "text-muted-foreground",
              )}
              data-testid={`thread-move-child-${entry.value}-label`}
            >
              {entry.label}
            </span>
            <span
              className="block text-[12.5px] text-muted-foreground"
              data-testid={`thread-move-child-${entry.value}-detail`}
            >
              {entry.refusal ?? entry.detail}
            </span>
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}

/**
 * A parent's family (docs/design/fleet.md, Part 3f, (g)): its threads here,
 * ticked to come along, each unticked or unable to come staying here as its
 * own thread; and the threads its agent started on other computers, which
 * stay there.
 */
function FamilyField({
  family,
  targetLabel,
  staying,
  comingCount,
  disabled,
  onToggle,
}: {
  readonly family: NonNullable<ThreadMovePreview["family"]>;
  readonly targetLabel: string;
  readonly staying: ReadonlySet<ThreadId>;
  readonly comingCount: number;
  readonly disabled: boolean;
  readonly onToggle: (threadId: ThreadId, comes: boolean) => void;
}) {
  return (
    <div className="grid gap-1.5" data-testid="thread-move-family">
      {family.children.length > 0 ? (
        <>
          <p
            className="text-[13.5px] leading-[19px] text-foreground"
            data-testid="thread-move-family-coming"
          >
            {describeFamilyComing(comingCount)}
          </p>
          <ul className="surface-group py-1" aria-label="Its threads">
            {family.children.map((child) => {
              const refused = child.refusal !== undefined;
              const comes = !refused && !staying.has(child.threadId);
              return (
                <li key={child.threadId} data-testid={`thread-move-family-row-${child.threadId}`}>
                  <label
                    className={cn(
                      "flex items-start gap-2.5 px-3.5 py-1.5",
                      refused ? "cursor-default" : "cursor-pointer",
                    )}
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={comes}
                      disabled={refused || disabled}
                      onCheckedChange={(checked) => onToggle(child.threadId, checked === true)}
                      data-testid={`thread-move-family-tick-${child.threadId}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-[13.5px] leading-[19px]",
                          refused ? "text-muted-foreground" : "text-foreground",
                        )}
                      >
                        {child.title}
                      </span>
                      {comes ? null : (
                        <span
                          className={cn("block", LINE_CLASS)}
                          data-testid={`thread-move-family-stays-${child.threadId}`}
                        >
                          {refused
                            ? `${child.refusal} It stays here as its own thread.`
                            : "Stays here as its own thread."}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {describeRemoteChildrenStaying(family.remoteChildren, targetLabel).map((line) => (
        <p key={line} className={LINE_CLASS} data-testid="thread-move-family-remote">
          {line}
        </p>
      ))}
    </div>
  );
}

/** The computers the thread can go to; one that can't take it is listed, disabled, with why. */
export function TargetField({
  targets,
  target,
  disabled,
  onChange,
}: {
  readonly targets: ReadonlyArray<ThreadMoveTargetPreview>;
  readonly target: ThreadMoveTargetPreview | null;
  readonly disabled: boolean;
  readonly onChange: (target: ThreadMoveTargetPreview) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <span className={FIELD_LABEL_CLASS}>Computer</span>
      <Select
        value={target?.environmentId ?? null}
        disabled={disabled}
        onValueChange={(value) => {
          const next = targets.find((candidate) => candidate.environmentId === value);
          if (next) onChange(next);
        }}
      >
        <SelectTrigger className="w-full" aria-label="Computer" data-testid="thread-move-target">
          <SelectValue>{target?.label ?? "Pick a computer"}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {targets.map((candidate) => (
            <SelectItem
              key={candidate.environmentId}
              value={candidate.environmentId}
              // One without the project can be picked: the dialog offers to set
              // it up there. One out of reach too: the move waits for it.
              disabled={
                !isThreadMoveTargetPickable(candidate) && candidate.refusalCode !== "no_project"
              }
              data-testid={`thread-move-target-${candidate.environmentId}`}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{candidate.label}</span>
                {candidate.refusal !== undefined ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {candidate.refusal}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/** The target computer's ready agents, each with its models; the target's suggestion comes picked. */
function AgentField({
  target,
  agent,
  disabled,
  onChange,
}: {
  readonly target: ThreadMoveTargetPreview;
  readonly agent: ThreadMoveAgentChoice | null;
  readonly disabled: boolean;
  readonly onChange: (agent: ThreadMoveAgentChoice) => void;
}) {
  if (!target.agents.some((candidate) => candidate.models.length > 0)) {
    return (
      <p className="text-sm text-foreground" data-testid="thread-move-no-agents">
        {target.label} has no agent ready.
      </p>
    );
  }
  return (
    <div className="grid gap-1.5">
      <span className={FIELD_LABEL_CLASS}>Agent</span>
      <AgentSelect
        agents={target.agents}
        value={agent}
        ariaLabel="Agent"
        testId="thread-move-agent"
        disabled={disabled}
        onChange={(next) => {
          if (next !== null) onChange(next);
        }}
      />
    </div>
  );
}

/**
 * One of a room's other agents (Part 3f, (i)): its name here, the agent it
 * moves as there or "Leave out", and under it what the agent picked gets of
 * its session, or, left out, why none matches (the server's words).
 */
function RoomAgentField({
  target,
  row,
  disabled,
  onChange,
}: {
  readonly target: ThreadMoveTargetPreview;
  readonly row: ThreadMoveRoomAgentRow;
  readonly disabled: boolean;
  readonly onChange: (agent: ThreadMoveAgentChoice | null) => void;
}) {
  const line = row.session !== null ? describeThreadMoveSession(row.session) : row.cantCome;
  return (
    <div className="grid gap-1.5" data-testid={`thread-move-room-agent-${row.participantId}`}>
      <span className={FIELD_LABEL_CLASS}>{row.name}</span>
      <AgentSelect
        agents={target.agents}
        value={row.pick}
        ariaLabel={row.name}
        testId={`thread-move-room-agent-picker-${row.participantId}`}
        disabled={disabled}
        leaveOut
        onChange={onChange}
      />
      {line !== null ? (
        <p className={LINE_CLASS} data-testid={`thread-move-room-agent-line-${row.participantId}`}>
          {line}
        </p>
      ) : null}
    </div>
  );
}

/** The value "Leave out" is picked by; agent keys hold a NUL, so none is this. */
const LEAVE_OUT_KEY = "leave-out";

/**
 * A computer's agents, each with its models, to pick one from. `leaveOut`:
 * "Leave out" comes last, picked as null.
 */
function AgentSelect({
  agents,
  value,
  ariaLabel,
  testId,
  disabled,
  leaveOut = false,
  onChange,
}: {
  readonly agents: ThreadMoveTargetPreview["agents"];
  readonly value: ThreadMoveAgentChoice | null;
  readonly ariaLabel: string;
  readonly testId: string;
  readonly disabled: boolean;
  readonly leaveOut?: boolean;
  readonly onChange: (agent: ThreadMoveAgentChoice | null) => void;
}) {
  const choices = useMemo(
    () =>
      new Map(
        agents.flatMap((candidate) =>
          candidate.models.map((model) => {
            const choice = { instanceId: candidate.instanceId, model: model.model };
            return [
              threadMoveAgentKey(choice),
              { choice, label: `${candidate.name} · ${model.name}` },
            ] as const;
          }),
        ),
      ),
    [agents],
  );
  const selectedKey = value !== null ? threadMoveAgentKey(value) : leaveOut ? LEAVE_OUT_KEY : null;
  return (
    <Select
      value={selectedKey}
      disabled={disabled}
      onValueChange={(next) => {
        if (leaveOut && next === LEAVE_OUT_KEY) {
          onChange(null);
          return;
        }
        const picked = next === null ? undefined : choices.get(next);
        if (picked) onChange(picked.choice);
      }}
    >
      <SelectTrigger className="w-full" aria-label={ariaLabel} data-testid={testId}>
        <SelectValue>
          {selectedKey === LEAVE_OUT_KEY
            ? "Leave out"
            : ((selectedKey !== null ? choices.get(selectedKey)?.label : undefined) ??
              "Pick an agent")}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {agents.map((candidate) => (
          <SelectGroup key={candidate.instanceId}>
            <SelectGroupLabel>
              {candidate.billing ? `${candidate.name} · ${candidate.billing}` : candidate.name}
            </SelectGroupLabel>
            {candidate.models.map((model) => (
              <SelectItem
                key={model.model}
                value={threadMoveAgentKey({
                  instanceId: candidate.instanceId,
                  model: model.model,
                })}
              >
                {model.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
        {leaveOut ? (
          <>
            <SelectSeparator />
            <SelectItem value={LEAVE_OUT_KEY}>Leave out</SelectItem>
          </>
        ) : null}
      </SelectPopup>
    </Select>
  );
}

/**
 * For a computer that lacks the thread's project: set it up there (the move
 * is asked again once that's done), or, when this app can't reach that
 * computer to do it, the way to connect to it first.
 */
function SetUpThereAction({
  project,
  target,
  onOpen,
  onSetUp,
}: {
  readonly project: ScopedProjectRef;
  readonly target: ThreadMoveTargetPreview;
  readonly onOpen: () => void;
  readonly onSetUp: () => void;
}) {
  const navigate = useNavigate();
  const setupTargets = useProjectSetupTargets(project);
  const reachable = useProjectSetupComputerReady(target.environmentId);
  if (setupTargets.some((candidate) => candidate.environmentId === target.environmentId)) {
    return (
      <Button
        size="sm"
        variant="outline"
        data-testid="thread-move-set-up"
        onClick={() => {
          onOpen();
          openProjectSetupDialog({
            project,
            targetEnvironmentId: target.environmentId,
            onDone: onSetUp,
          });
        }}
      >
        Set it up there
      </Button>
    );
  }
  if (reachable) return null;
  return (
    <Button
      size="sm"
      variant="link"
      className="h-auto px-0"
      data-testid="thread-move-connect-first"
      onClick={() => {
        closeThreadMoveDialog();
        void navigate({
          to: "/fleet/$environmentId",
          params: { environmentId: target.environmentId },
        });
      }}
    >
      Connect to {target.label} in this app first
    </Button>
  );
}

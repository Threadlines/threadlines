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
  ThreadMovePreview,
  ThreadMoveTargetPreview,
  ThreadMoveWait,
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
import { selectSidebarThreadSummaryByRef, useStore } from "../store";
import {
  describeThreadMoveWaits,
  formatThreadMoveChanges,
  isThreadMoveTargetPickable,
  pickDefaultMoveAgent,
  pickDefaultMoveTarget,
  threadMoveAgentKey,
  threadMoveAgentSelection,
  type ThreadMoveAgentChoice,
} from "../threadMove";
import { openProjectSetupDialog } from "./ProjectSetupDialog";
import { useComputerLabel } from "./sidebar/linkedComputers";
import { Button } from "./ui/button";
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
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { closeThreadMoveDialog } from "./ThreadMoveDialog";

type PreviewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: ThreadMovePreview }
  | { readonly status: "failed"; readonly message: string };

const FIELD_LABEL_CLASS = "text-xs font-medium text-foreground";

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
  const [mode, setMode] = useState<ThreadPendingMoveMode>("when-done");
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
  // Out of reach: a queued move to it waits for it to connect, and runs
  // with the agent it suggests then (no agent sent).
  const unreachable = queues && target?.refusalCode === "unreachable";
  const agentSelection: ModelSelection | null =
    target !== null && agent !== null ? threadMoveAgentSelection(target, agent) : null;
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
      if (queues) {
        await client.queue({
          ...input,
          ...(unreachable || agentSelection === null ? {} : { agent: agentSelection }),
          mode: working ? mode : "when-done",
        });
      } else if (agentSelection !== null) {
        await client.start({ ...input, agent: agentSelection });
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
          {title
            ? `“${title}” goes with its messages and its code changes.`
            : "The thread goes with its messages and its code changes."}
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
                  <p className="text-[13.5px] leading-[19px] font-medium text-foreground">
                    {target.projectName
                      ? `Lands in ${target.projectName} on ${target.label}`
                      : `Lands on ${target.label}`}
                  </p>
                  {preview.changes ? (
                    <p
                      className="text-[12.5px] leading-[18px] text-muted-foreground"
                      data-testid="thread-move-changes"
                    >
                      {formatThreadMoveChanges(preview.changes)}
                    </p>
                  ) : null}
                  <p className="text-[12.5px] leading-[18px] text-muted-foreground">
                    Staged changes arrive as unstaged changes.
                  </p>
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
                ) : (
                  <AgentField
                    target={target}
                    agent={agent}
                    disabled={starting}
                    onChange={(next) => {
                      setAgent(next);
                      setStartError(null);
                    }}
                  />
                )}
                {working ? (
                  <MoveWhenField
                    label={target.label}
                    waits={waits}
                    mode={mode}
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
 * is doing.
 */
function MoveWhenField({
  label,
  waits,
  mode,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly waits: ReadonlyArray<ThreadMoveWait>;
  readonly mode: ThreadPendingMoveMode;
  readonly disabled: boolean;
  readonly onChange: (mode: ThreadPendingMoveMode) => void;
}) {
  const choices: ReadonlyArray<{
    readonly value: ThreadPendingMoveMode;
    readonly label: string;
    readonly detail: string;
  }> = [
    {
      value: "when-done",
      label: "Move when the agent finishes",
      detail: `Waits for the agent to finish, then moves to ${label}.`,
    },
    {
      value: "stop-now",
      label: "Stop the agent and move now",
      detail: "Stops the agent and anything it started, then moves.",
    },
  ];
  return (
    <div className="grid gap-1.5" data-testid="thread-move-when">
      <p className="text-[13.5px] leading-[19px] text-foreground" data-testid="thread-move-doing">
        {describeThreadMoveWaits(waits)}
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
            className="flex cursor-pointer items-start gap-2.5 rounded-lg px-1 py-1.5"
            data-testid={`thread-move-mode-${choice.value}`}
          >
            <Radio value={choice.value} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-[13.5px] font-medium">{choice.label}</span>
              <span className="block text-[12.5px] text-muted-foreground">{choice.detail}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}

/** The computers the thread can go to; one that can't take it is listed, disabled, with why. */
function TargetField({
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
  const choices = useMemo(
    () =>
      new Map(
        target.agents.flatMap((candidate) =>
          candidate.models.map((model) => {
            const choice = { instanceId: candidate.instanceId, model: model.model };
            return [
              threadMoveAgentKey(choice),
              { choice, label: `${candidate.name} · ${model.name}` },
            ] as const;
          }),
        ),
      ),
    [target.agents],
  );
  if (choices.size === 0) {
    return (
      <p className="text-sm text-foreground" data-testid="thread-move-no-agents">
        {target.label} has no agent ready.
      </p>
    );
  }
  const selectedKey = agent ? threadMoveAgentKey(agent) : null;
  return (
    <div className="grid gap-1.5">
      <span className={FIELD_LABEL_CLASS}>Agent</span>
      <Select
        value={selectedKey}
        disabled={disabled}
        onValueChange={(value) => {
          const next = value === null ? undefined : choices.get(value);
          if (next) onChange(next.choice);
        }}
      >
        <SelectTrigger className="w-full" aria-label="Agent" data-testid="thread-move-agent">
          <SelectValue>
            {(selectedKey !== null ? choices.get(selectedKey)?.label : undefined) ??
              "Pick an agent"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {target.agents.map((candidate) => (
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
        </SelectPopup>
      </Select>
    </div>
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

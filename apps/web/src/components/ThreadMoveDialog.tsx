/**
 * "Move to another computer" (docs/design/fleet.md, Part 3): one dialog for
 * every entry point (the sidebar's thread menu, the command palette, the chat
 * header). Each asks through openThreadMoveDialog; the host mounted once at
 * the root shows it. The dialog asks the thread's computer where the thread
 * could go and what would go with it, then starts the move there.
 */
import type {
  EnvironmentId,
  ScopedThreadRef,
  ThreadMovePreview,
  ThreadMoveTargetPreview,
} from "@threadlines/contracts";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";

import { describeComputerLinkFailure } from "../environments/links/computerLinks";
import { requireThreadMovesClient } from "../environments/links/threadMoves";
import { selectSidebarThreadSummaryByRef, useStore } from "../store";
import {
  formatThreadMoveChanges,
  pickDefaultMoveAgent,
  pickDefaultMoveTarget,
  threadMoveAgentKey,
  threadMoveAgentSelection,
  type ThreadMoveAgentChoice,
} from "../threadMove";
import { useComputerLabel } from "./sidebar/linkedComputers";
import { Button } from "./ui/button";
import {
  Dialog,
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

interface ThreadMoveDialogRequest {
  /** Each ask starts fresh, even for the same thread twice. */
  readonly id: number;
  readonly threadRef: ScopedThreadRef;
}

const useThreadMoveDialogStore = create<{ request: ThreadMoveDialogRequest | null }>(() => ({
  request: null,
}));

/** Opens the move dialog for a thread; a second ask replaces the first. */
export function openThreadMoveDialog(threadRef: ScopedThreadRef): void {
  const previous = useThreadMoveDialogStore.getState().request;
  useThreadMoveDialogStore.setState({ request: { id: (previous?.id ?? 0) + 1, threadRef } });
}

export function closeThreadMoveDialog(): void {
  useThreadMoveDialogStore.setState({ request: null });
}

/** Mounted once at the root; shows whatever openThreadMoveDialog asks. */
export function ThreadMoveDialogHost() {
  const request = useThreadMoveDialogStore((state) => state.request);
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) closeThreadMoveDialog();
      }}
    >
      {request ? <ThreadMoveDialogContent key={request.id} threadRef={request.threadRef} /> : null}
    </Dialog>
  );
}

type PreviewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: ThreadMovePreview }
  | { readonly status: "failed"; readonly message: string };

const FIELD_LABEL_CLASS = "text-xs font-medium text-foreground";

function ThreadMoveDialogContent({ threadRef }: { threadRef: ScopedThreadRef }) {
  const title = useStore(
    (state) => selectSidebarThreadSummaryByRef(state, threadRef)?.title ?? null,
  );
  const computerLabel = useComputerLabel()(threadRef.environmentId, threadRef.environmentId);
  const [previewState, setPreviewState] = useState<PreviewState>({ status: "loading" });
  const [targetId, setTargetId] = useState<EnvironmentId | null>(null);
  const [agent, setAgent] = useState<ThreadMoveAgentChoice | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const preview = await requireThreadMovesClient(
          threadRef.environmentId,
          computerLabel,
        ).preview({ threadId: threadRef.threadId });
        if (!active) return;
        const target = pickDefaultMoveTarget(preview.targets);
        setTargetId(target?.environmentId ?? null);
        setAgent(target ? pickDefaultMoveAgent(target) : null);
        setPreviewState({ status: "ready", preview });
      } catch (error) {
        if (!active) return;
        setPreviewState({
          status: "failed",
          message: describeComputerLinkFailure(error, `${computerLabel} didn't answer.`),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [computerLabel, threadRef.environmentId, threadRef.threadId]);

  const preview = previewState.status === "ready" ? previewState.preview : null;
  const target = preview?.targets.find((candidate) => candidate.environmentId === targetId) ?? null;
  const canMove =
    preview !== null &&
    preview.refusal === undefined &&
    target !== null &&
    target.refusal === undefined &&
    agent !== null &&
    !starting;

  const start = async () => {
    if (!canMove || target === null || agent === null) return;
    setStarting(true);
    setStartError(null);
    try {
      await requireThreadMovesClient(threadRef.environmentId, computerLabel).start({
        threadId: threadRef.threadId,
        targetEnvironmentId: target.environmentId,
        agent: threadMoveAgentSelection(target, agent),
      });
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
                setTargetId(next.environmentId);
                setAgent(pickDefaultMoveAgent(next));
                setStartError(null);
              }}
            />
            {target?.refusal !== undefined ? (
              <p className="text-sm text-foreground" data-testid="thread-move-target-refusal">
                {target.refusal}
              </p>
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
                <AgentField
                  target={target}
                  agent={agent}
                  disabled={starting}
                  onChange={(next) => {
                    setAgent(next);
                    setStartError(null);
                  }}
                />
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
          {starting ? "Moving…" : "Move"}
        </Button>
      </DialogFooter>
    </DialogPopup>
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
              disabled={candidate.refusal !== undefined}
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

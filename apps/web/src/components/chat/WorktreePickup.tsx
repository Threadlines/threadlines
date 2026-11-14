/**
 * The new-thread screen's two views of a project's worktrees made outside
 * Threadlines (docs/design/worktree-pickup.md): the list laid out for picking
 * right after the repository is added, and the rows behind the folded count
 * every later visit. Both read what is in each worktree when they are shown;
 * the count that leads to them only needed their names.
 */
import type { ScopedProjectRef, VcsWorktreeStatus } from "@threadlines/contracts";
import { areFilesystemPathsEqual, shortenHomePath } from "@threadlines/shared/path";
import { useState } from "react";

import { useWorktreePickup } from "../../hooks/useWorktreePickup";
import { isSettledWorktree, worktreePathLabel } from "../../worktreePickup";
import { RelativeTimeLabel } from "../RelativeTimeLabel";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";

/**
 * The project whose worktrees the screen offers, and what its draft does
 * with one; the chat view supplies it.
 */
export interface WorktreePickupActions {
  readonly projectRef: ScopedProjectRef;
  readonly projectCwd: string;
  /** Where the draft on screen points, to mark its row. */
  readonly draftWorktreePath: string | null;
  /** Points the draft on screen at the worktree. */
  readonly onWorkHere: (worktree: VcsWorktreeStatus) => void;
  /** Makes a thread for each, with the message box's model and access. No turn starts. */
  readonly onAddThreads: (worktrees: ReadonlyArray<VcsWorktreeStatus>) => Promise<void>;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The branch, or what stands in for one on a detached worktree. */
function worktreeName(worktree: VcsWorktreeStatus): string {
  return worktree.refName ?? "Detached";
}

/** What is waiting in the worktree, in a few words; `known` false while it is being read. */
function WorktreeFacts({ worktree, known }: { worktree: VcsWorktreeStatus; known: boolean }) {
  if (!known) {
    return <span className="shrink-0 text-xs text-muted-foreground">Checking</span>;
  }
  const facts: string[] = [];
  if (worktree.changedFileCount !== null && worktree.changedFileCount > 0) {
    facts.push(`${worktree.changedFileCount} changed`);
  }
  if (worktree.mergedByContent) {
    facts.push("merged");
  } else if (worktree.unmergedCommitCount !== null && worktree.unmergedCommitCount > 0) {
    facts.push(`${worktree.unmergedCommitCount} ahead`);
  }
  if (facts.length === 0 && !worktree.dirtyUnknown) {
    facts.push("no changes");
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
      {facts.length > 0 ? <span>{facts.join(" · ")}</span> : null}
      {facts.length > 0 && worktree.lastCommitAt !== null ? (
        <span aria-hidden="true">·</span>
      ) : null}
      {worktree.lastCommitAt !== null ? (
        <RelativeTimeLabel at={worktree.lastCommitAt} compact />
      ) : null}
    </span>
  );
}

function WorktreeLabel({
  worktree,
  projectCwd,
}: {
  worktree: VcsWorktreeStatus;
  projectCwd: string;
}) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-sm text-foreground/90">{worktreeName(worktree)}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground" title={worktree.path}>
        {worktreePathLabel(worktree.path, projectCwd)}
      </span>
    </span>
  );
}

/**
 * The list laid out for picking: a checkbox a worktree, the ones with nothing
 * left to ship unticked, and one button that makes the threads.
 */
export function WorktreePickupOffer(props: {
  readonly actions: WorktreePickupActions;
  readonly onClose: () => void;
  readonly className?: string;
}) {
  const { actions } = props;
  const { candidates: worktrees, statusesLoaded } = useWorktreePickup({
    projectRef: actions.projectRef,
    projectCwd: actions.projectCwd,
    statuses: true,
  });
  // Only what the user changed is kept, so a worktree starts as its state
  // says once that is read, and one that appears meanwhile does too.
  const [choices, setChoices] = useState<Readonly<Record<string, boolean>>>({});
  const [adding, setAdding] = useState(false);
  const isPicked = (worktree: VcsWorktreeStatus) =>
    choices[worktree.path] ?? !(statusesLoaded && isSettledWorktree(worktree));
  const picked = worktrees.filter(isPicked);

  return (
    <section
      aria-label="Worktrees in this repository"
      className={props.className}
      data-testid="worktree-pickup-offer"
    >
      <div className="mb-2 text-center text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {plural(worktrees.length, "worktree", "worktrees")} already in this repository.
        </span>{" "}
        Add the ones you want as threads. Nothing runs until you send a message.
      </div>
      <div className="flex flex-col divide-y divide-border/50">
        {worktrees.map((worktree) => (
          // The whole row is the checkbox's label.
          <label
            className="flex w-full min-w-0 cursor-pointer items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted"
            data-testid="worktree-pickup-offer-row"
            key={worktree.path}
          >
            <Checkbox
              checked={isPicked(worktree)}
              onCheckedChange={(checked) =>
                setChoices((current) => ({ ...current, [worktree.path]: checked }))
              }
            />
            <WorktreeLabel projectCwd={actions.projectCwd} worktree={worktree} />
            <WorktreeFacts known={statusesLoaded} worktree={worktree} />
          </label>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-center gap-2">
        <Button
          // Which ones start ticked is not known until they are read.
          disabled={picked.length === 0 || adding || !statusesLoaded}
          onClick={() => {
            setAdding(true);
            void actions
              .onAddThreads(picked)
              .then(props.onClose, () => undefined)
              .finally(() => setAdding(false));
          }}
          size="sm"
        >
          {picked.length === 0
            ? "Add threads"
            : `Add ${plural(picked.length, "thread", "threads")}`}
        </Button>
        <Button onClick={props.onClose} size="sm" variant="ghost">
          Not now
        </Button>
      </div>
    </section>
  );
}

/**
 * The rows behind the folded count: each worktree with the one thing to do
 * there now, and the two ways out of the list under them.
 */
export function WorktreePickupRows(props: {
  readonly actions: WorktreePickupActions;
  readonly onOffer: () => void;
  readonly onHide: () => void;
}) {
  const { actions } = props;
  const { candidates: worktrees, statusesLoaded } = useWorktreePickup({
    projectRef: actions.projectRef,
    projectCwd: actions.projectCwd,
    statuses: true,
  });
  const { draftWorktreePath } = actions;
  return (
    <div data-testid="worktree-pickup-rows">
      <div className="flex flex-col divide-y divide-border/50">
        {worktrees.map((worktree) => {
          const isDraftHere =
            draftWorktreePath !== null && areFilesystemPathsEqual(draftWorktreePath, worktree.path);
          return (
            <div
              className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2"
              data-testid="worktree-pickup-row"
              key={worktree.path}
            >
              <WorktreeLabel projectCwd={actions.projectCwd} worktree={worktree} />
              <WorktreeFacts known={statusesLoaded} worktree={worktree} />
              {isDraftHere ? (
                <span className="shrink-0 px-2 text-xs font-medium text-foreground">
                  This thread
                </span>
              ) : (
                <Button
                  aria-label={`Work in ${worktreeName(worktree)}`}
                  className="shrink-0"
                  onClick={() => actions.onWorkHere(worktree)}
                  size="xs"
                  variant="ghost"
                >
                  Work here
                </Button>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-center gap-1">
        <Button onClick={props.onOffer} size="xs" variant="ghost">
          Add as threads…
        </Button>
        <Button className="text-muted-foreground" onClick={props.onHide} size="xs" variant="ghost">
          Hide for this project
        </Button>
      </div>
    </div>
  );
}

/**
 * What a thread added for an existing worktree shows before its first
 * message: where it works, and that nothing has run there yet.
 */
export function ExistingWorktreeThreadEmptyState(props: {
  readonly worktreePath: string;
  /** The project's folder, which the path is written from; null when unknown. */
  readonly projectCwd: string | null;
  readonly branch: string | null;
}) {
  return (
    <div
      className="flex max-w-md flex-col items-center gap-1.5 text-center"
      data-testid="existing-worktree-empty-state"
    >
      <p className="text-sm text-foreground">Nothing has run in this thread yet.</p>
      <p className="text-xs leading-5 text-muted-foreground">
        It works in the worktree at{" "}
        <span className="font-mono text-[11px] text-foreground/85" title={props.worktreePath}>
          {props.projectCwd === null
            ? shortenHomePath(props.worktreePath)
            : worktreePathLabel(props.worktreePath, props.projectCwd)}
        </span>
        {props.branch !== null ? (
          <>
            {" "}
            on <span className="text-foreground/85">{props.branch}</span>
          </>
        ) : null}
        . Send a message to start. Deleting the thread leaves the folder where it is.
      </p>
    </div>
  );
}

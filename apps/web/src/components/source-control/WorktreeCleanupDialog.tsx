import type { EnvironmentId, VcsWorktreeStatus } from "@threadlines/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "~/environmentApi";
import { useArchivedThreadSnapshots } from "~/lib/archivedThreadsState";
import { invalidateGitQueries, vcsListWorktreesQueryOptions } from "~/lib/gitReactQuery";
import { cn } from "~/lib/utils";
import { selectThreadsForEnvironment, useStore } from "~/store";
import {
  classifyWorktreesForCleanup,
  describeWorktreeHolder,
  describeWorktreeNotes,
  describeWorktreeRemovalError,
  formatWorktreePathForDisplay,
  isWorktreeSafeToDelete,
  summarizeWorktreeSelection,
  type WorktreeCleanupRow,
} from "~/worktreeCleanup";
import {
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { MenuItem } from "../ui/menu";
import { Spinner } from "../ui/spinner";

/** The repository a cleanup reads and deletes in. */
export interface WorktreeCleanupTarget {
  readonly environmentId: EnvironmentId;
  /** Any checkout of the repository; every one lists the same worktrees. */
  readonly cwd: string;
  /** The project root. Removals run here: git cannot remove the folder it stands in. */
  readonly projectCwd: string;
}

/**
 * The cleanup rows for one repository, classified against the active and
 * archived threads of its environment. `worktrees` is undefined until the
 * list has loaded.
 */
function useWorktreeCleanupRows(
  environmentId: EnvironmentId,
  worktrees: readonly VcsWorktreeStatus[] | undefined,
) {
  const environmentIds = useMemo(() => [environmentId], [environmentId]);
  const archived = useArchivedThreadSnapshots(environmentIds);
  const liveThreads = useStore(
    useShallow((state) => selectThreadsForEnvironment(state, environmentId)),
  );
  const archivedThreads = useMemo(
    () => archived.snapshots.flatMap((entry) => entry.snapshot.threads),
    [archived.snapshots],
  );
  // Any failed read leaves the archived threads unknown, even with an older
  // list in hand: a thread archived since then would read as unused.
  const archivedThreadsUnknown = archived.error !== null;
  const rows = useMemo(
    () =>
      classifyWorktreesForCleanup({
        worktrees: worktrees ?? [],
        liveThreads,
        archivedThreads,
        archivedThreadsUnknown,
      }),
    [archivedThreads, archivedThreadsUnknown, liveThreads, worktrees],
  );
  return {
    rows,
    // The archived list decides which rows read as "archived", so rows shown
    // before it lands would pre-check a worktree an archived thread wants.
    archiveLoading:
      archived.isLoading && archived.snapshots.length === 0 && !archivedThreadsUnknown,
    /** A read is in flight, even with an older list in hand. */
    archiveRefreshing: archived.isLoading,
  };
}

/**
 * The branch menu's entry point into worktree cleanup.
 *
 * Mounted only while the branch menu is open. Its count is a hint drawn from
 * whatever list is at hand; the dialog reads a fresh one, so a stale count
 * never turns into a stale deletion.
 */
export function BranchMenuCleanupItem({
  target,
  onOpen,
}: {
  readonly target: WorktreeCleanupTarget;
  readonly onOpen: () => void;
}) {
  const worktreesQuery = useQuery(
    vcsListWorktreesQueryOptions({ environmentId: target.environmentId, cwd: target.cwd }),
  );
  const { rows, archiveLoading } = useWorktreeCleanupRows(
    target.environmentId,
    worktreesQuery.data?.worktrees,
  );
  const unusedCount = rows.filter((row) => row.state === "unused").length;
  const isCounting = worktreesQuery.isPending || archiveLoading;
  // Only a fresh read that found nothing but the main checkout disables it.
  const nothingToClean =
    worktreesQuery.isSuccess && !worktreesQuery.isFetching && rows.length === 0;

  return (
    <MenuItem disabled={nothingToClean} onClick={onOpen}>
      <FolderGit2Icon className="size-3.5" />
      <span>Clean up worktrees...</span>
      {isCounting ? (
        <Spinner className="ms-auto size-3 shrink-0 text-muted-foreground/60 motion-reduce:animate-none" />
      ) : unusedCount > 0 ? (
        <span className="ms-auto shrink-0 text-[10px] text-muted-foreground/60">
          {unusedCount} unused
        </span>
      ) : null}
    </MenuItem>
  );
}

type WorktreeCleanupProgress =
  | { readonly status: "deleting" }
  | { readonly status: "deleted" }
  | { readonly status: "failed"; readonly message: string };

/**
 * Batch cleanup for a project's spare checkouts.
 *
 * Opens on a fresh list rather than whatever the menu last saw, so it never
 * offers a folder that was deleted moments ago. Until a run starts, the rows
 * follow the live thread list; the run freezes them so each keeps its
 * outcome. Deletions run one at a time and report in place, and the ones that
 * fail can be retried without reopening. Mounted fresh per open, which is what
 * resets the ticks and the progress.
 */
export function WorktreeCleanupDialogBody({
  target,
  projectName,
  defaultBranchName,
  onDone,
  onSwitchCheckout,
}: {
  readonly target: WorktreeCleanupTarget;
  readonly projectName: string;
  readonly defaultBranchName: string | null;
  readonly onDone: () => void;
  /** Omitted when no thread is open: there is nothing to move. */
  readonly onSwitchCheckout?: ((row: WorktreeCleanupRow) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const worktreesQuery = useQuery({
    ...vcsListWorktreesQueryOptions({ environmentId: target.environmentId, cwd: target.cwd }),
    refetchOnMount: "always",
  });
  const freshWorktrees =
    worktreesQuery.isFetchedAfterMount && worktreesQuery.isSuccess
      ? worktreesQuery.data.worktrees
      : undefined;
  const live = useWorktreeCleanupRows(target.environmentId, freshWorktrees);
  const [runRows, setRunRows] = useState<readonly WorktreeCleanupRow[] | null>(null);
  const rows = runRows ?? live.rows;
  const listError =
    runRows === null && worktreesQuery.isFetchedAfterMount && worktreesQuery.isError
      ? worktreesQuery.error
      : null;
  // Deletions act on what the dialog shows, so it waits for both fresh reads.
  const isLoading =
    runRows === null &&
    listError === null &&
    (freshWorktrees === undefined || live.archiveRefreshing);

  const cleanableRows = useMemo(() => rows.filter((row) => row.state !== "in-use"), [rows]);
  const inUseRows = useMemo(() => rows.filter((row) => row.state === "in-use"), [rows]);
  // Null until the user changes a tick, so the safe rows stay ticked while
  // the list settles. A row that goes into use drops out either way.
  const [pickedPaths, setPickedPaths] = useState<ReadonlySet<string> | null>(null);
  const selectedPaths = useMemo(() => {
    const picked =
      pickedPaths ?? new Set(cleanableRows.filter(isWorktreeSafeToDelete).map((row) => row.path));
    return new Set(cleanableRows.filter((row) => picked.has(row.path)).map((row) => row.path));
  }, [cleanableRows, pickedPaths]);
  const [progress, setProgress] = useState<ReadonlyMap<string, WorktreeCleanupProgress>>(
    () => new Map(),
  );
  const [isRunning, setIsRunning] = useState(false);
  const hasRun = runRows !== null && !isRunning;
  const locked = runRows !== null;
  const selection = summarizeWorktreeSelection(cleanableRows, selectedPaths);
  const allSelected = cleanableRows.length > 0 && selection.count === cleanableRows.length;
  const showSelectAll = !locked && !isLoading && listError === null && cleanableRows.length > 1;
  const failedRows = hasRun
    ? cleanableRows.filter((row) => progress.get(row.path)?.status === "failed")
    : [];

  const toggleRow = (path: string, checked: boolean) => {
    const next = new Set(selectedPaths);
    if (checked) {
      next.add(path);
    } else {
      next.delete(path);
    }
    setPickedPaths(next);
  };

  const removeRows = async (targets: readonly WorktreeCleanupRow[]) => {
    setRunRows((current) => current ?? rows);
    setIsRunning(true);
    const api = readEnvironmentApi(target.environmentId);
    for (const row of targets) {
      setProgress((current) => new Map(current).set(row.path, { status: "deleting" }));
      try {
        if (!api) {
          throw new Error("Not connected to this computer right now.");
        }
        await api.vcs.removeWorktree({
          cwd: target.projectCwd,
          path: row.path,
          force: true,
          // The row showed its lock and the user ticked it anyway.
          ...(row.lockReason !== null ? { unlock: true } : {}),
        });
        setProgress((current) => new Map(current).set(row.path, { status: "deleted" }));
      } catch (error) {
        setProgress((current) =>
          new Map(current).set(row.path, {
            status: "failed",
            message: describeWorktreeRemovalError(error),
          }),
        );
      }
    }
    setIsRunning(false);
    await invalidateGitQueries(queryClient, { environmentId: target.environmentId });
  };

  const safeCount = cleanableRows.filter(isWorktreeSafeToDelete).length;
  // The count on the menu row promises N unused; explain here why fewer
  // start checked: only the rows whose removal provably loses nothing.
  const preselectionNote =
    cleanableRows.length === 0
      ? ""
      : safeCount === 0
        ? " Each one has something to check first, so none are ticked yet."
        : safeCount < cleanableRows.length
          ? ` The ${safeCount} with nothing to lose ${safeCount === 1 ? "is" : "are"} already ticked; the rest say what deleting them would lose.`
          : "";
  const deletedCount = [...progress.values()].filter((entry) => entry.status === "deleted").length;
  const summary = hasRun
    ? `Deleted ${deletedCount} worktree${deletedCount === 1 ? "" : "s"}.${
        failedRows.length > 0
          ? ` ${failedRows.length} couldn't be deleted; the reason is under ${failedRows.length === 1 ? "it" : "each"}.`
          : ""
      }`
    : isLoading
      ? "Checking which worktrees are safe to delete..."
      : listError !== null
        ? "Couldn't read this project's worktrees."
        : cleanableRows.length === 0
          ? inUseRows.length === 0
            ? `${projectName} has no other worktrees.`
            : "Every worktree is in use."
          : `${projectName} has ${cleanableRows.length} worktree${
              cleanableRows.length === 1 ? "" : "s"
            } no active thread is using.${preselectionNote}`;

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Clean up worktrees</AlertDialogTitle>
        <AlertDialogDescription className="flex items-center gap-2">
          {isLoading ? <Spinner className="size-3.5 shrink-0 motion-reduce:animate-none" /> : null}
          <span>{summary}</span>
        </AlertDialogDescription>
      </AlertDialogHeader>
      {listError !== null ? (
        <p className="-mt-2 px-6 text-muted-foreground text-xs">{listError.message}</p>
      ) : null}
      {showSelectAll ? (
        <div className="-mt-2 flex justify-end px-6 pb-1">
          <Button
            onClick={() =>
              setPickedPaths(
                allSelected ? new Set() : new Set(cleanableRows.map((row) => row.path)),
              )
            }
            size="xs"
            variant="ghost"
          >
            {allSelected ? "Select none" : `Select all ${cleanableRows.length}`}
          </Button>
        </div>
      ) : null}
      {/* Sides match the header's p-6; the popup itself is unpadded. */}
      <div className={cn("max-h-72 overflow-y-auto px-6", !showSelectAll && "-mt-2")}>
        {isLoading || listError !== null
          ? null
          : cleanableRows.map((row) => {
              const notes = describeWorktreeNotes(row, defaultBranchName);
              const rowProgress = progress.get(row.path);
              return (
                <div
                  className="flex items-start gap-2.5 border-border/55 border-b py-2 last:border-b-0"
                  key={row.path}
                  title={row.path}
                >
                  {/* The label stops short of the switch button so clicking that
                      button never doubles as a tick. */}
                  <label className="flex min-w-0 flex-1 items-start gap-2.5">
                    <Checkbox
                      checked={selectedPaths.has(row.path)}
                      className="mt-0.5"
                      disabled={locked}
                      onCheckedChange={(checked) => toggleRow(row.path, checked === true)}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-sm">
                          {formatWorktreePathForDisplay(row.path)}
                        </span>
                        {row.refName ? (
                          <span className="truncate text-muted-foreground text-xs">
                            {row.refName}
                          </span>
                        ) : null}
                      </span>
                      {notes.length > 0 ? (
                        <span className="text-muted-foreground text-xs">{notes.join(", ")}</span>
                      ) : null}
                      {rowProgress?.status === "failed" ? (
                        <span className="text-destructive-foreground text-xs">
                          {rowProgress.message}
                        </span>
                      ) : null}
                    </span>
                  </label>
                  {rowProgress ? (
                    <span className="mt-1 shrink-0 text-[10px] text-muted-foreground">
                      {rowProgress.status === "deleting"
                        ? "deleting"
                        : rowProgress.status === "deleted"
                          ? "deleted"
                          : "failed"}
                    </span>
                  ) : null}
                  {onSwitchCheckout &&
                  row.refName &&
                  !row.missing &&
                  rowProgress?.status !== "deleted" ? (
                    <Button
                      aria-label={`Switch checkout to ${formatWorktreePathForDisplay(row.path)}`}
                      className="shrink-0"
                      disabled={locked}
                      onClick={() => onSwitchCheckout(row)}
                      size="icon-xs"
                      tooltip="Switch checkout here"
                      variant="ghost"
                    >
                      <FolderGit2Icon />
                    </Button>
                  ) : null}
                </div>
              );
            })}
        {isLoading || listError !== null
          ? null
          : inUseRows.map((row) => (
              <div
                className="flex items-baseline gap-2 border-border/55 border-b py-2 opacity-64 last:border-b-0"
                key={row.path}
                title={row.path}
              >
                <span className="truncate text-sm">{formatWorktreePathForDisplay(row.path)}</span>
                {row.refName ? (
                  <span className="truncate text-muted-foreground text-xs">{row.refName}</span>
                ) : null}
                <span
                  className="ms-auto max-w-[50%] shrink-0 truncate text-[10px] text-muted-foreground"
                  title={row.blockingThreadTitles.join("\n")}
                >
                  {describeWorktreeHolder(row)}
                </span>
              </div>
            ))}
      </div>
      <AlertDialogFooter className="mt-4">
        {hasRun ? (
          <>
            {failedRows.length > 0 ? (
              <Button
                onClick={() => {
                  void removeRows(failedRows);
                }}
                size="sm"
                variant="outline"
              >
                {failedRows.length === 1 ? "Try again" : `Try ${failedRows.length} again`}
              </Button>
            ) : null}
            <Button onClick={onDone} size="sm">
              Close
            </Button>
          </>
        ) : listError !== null ? (
          <>
            <AlertDialogClose render={<Button size="sm" variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              onClick={() => {
                void worktreesQuery.refetch();
              }}
              size="sm"
            >
              Try again
            </Button>
          </>
        ) : (
          <>
            <AlertDialogClose disabled={isRunning} render={<Button size="sm" variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={isLoading || selection.count === 0 || isRunning}
              onClick={() => {
                void removeRows(cleanableRows.filter((row) => selectedPaths.has(row.path)));
              }}
              size="sm"
              variant={selection.hasRisky ? "destructive" : "default"}
            >
              {isRunning
                ? "Deleting..."
                : `Delete ${selection.count} worktree${selection.count === 1 ? "" : "s"}`}
            </Button>
          </>
        )}
      </AlertDialogFooter>
    </>
  );
}

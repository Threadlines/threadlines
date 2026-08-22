import {
  type ContextMenuItem,
  type EnvironmentId,
  type GitActionProgressEvent,
  type GitRemoteAuthFailure,
  type GitStackedAction,
  type ModelSelection,
  type ProviderReviewTarget,
  type RuntimeMode,
  type ScopedThreadRef,
  type VcsCommitDetailsResult,
  type VcsCommitGraphCommit,
  type VcsPullHistoryReconciliation,
  type VcsPullResult,
  type VcsRef,
  type VcsStashEntry,
  type VcsStatusResult,
  type VcsWorkingTreeFileChangeKind,
} from "@threadlines/contracts";
import { scopeProjectRef, scopeThreadRef } from "@threadlines/client-runtime";
import { formatGitErrorMessage, gitRemoteAuthFailureFromError } from "@threadlines/shared/git";
import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ArchiveIcon,
  CheckIcon,
  CloudIcon,
  CloudUploadIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderClosedIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  ListTreeIcon,
  DownloadIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
  Rows3Icon,
  SparklesIcon,
  TagIcon,
  TriangleAlertIcon,
  Trash2Icon,
  Undo2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Schema from "effect/Schema";
import { useShallow } from "zustand/react/shallow";

import { openInPreferredEditor } from "~/editorPreferences";
import { openFileInActiveViewer } from "~/fileViewerStore";
import { readEnvironmentApi, useEnvironmentApiAvailable } from "~/environmentApi";
import {
  gitBranchSearchInfiniteQueryOptions,
  gitApplyStashMutationOptions,
  gitCommitDetailsQueryOptions,
  gitCheckoutMutationOptions,
  gitCommitGraphQueryOptions,
  gitCreateTagMutationOptions,
  gitCreateStashMutationOptions,
  gitDeleteBranchMutationOptions,
  gitDropStashMutationOptions,
  gitDiscardChangesMutationOptions,
  gitGenerateCommitMessageMutationOptions,
  gitInitMutationOptions,
  gitMergeRefMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitQueryKeys,
  gitRunStackedActionMutationOptions,
  gitStartProviderReviewMutationOptions,
  gitStashesQueryOptions,
  invalidateGitQueries,
  gitStageChangesMutationOptions,
  gitUnstageChangesMutationOptions,
  vcsListWorktreesQueryOptions,
} from "~/lib/gitReactQuery";
import {
  GIT_STATUS_STALE_MESSAGE,
  rebuildGitStatusSubscription,
  refreshGitStatus,
  refreshLocalGitStatus,
  useGitStatus,
} from "~/lib/gitStatusState";
import { copyTextToClipboard } from "~/lib/clipboard";
import { cn, newCommandId, newThreadId, randomUUID } from "~/lib/utils";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useSettings } from "~/hooks/useSettings";
import { useCheckoutRecovery } from "~/hooks/useCheckoutRecovery";
import { readLocalApi } from "~/localApi";
import { useComposerDraftStore } from "~/composerDraftStore";
import {
  resolveProviderReviewContext,
  type ProviderReviewThreadBootstrap,
} from "~/lib/providerReview";
import { getAppModelOptionsForInstance } from "~/modelSelection";
import { useServerProviders } from "~/rpc/serverState";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { selectThreadsForEnvironment, useStore } from "~/store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "~/storeSelectors";
import { buildThreadRouteParams } from "~/threadRoutes";
import { resolvePathLinkTarget } from "~/terminal-links";
import {
  classifyWorktreesForCleanup,
  describeWorktreeRisks,
  formatWorktreePathForDisplay,
  getVcsRefBadge,
  isWorktreeSafeToDelete,
  summarizeWorktreeSelection,
  type WorktreeCleanupRow,
} from "~/worktreeCleanup";
import { useArchivedThreadSnapshots } from "~/lib/archivedThreadsState";
import { PublishRepositoryDialog } from "../GitActionsControl";
import { GitAuthRemediationDialog } from "./GitAuthRemediationDialog";
import { ProviderReviewDialog } from "./ProviderReviewDialog";
import { SourceControlIcon } from "../Icons";
import { SourceControlLinksMenu } from "./SourceControlLinksMenu";
import { deriveSourceControlQuickLinks } from "~/lib/sourceControlQuickLinks";
import {
  buildGitActionProgressStages,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  type DefaultBranchConfirmableAction,
} from "../GitActionsControl.logic";
import {
  dispatchGitActionProgressEvent,
  finishGitActionProgress,
  startGitActionProgress,
  useGitActionProgressView,
} from "../gitActionProgressState";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { SectionLabel } from "../ui/threadline";
import { stackedThreadToast, toastManager, type ThreadToastData } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger, TooltipWrapper } from "../ui/tooltip";
import {
  buildCommitGraphDetailRefs,
  buildCommitGraphDisplayRefs,
  buildCommitGraphRows,
  buildSourceControlFileTree,
  collectSourceControlFileTreeDirectoryPaths,
  type CommitGraphDisplayRef,
  type CommitGraphLaneLayout,
  type CommitGraphRefKind,
  formatCommitGraphDateTime,
  formatCommitGraphParentSummary,
  formatCommitGraphTimestamp,
  getCommitGraphRefKind,
  getVisibleCommitGraphRefs,
  normalizeCommitGraphRefName,
  resolveCommitGraphErrorPresentation,
  resolveSourceControlPrimaryAction,
  type SourceControlFileTreeNode,
  takeCommitGraphRowRefs,
} from "./SourceControlPanel.logic";
import {
  hasActiveThreadTurn,
  queuedCheckoutSwitchToast,
  resolveBranchSelectionTarget,
} from "../BranchToolbar.logic";
import { threadWorkingCwdLabel } from "@threadlines/shared/threadCwd";

export interface SourceControlProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string;
  readonly cwd: string;
  readonly name: string;
  readonly environmentLabel: string | null;
  readonly worktreePath: string | null;
  /**
   * The provider session's observed working directory when it moved away
   * from the configured checkout (agent entered a worktree mid-session).
   * When set, `cwd` already points at it; the header surfaces it as a
   * "working in" chip so the divergence is never silent.
   */
  readonly effectiveCwd: string | null;
}

interface SourceControlPanelProps {
  readonly target: SourceControlProjectTarget | null;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly onActiveBranchChange?:
    | ((branch: string | null, worktreePath: string | null) => void)
    | undefined;
  readonly onOpenDiff?: (filePath?: string) => void;
  /** Warm the diff chunk + working tree diff query before a likely diff open. */
  readonly onPrefetchDiff?: () => void;
  /**
   * Closes the containing right panel. Surfaced as an in-panel ✕ on phone
   * widths, where the sheet spans the full screen and the header toggle is easy
   * to miss. Ignored when embedded: the tab strip owns the dismissal there.
   */
  readonly onClose?: () => void;
  /**
   * Set when the panel renders inside the sidebar's tab strip, which already
   * carries the window chrome, the panel's name and its dismissal. The panel
   * then leads with the repository row instead of a title row of its own.
   */
  readonly embedded?: boolean;
}

type WorkingTreeFile = VcsStatusResult["workingTree"]["files"][number];
type WorkingTreeChangeSection = "staged" | "unstaged";
type ChangedFileContextAction = "open-diff" | "open-viewer" | "open-editor";

interface WorkingTreeSectionFile {
  readonly file: WorkingTreeFile;
  readonly path: string;
  readonly section: WorkingTreeChangeSection;
  readonly status: VcsWorkingTreeFileChangeKind;
  readonly insertions: number;
  readonly deletions: number;
}

const EMPTY_WORKING_TREE_FILES: readonly WorkingTreeFile[] = [];
const EMPTY_COMMIT_GRAPH_COMMITS: readonly VcsCommitGraphCommit[] = [];

interface PendingDiscardChanges {
  readonly filePaths: string[];
  readonly label: string;
  readonly count: number;
  readonly includesNewFiles: boolean;
  readonly scope: "all" | "unstaged";
}

interface PendingDeleteBranch {
  readonly branchName: string;
  readonly commit: VcsCommitGraphCommit;
}

interface PendingProviderReview {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly target: ProviderReviewTarget;
  readonly targetDescription: string;
  readonly threadTitle: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly bootstrap: ProviderReviewThreadBootstrap;
}

type HistoryReconciliationRequiredResult = Extract<
  VcsPullResult,
  { readonly status: "requires_history_reconciliation" }
>;

interface PullRequestTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

interface PendingHistoryReconciliation extends PullRequestTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly result: HistoryReconciliationRequiredResult;
}

interface PendingStashRecovery extends PullRequestTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly title: string;
  readonly detail: string;
  readonly stashId: string;
  readonly recoveryRef: string | null;
  readonly conflictedPaths: readonly string[];
}

function isSamePullRequestTarget(a: PullRequestTarget, b: PullRequestTarget): boolean {
  return a.environmentId === b.environmentId && a.cwd === b.cwd;
}

const WORKING_TREE_CHANGE_STATUS_CODES: Record<VcsWorkingTreeFileChangeKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  unmerged: "U",
  untracked: "U",
};

const WORKING_TREE_CHANGE_STATUS_LABELS: Record<VcsWorkingTreeFileChangeKind, string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  unmerged: "Unmerged",
  untracked: "Untracked",
};

function splitPath(filePath: string): { readonly name: string; readonly directory: string } {
  const parts = filePath.split(/[\\/]/g).filter(Boolean);
  const name = parts.at(-1) ?? filePath;
  return {
    name,
    directory: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
  };
}

function workingTreeFileSectionStats(
  file: WorkingTreeFile,
  section: WorkingTreeChangeSection,
): { readonly insertions: number; readonly deletions: number } {
  if (section === "staged") {
    return {
      insertions: file.stagedInsertions ?? file.insertions,
      deletions: file.stagedDeletions ?? file.deletions,
    };
  }
  return {
    insertions: file.unstagedInsertions ?? file.insertions,
    deletions: file.unstagedDeletions ?? file.deletions,
  };
}

function toWorkingTreeSectionFile(
  file: WorkingTreeFile,
  section: WorkingTreeChangeSection,
): WorkingTreeSectionFile | null {
  const status = section === "staged" ? file.indexStatus : file.worktreeStatus;
  if (!status) {
    return null;
  }
  const stats = workingTreeFileSectionStats(file, section);
  return {
    file,
    path: file.path,
    section,
    status,
    insertions: stats.insertions,
    deletions: stats.deletions,
  };
}

function workingTreeChangeStatusCode(kind: VcsWorkingTreeFileChangeKind | null | undefined) {
  return kind ? WORKING_TREE_CHANGE_STATUS_CODES[kind] : null;
}

function formatWorkingTreeFileStatus(entry: WorkingTreeSectionFile): string {
  if (entry.section === "unstaged" && entry.status === "untracked") {
    return "U";
  }
  return workingTreeChangeStatusCode(entry.status) ?? "M";
}

function describeWorkingTreeFileStatus(entry: WorkingTreeSectionFile): string {
  const parts: string[] = [];
  if (entry.section === "staged") {
    parts.push(`Index: ${WORKING_TREE_CHANGE_STATUS_LABELS[entry.status]}`);
  } else {
    parts.push(
      entry.status === "untracked"
        ? WORKING_TREE_CHANGE_STATUS_LABELS[entry.status]
        : `Working tree: ${WORKING_TREE_CHANGE_STATUS_LABELS[entry.status]}`,
    );
  }
  if (entry.file.originalPath) {
    parts.push(`From ${entry.file.originalPath}`);
  }
  return parts.length > 0 ? parts.join(". ") : "Changed";
}

/** One color language with the diff panel cards: green new, red deleted or
 * conflicted, amber modified. */
function workingTreeFileStatusClassName(entry: WorkingTreeSectionFile): string {
  if (entry.status === "unmerged") {
    return "border-destructive/25 bg-destructive/8 text-destructive-foreground";
  }
  if (entry.status === "deleted") {
    return "border-destructive/25 bg-destructive/8 text-destructive-foreground";
  }
  if (entry.status === "added" || entry.status === "untracked") {
    return "border-success/25 bg-success/8 text-success-foreground";
  }
  return "border-warning/25 bg-warning/8 text-warning-foreground";
}

function buildDiscardChangesDescription(pending: PendingDiscardChanges): string {
  if (pending.scope === "unstaged") {
    const scope =
      pending.count === 1
        ? `Discard unstaged changes to ${pending.label}.`
        : `Discard unstaged changes in ${pending.count} files.`;
    const removal = pending.includesNewFiles ? " Untracked files will be deleted." : "";
    return `${scope} Staged changes will be preserved.${removal} This cannot be undone.`;
  }
  const scope =
    pending.count === 1
      ? `Discard changes to ${pending.label}.`
      : `Discard changes in ${pending.count} files.`;
  const removal = pending.includesNewFiles ? " New or untracked files will be deleted." : "";
  return `${scope} Tracked changes will be restored to HEAD when possible.${removal} This cannot be undone.`;
}

function actionDisabledReason(input: {
  readonly status: VcsStatusResult | null;
  readonly action: "commit" | "commit_push" | "pull" | "push" | "create_pr";
  readonly isBusy: boolean;
  readonly repositorySafetyReason?: string | null;
}): string | null {
  if (input.repositorySafetyReason) {
    return input.repositorySafetyReason;
  }
  if (input.isBusy) {
    return "Git action in progress.";
  }
  const status = input.status;
  if (!status?.isRepo) {
    return "No Git repository.";
  }
  if (input.action === "commit") {
    return status.hasWorkingTreeChanges ? null : "No working tree changes.";
  }
  if (input.action === "commit_push") {
    if (!status.hasWorkingTreeChanges) {
      return "No working tree changes.";
    }
    if (status.refName === null) {
      return "Detached HEAD.";
    }
    if (status.behindCount > 0) {
      return "Branch is behind upstream.";
    }
    if (!status.hasUpstream && !status.hasPrimaryRemote) {
      return "No primary remote.";
    }
    return null;
  }
  if (input.action === "pull") {
    if (status.refName === null) {
      return "Detached HEAD.";
    }
    if (status.hasWorkingTreeChanges) {
      if (
        status.workingTree.files.some(
          (file) => file.indexStatus === "unmerged" || file.worktreeStatus === "unmerged",
        )
      ) {
        return "Resolve merge conflicts first.";
      }
      if (status.aheadCount > 0 && status.behindCount > 0) {
        return "Commit or stash changes before resolving branch divergence.";
      }
    }
    return status.behindCount > 0 ? null : "Branch is up to date.";
  }

  if (status.refName === null) {
    return "Detached HEAD.";
  }
  if (status.hasWorkingTreeChanges) {
    return "Commit changes first.";
  }
  if (status.behindCount > 0) {
    return "Branch is behind upstream.";
  }
  if (!status.hasUpstream && !status.hasPrimaryRemote) {
    return "No primary remote.";
  }
  if (input.action === "push") {
    if (!status.hasUpstream && status.hasPrimaryRemote && !status.isDefaultRef) {
      return null;
    }
    return status.aheadCount > 0 ? null : "No local commits to push.";
  }
  if (status.pr?.state === "open") {
    return null;
  }
  return (status.aheadOfDefaultCount ?? status.aheadCount) > 0
    ? null
    : "No branch commits to include.";
}

function ActionButton({
  label,
  icon,
  disabledReason,
  onClick,
  variant = "outline",
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabledReason: string | null;
  readonly onClick: () => void;
  readonly variant?: "default" | "outline";
}) {
  const button = (
    <Button
      variant={variant}
      size="xs"
      disabled={disabledReason !== null}
      onClick={disabledReason === null ? onClick : undefined}
      className="w-full min-w-0 justify-center"
    >
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  );

  if (disabledReason === null) {
    return button;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="min-w-0" />}>{button}</TooltipTrigger>
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  );
}

type CommitGraphContextAction =
  | "copy-full-sha"
  | "copy-title"
  | "copy-full-message"
  | "open-commit"
  | "review-commit"
  | "create-tag"
  | `delete-branch:${string}`;

function getDeletableCommitGraphBranchRefs(
  refs: readonly string[],
  currentBranch: string | null | undefined,
): string[] {
  const seen = new Set<string>();
  const branchNames: string[] = [];
  for (const refName of getVisibleCommitGraphRefs(refs)) {
    if (getCommitGraphRefKind(refName, currentBranch) !== "branch") {
      continue;
    }
    const branchName = normalizeCommitGraphRefName(refName);
    if (branchName === currentBranch || seen.has(branchName)) {
      continue;
    }
    seen.add(branchName);
    branchNames.push(branchName);
  }
  return branchNames;
}

function getCommitGraphStatusRefreshKey(status: VcsStatusResult | null | undefined): string | null {
  if (!status?.isRepo) {
    return null;
  }

  return [
    status.refName ?? "",
    status.headSha ?? "",
    status.hasPrimaryRemote ? "1" : "0",
    status.isDefaultRef ? "1" : "0",
    status.hasUpstream ? "1" : "0",
    String(status.aheadCount),
    String(status.behindCount),
    String(status.aheadOfDefaultCount ?? 0),
  ].join("\0");
}

function commitGraphRefClassName(kind: CommitGraphRefKind) {
  if (kind === "current") {
    return "border-primary-graph/70 bg-primary/16 text-primary-readable";
  }
  if (kind === "remote") {
    return "border-warning/18 bg-warning/5 text-warning-foreground/55";
  }
  if (kind === "tag") {
    return "border-border/55 bg-muted/30 text-muted-foreground";
  }
  return "border-warning/14 bg-warning/4 text-warning-foreground/45";
}

function CommitGraphRefChip({
  displayRef,
  className,
}: {
  readonly displayRef: CommitGraphDisplayRef;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 shrink items-center overflow-hidden rounded-sm border font-mono text-[10px] leading-none",
        commitGraphRefClassName(displayRef.kind),
        className,
      )}
    >
      {displayRef.cloudBadge === "remote" ? (
        // A leading cloud (inline, no divider) marks a remote-only ref and
        // stands in for the primary remote's stripped origin/ prefix.
        <CloudIcon aria-hidden="true" className="ml-1 size-2.5 shrink-0 opacity-70" />
      ) : null}
      <span className="min-w-0 truncate px-1 py-0.5">{displayRef.label}</span>
      {displayRef.cloudBadge === "synced" ? (
        // A same-named remote branch points at this commit too. The divider
        // gives the cloud its own segment so the pill reads as two refs
        // sharing one chip, not as "this branch is the remote".
        <span className="flex shrink-0 items-center self-stretch border-l border-inherit px-1">
          <CloudIcon aria-hidden="true" className="size-2.5 opacity-70" />
        </span>
      ) : null}
    </span>
  );
}

const COMMIT_GRAPH_LANE_GAP = 12;
const COMMIT_GRAPH_LEFT_PADDING = 8;
const COMMIT_GRAPH_ROW_HEIGHT = 28;
const COMMIT_GRAPH_NODE_Y = 14;
// Line weight matches the brand threadline figure (thin strokes, small nodes).
const COMMIT_GRAPH_NODE_RADIUS = 3;
const COMMIT_GRAPH_NODE_GAP = COMMIT_GRAPH_NODE_RADIUS + 1.5;
const COMMIT_GRAPH_STROKE_WIDTH = 1.5;

// Lane 0 is reserved for the "main line" (the leftmost lane carrying the current branch
// in typical workflows). Side lanes rotate through distinct hues so adjacent branches
// stay visually distinguishable without looking decorative.
const COMMIT_GRAPH_LANE_STROKE = [
  "stroke-primary-graph",
  "stroke-amber-400",
  "stroke-emerald-400",
  "stroke-pink-400",
  "stroke-cyan-400",
  "stroke-violet-400",
  "stroke-muted-foreground",
] as const;

const COMMIT_GRAPH_LANE_FILL = [
  "fill-primary-graph",
  "fill-amber-400",
  "fill-emerald-400",
  "fill-pink-400",
  "fill-cyan-400",
  "fill-violet-400",
  "fill-muted-foreground",
] as const;

function commitGraphLaneStrokeClass(lane: number) {
  return COMMIT_GRAPH_LANE_STROKE[lane % COMMIT_GRAPH_LANE_STROKE.length];
}

function commitGraphLaneFillClass(lane: number) {
  return COMMIT_GRAPH_LANE_FILL[lane % COMMIT_GRAPH_LANE_FILL.length];
}

function commitGraphLaneOpacity(_lane: number) {
  return 1;
}

// Cross-lane curves always carry the SIDE lane's identity, regardless of direction.
// A curve from main (0) → side (1) starts a side branch; a curve from side (1) → main (0)
// closes it. In both cases the curve belongs to the side branch, so it should pick up
// the higher lane index's color, never the main lane's color.
function commitGraphCurveLane(fromLane: number, toLane: number): number {
  return Math.max(fromLane, toLane);
}

function commitGraphLaneX(lane: number) {
  return COMMIT_GRAPH_LEFT_PADDING + lane * COMMIT_GRAPH_LANE_GAP;
}

function CommitGraphGlyph({
  layout,
  highlighted,
  mergeCommit,
}: {
  readonly layout: CommitGraphLaneLayout;
  readonly highlighted: boolean;
  readonly mergeCommit: boolean;
}) {
  const width = commitGraphLaneX(layout.laneCount - 1) + COMMIT_GRAPH_LEFT_PADDING;
  const rowHeight = COMMIT_GRAPH_ROW_HEIGHT;
  const rowCenterY = COMMIT_GRAPH_NODE_Y;
  const nodeY = rowCenterY;
  const radius = COMMIT_GRAPH_NODE_RADIUS;
  const gap = COMMIT_GRAPH_NODE_GAP;
  const nodeX = commitGraphLaneX(layout.lane);
  const crossLanePaths = layout.parentPaths.filter((path) => path.fromLane !== path.toLane);
  const deferredClosingPaths = crossLanePaths.filter((path) => path.toLane < path.fromLane);
  const rowCrossLanePaths = crossLanePaths.filter((path) => path.toLane >= path.fromLane);
  const deferredClosingLanes = new Set(deferredClosingPaths.map((path) => path.fromLane));
  const hasCurrentLaneBottomSegment =
    deferredClosingLanes.has(layout.lane) ||
    layout.parentPaths.some((path) => path.fromLane === layout.lane && path.toLane === layout.lane);
  const bottomLaneCandidates = new Set(layout.bottomLanes);
  for (const path of deferredClosingPaths) {
    bottomLaneCandidates.add(path.fromLane);
  }
  const topLaneSet = new Set(layout.topLanes);
  const visibleBottomLanes = Array.from(bottomLaneCandidates).filter((bottomLane) => {
    if (bottomLane === layout.lane) {
      return hasCurrentLaneBottomSegment;
    }
    if (deferredClosingLanes.has(bottomLane)) {
      return true;
    }
    return topLaneSet.has(bottomLane);
  });

  return (
    <svg
      aria-hidden="true"
      className="block overflow-visible"
      width={width}
      height={rowHeight}
      viewBox={`0 0 ${width} ${rowHeight}`}
    >
      {layout.topLanes.map((lane) => {
        const x = commitGraphLaneX(lane);
        const y2 = lane === layout.lane ? nodeY - gap : rowCenterY;
        return (
          <line
            key={`top-${lane}`}
            x1={x}
            y1={0}
            x2={x}
            y2={y2}
            className={commitGraphLaneStrokeClass(lane)}
            strokeWidth={COMMIT_GRAPH_STROKE_WIDTH}
            strokeLinecap="round"
            opacity={commitGraphLaneOpacity(lane)}
          />
        );
      })}
      {visibleBottomLanes.map((lane) => {
        const x = commitGraphLaneX(lane);
        const y1 = lane === layout.lane ? nodeY + gap : rowCenterY;
        return (
          <line
            key={`bottom-${lane}`}
            x1={x}
            y1={y1}
            x2={x}
            y2={rowHeight}
            className={commitGraphLaneStrokeClass(lane)}
            strokeWidth={COMMIT_GRAPH_STROKE_WIDTH}
            strokeLinecap="round"
            opacity={commitGraphLaneOpacity(lane)}
          />
        );
      })}
      {rowCrossLanePaths.map((path) => {
        const fromX = commitGraphLaneX(path.fromLane);
        const toX = commitGraphLaneX(path.toLane);
        const startY = nodeY + gap;
        const curveLane = commitGraphCurveLane(path.fromLane, path.toLane);
        return (
          <path
            key={`path-${path.fromLane}-${path.toLane}`}
            d={`M ${fromX} ${startY} C ${fromX} ${rowHeight}, ${toX} ${startY}, ${toX} ${rowHeight}`}
            className={commitGraphLaneStrokeClass(curveLane)}
            fill="none"
            strokeWidth={COMMIT_GRAPH_STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={commitGraphLaneOpacity(curveLane)}
          />
        );
      })}
      {deferredClosingPaths.map((path) => {
        const fromX = commitGraphLaneX(path.fromLane);
        const toX = commitGraphLaneX(path.toLane);
        const endY = rowHeight + rowCenterY - gap;
        const curveLane = commitGraphCurveLane(path.fromLane, path.toLane);
        return (
          <path
            key={`deferred-path-${path.fromLane}-${path.toLane}`}
            d={`M ${fromX} ${rowHeight} C ${fromX} ${endY}, ${toX} ${rowHeight}, ${toX} ${endY}`}
            className={commitGraphLaneStrokeClass(curveLane)}
            fill="none"
            strokeWidth={COMMIT_GRAPH_STROKE_WIDTH}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={commitGraphLaneOpacity(curveLane)}
          />
        );
      })}
      {highlighted ? (
        <>
          {/* The panel's one live node: the tip of the branch you are on. */}
          <circle
            className="thread-halo fill-primary-graph"
            cx={nodeX}
            cy={nodeY}
            r={radius + 1.5}
          />
          <circle
            cx={nodeX}
            cy={nodeY}
            r={radius + 1.5}
            className="fill-background stroke-primary-graph"
            strokeWidth={COMMIT_GRAPH_STROKE_WIDTH}
          />
          <circle
            cx={nodeX}
            cy={nodeY}
            r={radius - 1}
            className={commitGraphLaneFillClass(layout.lane)}
          />
        </>
      ) : mergeCommit ? (
        <circle
          cx={nodeX}
          cy={nodeY}
          r={radius}
          className={cn("fill-background", commitGraphLaneStrokeClass(layout.lane))}
          strokeWidth={COMMIT_GRAPH_STROKE_WIDTH}
          opacity={commitGraphLaneOpacity(layout.lane)}
        />
      ) : (
        <circle
          cx={nodeX}
          cy={nodeY}
          r={radius}
          className={commitGraphLaneFillClass(layout.lane)}
          opacity={commitGraphLaneOpacity(layout.lane)}
        />
      )}
    </svg>
  );
}

function CommitGraphDetailRow({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground/70">{label}</span>
      <span className="min-w-0 text-popover-foreground">{children}</span>
    </div>
  );
}

const COMMIT_DETAILS_VIEWPORT_PADDING = 8;
const COMMIT_DETAILS_GRAPH_SCROLL_CLOSE_THRESHOLD_PX = 12;
const COMMIT_DETAILS_COPIED_FEEDBACK_MS = 1_600;

type CopyCommitValueOptions = {
  readonly successToast?: boolean;
};

function useViewportConstrainedCommitCard(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const [offsetY, setOffsetY] = useState(0);

  useLayoutEffect(() => {
    if (!enabled) {
      offsetRef.current = 0;
      setOffsetY(0);
      return;
    }

    const element = ref.current;
    if (!element) {
      return;
    }

    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const currentOffset = offsetRef.current;
      const baseTop = rect.top - currentOffset;
      const baseBottom = rect.bottom - currentOffset;
      let nextOffset = 0;

      const bottomOverflow = baseBottom - (window.innerHeight - COMMIT_DETAILS_VIEWPORT_PADDING);
      if (bottomOverflow > 0) {
        nextOffset -= bottomOverflow;
      }

      const topOverflow = COMMIT_DETAILS_VIEWPORT_PADDING - (baseTop + nextOffset);
      if (topOverflow > 0) {
        nextOffset += topOverflow;
      }

      if (Math.abs(nextOffset - currentOffset) < 0.5) {
        return;
      }

      offsetRef.current = nextOffset;
      setOffsetY(nextOffset);
    };
    const scheduleUpdate = () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(update);
    };

    update();

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    resizeObserver?.observe(element);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [enabled]);

  return { offsetY, ref };
}

function CommitGraphHoverCard({
  commit,
  currentBranch,
  details,
  detailsError,
  detailsLoading,
  pinned,
  onClose,
  onCopyCommitValue,
  onCopyFullMessage,
  onOpenCommitUrl,
}: {
  readonly commit: VcsCommitGraphCommit;
  readonly currentBranch: string | null | undefined;
  readonly details: VcsCommitDetailsResult | null | undefined;
  readonly detailsError: Error | null;
  readonly detailsLoading: boolean;
  readonly pinned: boolean;
  readonly onClose: () => void;
  readonly onCopyCommitValue: (value: string, title: string) => void;
  readonly onCopyFullMessage: (
    commit: VcsCommitGraphCommit,
    options?: CopyCommitValueOptions,
  ) => Promise<boolean>;
  readonly onOpenCommitUrl: (commit: VcsCommitGraphCommit) => void;
}) {
  const [copyFullMessageState, setCopyFullMessageState] = useState<"idle" | "copied">("idle");
  const absoluteDate = formatCommitGraphDateTime(commit.committedAt);
  const relativeDate = formatCommitGraphTimestamp(commit.committedAt);
  const parentSummary = formatCommitGraphParentSummary(commit.parents.length);
  const displayRefs = buildCommitGraphDetailRefs(commit.refs, currentBranch);
  const messageBody = details?.body.trim() || details?.message.trim() || "";
  const canOpenCommit = Boolean(details?.commitUrl);
  const fullMessageCopied = copyFullMessageState === "copied";

  useEffect(() => {
    setCopyFullMessageState("idle");
  }, [commit.sha]);

  useEffect(() => {
    if (!fullMessageCopied) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setCopyFullMessageState("idle");
    }, COMMIT_DETAILS_COPIED_FEEDBACK_MS);
    return () => window.clearTimeout(timeout);
  }, [fullMessageCopied]);

  return (
    <div
      className="flex max-h-[min(calc(100vh-1rem),var(--available-height,100vh))] w-80 max-w-[calc(100vw-2rem)] flex-col gap-2.5 overflow-x-hidden overflow-y-auto p-1 text-left"
      data-commit-details-surface
    >
      <div className="shrink-0 space-y-1">
        <div className="flex min-w-0 items-start gap-2">
          <div className="line-clamp-2 min-w-0 flex-1 text-xs font-medium leading-snug text-popover-foreground">
            {commit.subject || "Untitled commit"}
          </div>
          {pinned ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-6"
              aria-label="Close commit details"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }}
            >
              <XIcon className="size-3" />
            </Button>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded-sm bg-muted px-1.5 py-1 font-mono text-[10px] text-muted-foreground">
            {commit.sha}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-6"
            aria-label="Copy commit id"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onCopyCommitValue(commit.sha, "Commit id");
            }}
          >
            <CopyIcon className="size-3" />
          </Button>
        </div>
      </div>

      <div className="shrink-0 space-y-1.5 text-[11px] leading-tight">
        <CommitGraphDetailRow label="Author">
          <span className="truncate">{commit.authorName || "Unknown author"}</span>
        </CommitGraphDetailRow>
        <CommitGraphDetailRow label="Date">
          <span className="truncate">
            {absoluteDate || "Unknown date"}
            {relativeDate ? (
              <span className="text-muted-foreground/70"> ({relativeDate})</span>
            ) : null}
          </span>
        </CommitGraphDetailRow>
        <CommitGraphDetailRow label="Parents">
          <span className="truncate">{parentSummary}</span>
        </CommitGraphDetailRow>
        {displayRefs.length > 0 ? (
          <CommitGraphDetailRow label="Refs">
            <span className="flex min-w-0 flex-wrap gap-1">
              {displayRefs.map((displayRef) => (
                <CommitGraphRefChip
                  key={displayRef.refName}
                  displayRef={displayRef}
                  className="max-w-full"
                />
              ))}
            </span>
          </CommitGraphDetailRow>
        ) : null}
      </div>

      {pinned ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 border-t border-border/70 pt-2">
          <div className="max-h-32 min-h-12 overflow-auto rounded-md border border-border/70 bg-muted/35 p-2">
            {detailsLoading ? (
              <div className="text-[11px] text-muted-foreground">Loading full message...</div>
            ) : detailsError ? (
              <div className="text-[11px] text-destructive-foreground">
                {detailsError.message || "Failed to load commit details."}
              </div>
            ) : messageBody.length > 0 ? (
              <pre className="whitespace-pre-wrap font-mono text-[10px] leading-snug text-popover-foreground">
                {messageBody}
              </pre>
            ) : (
              <div className="text-[11px] text-muted-foreground">No commit message.</div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className={cn(
                "min-w-[8.75rem] justify-center transition-colors",
                fullMessageCopied && "bg-success/10 text-success",
              )}
              disabled={detailsLoading}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                void onCopyFullMessage(commit, { successToast: false }).then((copied) => {
                  if (copied) {
                    setCopyFullMessageState("copied");
                  }
                });
              }}
            >
              {fullMessageCopied ? (
                <CheckIcon className="size-3" />
              ) : (
                <CopyIcon className="size-3" />
              )}
              <span>{fullMessageCopied ? "Copied" : "Copy full message"}</span>
            </Button>
            {canOpenCommit ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenCommitUrl(commit);
                }}
              >
                <ExternalLinkIcon className="size-3" />
                <span>Open on GitHub</span>
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="shrink-0 border-t border-border/70 pt-1.5 text-[10px] text-muted-foreground/70">
          Click the commit for the full message and actions
        </div>
      )}
    </div>
  );
}

function CommitGraphRow({
  commit,
  currentBranch,
  details,
  detailsError,
  detailsLoading,
  isAnyCommitPinned,
  isPinned,
  layout,
  visibleRefs,
  onClosePinnedCommit,
  onCopyCommitValue,
  onCopyFullMessage,
  onCommitContextMenu,
  onOpenCommitUrl,
  onPinCommit,
}: {
  readonly commit: VcsCommitGraphCommit;
  readonly currentBranch: string | null | undefined;
  readonly details: VcsCommitDetailsResult | null | undefined;
  readonly detailsError: Error | null;
  readonly detailsLoading: boolean;
  readonly isAnyCommitPinned: boolean;
  readonly isPinned: boolean;
  readonly layout: CommitGraphLaneLayout;
  readonly visibleRefs: readonly string[];
  readonly onClosePinnedCommit: () => void;
  readonly onCopyCommitValue: (value: string, title: string) => void;
  readonly onCopyFullMessage: (
    commit: VcsCommitGraphCommit,
    options?: CopyCommitValueOptions,
  ) => Promise<boolean>;
  readonly onCommitContextMenu: (
    commit: VcsCommitGraphCommit,
    position: { readonly x: number; readonly y: number },
  ) => void;
  readonly onOpenCommitUrl: (commit: VcsCommitGraphCommit) => void;
  readonly onPinCommit: (commit: VcsCommitGraphCommit) => void;
}) {
  const [hoverCardOpen, setHoverCardOpen] = useState(false);
  const displayRefs = buildCommitGraphDisplayRefs(visibleRefs, currentBranch);
  const isCurrentBranchCommit = displayRefs.some((displayRef) => displayRef.kind === "current");
  const rowRefs = takeCommitGraphRowRefs(displayRefs);
  const graphWidth = commitGraphLaneX(layout.laneCount - 1) + COMMIT_GRAPH_LEFT_PADDING;
  const detailsCardOpen = isPinned || (!isAnyCommitPinned && hoverCardOpen);
  const viewportClamp = useViewportConstrainedCommitCard(isPinned);
  const popupStyle =
    viewportClamp.offsetY === 0
      ? undefined
      : { transform: `translateY(${viewportClamp.offsetY}px)` };

  return (
    <Tooltip open={detailsCardOpen} onOpenChange={setHoverCardOpen}>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Commit ${commit.shortSha}: ${commit.subject || "Untitled commit"}`}
            aria-pressed={isPinned}
            data-commit-details-surface
            onClick={(event: ReactMouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              if (isPinned) {
                setHoverCardOpen(false);
              }
              onPinCommit(commit);
            }}
            onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
              event.preventDefault();
              event.stopPropagation();
              onCommitContextMenu(commit, { x: event.clientX, y: event.clientY });
            }}
            className={cn(
              "grid w-full cursor-pointer appearance-none items-center gap-2 border-0 bg-transparent px-2.5 text-left transition-colors hover:bg-accent/60",
              isCurrentBranchCommit && "bg-primary/10 hover:bg-primary/15",
              isPinned && "bg-primary/20 hover:bg-primary/25 ring-1 ring-primary/80",
            )}
            style={{
              gridTemplateColumns: `${graphWidth}px minmax(0, 1fr)`,
              height: COMMIT_GRAPH_ROW_HEIGHT,
            }}
          >
            <CommitGraphGlyph
              layout={layout}
              highlighted={isCurrentBranchCommit}
              mergeCommit={commit.parents.length > 1}
            />
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs leading-tight text-foreground",
                  isCurrentBranchCommit && "font-medium",
                )}
              >
                {commit.subject || "Untitled commit"}
              </span>
              {rowRefs.rendered.length > 0 ? (
                // Chips yield to the subject: the cap reserves 4rem (plus the
                // 0.5rem gap) of title width before chips start truncating.
                <span className="flex min-w-0 max-w-[calc(100%-4.5rem)] items-center gap-1">
                  {rowRefs.rendered.map((displayRef, index) => (
                    <CommitGraphRefChip
                      key={displayRef.refName}
                      displayRef={displayRef}
                      className={cn("max-w-40", index > 0 && "shrink-[3]")}
                    />
                  ))}
                  {rowRefs.hiddenCount > 0 ? (
                    <span className="shrink-0 rounded-sm border border-border/60 px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground/60">
                      +{rowRefs.hiddenCount}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </span>
          </button>
        }
      />
      <TooltipPopup
        side="left"
        align={isPinned ? "end" : "center"}
        sideOffset={8}
        collisionAvoidance={
          isPinned ? { side: "shift", align: "shift", fallbackAxisSide: "none" } : undefined
        }
        collisionPadding={8}
        positionMethod={isPinned ? "fixed" : undefined}
        popupRef={viewportClamp.ref}
        positionerClassName={isPinned ? undefined : "transition-none"}
        style={popupStyle}
        sticky={isPinned ? true : undefined}
        className={cn(
          "max-w-none overflow-hidden",
          isPinned && "transition-[width,height,scale,opacity,transform] duration-150 ease-out",
        )}
      >
        <CommitGraphHoverCard
          commit={commit}
          currentBranch={currentBranch}
          details={isPinned ? details : null}
          detailsError={isPinned ? detailsError : null}
          detailsLoading={isPinned && detailsLoading}
          pinned={isPinned}
          onClose={onClosePinnedCommit}
          onCopyCommitValue={onCopyCommitValue}
          onCopyFullMessage={onCopyFullMessage}
          onOpenCommitUrl={onOpenCommitUrl}
        />
      </TooltipPopup>
    </Tooltip>
  );
}

function CommitGraphSkeleton() {
  const rows = [
    { id: "latest", width: "70%" },
    { id: "parent", width: "58%" },
    { id: "branch", width: "82%" },
    { id: "base", width: "64%" },
  ] as const;
  return (
    <div role="status" aria-label="Loading commit graph" className="space-y-0.5 px-2.5 py-2">
      {rows.map((row) => (
        <div
          key={row.id}
          className="grid items-center gap-2"
          style={{
            gridTemplateColumns: `${COMMIT_GRAPH_LEFT_PADDING}px minmax(0, 1fr)`,
            height: COMMIT_GRAPH_ROW_HEIGHT,
          }}
        >
          <div className="relative h-full">
            <Skeleton className="absolute top-1/2 left-1/2 h-full w-px -translate-x-1/2 -translate-y-1/2" />
            <Skeleton className="absolute top-1/2 left-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full" />
          </div>
          <Skeleton className="h-3" style={{ width: row.width }} />
        </div>
      ))}
    </div>
  );
}

function CommitGraphMessage({
  children,
  action,
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex min-h-20 flex-col items-start justify-center gap-2 px-2.5 py-2 text-xs text-muted-foreground/70">
      <div>{children}</div>
      {action}
    </div>
  );
}

const GRAPH_INITIAL_LIMIT = 24;
const GRAPH_LOAD_MORE_INCREMENT = 24;
const COMMIT_GRAPH_COUNT_FORMATTER = new Intl.NumberFormat();
const BRANCH_MENU_REF_LIMIT = 14;
const SOURCE_CONTROL_STATUS_REFRESH_INTERVAL_MS = 5_000;
const COMMIT_MESSAGE_EDITOR_TRANSITION_MS = 160;
const DEFAULT_CHANGES_PANEL_HEIGHT = 150;
// Changes is the actionable half of the split, so it gets the larger share
// by default; the divider remains draggable (and persisted) either way.
const DEFAULT_CHANGES_PANEL_RATIO = 0.6;
const SOURCE_CONTROL_NAME_TOOLTIP_DELAY_MS = 500;
const CHANGED_FILE_ACTIONS_VISIBILITY_CLASS_NAME =
  "pointer-events-none opacity-0 transition-opacity duration-150 group-hover/change-file:pointer-events-auto group-hover/change-file:opacity-100 group-focus-within/change-file:pointer-events-auto group-focus-within/change-file:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100";
// Coarse pointers get real (not hit-area-extended) size: discard sits next to
// stage, and overlapping 44px extensions over a destructive pair would route
// edge taps to the wrong action.
const CHANGED_FILE_ROW_ACTION_BUTTON_CLASS_NAME =
  "size-4 rounded-sm p-0 text-muted-foreground/60 before:rounded-sm sm:size-4 pointer-coarse:size-7 sm:pointer-coarse:size-7 [&_svg]:mx-0";
const MIN_CHANGES_PANEL_RATIO = 0.2;
const MAX_CHANGES_PANEL_RATIO = 0.8;
const MIN_GRAPH_PANEL_HEIGHT = 120;
const MIN_CHANGES_PANEL_HEIGHT = 96;
const SOURCE_CONTROL_SPLIT_VERTICAL_CHROME = 28;
const SOURCE_CONTROL_CHANGES_PANEL_RATIO_STORAGE_KEY =
  "threadlines:source-control:changes-panel-ratio:v1";
const LEGACY_SOURCE_CONTROL_CHANGES_PANEL_RATIO_STORAGE_KEYS = [
  "badcode:source-control:changes-panel-ratio:v1",
] as const;
const SOURCE_CONTROL_CHANGES_VIEW_MODE_STORAGE_KEY =
  "threadlines:source-control:changes-view-mode:v1";
const LEGACY_SOURCE_CONTROL_CHANGES_VIEW_MODE_STORAGE_KEYS = [
  "badcode:source-control:changes-view-mode:v1",
] as const;
const SourceControlChangesViewMode = Schema.Literals(["list", "tree"]);
type SourceControlChangesViewMode = typeof SourceControlChangesViewMode.Type;
const EMPTY_DIRECTORY_EXPANSION_OVERRIDES: Record<string, boolean> = {};

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampChangesPanelRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHANGES_PANEL_RATIO;
  }
  return clampNumber(value, MIN_CHANGES_PANEL_RATIO, MAX_CHANGES_PANEL_RATIO);
}

function DelayedSourceControlNameTooltip({
  label,
  className,
}: {
  readonly label: string;
  readonly className: string;
}) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      open={open}
      onOpenChange={(nextOpen) => {
        // Only reveal the full name when the inline label is actually clipped.
        const element = labelRef.current;
        if (nextOpen && element && element.scrollWidth <= element.clientWidth) {
          return;
        }
        setOpen(nextOpen);
      }}
    >
      <TooltipTrigger
        closeDelay={0}
        delay={SOURCE_CONTROL_NAME_TOOLTIP_DELAY_MS}
        render={
          <span ref={labelRef} className={className}>
            {label}
          </span>
        }
      />
      <TooltipPopup
        align="start"
        side="top"
        className="max-w-[min(32rem,calc(100vw-2rem))] whitespace-normal break-all font-mono leading-tight"
      >
        {label}
      </TooltipPopup>
    </Tooltip>
  );
}

function toGitActionErrorMessage(error: unknown): string {
  return formatGitErrorMessage(error);
}

function isRefOnCurrentBranch(refName: string, currentBranch: string | null | undefined): boolean {
  if (!currentBranch) {
    return false;
  }
  return refName === currentBranch || refName === `origin/${currentBranch}`;
}

function getBranchActionDisabledReason(input: {
  readonly status: VcsStatusResult | null | undefined;
  readonly isBusy: boolean;
  readonly action: "switch" | "create" | "merge";
  readonly repositorySafetyReason?: string | null;
}): string | null {
  if (input.repositorySafetyReason) {
    return input.repositorySafetyReason;
  }
  if (input.isBusy) {
    return "Git action in progress.";
  }
  if (!input.status?.isRepo) {
    return "No Git repository.";
  }
  if (input.action === "switch") {
    if (input.status.hasWorkingTreeChanges) {
      return "Commit or stash changes before switching branches.";
    }
  }
  if (input.action === "merge") {
    if (input.status.refName === null) {
      return "Detached HEAD.";
    }
    if (input.status.hasWorkingTreeChanges) {
      return "Commit or stash changes before merging.";
    }
    if (input.status.behindCount > 0) {
      return "Branch is behind upstream.";
    }
    if (!input.status.hasUpstream && !input.status.hasPrimaryRemote) {
      return "No remote configured to push.";
    }
  }
  return null;
}

/**
 * The branch menu's entry point into worktree cleanup.
 *
 * Mounted only while the branch menu is open: the worktree list and the
 * archived thread snapshot are both fetched on demand, and neither is worth
 * polling for a menu the user opens for a second at a time. The rows travel up
 * with the click so the dialog can outlive the menu that launched it.
 */
function BranchMenuCleanupItem({
  target,
  onOpenCleanup,
}: {
  readonly target: SourceControlProjectTarget;
  readonly onOpenCleanup: (rows: readonly WorktreeCleanupRow[]) => void;
}) {
  const worktreesQuery = useQuery(
    vcsListWorktreesQueryOptions({
      environmentId: target.environmentId,
      cwd: target.cwd,
    }),
  );
  const environmentIds = useMemo(() => [target.environmentId], [target.environmentId]);
  const { snapshots, isLoading: archivedLoading } = useArchivedThreadSnapshots(environmentIds);
  const liveThreads = useStore(
    useShallow((state) => selectThreadsForEnvironment(state, target.environmentId)),
  );
  const archivedThreads = useMemo(
    () => snapshots.flatMap((entry) => entry.snapshot.threads),
    [snapshots],
  );
  const rows = useMemo(
    () =>
      classifyWorktreesForCleanup({
        worktrees: worktreesQuery.data?.worktrees ?? [],
        liveThreads,
        archivedThreads,
      }),
    [archivedThreads, liveThreads, worktreesQuery.data?.worktrees],
  );
  const cleanableCount = rows.filter((row) => row.state !== "in-use").length;
  // The archived snapshot decides which rows read as "archived", so opening
  // before it lands would pre-check a worktree an archived thread still wants.
  // A background revalidation with snapshots already in hand does not count.
  const isLoading = worktreesQuery.isPending || (archivedLoading && snapshots.length === 0);

  return (
    <MenuItem disabled={isLoading || rows.length === 0} onClick={() => onOpenCleanup(rows)}>
      <FolderGit2Icon className="size-3.5" />
      <span>Clean up worktrees...</span>
      {isLoading ? (
        <Spinner className="ms-auto size-3 shrink-0 text-muted-foreground/60 motion-reduce:animate-none" />
      ) : cleanableCount > 0 ? (
        <span className="ms-auto shrink-0 text-[10px] text-muted-foreground/60">
          {cleanableCount} unused
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
 * Deletions run one at a time and report in place, so a repository with two
 * dozen worktrees costs the user a single decision and still shows an outcome
 * per row. Mounted fresh per open, which is what resets the ticks and the
 * progress.
 */
function WorktreeCleanupDialogBody({
  rows,
  projectName,
  projectCwd,
  environmentId,
  defaultBranchName,
  onDone,
  onSwitchCheckout,
}: {
  readonly rows: readonly WorktreeCleanupRow[];
  readonly projectName: string;
  readonly projectCwd: string;
  readonly environmentId: EnvironmentId;
  readonly defaultBranchName: string | null;
  readonly onDone: () => void;
  /** Omitted when no thread is open: there is nothing to move. */
  readonly onSwitchCheckout?: ((row: WorktreeCleanupRow) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const cleanableRows = useMemo(() => rows.filter((row) => row.state !== "in-use"), [rows]);
  const inUseRows = useMemo(() => rows.filter((row) => row.state === "in-use"), [rows]);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(
    () => new Set(cleanableRows.filter(isWorktreeSafeToDelete).map((row) => row.path)),
  );
  const [progress, setProgress] = useState<ReadonlyMap<string, WorktreeCleanupProgress>>(
    () => new Map(),
  );
  const [isRunning, setIsRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const selection = summarizeWorktreeSelection(cleanableRows, selectedPaths);
  const locked = isRunning || hasRun;
  const allSelected = cleanableRows.length > 0 && selection.count === cleanableRows.length;
  const showSelectAll = cleanableRows.length > 1;

  const toggleRow = (path: string, checked: boolean) => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
  };

  const runCleanup = async () => {
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }
    const targets = cleanableRows.filter((row) => selectedPaths.has(row.path));
    setIsRunning(true);
    for (const row of targets) {
      setProgress((current) => new Map(current).set(row.path, { status: "deleting" }));
      try {
        // Run from the project root: git cannot remove the folder it stands in.
        await api.vcs.removeWorktree({ cwd: projectCwd, path: row.path, force: true });
        setProgress((current) => new Map(current).set(row.path, { status: "deleted" }));
      } catch (error) {
        setProgress((current) =>
          new Map(current).set(row.path, {
            status: "failed",
            message: toGitActionErrorMessage(error),
          }),
        );
      }
    }
    setIsRunning(false);
    setHasRun(true);
    await invalidateGitQueries(queryClient, { environmentId });
  };

  const safeCount = cleanableRows.filter(isWorktreeSafeToDelete).length;
  // The count on the menu row promises N deletable; explain here why fewer
  // start checked: only the rows whose removal provably loses nothing.
  const preselectionNote =
    cleanableRows.length === 0
      ? ""
      : safeCount === 0
        ? " Each one has something at risk, so none are checked yet."
        : safeCount < cleanableRows.length
          ? ` The ${safeCount} with nothing to lose ${safeCount === 1 ? "is" : "are"} already checked; the rest show what deleting them would cost.`
          : "";
  const summary =
    cleanableRows.length === 0
      ? "All worktrees are in use."
      : `${projectName} has ${cleanableRows.length} worktree${
          cleanableRows.length === 1 ? "" : "s"
        } nothing is using.${preselectionNote}`;

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Clean up worktrees</AlertDialogTitle>
        <AlertDialogDescription>{summary}</AlertDialogDescription>
      </AlertDialogHeader>
      {showSelectAll ? (
        <div className="-mt-2 flex justify-end px-6 pb-1">
          <Button
            disabled={locked}
            onClick={() =>
              setSelectedPaths(
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
        {cleanableRows.map((row) => {
          const risks = describeWorktreeRisks(row, defaultBranchName);
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
                      <span className="truncate text-muted-foreground text-xs">{row.refName}</span>
                    ) : null}
                  </span>
                  {risks.length > 0 ? (
                    <span className="text-muted-foreground text-xs">{risks.join(", ")}</span>
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
              {onSwitchCheckout && row.refName ? (
                <Button
                  aria-label={`Switch checkout to ${formatWorktreePathForDisplay(row.path)}`}
                  className="shrink-0"
                  disabled={locked}
                  onClick={() => onSwitchCheckout(row)}
                  size="icon-xs"
                  title="Switch checkout here"
                  variant="ghost"
                >
                  <FolderGit2Icon />
                </Button>
              ) : null}
            </div>
          );
        })}
        {inUseRows.map((row) => (
          <div
            className="flex items-baseline gap-2 border-border/55 border-b py-2 opacity-64 last:border-b-0"
            key={row.path}
            title={row.path}
          >
            <span className="truncate text-sm">{formatWorktreePathForDisplay(row.path)}</span>
            {row.refName ? (
              <span className="truncate text-muted-foreground text-xs">{row.refName}</span>
            ) : null}
            <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">in use</span>
          </div>
        ))}
      </div>
      <AlertDialogFooter className="mt-4">
        {hasRun ? (
          <Button onClick={onDone} size="sm">
            Close
          </Button>
        ) : (
          <>
            <AlertDialogClose disabled={isRunning} render={<Button size="sm" variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={selection.count === 0 || isRunning}
              onClick={() => {
                void runCleanup();
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

function SourceControlBranchMenu({
  target,
  activeThreadRef,
  onActiveBranchChange,
  status,
  isBusy,
  repositorySafetyReason,
  refreshPanel,
}: {
  readonly target: SourceControlProjectTarget;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly onActiveBranchChange?:
    | ((branch: string | null, worktreePath: string | null) => void)
    | undefined;
  readonly status: VcsStatusResult | null | undefined;
  readonly isBusy: boolean;
  readonly repositorySafetyReason: string | null;
  readonly refreshPanel: () => void;
}) {
  const queryClient = useQueryClient();
  const setThreadBranch = useStore((store) => store.setThreadBranch);
  const activeThreadSession =
    useStore(useMemo(() => createThreadSelectorByRef(activeThreadRef), [activeThreadRef]))
      ?.session ?? null;
  const [pendingWorkingTreeSwitchRef, setPendingWorkingTreeSwitchRef] = useState<VcsRef | null>(
    null,
  );
  const [pendingMergeRef, setPendingMergeRef] = useState<VcsRef | null>(null);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // Held in the panel, not the menu: opening the dialog closes the menu, which
  // would unmount a dialog rendered inside it.
  const [cleanupRows, setCleanupRows] = useState<readonly WorktreeCleanupRow[] | null>(null);
  const branchSearch = useInfiniteQuery(
    gitBranchSearchInfiniteQueryOptions({
      environmentId: target.environmentId,
      cwd: target.cwd,
      query: "",
      enabled: Boolean(status?.isRepo),
    }),
  );
  const checkoutMutation = useMutation(
    gitCheckoutMutationOptions({
      environmentId: target.environmentId,
      cwd: target.cwd,
      queryClient,
    }),
  );
  const mergeMutation = useMutation(
    gitMergeRefMutationOptions({
      environmentId: target.environmentId,
      cwd: target.cwd,
      queryClient,
    }),
  );
  const createBranchMutation = useMutation({
    mutationFn: async (refName: string) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) {
        throw new Error("Git branch creation is unavailable.");
      }
      return api.vcs.createRef({ cwd: target.cwd, refName, switchRef: true });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: gitQueryKeys.refs(target.environmentId, target.cwd),
      });
    },
  });

  const refs = useMemo(
    () => branchSearch.data?.pages.flatMap((page) => page.refs) ?? [],
    [branchSearch.data?.pages],
  );
  const currentBranch = status?.refName ?? refs.find((ref) => ref.current)?.name ?? null;
  const defaultBranchName = refs.find((ref) => ref.isDefault && !ref.isRemote)?.name ?? null;
  const switchRefs = refs.slice(0, BRANCH_MENU_REF_LIMIT);
  const mergeRefs = refs
    .filter((ref) => ref.name !== currentBranch && !isRefOnCurrentBranch(ref.name, currentBranch))
    .slice(0, BRANCH_MENU_REF_LIMIT);
  const switchDisabledReason = getBranchActionDisabledReason({
    status,
    isBusy: isBusy || checkoutMutation.isPending || createBranchMutation.isPending,
    action: "switch",
    repositorySafetyReason,
  });
  const createDisabledReason = getBranchActionDisabledReason({
    status,
    isBusy: isBusy || checkoutMutation.isPending || createBranchMutation.isPending,
    action: "create",
    repositorySafetyReason,
  });
  const mergeDisabledReason = getBranchActionDisabledReason({
    status,
    isBusy: isBusy || mergeMutation.isPending,
    action: "merge",
    repositorySafetyReason,
  });

  const syncActiveThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null = target.worktreePath) => {
      if (onActiveBranchChange) {
        onActiveBranchChange(branch, worktreePath);
        return;
      }
      if (!activeThreadRef) {
        return;
      }
      const api = readEnvironmentApi(target.environmentId);
      if (!api) {
        // No connection means the switch cannot happen at all; applying the
        // optimistic update anyway would leave the panel lying indefinitely.
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Couldn't move the thread",
            description: "Not connected to the environment. Try again once it reconnects.",
          }),
        );
        return;
      }
      const previousBranch = currentBranch;
      const previousWorktreePath = target.worktreePath;
      void api.orchestration
        .dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadRef.threadId,
          branch,
          worktreePath,
        })
        .catch(() => {
          // Roll the optimistic update back to what the panel showed before;
          // a switch that silently stays put is this panel's worst failure
          // mode, and one that lies about having happened is the second.
          setThreadBranch(activeThreadRef, previousBranch, previousWorktreePath);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Couldn't move the thread",
              description: "The checkout switch didn't reach the server. Try again.",
            }),
          );
        });
      setThreadBranch(activeThreadRef, branch, worktreePath);
    },
    [
      activeThreadRef,
      currentBranch,
      onActiveBranchChange,
      setThreadBranch,
      target.environmentId,
      target.worktreePath,
    ],
  );

  /**
   * Points the thread at a checkout. Nothing runs in git: the thread records
   * where its next turn belongs, and the server cycles the runtime there when
   * that turn is dispatched. A pick that leaves the live session in a different
   * checkout is queued, not applied, and the composer chip saying so is easy to
   * miss, so it is announced here too.
   */
  const applyCheckoutSwitch = useCallback(
    (branch: string | null, nextWorktreePath: string | null) => {
      syncActiveThreadBranch(branch, nextWorktreePath);
      const queued = queuedCheckoutSwitchToast({
        session: activeThreadSession,
        activeProjectCwd: target.projectCwd,
        nextWorktreePath,
      });
      if (queued) {
        toastManager.add(stackedThreadToast({ type: "info", ...queued }));
      }
    },
    [activeThreadSession, syncActiveThreadBranch, target.projectCwd],
  );

  /**
   * Moves the thread into a worktree from the cleanup list so its uncommitted
   * files and unshipped commits can be read in the panel before deciding. Same
   * checkout switch the composer's picker performs for a branch that already
   * has a checkout, which also means the worktree reads as in use afterwards.
   */
  const switchCheckoutToWorktree = useCallback(
    (row: WorktreeCleanupRow) => {
      if (!row.refName) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Can't switch to this worktree",
            description: "It has no branch checked out, so the thread can't follow it.",
          }),
        );
        return;
      }
      setCleanupRows(null);
      applyCheckoutSwitch(row.refName, row.path);
    },
    [applyCheckoutSwitch],
  );

  const executeSwitchRef = useCallback(
    (ref: VcsRef) => {
      const selectionTarget = resolveBranchSelectionTarget({
        activeProjectCwd: target.projectCwd,
        activeWorktreePath: target.worktreePath,
        refName: ref,
      });
      const promise = checkoutMutation
        .mutateAsync({ cwd: selectionTarget.checkoutCwd, refName: ref.name })
        .then((result) => {
          const nextBranch = result.refName ?? ref.name;
          applyCheckoutSwitch(nextBranch, selectionTarget.nextWorktreePath);
          return nextBranch;
        });
      void toastManager.promise(promise, {
        loading: { title: `Switching to ${ref.name}...` },
        success: (branch) => ({
          title: "Branch switched",
          description: branch,
        }),
        error: (error) => ({
          title: "Switch branch failed",
          description: toGitActionErrorMessage(error),
        }),
      });
      void promise.then(refreshPanel, () => undefined);
    },
    [applyCheckoutSwitch, checkoutMutation, refreshPanel, target.projectCwd, target.worktreePath],
  );

  /**
   * A refused action must say why. The branch menu shows the safety reason in
   * place, but these handlers are also reachable from rows and dialogs that
   * render no reason — a silent return there reads as a dead button.
   */
  const notifyRepositorySafetyBlocked = useCallback((reason: string) => {
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Action paused",
        description: reason,
      }),
    );
  }, []);

  const runSwitchRef = useCallback(
    (ref: VcsRef) => {
      if (repositorySafetyReason) {
        notifyRepositorySafetyBlocked(repositorySafetyReason);
        return;
      }
      const selectionTarget = resolveBranchSelectionTarget({
        activeProjectCwd: target.projectCwd,
        activeWorktreePath: target.worktreePath,
        refName: ref,
      });
      // Switching a branch inside the checkout an agent is working in swaps
      // its files mid-turn. Selecting a ref that lives in another checkout is
      // a checkout switch instead, and the next turn picks that up on its own.
      if (!selectionTarget.reuseExistingWorktree && hasActiveThreadTurn(activeThreadSession)) {
        setPendingWorkingTreeSwitchRef(ref);
        return;
      }
      executeSwitchRef(ref);
    },
    [
      activeThreadSession,
      executeSwitchRef,
      notifyRepositorySafetyBlocked,
      repositorySafetyReason,
      target.projectCwd,
      target.worktreePath,
    ],
  );

  const runCreateBranch = useCallback(() => {
    if (repositorySafetyReason) {
      notifyRepositorySafetyBlocked(repositorySafetyReason);
      return;
    }
    const refName = createBranchName.trim();
    if (refName.length === 0) {
      return;
    }
    const promise = createBranchMutation.mutateAsync(refName).then((result) => {
      syncActiveThreadBranch(result.refName);
      return result.refName;
    });
    setCreateBranchOpen(false);
    setCreateBranchName("");
    void toastManager.promise(promise, {
      loading: { title: `Creating ${refName}...` },
      success: (branch) => ({
        title: "Branch created",
        description: branch,
      }),
      error: (error) => ({
        title: "Create branch failed",
        description: toGitActionErrorMessage(error),
      }),
    });
    void promise.then(refreshPanel, () => undefined);
  }, [
    createBranchMutation,
    createBranchName,
    notifyRepositorySafetyBlocked,
    refreshPanel,
    repositorySafetyReason,
    syncActiveThreadBranch,
  ]);

  const runMergeRef = useCallback(() => {
    if (!pendingMergeRef) {
      return;
    }
    if (repositorySafetyReason) {
      notifyRepositorySafetyBlocked(repositorySafetyReason);
      return;
    }
    const refName = pendingMergeRef.name;
    const promise = mergeMutation.mutateAsync(refName);
    setPendingMergeRef(null);
    void toastManager.promise(promise, {
      loading: { title: `Merging ${refName} & pushing...` },
      success: (result) => {
        const pushTarget = result.push?.upstreamBranch ?? result.push?.branch ?? currentBranch;
        return {
          title:
            result.push?.status === "skipped_up_to_date"
              ? "Branch already synchronized"
              : "Branch merged & pushed",
          description: currentBranch
            ? `${refName} merged into ${currentBranch}${
                pushTarget ? ` and pushed to ${pushTarget}` : ""
              }.`
            : refName,
        };
      },
      error: (error) => ({
        title: "Merge or push failed",
        description: toGitActionErrorMessage(error),
      }),
    });
    void promise.then(refreshPanel, () => refreshPanel());
  }, [
    currentBranch,
    mergeMutation,
    notifyRepositorySafetyBlocked,
    pendingMergeRef,
    refreshPanel,
    repositorySafetyReason,
  ]);

  return (
    <>
      <div className="min-w-0">
        <Menu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            render={
              <Button
                aria-label={currentBranch ? `Branch: ${currentBranch}` : "Select branch"}
                type="button"
                variant="outline"
                size="xs"
                className="w-full min-w-0 justify-between"
              />
            }
            disabled={!status?.isRepo || branchSearch.isPending}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="truncate">{currentBranch ?? "Select branch"}</span>
            </span>
            <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
          </MenuTrigger>
          <MenuPopup align="start" side="top" className="w-72">
            <MenuGroup>
              <MenuGroupLabel>Branch</MenuGroupLabel>
              <MenuItem disabled>
                <GitBranchIcon className="size-3.5" />
                <span className="min-w-0 truncate">{currentBranch ?? "Detached HEAD"}</span>
              </MenuItem>
            </MenuGroup>
            <MenuSeparator />
            <MenuItem
              disabled={createDisabledReason !== null}
              onClick={() => setCreateBranchOpen(true)}
            >
              <PlusIcon className="size-3.5" />
              <span>Create branch...</span>
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger>
                <GitBranchIcon className="size-3.5" />
                <span>Switch to</span>
              </MenuSubTrigger>
              <MenuSubPopup className="w-72">
                {switchDisabledReason ? (
                  <MenuItem disabled>
                    <span className="min-w-0 text-muted-foreground">{switchDisabledReason}</span>
                  </MenuItem>
                ) : switchRefs.length === 0 ? (
                  <MenuItem disabled>
                    <span className="min-w-0 text-muted-foreground">No branches found.</span>
                  </MenuItem>
                ) : (
                  switchRefs.map((ref) => (
                    <MenuItem
                      key={ref.name}
                      disabled={ref.current}
                      onClick={() => runSwitchRef(ref)}
                      className="justify-between"
                    >
                      <span className="min-w-0 truncate">{ref.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground/60">
                        {getVcsRefBadge(ref, target.projectCwd) ?? ""}
                      </span>
                    </MenuItem>
                  ))
                )}
              </MenuSubPopup>
            </MenuSub>
            <MenuSub>
              <MenuSubTrigger>
                <GitMergeIcon className="size-3.5" />
                <span>Merge into current</span>
              </MenuSubTrigger>
              <MenuSubPopup className="w-72">
                {mergeDisabledReason ? (
                  <MenuItem disabled>
                    <span className="min-w-0 text-muted-foreground">{mergeDisabledReason}</span>
                  </MenuItem>
                ) : mergeRefs.length === 0 ? (
                  <MenuItem disabled>
                    <span className="min-w-0 text-muted-foreground">No other branches found.</span>
                  </MenuItem>
                ) : (
                  mergeRefs.map((ref) => (
                    <MenuItem key={ref.name} onClick={() => setPendingMergeRef(ref)}>
                      <span className="min-w-0 truncate">{ref.name}</span>
                    </MenuItem>
                  ))
                )}
              </MenuSubPopup>
            </MenuSub>
            {menuOpen ? (
              <BranchMenuCleanupItem target={target} onOpenCleanup={setCleanupRows} />
            ) : null}
          </MenuPopup>
        </Menu>
      </div>

      <AlertDialog
        open={cleanupRows !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCleanupRows(null);
          }
        }}
      >
        <AlertDialogPopup className="max-w-lg">
          {cleanupRows ? (
            <WorktreeCleanupDialogBody
              defaultBranchName={defaultBranchName}
              environmentId={target.environmentId}
              onDone={() => setCleanupRows(null)}
              onSwitchCheckout={activeThreadRef ? switchCheckoutToWorktree : undefined}
              projectCwd={target.projectCwd}
              projectName={target.name}
              rows={cleanupRows}
            />
          ) : null}
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={pendingWorkingTreeSwitchRef !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingWorkingTreeSwitchRef(null);
          }
        }}
      >
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Switch branch while the agent is working?</AlertDialogTitle>
            <AlertDialogDescription>
              Switching to{" "}
              <span className="font-mono">
                {pendingWorkingTreeSwitchRef?.name ?? "this branch"}
              </span>{" "}
              changes the files in this checkout. The agent is running a turn here and will see the
              new files mid-task.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const ref = pendingWorkingTreeSwitchRef;
                setPendingWorkingTreeSwitchRef(null);
                if (ref) {
                  executeSwitchRef(ref);
                }
              }}
            >
              Switch anyway
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <Dialog
        open={pendingMergeRef !== null}
        onOpenChange={(open) => !open && setPendingMergeRef(null)}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Merge & push branch?</DialogTitle>
            <DialogDescription>
              Merge {pendingMergeRef?.name ?? "this branch"} into{" "}
              {currentBranch ?? "the current branch"}, then push{" "}
              {currentBranch ?? "the current branch"} to its remote. Your working tree must stay
              clean before the merge starts.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingMergeRef(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={mergeMutation.isPending || repositorySafetyReason !== null}
              onClick={runMergeRef}
            >
              Merge & push
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={createBranchOpen}
        onOpenChange={(open) => {
          setCreateBranchOpen(open);
          if (!open) {
            setCreateBranchName("");
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              runCreateBranch();
            }}
          >
            <DialogHeader>
              <DialogTitle>Create branch</DialogTitle>
              <DialogDescription>
                Create a new branch from {currentBranch ?? "the current ref"} and switch this thread
                to it.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              className="mt-4"
              nativeInput
              placeholder="feature/source-control-polish"
              size="sm"
              value={createBranchName}
              onChange={(event) => setCreateBranchName(event.target.value)}
            />
            <DialogFooter className="mt-4">
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => setCreateBranchOpen(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                type="submit"
                disabled={
                  createBranchMutation.isPending ||
                  createBranchName.trim().length === 0 ||
                  repositorySafetyReason !== null
                }
              >
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function SourceControlPanel({
  target,
  activeThreadRef,
  onActiveBranchChange,
  onOpenDiff,
  onPrefetchDiff,
  onClose,
  embedded = false,
}: SourceControlPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [commitMessage, setCommitMessage] = useState("");
  const [commitMessageEditorOpen, setCommitMessageEditorOpen] = useState(false);
  const [commitMessageEditorMounted, setCommitMessageEditorMounted] = useState(false);
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [approvedParentRepositoryKey, setApprovedParentRepositoryKey] = useState<string | null>(
    null,
  );
  const [authRemediationFailure, setAuthRemediationFailure] = useState<GitRemoteAuthFailure | null>(
    null,
  );
  const [pendingHistoryReconciliation, setPendingHistoryReconciliation] =
    useState<PendingHistoryReconciliation | null>(null);
  const [pendingStashRecovery, setPendingStashRecovery] = useState<PendingStashRecovery | null>(
    null,
  );
  const [safePullConfirmationOpen, setSafePullConfirmationOpen] = useState(false);
  const [stashDialogMode, setStashDialogMode] = useState<"create" | "manage" | null>(null);
  const [stashMessage, setStashMessage] = useState("");
  const [stashIncludeUntracked, setStashIncludeUntracked] = useState(true);
  const [pendingDropStash, setPendingDropStash] = useState<VcsStashEntry | null>(null);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<DefaultBranchConfirmableAction | null>(null);
  const [pendingDiscardChanges, setPendingDiscardChanges] = useState<PendingDiscardChanges | null>(
    null,
  );
  const [pendingCreateTagCommit, setPendingCreateTagCommit] = useState<VcsCommitGraphCommit | null>(
    null,
  );
  const [pendingDeleteBranch, setPendingDeleteBranch] = useState<PendingDeleteBranch | null>(null);
  const [pendingProviderReview, setPendingProviderReview] = useState<PendingProviderReview | null>(
    null,
  );
  const [createTagName, setCreateTagName] = useState("");
  const [changesPanelRatio, setChangesPanelRatio] = useLocalStorage(
    SOURCE_CONTROL_CHANGES_PANEL_RATIO_STORAGE_KEY,
    DEFAULT_CHANGES_PANEL_RATIO,
    Schema.Finite,
    { legacyKeys: LEGACY_SOURCE_CONTROL_CHANGES_PANEL_RATIO_STORAGE_KEYS },
  );
  const [changesViewMode, setChangesViewMode] = useLocalStorage<
    SourceControlChangesViewMode,
    string
  >(SOURCE_CONTROL_CHANGES_VIEW_MODE_STORAGE_KEY, "tree", SourceControlChangesViewMode, {
    legacyKeys: LEGACY_SOURCE_CONTROL_CHANGES_VIEW_MODE_STORAGE_KEYS,
  });
  const [changesPanelHeight, setChangesPanelHeight] = useState(DEFAULT_CHANGES_PANEL_HEIGHT);
  const [changesTreeExpansionState, setChangesTreeExpansionState] = useState<{
    readonly key: string;
    readonly overrides: Record<string, boolean>;
  }>(() => ({ key: "", overrides: {} }));
  const [commitGraphLimit, setCommitGraphLimit] = useState(GRAPH_INITIAL_LIMIT);
  const [pinnedCommitSha, setPinnedCommitSha] = useState<string | null>(null);
  const [isManualRefreshPending, setIsManualRefreshPending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const changesSectionRef = useRef<HTMLElement>(null);
  const commitControlsRef = useRef<HTMLElement>(null);
  const commitGraphScrollerRef = useRef<HTMLDivElement>(null);
  const commitGraphStatusRefreshRef = useRef<{
    readonly targetKey: string;
    readonly statusKey: string | null;
  } | null>(null);
  const environmentId = target?.environmentId ?? null;
  const cwd = target?.cwd ?? null;
  const environmentApiAvailable = useEnvironmentApiAvailable(environmentId);
  const currentPullTargetRef = useRef<PullRequestTarget>({ environmentId, cwd });
  currentPullTargetRef.current = { environmentId, cwd };
  const activeHistoryReconciliation =
    pendingHistoryReconciliation &&
    isSamePullRequestTarget(pendingHistoryReconciliation, currentPullTargetRef.current)
      ? pendingHistoryReconciliation
      : null;
  const activeStashRecovery =
    pendingStashRecovery &&
    isSamePullRequestTarget(pendingStashRecovery, currentPullTargetRef.current)
      ? pendingStashRecovery
      : null;

  useEffect(() => {
    setPendingHistoryReconciliation(null);
    setPendingStashRecovery(null);
    setSafePullConfirmationOpen(false);
    setStashDialogMode(null);
    setPendingDropStash(null);
  }, [cwd, environmentId]);
  const reviewThread = useStore(
    useMemo(() => createThreadSelectorByRef(activeThreadRef), [activeThreadRef]),
  );
  const reviewDraftSession = useComposerDraftStore((store) =>
    activeThreadRef ? store.getDraftSessionByRef(activeThreadRef) : null,
  );
  const reviewComposerDraft = useComposerDraftStore((store) =>
    activeThreadRef ? store.getComposerDraft(activeThreadRef) : null,
  );
  const reviewProjectRef = useMemo(() => {
    const threadContext = reviewThread ?? reviewDraftSession;
    return threadContext
      ? scopeProjectRef(threadContext.environmentId, threadContext.projectId)
      : null;
  }, [reviewDraftSession, reviewThread]);
  const reviewProject = useStore(
    useMemo(() => createProjectSelectorByRef(reviewProjectRef), [reviewProjectRef]),
  );
  const reviewProviders = useServerProviders();
  const reviewSettings = useSettings();
  const providerReviewContext = useMemo(
    () =>
      resolveProviderReviewContext({
        thread: reviewThread,
        draftSession: reviewDraftSession,
        composerDraft: reviewComposerDraft,
        project: reviewProject,
        providers: reviewProviders,
        settings: reviewSettings,
      }),
    [
      reviewComposerDraft,
      reviewDraftSession,
      reviewProject,
      reviewProviders,
      reviewSettings,
      reviewThread,
    ],
  );
  const providerReviewModelOptionsByInstance = useMemo(
    () =>
      new Map(
        providerReviewContext.providerInstanceEntries.map(
          (entry) =>
            [entry.instanceId, getAppModelOptionsForInstance(reviewSettings, entry)] as const,
        ),
      ),
    [providerReviewContext.providerInstanceEntries, reviewSettings],
  );
  const activeGitActionProgressView = useGitActionProgressView({ environmentId, cwd });
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const gitStatus = useGitStatus({
    environmentId: environmentApiAvailable ? environmentId : null,
    cwd: environmentApiAvailable ? cwd : null,
  });
  // A status snapshot may be retained across reconnects. Keep it out of the
  // render model while its API is absent, otherwise that stale `isRepo` value
  // enables graph, stash, and branch queries against a missing connection.
  const status = environmentApiAvailable ? gitStatus.data : null;
  // A deleted checkout reaches this panel as a status with no repository, which
  // used to read as "not a repo yet" and offered to initialize one. The same
  // hook the composer notice uses tells the two apart and carries the actions.
  const checkoutRecoveryView = useCheckoutRecovery({
    environmentId,
    threadId: activeThreadRef?.threadId ?? null,
    cwd,
    projectCwd: reviewProject?.cwd ?? null,
    branch: reviewThread?.branch ?? null,
    status,
  });
  const parentRepositoryRoot =
    status?.isRepo && status.repositoryRootRelation === "ancestor"
      ? (status.repositoryRoot ?? null)
      : null;
  const parentRepositoryKey =
    environmentId && cwd && parentRepositoryRoot
      ? `${environmentId}\0${cwd}\0${parentRepositoryRoot}`
      : null;
  const isParentRepositoryConfirmationRequired =
    parentRepositoryKey !== null && approvedParentRepositoryKey !== parentRepositoryKey;
  const repositorySafetyReason = isParentRepositoryConfirmationRequired
    ? "Confirm the parent repository before making changes."
    : null;
  const commitGraphStatusRefreshKey = getCommitGraphStatusRefreshKey(status);
  useEffect(() => {
    setCommitGraphLimit(GRAPH_INITIAL_LIMIT);
    setPinnedCommitSha(null);
  }, [cwd, environmentId]);
  const graphQueryEnabled = Boolean(status?.isRepo);
  const graphQuery = useQuery(
    gitCommitGraphQueryOptions({
      environmentId,
      cwd,
      limit: commitGraphLimit,
      enabled: graphQueryEnabled,
    }),
  );
  const refetchCommitGraph = graphQuery.refetch;
  const graphCommits = graphQuery.data?.commits ?? EMPTY_COMMIT_GRAPH_COMMITS;
  const commitGraphRows = useMemo(() => buildCommitGraphRows(graphCommits), [graphCommits]);
  const pinnedCommit = useMemo(
    () => graphCommits.find((commit) => commit.sha === pinnedCommitSha) ?? null,
    [graphCommits, pinnedCommitSha],
  );
  const commitDetailsQuery = useQuery(
    gitCommitDetailsQueryOptions({
      environmentId,
      cwd,
      sha: pinnedCommitSha,
      enabled: pinnedCommitSha !== null && graphQueryEnabled,
    }),
  );
  const pinnedCommitDetails =
    commitDetailsQuery.data?.sha === pinnedCommitSha ? commitDetailsQuery.data : null;
  const pinnedCommitDetailsError =
    pinnedCommitSha !== null && commitDetailsQuery.error instanceof Error
      ? commitDetailsQuery.error
      : null;
  const graphHasData = graphQuery.data !== undefined;
  const isCommitGraphInitialLoading = graphQueryEnabled && !graphHasData && graphQuery.isPending;
  const isCommitGraphRefreshing = graphHasData && graphQuery.isFetching;
  const commitGraphErrorPresentation =
    graphQuery.isError && !graphHasData
      ? resolveCommitGraphErrorPresentation(graphQuery.error)
      : null;
  const isSourceControlRefreshing =
    !environmentApiAvailable ||
    gitStatus.isPending ||
    isManualRefreshPending ||
    isCommitGraphRefreshing;
  // The live status subscription gave up on delivering a snapshot. Saying so
  // beats an endless spinner, and the retry re-runs the same refresh the
  // toolbar button uses.
  const isSourceControlStatusStale =
    status === null && !gitStatus.isPending && gitStatus.error !== null;
  const isCommitGraphLoadingMore =
    graphQuery.isFetching &&
    graphQuery.data?.truncated === true &&
    commitGraphLimit > graphCommits.length;
  const hasCommitGraphLoadMoreError = graphHasData && graphQuery.isError;
  const shouldShowCommitGraphLoadMore =
    graphQuery.data?.truncated === true || hasCommitGraphLoadMoreError;
  const canCommitGraphShowLess =
    commitGraphLimit > GRAPH_INITIAL_LIMIT && graphCommits.length > GRAPH_INITIAL_LIMIT;
  const shouldShowCommitGraphFooter = shouldShowCommitGraphLoadMore || canCommitGraphShowLess;
  const isCommitGraphFooterSplit = canCommitGraphShowLess && shouldShowCommitGraphLoadMore;
  const commitGraphShownCount = COMMIT_GRAPH_COUNT_FORMATTER.format(graphCommits.length);
  const commitGraphLoadMoreCount = COMMIT_GRAPH_COUNT_FORMATTER.format(GRAPH_LOAD_MORE_INCREMENT);
  const commitGraphShowLessCount = COMMIT_GRAPH_COUNT_FORMATTER.format(
    Math.min(GRAPH_LOAD_MORE_INCREMENT, Math.max(0, graphCommits.length - GRAPH_INITIAL_LIMIT)),
  );
  const commitGraphCountLabel = `${commitGraphShownCount} shown`;
  const commitGraphLoadMoreDescription = hasCommitGraphLoadMoreError
    ? "Could not load older commits."
    : "";
  const commitGraphLoadMoreButtonLabel = hasCommitGraphLoadMoreError
    ? "Retry"
    : isCommitGraphLoadingMore
      ? "Loading..."
      : isCommitGraphFooterSplit
        ? `${commitGraphLoadMoreCount} more`
        : `Load ${commitGraphLoadMoreCount} more`;
  const commitGraphLoadMoreButtonAriaLabel = hasCommitGraphLoadMoreError
    ? "Retry loading older commits"
    : isCommitGraphLoadingMore
      ? "Loading older commits"
      : `Load ${commitGraphLoadMoreCount} older commits`;
  const commitGraphShowLessButtonAriaLabel = `Show ${commitGraphShowLessCount} fewer commits`;
  const loadOlderCommitGraph = useCallback(() => {
    if (hasCommitGraphLoadMoreError) {
      void refetchCommitGraph();
      return;
    }
    setCommitGraphLimit((limit) => limit + GRAPH_LOAD_MORE_INCREMENT);
  }, [hasCommitGraphLoadMoreError, refetchCommitGraph]);
  const showLessCommitGraph = useCallback(() => {
    setCommitGraphLimit((limit) =>
      Math.max(GRAPH_INITIAL_LIMIT, limit - GRAPH_LOAD_MORE_INCREMENT),
    );
  }, []);
  useEffect(() => {
    if (pinnedCommitSha !== null && graphHasData && pinnedCommit === null) {
      setPinnedCommitSha(null);
    }
  }, [graphHasData, pinnedCommit, pinnedCommitSha]);
  useEffect(() => {
    if (pinnedCommitSha === null) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const targetNode = event.target;
      if (targetNode instanceof Element && targetNode.closest("[data-commit-details-surface]")) {
        return;
      }
      setPinnedCommitSha(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPinnedCommitSha(null);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [pinnedCommitSha]);
  useEffect(() => {
    if (pinnedCommitSha === null) {
      return;
    }

    const scroller = commitGraphScrollerRef.current;
    if (!scroller) {
      return;
    }

    const initialScrollTop = scroller.scrollTop;
    const initialScrollLeft = scroller.scrollLeft;
    let closed = false;
    const closeOnGraphScroll = () => {
      if (closed) {
        return;
      }

      const scrollDelta = Math.max(
        Math.abs(scroller.scrollTop - initialScrollTop),
        Math.abs(scroller.scrollLeft - initialScrollLeft),
      );
      if (scrollDelta < COMMIT_DETAILS_GRAPH_SCROLL_CLOSE_THRESHOLD_PX) {
        return;
      }

      closed = true;
      setPinnedCommitSha(null);
    };

    scroller.addEventListener("scroll", closeOnGraphScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", closeOnGraphScroll);
    };
  }, [pinnedCommitSha]);
  const closePinnedCommit = useCallback(() => {
    setPinnedCommitSha(null);
  }, []);
  const pinCommit = useCallback((commit: VcsCommitGraphCommit) => {
    setPinnedCommitSha((currentSha) => (currentSha === commit.sha ? null : commit.sha));
  }, []);
  const actionMutation = useMutation(
    gitRunStackedActionMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const generateCommitMessageMutation = useMutation(
    gitGenerateCommitMessageMutationOptions({
      environmentId,
      cwd,
    }),
  );
  const providerReviewMutation = useMutation(gitStartProviderReviewMutationOptions());
  const initMutation = useMutation(
    gitInitMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const pullMutation = useMutation(
    gitPullMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const stashesQuery = useQuery(
    gitStashesQueryOptions({
      environmentId,
      cwd,
      enabled: Boolean(status?.isRepo),
    }),
  );
  const createStashMutation = useMutation(
    gitCreateStashMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const applyStashMutation = useMutation(
    gitApplyStashMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const dropStashMutation = useMutation(
    gitDropStashMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const discardChangesMutation = useMutation(
    gitDiscardChangesMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const stageChangesMutation = useMutation(
    gitStageChangesMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const unstageChangesMutation = useMutation(
    gitUnstageChangesMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const createTagMutation = useMutation(
    gitCreateTagMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const deleteBranchMutation = useMutation(
    gitDeleteBranchMutationOptions({
      environmentId,
      cwd,
      queryClient,
    }),
  );
  const runningStackedActionCount = useIsMutating({
    mutationKey: gitMutationKeys.runStackedAction(environmentId, cwd),
  });
  const runningPublishActionCount = useIsMutating({
    mutationKey: gitMutationKeys.publishRepository(environmentId, cwd),
  });
  const runningPullActionCount = useIsMutating({
    mutationKey: gitMutationKeys.pull(environmentId, cwd),
  });
  const runningCreateStashCount = useIsMutating({
    mutationKey: gitMutationKeys.createStash(environmentId, cwd),
  });
  const runningApplyStashCount = useIsMutating({
    mutationKey: gitMutationKeys.applyStash(environmentId, cwd),
  });
  const runningDropStashCount = useIsMutating({
    mutationKey: gitMutationKeys.dropStash(environmentId, cwd),
  });
  const isGitActionRunning =
    runningStackedActionCount > 0 ||
    runningPublishActionCount > 0 ||
    runningPullActionCount > 0 ||
    runningCreateStashCount > 0 ||
    runningApplyStashCount > 0 ||
    runningDropStashCount > 0 ||
    actionMutation.isPending ||
    initMutation.isPending ||
    pullMutation.isPending ||
    createStashMutation.isPending ||
    applyStashMutation.isPending ||
    dropStashMutation.isPending ||
    discardChangesMutation.isPending ||
    stageChangesMutation.isPending ||
    unstageChangesMutation.isPending ||
    createTagMutation.isPending ||
    deleteBranchMutation.isPending;
  const isSourceControlMutationDisabled =
    isGitActionRunning || isParentRepositoryConfirmationRequired;
  const changedFiles = status?.workingTree.files ?? EMPTY_WORKING_TREE_FILES;
  const hasChangedFiles = changedFiles.length > 0;
  const stagedChangeFiles = useMemo(
    () =>
      changedFiles
        .map((file) => toWorkingTreeSectionFile(file, "staged"))
        .filter((file): file is WorkingTreeSectionFile => file !== null),
    [changedFiles],
  );
  const unstagedChangeFiles = useMemo(
    () =>
      changedFiles
        .map((file) => toWorkingTreeSectionFile(file, "unstaged"))
        .filter((file): file is WorkingTreeSectionFile => file !== null),
    [changedFiles],
  );
  const stagedChangeFileTree = useMemo(
    () => buildSourceControlFileTree(stagedChangeFiles),
    [stagedChangeFiles],
  );
  const unstagedChangeFileTree = useMemo(
    () => buildSourceControlFileTree(unstagedChangeFiles),
    [unstagedChangeFiles],
  );
  const changedFileTreeExpansionKey = useMemo(
    () =>
      [
        ...collectSourceControlFileTreeDirectoryPaths(stagedChangeFileTree).map(
          (pathValue) => `staged:${pathValue}`,
        ),
        ...collectSourceControlFileTreeDirectoryPaths(unstagedChangeFileTree).map(
          (pathValue) => `unstaged:${pathValue}`,
        ),
      ].join("\u0000"),
    [stagedChangeFileTree, unstagedChangeFileTree],
  );
  const changesTreeExpansionOverrides =
    changesTreeExpansionState.key === changedFileTreeExpansionKey
      ? changesTreeExpansionState.overrides
      : EMPTY_DIRECTORY_EXPANSION_OVERRIDES;
  const changedFileCount = changedFiles.length;
  const stashes = stashesQuery.data?.stashes ?? [];
  const hasBranchDivergence = Boolean(status && status.aheadCount > 0 && status.behindCount > 0);
  const shouldProtectChangesBeforePull = Boolean(
    status?.hasWorkingTreeChanges && status.behindCount > 0 && status.aheadCount === 0,
  );
  const stashChangesDisabledReason = isGitActionRunning
    ? "Git action in progress."
    : !status?.isRepo
      ? "No Git repository."
      : !status.hasWorkingTreeChanges
        ? "No working tree changes."
        : status.workingTree.files.some(
              (file) => file.indexStatus === "unmerged" || file.worktreeStatus === "unmerged",
            )
          ? "Resolve merge conflicts first."
          : repositorySafetyReason;
  const canPublishRepository = Boolean(status?.isRepo && !status.hasPrimaryRemote);
  const shouldPublishBranch = Boolean(
    status?.isRepo &&
    status.refName !== null &&
    !status.hasUpstream &&
    status.hasPrimaryRemote &&
    !status.isDefaultRef,
  );
  const sourceControlPresentation = getSourceControlPresentation(status?.sourceControlProvider);
  const changeRequestLabel = sourceControlPresentation.terminology.shortLabel;
  const openPullRequest = status?.pr?.state === "open" ? status.pr : null;
  const commitDisabledReason = actionDisabledReason({
    status,
    action: "commit",
    isBusy: isGitActionRunning,
    repositorySafetyReason,
  });
  const commitAndPushDisabledReason = actionDisabledReason({
    status,
    action: "commit_push",
    isBusy: isGitActionRunning,
    repositorySafetyReason,
  });
  const pullDisabledReason = actionDisabledReason({
    status,
    action: "pull",
    isBusy: isGitActionRunning,
    repositorySafetyReason,
  });
  const pushDisabledReason = actionDisabledReason({
    status,
    action: "push",
    isBusy: isGitActionRunning,
    repositorySafetyReason,
  });
  const prDisabledReason = actionDisabledReason({
    status,
    action: "create_pr",
    isBusy: isGitActionRunning,
    repositorySafetyReason,
  });
  const generateCommitMessageDisabledReason = isGitActionRunning
    ? "Git action in progress."
    : changedFiles.length === 0
      ? "No working tree changes."
      : generateCommitMessageMutation.isPending
        ? "Commit message generation in progress."
        : null;
  const reviewChangesDisabledReason = !activeThreadRef
    ? "Open a thread to run a Codex review."
    : !status?.isRepo
      ? "Repository unavailable."
      : changedFileCount === 0
        ? "No working tree changes."
        : providerReviewMutation.isPending
          ? "Review already in progress."
          : null;
  const reviewCommitDisabledReason = !activeThreadRef
    ? "Open a thread to run a Codex review."
    : providerReviewMutation.isPending
      ? "Review already in progress."
      : null;
  const primaryCommitPushDisabledReason = generateCommitMessageMutation.isPending
    ? "Commit message generation in progress."
    : commitAndPushDisabledReason;
  const changeRequestDisabledReason = openPullRequest
    ? isGitActionRunning
      ? "Git action in progress."
      : null
    : prDisabledReason;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction,
        branchName: status?.refName ?? "current ref",
        includesCommit:
          pendingDefaultBranchAction === "commit_push" ||
          pendingDefaultBranchAction === "commit_push_pr",
        terminology: sourceControlPresentation.terminology,
      })
    : null;

  const refreshPanel = useCallback(() => {
    if (!environmentId || !cwd) {
      return;
    }
    void refreshGitStatus({ environmentId, cwd }).catch(() => undefined);
    void queryClient.invalidateQueries({
      queryKey: gitQueryKeys.commitGraphPrefix(environmentId, cwd),
    });
  }, [cwd, environmentId, queryClient]);

  const refreshPanelFromRemote = useCallback(() => {
    if (!environmentId || !cwd) {
      return;
    }
    setIsManualRefreshPending(true);
    // Refreshing repairs the data over the unary RPC; rebuilding repairs the
    // push stream that stopped delivering it. Retry has to do both, or the
    // panel goes stale again on the next change nobody hears about.
    rebuildGitStatusSubscription({ environmentId, cwd });
    void refreshGitStatus({ environmentId, cwd }, undefined, { force: true })
      .then(() =>
        queryClient.invalidateQueries({
          queryKey: gitQueryKeys.commitGraphPrefix(environmentId, cwd),
        }),
      )
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Refresh failed",
            description: toGitActionErrorMessage(error),
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
      })
      .finally(() => setIsManualRefreshPending(false));
  }, [cwd, environmentId, queryClient, threadToastData]);

  useLayoutEffect(() => {
    const targetKey = environmentId && cwd ? `${environmentId}\0${cwd}` : null;
    if (targetKey === null) {
      commitGraphStatusRefreshRef.current = null;
      return;
    }

    const previous = commitGraphStatusRefreshRef.current;
    commitGraphStatusRefreshRef.current = {
      targetKey,
      statusKey: commitGraphStatusRefreshKey,
    };

    if (
      !previous ||
      previous.targetKey !== targetKey ||
      previous.statusKey === null ||
      commitGraphStatusRefreshKey === null ||
      previous.statusKey === commitGraphStatusRefreshKey
    ) {
      return;
    }

    void refetchCommitGraph();
  }, [commitGraphStatusRefreshKey, cwd, environmentId, refetchCommitGraph]);

  const clearCommitMessageDraft = useCallback(() => {
    setCommitMessage("");
    setCommitMessageEditorOpen(false);
  }, []);

  useEffect(() => {
    if (!environmentId || !cwd) {
      return;
    }

    const refreshStatus = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      void refreshLocalGitStatus({ environmentId, cwd }).catch(() => undefined);
    };

    refreshStatus();
    const intervalId = window.setInterval(refreshStatus, SOURCE_CONTROL_STATUS_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshStatus);
    document.addEventListener("visibilitychange", refreshStatus);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshStatus);
      document.removeEventListener("visibilitychange", refreshStatus);
    };
  }, [cwd, environmentId]);

  const runAction = useCallback(
    async (action: GitStackedAction, options?: { readonly skipDefaultBranchPrompt?: boolean }) => {
      if (!environmentId || !cwd || isParentRepositoryConfirmationRequired) {
        return;
      }
      if (
        !options?.skipDefaultBranchPrompt &&
        status?.isDefaultRef &&
        requiresDefaultBranchConfirmation(action, true)
      ) {
        if (
          action === "push" ||
          action === "create_pr" ||
          action === "commit_push" ||
          action === "commit_push_pr"
        ) {
          setPendingDefaultBranchAction(action);
        }
        return;
      }
      const actionId = randomUUID();
      const trimmedMessage = commitMessage.trim();
      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: trimmedMessage.length > 0,
        hasWorkingTreeChanges: !!status?.hasWorkingTreeChanges,
        terminology: sourceControlPresentation.terminology,
        shouldPushBeforePr:
          action === "create_pr" && (!status?.hasUpstream || (status?.aheadCount ?? 0) > 0),
      });
      const initialTitle = progressStages[0] ?? "Running git action...";
      const scopedToastData = threadToastData ? { ...threadToastData } : undefined;
      // Progress lives in the module store keyed by environment + cwd so it
      // survives this panel unmounting (diff viewer, route swaps) mid-action.
      const progressTarget = { environmentId, cwd };
      startGitActionProgress(progressTarget, { actionId, initialTitle });

      const applyProgressEvent = (event: GitActionProgressEvent) => {
        dispatchGitActionProgressEvent(progressTarget, event);
      };

      try {
        const result = await actionMutation.mutateAsync({
          actionId,
          action,
          ...((action === "commit" || action === "commit_push" || action === "commit_push_pr") &&
          trimmedMessage.length > 0
            ? { commitMessage: trimmedMessage }
            : {}),
          onProgress: applyProgressEvent,
        });
        finishGitActionProgress(progressTarget, actionId);
        if (action === "commit" || action === "commit_push" || action === "commit_push_pr") {
          setCommitMessage("");
          setCommitMessageEditorOpen(false);
        }
        toastManager.add({
          type: "success",
          title: result.toast.title,
          description: result.toast.description,
          timeout: 0,
          data: {
            ...scopedToastData,
            dismissAfterVisibleMs: 10_000,
          },
        });
        void refreshGitStatus({ environmentId, cwd }, undefined, { force: true }).catch(
          () => undefined,
        );
        void queryClient.invalidateQueries({
          queryKey: gitQueryKeys.commitGraphPrefix(environmentId, cwd),
        });
      } catch (error) {
        finishGitActionProgress(progressTarget, actionId);
        void refreshGitStatus({ environmentId, cwd }, undefined, { force: true }).catch(
          () => undefined,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Action failed",
            description: toGitActionErrorMessage(error),
            ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
          }),
        );
      }
    },
    [
      actionMutation,
      commitMessage,
      cwd,
      environmentId,
      isParentRepositoryConfirmationRequired,
      queryClient,
      sourceControlPresentation.terminology,
      status?.aheadCount,
      status?.hasUpstream,
      status?.hasWorkingTreeChanges,
      status?.isDefaultRef,
      threadToastData,
    ],
  );

  const executePull = useCallback(
    (options?: {
      readonly historyReconciliation?: VcsPullHistoryReconciliation;
      readonly stashLocalChanges?: boolean;
    }) => {
      if (isParentRepositoryConfirmationRequired) {
        return;
      }
      const requestTarget: PullRequestTarget = { environmentId, cwd };
      const promise = pullMutation.mutateAsync(options);
      void toastManager.promise<
        Awaited<ReturnType<typeof pullMutation.mutateAsync>>,
        ThreadToastData
      >(promise, {
        loading: {
          title: options?.historyReconciliation
            ? "Updating from rewritten upstream..."
            : options?.stashLocalChanges
              ? "Stashing, pulling, and restoring..."
              : hasBranchDivergence
                ? "Checking branch history..."
                : "Pulling...",
          data: threadToastData,
        },
        success: (result) => {
          switch (result.status) {
            case "pulled":
              return {
                title: "Pulled",
                description: `Updated ${result.refName} from ${result.upstreamRef ?? "upstream"}`,
                data: threadToastData,
              };
            case "skipped_up_to_date":
              return {
                title: "Already up to date",
                description: `${result.refName} is already synchronized.`,
                data: threadToastData,
              };
            case "requires_history_reconciliation":
              return options?.stashLocalChanges
                ? {
                    title: "Upstream history changed",
                    description:
                      "Stash your changes manually, then pull again to review the rewritten history.",
                    timeout: 0,
                    data: threadToastData,
                  }
                : {
                    title: "Branch history needs review",
                    description: `Review ${result.refName} against ${result.upstreamRef} before updating.`,
                    data: threadToastData,
                  };
            case "reconciled":
              return {
                title: "Updated from rewritten upstream",
                description: `Backed up ${result.refName} to ${result.recoveryRef}, then updated it from ${result.upstreamRef}.`,
                data: threadToastData,
              };
            case "pulled_with_restored_changes":
              return {
                title: "Updated and restored changes",
                description: result.stashDropped
                  ? `Updated ${result.refName} from ${result.upstreamRef} and restored your local changes.`
                  : `Updated ${result.refName} and restored your local changes. The protected stash was kept because the stash list changed.`,
                data: threadToastData,
              };
            case "pulled_with_restore_conflicts":
              return {
                title: "Updated; local changes need attention",
                description: `Your protected stash was kept. Resolve ${result.conflictedPaths.length} conflicted ${result.conflictedPaths.length === 1 ? "file" : "files"}.`,
                timeout: 0,
                data: threadToastData,
              };
            case "pulled_with_restore_failure":
              return {
                title: "Updated; protected changes need attention",
                description: result.detail,
                timeout: 0,
                data: threadToastData,
              };
            case "update_failed_with_protected_changes":
              return {
                title: "Update stopped; protected changes need attention",
                description: result.detail,
                timeout: 0,
                data: threadToastData,
              };
          }
        },
        error: (error) => {
          const authFailure = gitRemoteAuthFailureFromError(error);
          if (authFailure) {
            return {
              title: "Pull failed",
              description: formatGitErrorMessage(error),
              timeout: 0,
              actionProps: {
                children: "Fix authentication...",
                onClick: () => setAuthRemediationFailure(authFailure),
              },
              data: {
                ...threadToastData,
                actionLayout: "stacked-end" as const,
                actionVariant: "default" as const,
              },
            };
          }
          return {
            title: "Pull failed",
            description: formatGitErrorMessage(error),
            data: threadToastData,
          };
        },
      });
      void promise.then(
        (result) => {
          if (!isSamePullRequestTarget(requestTarget, currentPullTargetRef.current)) {
            return;
          }
          if (result.status === "requires_history_reconciliation" && !options?.stashLocalChanges) {
            if (requestTarget.environmentId && requestTarget.cwd) {
              setPendingHistoryReconciliation({
                environmentId: requestTarget.environmentId,
                cwd: requestTarget.cwd,
                result,
              });
            }
          } else if (result.status === "requires_history_reconciliation") {
            setPendingHistoryReconciliation(null);
            setStashDialogMode("create");
          } else if (
            result.status === "pulled_with_restore_conflicts" ||
            result.status === "pulled_with_restore_failure" ||
            result.status === "update_failed_with_protected_changes"
          ) {
            if (requestTarget.environmentId && requestTarget.cwd) {
              setPendingStashRecovery({
                environmentId: requestTarget.environmentId,
                cwd: requestTarget.cwd,
                title:
                  result.status === "update_failed_with_protected_changes"
                    ? "Update stopped; protected changes remain"
                    : "Branch updated; local changes need attention",
                detail:
                  result.status === "pulled_with_restore_conflicts"
                    ? "Threadlines kept the protected stash because restoring it caused conflicts."
                    : result.detail,
                stashId: result.stashId,
                recoveryRef: result.recoveryRef,
                conflictedPaths:
                  result.status === "pulled_with_restore_failure" ? [] : result.conflictedPaths,
              });
            }
            setPendingHistoryReconciliation(null);
          } else {
            setPendingHistoryReconciliation(null);
          }
          refreshPanel();
        },
        () => {
          if (
            options?.historyReconciliation &&
            isSamePullRequestTarget(requestTarget, currentPullTargetRef.current)
          ) {
            // A failed confirmation may mean HEAD or the upstream moved. Require a fresh probe
            // instead of leaving a stale destructive confirmation available for retry.
            setPendingHistoryReconciliation(null);
            refreshPanel();
          }
        },
      );
    },
    [
      cwd,
      environmentId,
      hasBranchDivergence,
      isParentRepositoryConfirmationRequired,
      pullMutation,
      refreshPanel,
      threadToastData,
    ],
  );

  const runPull = useCallback(() => {
    if (shouldProtectChangesBeforePull) {
      setSafePullConfirmationOpen(true);
      return;
    }
    executePull();
  }, [executePull, shouldProtectChangesBeforePull]);

  const createStash = useCallback(() => {
    const message = stashMessage.trim();
    const promise = createStashMutation.mutateAsync({
      includeUntracked: stashIncludeUntracked,
      ...(message.length > 0 ? { message } : {}),
    });
    void toastManager.promise(promise, {
      loading: { title: "Stashing changes...", data: threadToastData },
      success: (result) => ({
        title: "Changes stashed",
        description: result.stash.message,
        data: threadToastData,
      }),
      error: (error) => ({
        title: "Could not stash changes",
        description: formatGitErrorMessage(error),
        data: threadToastData,
      }),
    });
    void promise.then(
      () => {
        setStashMessage("");
        setStashIncludeUntracked(true);
        setStashDialogMode(null);
        refreshPanel();
      },
      () => {
        refreshPanel();
      },
    );
  }, [createStashMutation, refreshPanel, stashIncludeUntracked, stashMessage, threadToastData]);

  const applySelectedStash = useCallback(
    (stash: VcsStashEntry, dropAfterApply: boolean) => {
      const requestTarget: PullRequestTarget = { environmentId, cwd };
      const promise = applyStashMutation.mutateAsync({
        selector: stash.selector,
        expectedStashId: stash.id,
        dropAfterApply,
      });
      void toastManager.promise(promise, {
        loading: {
          title: dropAfterApply ? "Popping stash..." : "Applying stash...",
          data: threadToastData,
        },
        success: (result) =>
          result.status === "conflicted"
            ? {
                title: "Stash needs conflict resolution",
                description: `The stash was kept. Resolve ${result.conflictedPaths.length} conflicted ${result.conflictedPaths.length === 1 ? "file" : "files"}.`,
                timeout: 0,
                data: threadToastData,
              }
            : {
                title: dropAfterApply
                  ? result.dropped
                    ? "Stash popped"
                    : "Stash applied and kept"
                  : "Stash applied",
                description:
                  dropAfterApply && !result.dropped
                    ? "The stash list changed before cleanup, so Threadlines left the stash in place."
                    : undefined,
                data: threadToastData,
              },
        error: (error) => ({
          title: dropAfterApply ? "Could not pop stash" : "Could not apply stash",
          description: formatGitErrorMessage(error),
          data: threadToastData,
        }),
      });
      void promise.then(
        (result) => {
          if (
            result.status === "conflicted" &&
            requestTarget.environmentId &&
            requestTarget.cwd &&
            isSamePullRequestTarget(requestTarget, currentPullTargetRef.current)
          ) {
            setPendingStashRecovery({
              environmentId: requestTarget.environmentId,
              cwd: requestTarget.cwd,
              title: "Stash needs conflict resolution",
              detail: "The selected stash was kept because applying it caused conflicts.",
              stashId: result.stashId,
              recoveryRef: null,
              conflictedPaths: result.conflictedPaths,
            });
            setStashDialogMode(null);
          }
          refreshPanel();
        },
        () => {
          refreshPanel();
        },
      );
    },
    [applyStashMutation, cwd, environmentId, refreshPanel, threadToastData],
  );

  const dropSelectedStash = useCallback(() => {
    const stash = pendingDropStash;
    if (!stash) {
      return;
    }
    const promise = dropStashMutation.mutateAsync({
      selector: stash.selector,
      expectedStashId: stash.id,
    });
    void toastManager.promise(promise, {
      loading: { title: "Dropping stash...", data: threadToastData },
      success: { title: "Stash dropped", data: threadToastData },
      error: (error) => ({
        title: "Could not drop stash",
        description: formatGitErrorMessage(error),
        data: threadToastData,
      }),
    });
    void promise.then(
      () => {
        setPendingDropStash(null);
        refreshPanel();
      },
      () => {
        refreshPanel();
      },
    );
  }, [dropStashMutation, pendingDropStash, refreshPanel, threadToastData]);

  const initializeRepository = useCallback(() => {
    const promise = initMutation.mutateAsync();
    void toastManager.promise(promise, {
      loading: { title: "Initializing Git...", data: threadToastData },
      success: {
        title: "Git initialized",
        data: threadToastData,
      },
      error: (error) => ({
        title: "Git initialization failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        data: threadToastData,
      }),
    });
    void promise.then(refreshPanel, () => undefined);
  }, [initMutation, refreshPanel, threadToastData]);

  const runStageChanges = useCallback(
    (filePaths: string[], label: string, count: number) => {
      if (isParentRepositoryConfirmationRequired) {
        return;
      }
      clearCommitMessageDraft();
      const promise = stageChangesMutation.mutateAsync({ filePaths });
      void toastManager.promise(promise, {
        loading: { title: "Staging changes...", data: threadToastData },
        success: () => ({
          title: "Changes staged",
          description: count === 1 ? label : `${count} files`,
          data: threadToastData,
        }),
        error: (error) => ({
          title: "Stage changes failed",
          description: toGitActionErrorMessage(error),
          data: threadToastData,
        }),
      });
      void promise.then(refreshPanel, () => refreshPanel());
    },
    [
      clearCommitMessageDraft,
      isParentRepositoryConfirmationRequired,
      refreshPanel,
      stageChangesMutation,
      threadToastData,
    ],
  );

  const runUnstageChanges = useCallback(
    (filePaths: string[], label: string, count: number) => {
      if (isParentRepositoryConfirmationRequired) {
        return;
      }
      clearCommitMessageDraft();
      const promise = unstageChangesMutation.mutateAsync({ filePaths });
      void toastManager.promise(promise, {
        loading: { title: "Unstaging changes...", data: threadToastData },
        success: () => ({
          title: "Changes unstaged",
          description: count === 1 ? label : `${count} files`,
          data: threadToastData,
        }),
        error: (error) => ({
          title: "Unstage changes failed",
          description: toGitActionErrorMessage(error),
          data: threadToastData,
        }),
      });
      void promise.then(refreshPanel, () => refreshPanel());
    },
    [
      clearCommitMessageDraft,
      isParentRepositoryConfirmationRequired,
      refreshPanel,
      threadToastData,
      unstageChangesMutation,
    ],
  );

  const stageFileChanges = useCallback(
    (entry: WorkingTreeSectionFile) => {
      runStageChanges([entry.path], entry.path, 1);
    },
    [runStageChanges],
  );

  const unstageFileChanges = useCallback(
    (entry: WorkingTreeSectionFile) => {
      runUnstageChanges([entry.path], entry.path, 1);
    },
    [runUnstageChanges],
  );

  const stageAllUnstagedChanges = useCallback(() => {
    if (unstagedChangeFiles.length === 0) {
      return;
    }
    runStageChanges(
      unstagedChangeFiles.map((entry) => entry.path),
      "all unstaged changes",
      unstagedChangeFiles.length,
    );
  }, [runStageChanges, unstagedChangeFiles]);

  const unstageAllStagedChanges = useCallback(() => {
    if (stagedChangeFiles.length === 0) {
      return;
    }
    runUnstageChanges(
      stagedChangeFiles.map((entry) => entry.path),
      "all staged changes",
      stagedChangeFiles.length,
    );
  }, [runUnstageChanges, stagedChangeFiles]);

  const requestDiscardFileChanges = useCallback(
    (entry: WorkingTreeSectionFile) => {
      if (isParentRepositoryConfirmationRequired) {
        return;
      }
      setPendingDiscardChanges({
        filePaths: [entry.path],
        label: entry.path,
        count: 1,
        includesNewFiles: entry.status === "untracked",
        scope: "unstaged",
      });
    },
    [isParentRepositoryConfirmationRequired],
  );

  const requestDiscardAllUnstagedChanges = useCallback(() => {
    if (unstagedChangeFiles.length === 0 || isParentRepositoryConfirmationRequired) {
      return;
    }
    setPendingDiscardChanges({
      filePaths: unstagedChangeFiles.map((entry) => entry.path),
      label: "all unstaged changes",
      count: unstagedChangeFiles.length,
      includesNewFiles: unstagedChangeFiles.some((entry) => entry.status === "untracked"),
      scope: "unstaged",
    });
  }, [isParentRepositoryConfirmationRequired, unstagedChangeFiles]);

  const toggleChangesViewMode = useCallback(() => {
    setChangesViewMode((current) => (current === "tree" ? "list" : "tree"));
  }, [setChangesViewMode]);

  const toggleChangesTreeDirectory = useCallback(
    (directoryPath: string) => {
      setChangesTreeExpansionState((current) => {
        const currentOverrides =
          current.key === changedFileTreeExpansionKey ? current.overrides : {};
        const isExpanded = currentOverrides[directoryPath] ?? true;
        return {
          key: changedFileTreeExpansionKey,
          overrides: {
            ...currentOverrides,
            [directoryPath]: !isExpanded,
          },
        };
      });
    },
    [changedFileTreeExpansionKey],
  );

  const runDiscardChanges = useCallback(() => {
    if (!pendingDiscardChanges || isParentRepositoryConfirmationRequired) {
      return;
    }
    const discardRequest = pendingDiscardChanges;
    clearCommitMessageDraft();
    const promise = discardChangesMutation.mutateAsync({
      filePaths: discardRequest.filePaths,
      scope: discardRequest.scope,
    });
    setPendingDiscardChanges(null);
    void toastManager.promise(promise, {
      loading: { title: "Discarding changes...", data: threadToastData },
      success: () => ({
        title: "Changes discarded",
        description:
          discardRequest.count === 1 ? discardRequest.label : `${discardRequest.count} files`,
        data: threadToastData,
      }),
      error: (error) => ({
        title: "Discard changes failed",
        description: toGitActionErrorMessage(error),
        data: threadToastData,
      }),
    });
    void promise.then(refreshPanel, () => refreshPanel());
  }, [
    clearCommitMessageDraft,
    discardChangesMutation,
    isParentRepositoryConfirmationRequired,
    pendingDiscardChanges,
    refreshPanel,
    threadToastData,
  ]);

  const openChangedFileDiff = useCallback(
    (filePath: string) => {
      onOpenDiff?.(filePath);
    },
    [onOpenDiff],
  );

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      const api = readLocalApi();
      if (!api || !cwd) {
        return;
      }
      void openInPreferredEditor(api, resolvePathLinkTarget(filePath, cwd)).catch(() => undefined);
    },
    [cwd],
  );

  const handleChangedFileContextMenu = useCallback(
    async (entry: WorkingTreeSectionFile, position: { readonly x: number; readonly y: number }) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }

      const menuItems: readonly ContextMenuItem<ChangedFileContextAction>[] = [
        { id: "open-diff", label: "Open diff", disabled: !onOpenDiff },
        { id: "open-viewer", label: "Open in file viewer" },
        { id: "open-editor", label: "Open in external editor" },
      ];
      const clicked = await api.contextMenu.show(menuItems, position);

      if (clicked === "open-diff") {
        openChangedFileDiff(entry.path);
        return;
      }
      if (clicked === "open-viewer") {
        if (!openFileInActiveViewer({ path: entry.path })) {
          openChangedFileInEditor(entry.path);
        }
        return;
      }
      if (clicked === "open-editor") {
        openChangedFileInEditor(entry.path);
      }
    },
    [onOpenDiff, openChangedFileDiff, openChangedFileInEditor],
  );

  const openExistingPr = useCallback(() => {
    const api = readLocalApi();
    if (!api || !openPullRequest) {
      return;
    }
    void api.shell.openExternal(openPullRequest.url).catch(() => undefined);
  }, [openPullRequest]);

  const copyCommitValue = useCallback(
    (value: string, title: string, options?: CopyCommitValueOptions) => {
      return copyTextToClipboard(value).then(
        () => {
          if (options?.successToast !== false) {
            const description = value.length > 240 ? `${value.slice(0, 240)}...` : value;
            toastManager.add({
              type: "success",
              title: `${title} copied`,
              description,
            });
          }
          return true;
        },
        (error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Failed to copy ${title.toLowerCase()}`,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return false;
        },
      );
    },
    [],
  );

  const fetchCommitDetails = useCallback(
    (commit: VcsCommitGraphCommit) => {
      if (!environmentId || !cwd) {
        return Promise.reject(new Error("Commit details are unavailable."));
      }
      return queryClient.fetchQuery(
        gitCommitDetailsQueryOptions({
          environmentId,
          cwd,
          sha: commit.sha,
        }),
      );
    },
    [cwd, environmentId, queryClient],
  );

  const copyFullCommitMessage = useCallback(
    (commit: VcsCommitGraphCommit, options?: CopyCommitValueOptions) => {
      return fetchCommitDetails(commit).then(
        (details) => {
          return copyCommitValue(details.message, "Commit message", options);
        },
        (error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to copy commit message",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
          return false;
        },
      );
    },
    [copyCommitValue, fetchCommitDetails],
  );

  const openCommitUrl = useCallback(
    (commit: VcsCommitGraphCommit) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }
      void fetchCommitDetails(commit).then(
        (details) => {
          if (!details.commitUrl) {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Commit link unavailable",
                description: "No GitHub remote URL was found for this commit.",
              }),
            );
            return;
          }
          void api.shell.openExternal(details.commitUrl).catch((error) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Failed to open commit",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          });
        },
        (error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Commit link unavailable",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        },
      );
    },
    [fetchCommitDetails],
  );

  const openCreateTagDialog = useCallback((commit: VcsCommitGraphCommit) => {
    setPendingCreateTagCommit(commit);
    setCreateTagName("");
  }, []);

  const runCreateTag = useCallback(() => {
    if (!pendingCreateTagCommit || isParentRepositoryConfirmationRequired) {
      return;
    }
    const tagName = createTagName.trim();
    if (tagName.length === 0) {
      return;
    }
    const commit = pendingCreateTagCommit;
    const promise = createTagMutation.mutateAsync({
      tagName,
      targetSha: commit.sha,
    });
    setPendingCreateTagCommit(null);
    setCreateTagName("");
    void toastManager.promise(promise, {
      loading: { title: `Creating tag ${tagName}...`, data: threadToastData },
      success: (result) => ({
        title: "Tag created",
        description: `${result.tagName} at ${commit.shortSha}`,
        data: threadToastData,
      }),
      error: (error) => ({
        title: "Create tag failed",
        description: toGitActionErrorMessage(error),
        data: threadToastData,
      }),
    });
    void promise.then(refreshPanel, () => refreshPanel());
  }, [
    createTagMutation,
    createTagName,
    isParentRepositoryConfirmationRequired,
    pendingCreateTagCommit,
    refreshPanel,
    threadToastData,
  ]);

  const runDeleteBranch = useCallback(() => {
    if (!pendingDeleteBranch || isParentRepositoryConfirmationRequired) {
      return;
    }
    const deleteRequest = pendingDeleteBranch;
    const promise = deleteBranchMutation.mutateAsync(deleteRequest.branchName);
    setPendingDeleteBranch(null);
    void toastManager.promise(promise, {
      loading: { title: `Deleting ${deleteRequest.branchName}...`, data: threadToastData },
      success: () => ({
        title: "Branch deleted",
        description: deleteRequest.branchName,
        data: threadToastData,
      }),
      error: (error) => ({
        title: "Delete branch failed",
        description: toGitActionErrorMessage(error),
        data: threadToastData,
      }),
    });
    void promise.then(refreshPanel, () => refreshPanel());
  }, [
    deleteBranchMutation,
    isParentRepositoryConfirmationRequired,
    pendingDeleteBranch,
    refreshPanel,
    threadToastData,
  ]);

  const startProviderReview = useCallback(
    (reviewTarget: ProviderReviewTarget, targetDescription: string) => {
      const bootstrap = providerReviewContext.bootstrap;
      const unavailableReason =
        providerReviewContext.unavailableReason ??
        (bootstrap === null
          ? "The current thread cannot provide a project context for this review."
          : null);
      if (unavailableReason !== null || !environmentId || !cwd || bootstrap === null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Codex review unavailable",
            description: unavailableReason ?? "The source control target is unavailable.",
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
        return;
      }
      const threadTitle =
        reviewTarget.type === "commit"
          ? `Review: ${reviewTarget.title ?? reviewTarget.sha.slice(0, 12)}`
          : reviewTarget.type === "uncommittedChanges"
            ? "Review working tree changes"
            : "Code review";
      setPendingProviderReview({
        environmentId,
        cwd,
        target: reviewTarget,
        targetDescription,
        threadTitle,
        modelSelection: providerReviewContext.modelSelection,
        runtimeMode: providerReviewContext.runtimeMode,
        bootstrap,
      });
    },
    [
      cwd,
      environmentId,
      providerReviewContext.bootstrap,
      providerReviewContext.modelSelection,
      providerReviewContext.runtimeMode,
      providerReviewContext.unavailableReason,
      threadToastData,
    ],
  );

  const confirmProviderReview = useCallback(async () => {
    if (!pendingProviderReview) {
      return;
    }

    const reviewThreadId = newThreadId();
    const reviewThreadRef = scopeThreadRef(pendingProviderReview.environmentId, reviewThreadId);
    try {
      await providerReviewMutation.mutateAsync({
        environmentId: pendingProviderReview.environmentId,
        cwd: pendingProviderReview.cwd,
        threadId: reviewThreadId,
        target: pendingProviderReview.target,
        modelSelection: pendingProviderReview.modelSelection,
        runtimeMode: pendingProviderReview.runtimeMode,
        bootstrap: {
          ...pendingProviderReview.bootstrap,
          title: pendingProviderReview.threadTitle,
          modelSelection: pendingProviderReview.modelSelection,
          createdAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Review failed",
          description: error instanceof Error ? error.message : "An error occurred.",
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
      return;
    }

    setPendingProviderReview(null);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Codex review started in a new thread",
        description: pendingProviderReview.targetDescription,
        data: { threadRef: reviewThreadRef },
      }),
    );
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(reviewThreadRef),
    });
  }, [navigate, pendingProviderReview, providerReviewMutation, threadToastData]);

  const handleProviderReviewDialogOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !providerReviewMutation.isPending) {
        setPendingProviderReview(null);
      }
    },
    [providerReviewMutation.isPending],
  );
  const handleProviderReviewModelSelectionChange = useCallback((modelSelection: ModelSelection) => {
    setPendingProviderReview((pending) => (pending ? { ...pending, modelSelection } : pending));
  }, []);
  const submitProviderReview = useCallback(() => {
    void confirmProviderReview();
  }, [confirmProviderReview]);

  const handleCommitContextMenu = useCallback(
    async (commit: VcsCommitGraphCommit, position: { readonly x: number; readonly y: number }) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }
      const deletableBranches = getDeletableCommitGraphBranchRefs(commit.refs, status?.refName);
      const canOpenCommitUrl = status?.sourceControlProvider?.kind === "github";

      const clicked = await api.contextMenu.show<CommitGraphContextAction>(
        [
          { id: "copy-full-sha", label: "Copy commit id" },
          { id: "copy-title", label: "Copy title" },
          { id: "copy-full-message", label: "Copy full message" },
          ...(canOpenCommitUrl
            ? ([
                {
                  id: "open-commit",
                  label: `Open on ${sourceControlPresentation.providerName}`,
                },
              ] satisfies readonly ContextMenuItem<CommitGraphContextAction>[])
            : []),
          {
            id: "review-commit",
            label: "Review this commit with Codex...",
            disabled: reviewCommitDisabledReason !== null,
          },
          {
            id: "create-tag",
            label: "Create tag...",
            disabled: createTagMutation.isPending || isParentRepositoryConfirmationRequired,
          },
          ...deletableBranches.map((branchName) => ({
            id: `delete-branch:${branchName}` as const,
            label: `Delete branch '${branchName}'...`,
            disabled:
              !environmentId ||
              !cwd ||
              deleteBranchMutation.isPending ||
              isParentRepositoryConfirmationRequired,
          })),
        ],
        position,
      );

      if (clicked === "copy-full-sha") {
        void copyCommitValue(commit.sha, "Commit id");
        return;
      }
      if (clicked === "copy-title") {
        void copyCommitValue(commit.subject, "Commit title");
        return;
      }
      if (clicked === "copy-full-message") {
        void copyFullCommitMessage(commit);
        return;
      }
      if (clicked === "open-commit") {
        openCommitUrl(commit);
        return;
      }
      if (clicked === "review-commit") {
        void startProviderReview(
          {
            type: "commit",
            sha: commit.sha,
            title: commit.subject.trim().length > 0 ? commit.subject : null,
          },
          commit.subject.trim().length > 0 ? commit.subject : commit.shortSha,
        );
        return;
      }
      if (clicked === "create-tag") {
        openCreateTagDialog(commit);
        return;
      }
      if (clicked?.startsWith("delete-branch:")) {
        const branchName = clicked.slice("delete-branch:".length);
        if (branchName.length > 0) {
          setPendingDeleteBranch({ branchName, commit });
        }
      }
    },
    [
      copyFullCommitMessage,
      copyCommitValue,
      createTagMutation.isPending,
      cwd,
      deleteBranchMutation.isPending,
      environmentId,
      isParentRepositoryConfirmationRequired,
      openCreateTagDialog,
      openCommitUrl,
      reviewCommitDisabledReason,
      sourceControlPresentation.providerName,
      status?.sourceControlProvider?.kind,
      status?.refName,
      startProviderReview,
    ],
  );

  const generateCommitMessage = useCallback(async () => {
    if (!environmentId || !cwd || changedFileCount === 0 || isGitActionRunning) {
      return;
    }

    const hadCommitMessage = commitMessage.trim().length > 0;
    setCommitMessageEditorOpen(true);
    try {
      const result = await generateCommitMessageMutation.mutateAsync({});
      setCommitMessage(result.message);
      setCommitMessageEditorOpen(result.message.trim().length > 0);
    } catch (error) {
      if (!hadCommitMessage) {
        setCommitMessageEditorOpen(false);
      }
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Commit message generation failed",
          description: error instanceof Error ? error.message : "An error occurred.",
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    }
  }, [
    changedFileCount,
    commitMessage,
    cwd,
    environmentId,
    generateCommitMessageMutation,
    isGitActionRunning,
    threadToastData,
  ]);

  const hasCommitMessage = commitMessage.trim().length > 0;
  const showCommitMessageEditor = commitMessageEditorOpen || hasCommitMessage;
  const renderCommitMessageEditor = showCommitMessageEditor || commitMessageEditorMounted;
  const closeEmptyCommitMessageEditor = useCallback(() => {
    if (commitMessage.trim().length === 0) {
      setCommitMessageEditorOpen(false);
    }
  }, [commitMessage]);

  useEffect(() => {
    if (showCommitMessageEditor) {
      setCommitMessageEditorMounted(true);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCommitMessageEditorMounted(false);
    }, COMMIT_MESSAGE_EDITOR_TRANSITION_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [showCommitMessageEditor]);

  const primaryAction = resolveSourceControlPrimaryAction({
    status,
    hasCommitMessage,
    commitAndPushDisabledReason: primaryCommitPushDisabledReason,
    pushDisabledReason,
  });
  const normalizedChangesPanelRatio = clampChangesPanelRatio(changesPanelRatio);

  const measureSourceControlSplit = useCallback(() => {
    const body = bodyRef.current;
    const changesSection = changesSectionRef.current;
    if (!body || !changesSection) {
      return null;
    }

    const bodyRect = body.getBoundingClientRect();
    const changesRect = changesSection.getBoundingClientRect();
    const commitControlsHeight = commitControlsRef.current?.getBoundingClientRect().height ?? 0;
    const availableSplitHeight = Math.max(
      MIN_CHANGES_PANEL_HEIGHT + MIN_GRAPH_PANEL_HEIGHT,
      bodyRect.bottom -
        changesRect.top -
        commitControlsHeight -
        SOURCE_CONTROL_SPLIT_VERTICAL_CHROME,
    );
    const maxChangesHeight = Math.max(
      MIN_CHANGES_PANEL_HEIGHT,
      availableSplitHeight - MIN_GRAPH_PANEL_HEIGHT,
    );
    const minChangesHeight = Math.min(MIN_CHANGES_PANEL_HEIGHT, maxChangesHeight);
    return {
      changesTop: changesRect.top,
      availableSplitHeight,
      maxChangesHeight,
      minChangesHeight,
    };
  }, []);

  const applyChangesPanelRatio = useCallback(
    (ratio: number) => {
      const split = measureSourceControlSplit();
      if (!split) {
        return;
      }
      const nextHeight = split.availableSplitHeight * clampChangesPanelRatio(ratio);
      setChangesPanelHeight(
        clampNumber(nextHeight, split.minChangesHeight, split.maxChangesHeight),
      );
    },
    [measureSourceControlSplit],
  );

  useLayoutEffect(() => {
    applyChangesPanelRatio(normalizedChangesPanelRatio);
  }, [applyChangesPanelRatio, normalizedChangesPanelRatio, target?.cwd, target?.environmentId]);

  useEffect(() => {
    const body = bodyRef.current;
    const commitControls = commitControlsRef.current;
    if (!body || typeof ResizeObserver === "undefined") {
      return;
    }
    const resizeObserver = new ResizeObserver(() => {
      applyChangesPanelRatio(normalizedChangesPanelRatio);
    });
    resizeObserver.observe(body);
    if (commitControls) {
      resizeObserver.observe(commitControls);
    }
    return () => resizeObserver.disconnect();
  }, [applyChangesPanelRatio, normalizedChangesPanelRatio]);

  const startChangesResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const split = measureSourceControlSplit();
      if (!split) {
        return;
      }

      event.preventDefault();
      let latestChangesHeight = changesPanelHeight;

      const updateChangesHeight = (clientY: number) => {
        const nextHeight = clampNumber(
          clientY - split.changesTop,
          split.minChangesHeight,
          split.maxChangesHeight,
        );
        latestChangesHeight = nextHeight;
        setChangesPanelHeight(nextHeight);
      };

      updateChangesHeight(event.clientY);

      const onPointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        updateChangesHeight(moveEvent.clientY);
      };
      const onPointerUp = () => {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setChangesPanelRatio(
          clampChangesPanelRatio(latestChangesHeight / split.availableSplitHeight),
        );
      };

      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp, { once: true });
    },
    [changesPanelHeight, measureSourceControlSplit, setChangesPanelRatio],
  );

  const renderChangedFileRow = (
    entry: WorkingTreeSectionFile,
    options: { readonly depth?: number; readonly showDirectory?: boolean } = {},
  ) => {
    const pathParts = splitPath(entry.path);
    const statusLabel = formatWorkingTreeFileStatus(entry);
    const statusDescription = describeWorkingTreeFileStatus(entry);
    const depth = options.depth;
    const isTreeRow = depth !== undefined;
    const showDirectory = options.showDirectory ?? true;

    return (
      <div
        key={`${entry.section}:file:${entry.path}`}
        onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
          event.preventDefault();
          event.stopPropagation();
          void handleChangedFileContextMenu(entry, { x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "group/change-file grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1.5 py-1.5 transition-colors hover:bg-accent/60 pointer-coarse:py-2",
          isTreeRow ? "pr-2" : "px-2",
        )}
        style={isTreeRow ? { paddingLeft: `${8 + depth * 14}px` } : undefined}
        onPointerEnter={onPrefetchDiff}
      >
        <button
          type="button"
          aria-label={`Open diff for ${entry.path}`}
          className="grid min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-x-1.5 rounded-sm text-left outline-none focus-ring"
          onClick={() => openChangedFileDiff(entry.path)}
        >
          <TooltipWrapper tooltip={statusDescription}>
            <span
              aria-label={statusDescription}
              className={cn(
                "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border px-1 font-mono text-[10px] leading-none",
                workingTreeFileStatusClassName(entry),
              )}
            >
              {statusLabel}
            </span>
          </TooltipWrapper>
          <span className="min-w-0">
            <DelayedSourceControlNameTooltip
              label={pathParts.name}
              className="block truncate text-xs text-foreground"
            />
            {showDirectory && pathParts.directory ? (
              <DelayedSourceControlNameTooltip
                label={pathParts.directory}
                className="block truncate font-mono text-[10px] text-muted-foreground/55"
              />
            ) : null}
          </span>
        </button>
        <span className="shrink-0 self-center font-mono text-[10px]">
          <span className="text-success">+{entry.insertions}</span>
          <span className="px-0.5 text-muted-foreground/60">/</span>
          <span className="text-destructive">-{entry.deletions}</span>
        </span>
        <div
          className={cn(
            "flex shrink-0 items-center gap-px pointer-coarse:gap-1",
            CHANGED_FILE_ACTIONS_VISIBILITY_CLASS_NAME,
          )}
        >
          {entry.section === "unstaged" ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      aria-label={`Discard changes to ${entry.path}`}
                      variant="ghost"
                      size="icon-xs"
                      className={cn(
                        CHANGED_FILE_ROW_ACTION_BUTTON_CLASS_NAME,
                        "hover:text-destructive-foreground",
                      )}
                      disabled={isSourceControlMutationDisabled}
                      onClick={() => requestDiscardFileChanges(entry)}
                    />
                  }
                >
                  <Undo2Icon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {repositorySafetyReason ?? "Discard changes"}
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      aria-label={`Stage changes to ${entry.path}`}
                      variant="ghost"
                      size="icon-xs"
                      className={cn(
                        CHANGED_FILE_ROW_ACTION_BUTTON_CLASS_NAME,
                        "hover:text-foreground",
                      )}
                      disabled={isSourceControlMutationDisabled}
                      onClick={() => stageFileChanges(entry)}
                    />
                  }
                >
                  <PlusIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">{repositorySafetyReason ?? "Stage changes"}</TooltipPopup>
              </Tooltip>
            </>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    aria-label={`Unstage changes to ${entry.path}`}
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      CHANGED_FILE_ROW_ACTION_BUTTON_CLASS_NAME,
                      "hover:text-foreground",
                    )}
                    disabled={isSourceControlMutationDisabled}
                    onClick={() => unstageFileChanges(entry)}
                  />
                }
              >
                <MinusIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">{repositorySafetyReason ?? "Unstage changes"}</TooltipPopup>
            </Tooltip>
          )}
        </div>
      </div>
    );
  };

  const renderChangedFileTreeNode = (
    node: SourceControlFileTreeNode<WorkingTreeSectionFile>,
    depth: number,
  ): ReactNode => {
    if (node.kind === "file") {
      return renderChangedFileRow(node.file, { depth, showDirectory: false });
    }

    const isExpanded = changesTreeExpansionOverrides[node.path] ?? true;
    return (
      <div key={`dir:${node.path}`}>
        <button
          type="button"
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${node.path}`}
          aria-expanded={isExpanded}
          className="group/change-directory grid w-full cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-1.5 py-1.5 pr-2 text-left transition-colors hover:bg-accent/60"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          onClick={() => toggleChangesTreeDirectory(node.path)}
        >
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground/60 transition-transform group-hover/change-directory:text-foreground/80",
              isExpanded && "rotate-90",
            )}
          />
          <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/65" />
          <DelayedSourceControlNameTooltip
            label={node.name}
            className="truncate font-mono text-[10px] text-muted-foreground/80 group-hover/change-directory:text-foreground/90"
          />
          <span className="shrink-0 self-center font-mono text-[10px]">
            <span className="text-success">+{node.insertions}</span>
            <span className="px-0.5 text-muted-foreground/60">/</span>
            <span className="text-destructive">-{node.deletions}</span>
          </span>
        </button>
        {isExpanded ? (
          <div>
            {node.children.map((childNode) => renderChangedFileTreeNode(childNode, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  const renderWorkingTreeChangeSection = ({
    title,
    entries,
    tree,
    emptyMessage,
    actions,
  }: {
    readonly title: string;
    readonly entries: readonly WorkingTreeSectionFile[];
    readonly tree: readonly SourceControlFileTreeNode<WorkingTreeSectionFile>[];
    readonly emptyMessage?: string;
    readonly actions: ReactNode;
  }) => {
    const insertions = entries.reduce((sum, entry) => sum + entry.insertions, 0);
    const deletions = entries.reduce((sum, entry) => sum + entry.deletions, 0);

    if (entries.length === 0 && !emptyMessage) {
      return null;
    }

    return (
      <div className="border-b border-border/55 last:border-b-0">
        <div className="flex items-center justify-between gap-2 border-b border-border/35 bg-background/45 px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[11px] font-medium text-muted-foreground/90">
              {title}
            </span>
            <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {entries.length}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="mr-1 font-mono text-[10px] text-muted-foreground">
              <span className="text-success">+{insertions}</span>
              <span className="px-0.5 text-muted-foreground/60">/</span>
              <span className="text-destructive">-{deletions}</span>
            </span>
            {actions}
          </div>
        </div>
        {entries.length === 0 ? (
          <div className="px-2.5 py-2 text-xs text-muted-foreground/70">{emptyMessage}</div>
        ) : (
          <div className={changesViewMode === "list" ? "divide-y divide-border/45" : "py-1"}>
            {changesViewMode === "list"
              ? entries.map((entry) => renderChangedFileRow(entry))
              : tree.map((node) => renderChangedFileTreeNode(node, 0))}
          </div>
        )}
      </div>
    );
  };

  if (!target) {
    return null;
  }

  const headerTitle = status?.refName ? `${target.name} - ${status.refName}` : target.name;
  const sourceControlLinks = deriveSourceControlQuickLinks(status);

  const refreshButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            aria-label={
              isSourceControlRefreshing ? "Refreshing source control" : "Refresh source control"
            }
            variant="ghost"
            size="icon-xs"
            className="shrink-0"
            onClick={refreshPanelFromRemote}
          />
        }
      >
        <RefreshCwIcon className={cn("size-3.5", isSourceControlRefreshing && "animate-spin")} />
      </TooltipTrigger>
      <TooltipPopup side="top">Refresh</TooltipPopup>
    </Tooltip>
  );

  // The repository row: which checkout these changes are in, and the branch
  // they are on. Embedded it is the panel's whole header, so it takes the
  // refresh control with it.
  const repositoryRow = (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 px-3",
        embedded ? "h-9 border-b border-border" : "pt-0.5 pb-2",
      )}
    >
      <span
        className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/85"
        title={headerTitle}
      >
        {target.name}
      </span>
      {target.effectiveCwd ? (
        <TooltipWrapper
          tooltip={`This thread's work is currently in ${target.effectiveCwd}; showing that checkout.`}
        >
          <span className="inline-flex min-w-0 max-w-[45%] items-center gap-1 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-amber-600 dark:text-amber-400">
            <FolderGit2Icon className="size-3 shrink-0 opacity-70" />
            <span className="min-w-0 truncate">{threadWorkingCwdLabel(target.effectiveCwd)}</span>
          </span>
        </TooltipWrapper>
      ) : null}
      {sourceControlLinks ? <SourceControlLinksMenu links={sourceControlLinks} /> : null}
      {status?.refName ? (
        <TooltipWrapper tooltip={`Branch: ${status.refName}`}>
          {/* Which branch, in the same voice as the left sidebar's version text:
              mono, muted, no fill. It is a fact about the header, not a control
              waiting to be pressed. */}
          <span
            className="inline-flex min-w-0 max-w-[45%] items-center gap-1 font-mono text-[10px] leading-none text-muted-foreground/70"
            data-source-control-branch-chip="true"
          >
            <GitBranchIcon className="size-3 shrink-0 opacity-70" />
            <span className="min-w-0 truncate">{status.refName}</span>
          </span>
        </TooltipWrapper>
      ) : null}
      {embedded ? <span className="-mr-1 shrink-0">{refreshButton}</span> : null}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-rail" data-source-control-panel="true">
      {embedded ? (
        repositoryRow
      ) : (
        <div className="drag-region shrink-0 border-b border-border">
          <div className="@container/source-control-title flex h-12 items-center justify-between gap-2 px-4 py-2 wco:min-h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
            <div className="flex min-w-0 items-center gap-1.5">
              <SourceControlIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
              <h2
                aria-label="Source Control"
                className="truncate text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70"
                title="Source Control"
              >
                <span className="source-control-title-short">SC</span>
                <span className="source-control-title-full">Source Control</span>
              </h2>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {refreshButton}
              {onClose ? (
                <Button
                  type="button"
                  aria-label="Close source control panel"
                  variant="ghost"
                  size="icon-xs"
                  className="sm:hidden"
                  onClick={onClose}
                >
                  <XIcon className="size-3.5" />
                </Button>
              ) : null}
            </div>
          </div>
          {repositoryRow}
        </div>
      )}

      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-3">
        {parentRepositoryRoot ? (
          <section
            role="alert"
            className="mb-3 border-y border-warning/25 py-2.5 text-xs"
            data-parent-repository-warning
          >
            <div className="flex items-start gap-2">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">Parent repository detected</p>
                <p className="mt-1 leading-snug text-muted-foreground/80">
                  This project is inside a repository rooted at{" "}
                  <span className="font-mono text-foreground/80">
                    {threadWorkingCwdLabel(parentRepositoryRoot)}
                  </span>
                  . Changes and actions can include files outside {target.name}.
                </p>
                <p
                  className="mt-1 truncate font-mono text-[10px] text-muted-foreground/60"
                  title={parentRepositoryRoot}
                >
                  {parentRepositoryRoot}
                </p>
                {isParentRepositoryConfirmationRequired ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => setApprovedParentRepositoryKey(parentRepositoryKey)}
                    >
                      Use parent repository
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={initMutation.isPending}
                      onClick={initializeRepository}
                    >
                      {initMutation.isPending ? "Initializing" : "Initialize here"}
                    </Button>
                  </div>
                ) : (
                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground/70">
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <CheckIcon className="size-3 shrink-0 text-success" />
                      Parent actions enabled for this panel
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setApprovedParentRepositoryKey(null)}
                    >
                      Lock
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </section>
        ) : null}
        {checkoutRecoveryView.recovery ? (
          <section className="mb-3 border-b border-border pb-3 text-xs">
            <p className="font-medium text-foreground">This thread's folder no longer exists.</p>
            <p className="mt-1 font-mono text-muted-foreground/70">
              {checkoutRecoveryView.recovery.cwd}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {checkoutRecoveryView.recovery.canSwitchToProjectRoot ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={checkoutRecoveryView.isBusy}
                  onClick={checkoutRecoveryView.onSwitchToProjectRoot}
                >
                  Switch to local checkout
                </Button>
              ) : null}
              {checkoutRecoveryView.recovery.canRecreateWorktree ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={checkoutRecoveryView.isBusy}
                  onClick={checkoutRecoveryView.onRecreateWorktree}
                >
                  Recreate worktree
                </Button>
              ) : null}
            </div>
          </section>
        ) : null}
        {/* Only offered for a folder that exists but holds no repository.
            A checkout that was deleted gets the recovery section above: running
            `git init` there would recreate the directory as an unrelated empty
            repository and quietly strand the thread's real work. */}
        {status?.isRepo === false && !checkoutRecoveryView.recovery ? (
          <section className="mb-3 rounded-md border border-border/70 bg-background/40 px-3 py-3 text-xs">
            <p className="font-medium text-foreground">No Git repository</p>
            <p className="mt-1 text-muted-foreground/70">
              Initialize Git for this project to enable commits, push, and pull requests.
            </p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="mt-3"
              disabled={initMutation.isPending}
              onClick={initializeRepository}
            >
              <GitCommitIcon className="size-3" />
              {initMutation.isPending ? "Initializing" : "Initialize Git"}
            </Button>
          </section>
        ) : null}
        <section
          ref={changesSectionRef}
          className="flex min-h-[6rem] shrink-0 flex-col space-y-2"
          style={{ height: changesPanelHeight }}
        >
          <div className="flex items-center justify-between gap-2">
            <SectionLabel as="h3">Changes</SectionLabel>
            <div className="flex shrink-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      aria-label={
                        changesViewMode === "tree" ? "View changes as list" : "View changes as tree"
                      }
                      variant="ghost"
                      size="icon-xs"
                      className={cn(
                        "text-muted-foreground/70 hover:text-foreground",
                        changesViewMode === "tree" && "bg-accent text-foreground",
                      )}
                      disabled={changedFiles.length === 0}
                      onClick={toggleChangesViewMode}
                    />
                  }
                >
                  {changesViewMode === "tree" ? (
                    <Rows3Icon className="size-3.5" />
                  ) : (
                    <ListTreeIcon className="size-3.5" />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {changesViewMode === "tree" ? "View as list" : "View as tree"}
                </TooltipPopup>
              </Tooltip>
              {onOpenDiff ? (
                // `aria-disabled` rather than `disabled`: the button's own base
                // style drops pointer events while disabled, so the tooltip
                // saying why it is unavailable would never open -- on the one
                // state where the button needs to explain itself.
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-disabled={hasChangedFiles ? undefined : true}
                  className={cn(!hasChangedFiles && "cursor-default opacity-64")}
                  tooltip={hasChangedFiles ? undefined : "Nothing to diff yet"}
                  onPointerEnter={hasChangedFiles ? onPrefetchDiff : undefined}
                  onClick={hasChangedFiles ? () => onOpenDiff() : undefined}
                >
                  <FileTextIcon className="size-3" />
                  Diff
                </Button>
              ) : null}
              <span className="font-mono text-[11px] text-muted-foreground">
                <span className="text-success">+{status?.workingTree.insertions ?? 0}</span>
                <span className="px-0.5 text-muted-foreground/60">/</span>
                <span className="text-destructive">-{status?.workingTree.deletions ?? 0}</span>
              </span>
            </div>
          </div>
          {!environmentApiAvailable ? (
            <div
              role="status"
              className="flex items-center gap-2 border-t border-border/70 py-2 text-[13px] text-muted-foreground/70"
            >
              <RefreshCwIcon className="size-3 animate-spin" aria-hidden />
              <span>Connection lost. Reconnecting…</span>
            </div>
          ) : isSourceControlStatusStale ? (
            <div className="flex items-center gap-2 border-t border-border/70 py-2 text-[13px] text-muted-foreground/70">
              <span>{GIT_STATUS_STALE_MESSAGE}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={isManualRefreshPending}
                onClick={refreshPanelFromRemote}
              >
                Retry
              </Button>
            </div>
          ) : changedFiles.length === 0 ? (
            // Nothing to show is a line, not a box. The left sidebar's empty
            // states are flat text and this one is no different. While the
            // parent-repository gate is up the list is empty because queries
            // are paused, not because the tree is clean — saying "no changes"
            // there sends people hunting for a different bug.
            <div
              className="border-t border-border/40 py-2 text-[12px] text-muted-foreground/55"
              data-source-control-empty="true"
            >
              {isParentRepositoryConfirmationRequired
                ? "Changes are hidden until you confirm the parent repository above."
                : "No working tree changes"}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/70 bg-background/35 recess">
              {renderWorkingTreeChangeSection({
                title: "Staged Changes",
                entries: stagedChangeFiles,
                tree: stagedChangeFileTree,
                actions: (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          aria-label="Unstage all changes"
                          variant="ghost"
                          size="icon-xs"
                          className="text-muted-foreground/70 hover:text-foreground"
                          disabled={
                            stagedChangeFiles.length === 0 || isSourceControlMutationDisabled
                          }
                          onClick={unstageAllStagedChanges}
                        />
                      }
                    >
                      <MinusIcon className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">Unstage all changes</TooltipPopup>
                  </Tooltip>
                ),
              })}
              {renderWorkingTreeChangeSection({
                title: "Changes",
                entries: unstagedChangeFiles,
                tree: unstagedChangeFileTree,
                ...(stagedChangeFiles.length > 0
                  ? { emptyMessage: "No unstaged working tree changes" }
                  : {}),
                actions: (
                  <>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            aria-label="Discard all changes"
                            variant="ghost"
                            size="icon-xs"
                            className="text-muted-foreground/70 hover:text-destructive-foreground"
                            disabled={
                              unstagedChangeFiles.length === 0 || isSourceControlMutationDisabled
                            }
                            onClick={requestDiscardAllUnstagedChanges}
                          />
                        }
                      >
                        <Undo2Icon className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">Discard all changes</TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            aria-label="Stage all changes"
                            variant="ghost"
                            size="icon-xs"
                            className="text-muted-foreground/70 hover:text-foreground"
                            disabled={
                              unstagedChangeFiles.length === 0 || isSourceControlMutationDisabled
                            }
                            onClick={stageAllUnstagedChanges}
                          />
                        }
                      >
                        <PlusIcon className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">Stage all changes</TooltipPopup>
                    </Tooltip>
                  </>
                ),
              })}
            </div>
          )}
        </section>

        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize changes list"
          className="group/source-control-resizer -mx-1 my-2 flex h-3 shrink-0 cursor-row-resize items-center px-1"
          onPointerDown={startChangesResize}
        >
          <div className="h-px w-full bg-border/70 transition-colors group-hover/source-control-resizer:bg-primary/70" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <section ref={commitControlsRef} className="shrink-0 space-y-2">
            {renderCommitMessageEditor ? (
              <div
                aria-hidden={!showCommitMessageEditor}
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-150 ease-out",
                  showCommitMessageEditor
                    ? "grid-rows-[1fr] opacity-100"
                    : "grid-rows-[0fr] opacity-0",
                )}
              >
                <div className="min-h-0 overflow-hidden">
                  <Textarea
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                    placeholder="Commit message"
                    size="sm"
                    className="min-h-[4.5rem] resize-none text-xs"
                    autoFocus={showCommitMessageEditor && commitMessageEditorOpen}
                    onBlur={closeEmptyCommitMessageEditor}
                    disabled={generateCommitMessageMutation.isPending || !showCommitMessageEditor}
                    aria-busy={generateCommitMessageMutation.isPending}
                    tabIndex={showCommitMessageEditor ? undefined : -1}
                  />
                </div>
              </div>
            ) : null}
            {generateCommitMessageMutation.isPending ? (
              <div
                role="status"
                aria-live="polite"
                className="flex min-w-0 items-start gap-2 rounded-md border border-border/70 bg-muted/35 px-2.5 py-2"
              >
                <RefreshCwIcon
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    Generating commit message...
                  </div>
                  <div
                    className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
                    title="Reading the current Git diff"
                  >
                    Reading the current Git diff
                  </div>
                </div>
              </div>
            ) : null}
            {activeGitActionProgressView ? (
              <div
                role="status"
                aria-live="polite"
                className="flex min-w-0 items-start gap-2 rounded-md border border-border/70 bg-muted/35 px-2.5 py-2"
              >
                <RefreshCwIcon
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">
                    {activeGitActionProgressView.title}
                  </div>
                  <div
                    className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
                    title={activeGitActionProgressView.description ?? "Waiting for Git..."}
                  >
                    {activeGitActionProgressView.description ?? "Waiting for Git..."}
                  </div>
                </div>
              </div>
            ) : null}
            <div className="grid w-full grid-cols-[minmax(0,1fr)_1.5rem] gap-1.5">
              <ActionButton
                label={primaryAction.label}
                icon={
                  primaryAction.icon === "upload" ? (
                    <UploadIcon className="size-3" />
                  ) : (
                    <SparklesIcon className="size-3" />
                  )
                }
                disabledReason={primaryAction.disabledReason}
                onClick={() => void runAction(primaryAction.action)}
                variant="default"
              />
              <Menu>
                <MenuTrigger
                  className="w-full"
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-xs"
                      className="h-7 w-full"
                      aria-label="Source control actions"
                    />
                  }
                  disabled={isGitActionRunning || generateCommitMessageMutation.isPending}
                >
                  <ChevronDownIcon className="size-3.5" />
                </MenuTrigger>
                <MenuPopup align="end" side="top" className="w-56">
                  <MenuGroup>
                    <MenuGroupLabel>Actions</MenuGroupLabel>
                    <MenuItem
                      disabled={generateCommitMessageDisabledReason !== null}
                      onClick={() => void generateCommitMessage()}
                    >
                      <SparklesIcon className="size-3.5" />
                      <span>Generate message</span>
                    </MenuItem>
                    <MenuItem
                      disabled={reviewChangesDisabledReason !== null}
                      onClick={() =>
                        void startProviderReview(
                          { type: "uncommittedChanges" },
                          "Working tree changes",
                        )
                      }
                    >
                      <ListTreeIcon className="size-3.5" />
                      <span>Review changes with Codex...</span>
                    </MenuItem>
                    <MenuItem
                      disabled={commitDisabledReason !== null}
                      onClick={() => setCommitMessageEditorOpen(true)}
                    >
                      <FileTextIcon className="size-3.5" />
                      <span>Write message</span>
                    </MenuItem>
                    <MenuItem
                      disabled={commitDisabledReason !== null}
                      onClick={() => void runAction("commit")}
                    >
                      <GitCommitIcon className="size-3.5" />
                      <span>Commit only</span>
                    </MenuItem>
                    <MenuItem
                      disabled={commitAndPushDisabledReason !== null}
                      onClick={() => void runAction("commit_push")}
                    >
                      <UploadIcon className="size-3.5" />
                      <span>Commit & push</span>
                    </MenuItem>
                    <MenuItem
                      disabled={pushDisabledReason !== null}
                      onClick={() => void runAction("push")}
                    >
                      <UploadIcon className="size-3.5" />
                      <span>{shouldPublishBranch ? "Publish branch" : "Push only"}</span>
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      disabled={stashChangesDisabledReason !== null}
                      onClick={() => setStashDialogMode("create")}
                    >
                      <ArchiveIcon className="size-3.5" />
                      <span>Stash changes...</span>
                    </MenuItem>
                    <MenuItem
                      disabled={!status?.isRepo || isGitActionRunning}
                      onClick={() => setStashDialogMode("manage")}
                    >
                      <ArchiveIcon className="size-3.5" />
                      <span>View stashes{stashes.length > 0 ? ` (${stashes.length})` : ""}</span>
                    </MenuItem>
                  </MenuGroup>
                </MenuPopup>
              </Menu>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <ActionButton
                label={
                  hasBranchDivergence
                    ? "Resolve"
                    : shouldProtectChangesBeforePull
                      ? "Stash & pull"
                      : "Pull"
                }
                icon={<DownloadIcon className="size-3" />}
                disabledReason={pullDisabledReason}
                onClick={runPull}
              />
              <ActionButton
                label={openPullRequest ? `Open ${changeRequestLabel}` : `New ${changeRequestLabel}`}
                icon={
                  openPullRequest ? (
                    <ExternalLinkIcon className="size-3" />
                  ) : (
                    <GitPullRequestIcon className="size-3" />
                  )
                }
                disabledReason={changeRequestDisabledReason}
                onClick={openPullRequest ? openExistingPr : () => void runAction("create_pr")}
              />
            </div>
            {canPublishRepository ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={isSourceControlMutationDisabled}
                onClick={() => setIsPublishDialogOpen(true)}
                className="w-full min-w-0 justify-center"
              >
                <CloudUploadIcon className="size-3" />
                <span className="truncate">Publish repository</span>
              </Button>
            ) : null}
            <SourceControlBranchMenu
              target={target}
              activeThreadRef={activeThreadRef}
              onActiveBranchChange={onActiveBranchChange}
              status={status}
              isBusy={isGitActionRunning}
              repositorySafetyReason={repositorySafetyReason}
              refreshPanel={refreshPanel}
            />
            {status?.isRepo && stashes.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={isGitActionRunning}
                onClick={() => setStashDialogMode("manage")}
                className="w-full min-w-0 justify-center"
              >
                <ArchiveIcon className="size-3" />
                <span className="truncate">Stashes ({stashes.length})</span>
              </Button>
            ) : null}
          </section>

          <section className="flex min-h-[7.5rem] flex-1 flex-col space-y-2">
            <div className="flex items-center justify-between gap-2">
              <SectionLabel as="h3">Graph</SectionLabel>
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60">
                {isCommitGraphRefreshing ? (
                  <RefreshCwIcon className="size-3 animate-spin" aria-label="Refreshing graph" />
                ) : null}
                {commitGraphCountLabel}
              </span>
            </div>
            <div
              ref={commitGraphScrollerRef}
              className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/70 bg-background/35 recess"
              data-commit-graph-scroll-container
            >
              {status === null ? (
                <CommitGraphSkeleton />
              ) : !status.isRepo ? (
                <CommitGraphMessage>No Git repository</CommitGraphMessage>
              ) : isCommitGraphInitialLoading ? (
                <CommitGraphSkeleton />
              ) : graphQuery.isError && !graphHasData ? (
                <CommitGraphMessage
                  action={
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={() => void refetchCommitGraph()}
                    >
                      <RefreshCwIcon className="size-3" />
                      <span>Retry</span>
                    </Button>
                  }
                >
                  <div className="max-w-full space-y-1 leading-snug">
                    <div>{commitGraphErrorPresentation?.title ?? "Graph failed to load"}</div>
                    {commitGraphErrorPresentation?.description ? (
                      <div className="text-muted-foreground/60">
                        {commitGraphErrorPresentation.description}
                      </div>
                    ) : null}
                    {commitGraphErrorPresentation?.repairCommand ? (
                      <code className="block max-w-full rounded-sm bg-muted/45 px-1.5 py-1 font-mono text-[11px] break-all text-muted-foreground/90">
                        {commitGraphErrorPresentation.repairCommand}
                      </code>
                    ) : null}
                  </div>
                </CommitGraphMessage>
              ) : commitGraphRows.length === 0 ? (
                <CommitGraphMessage>No commits yet</CommitGraphMessage>
              ) : (
                <div>
                  <div>
                    {commitGraphRows.map((row) => (
                      <CommitGraphRow
                        key={row.commit.sha}
                        commit={row.commit}
                        currentBranch={status?.refName}
                        details={pinnedCommitSha === row.commit.sha ? pinnedCommitDetails : null}
                        detailsError={
                          pinnedCommitSha === row.commit.sha ? pinnedCommitDetailsError : null
                        }
                        detailsLoading={
                          pinnedCommitSha === row.commit.sha &&
                          pinnedCommitDetails === null &&
                          pinnedCommitDetailsError === null
                        }
                        isAnyCommitPinned={pinnedCommitSha !== null}
                        isPinned={pinnedCommitSha === row.commit.sha}
                        layout={row.layout}
                        visibleRefs={row.visibleRefs}
                        onClosePinnedCommit={closePinnedCommit}
                        onCopyCommitValue={copyCommitValue}
                        onCopyFullMessage={copyFullCommitMessage}
                        onCommitContextMenu={handleCommitContextMenu}
                        onOpenCommitUrl={openCommitUrl}
                        onPinCommit={pinCommit}
                      />
                    ))}
                  </div>
                  {shouldShowCommitGraphFooter ? (
                    <div
                      className={cn(
                        "flex gap-2 border-t border-border/60 px-2.5 py-2 text-xs",
                        hasCommitGraphLoadMoreError
                          ? "flex-col items-stretch text-muted-foreground/70"
                          : "items-center justify-center",
                      )}
                    >
                      {hasCommitGraphLoadMoreError ? (
                        <span className="min-w-0 truncate">{commitGraphLoadMoreDescription}</span>
                      ) : null}
                      <div
                        className={cn(
                          "grid w-full gap-2",
                          isCommitGraphFooterSplit ? "grid-cols-2" : "grid-cols-1",
                        )}
                      >
                        {canCommitGraphShowLess ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            className="min-w-0 justify-center"
                            aria-label={commitGraphShowLessButtonAriaLabel}
                            onClick={showLessCommitGraph}
                          >
                            <span className="truncate">Show less</span>
                          </Button>
                        ) : null}
                        {shouldShowCommitGraphLoadMore ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            className="min-w-0 justify-center"
                            disabled={graphQuery.isFetching && !hasCommitGraphLoadMoreError}
                            aria-label={commitGraphLoadMoreButtonAriaLabel}
                            onClick={loadOlderCommitGraph}
                          >
                            {isCommitGraphLoadingMore ? (
                              <RefreshCwIcon className="size-3 animate-spin" />
                            ) : hasCommitGraphLoadMoreError ? (
                              <RefreshCwIcon className="size-3" />
                            ) : null}
                            <span className="truncate">{commitGraphLoadMoreButtonLabel}</span>
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      <ProviderReviewDialog
        open={pendingProviderReview !== null}
        targetDescription={pendingProviderReview?.targetDescription ?? "Code review"}
        modelSelection={
          pendingProviderReview?.modelSelection ?? providerReviewContext.modelSelection
        }
        providerInstanceEntries={providerReviewContext.providerInstanceEntries}
        modelOptionsByInstance={providerReviewModelOptionsByInstance}
        isPending={providerReviewMutation.isPending}
        onOpenChange={handleProviderReviewDialogOpenChange}
        onModelSelectionChange={handleProviderReviewModelSelectionChange}
        onConfirm={submitProviderReview}
      />
      <Dialog
        open={pendingCreateTagCommit !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingCreateTagCommit(null);
            setCreateTagName("");
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              runCreateTag();
            }}
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <TagIcon className="size-4 text-muted-foreground" />
                Create tag
              </DialogTitle>
              <DialogDescription>
                Create a lightweight tag at{" "}
                <span className="font-mono">{pendingCreateTagCommit?.shortSha ?? "commit"}</span>
                {pendingCreateTagCommit ? ` - ${pendingCreateTagCommit.subject}` : ""}.
              </DialogDescription>
            </DialogHeader>
            <div className="px-6 pt-1 pb-4">
              <Input
                autoFocus
                className="w-full"
                nativeInput
                placeholder="v1.0.0"
                size="sm"
                value={createTagName}
                onChange={(event) => setCreateTagName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => {
                  setPendingCreateTagCommit(null);
                  setCreateTagName("");
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                type="submit"
                disabled={
                  createTagMutation.isPending ||
                  createTagName.trim().length === 0 ||
                  isParentRepositoryConfirmationRequired
                }
              >
                Create tag
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <AlertDialog
        open={pendingDeleteBranch !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteBranch(null);
          }
        }}
      >
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete branch?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteBranch ? (
                <>
                  Delete local branch{" "}
                  <span className="font-mono">{pendingDeleteBranch.branchName}</span> at{" "}
                  <span className="font-mono">{pendingDeleteBranch.commit.shortSha}</span>. Git will
                  refuse if the branch is not fully merged.
                </>
              ) : (
                "Delete the selected local branch."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleteBranchMutation.isPending || isParentRepositoryConfirmationRequired}
              onClick={runDeleteBranch}
            >
              Delete branch
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={pendingDiscardChanges !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDiscardChanges(null);
          }
        }}
      >
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDiscardChanges
                ? buildDiscardChangesDescription(pendingDiscardChanges)
                : "Discard selected working tree changes. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={discardChangesMutation.isPending || isParentRepositoryConfirmationRequired}
              onClick={runDiscardChanges}
            >
              Discard
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <Dialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDefaultBranchAction(null);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingDefaultBranchActionCopy?.title ?? "Run action on default ref?"}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingDefaultBranchAction(null)}>
              Abort
            </Button>
            <Button
              size="sm"
              onClick={() => {
                const action = pendingDefaultBranchAction;
                setPendingDefaultBranchAction(null);
                if (action) {
                  void runAction(action, { skipDefaultBranchPrompt: true });
                }
              }}
            >
              {pendingDefaultBranchActionCopy?.continueLabel ?? "Continue"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <AlertDialog
        open={safePullConfirmationOpen}
        onOpenChange={(open) => {
          if (!pullMutation.isPending) {
            setSafePullConfirmationOpen(open);
          }
        }}
      >
        <AlertDialogPopup className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Stash, pull, and restore?</AlertDialogTitle>
            <AlertDialogDescription>
              Threadlines will temporarily stash {changedFileCount} changed{" "}
              {changedFileCount === 1 ? "file" : "files"}, including untracked files, fast-forward{" "}
              <span className="font-mono">{status?.refName ?? "the current branch"}</span> by{" "}
              {status?.behindCount ?? 0} {(status?.behindCount ?? 0) === 1 ? "commit" : "commits"},
              then restore your staged and unstaged changes. Nothing will be committed or pushed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="outline" size="sm" disabled={pullMutation.isPending} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={pullMutation.isPending || pullDisabledReason !== null}
              onClick={() => {
                setSafePullConfirmationOpen(false);
                executePull({ stashLocalChanges: true });
              }}
            >
              Stash, pull &amp; restore
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <Dialog
        open={stashDialogMode === "create"}
        onOpenChange={(open) => {
          if (!createStashMutation.isPending) {
            setStashDialogMode(open ? "create" : null);
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              createStash();
            }}
          >
            <DialogHeader>
              <DialogTitle>Stash changes</DialogTitle>
              <DialogDescription>
                Save your current changes without creating a commit. You can apply or pop this stash
                later.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-4 space-y-4">
              <Input
                autoFocus
                nativeInput
                size="sm"
                maxLength={200}
                placeholder="Optional description"
                value={stashMessage}
                onChange={(event) => setStashMessage(event.target.value)}
              />
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={stashIncludeUntracked}
                  onCheckedChange={(checked) => setStashIncludeUntracked(Boolean(checked))}
                />
                <span>Include untracked files</span>
              </label>
            </div>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={createStashMutation.isPending}
                onClick={() => setStashDialogMode(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={
                  createStashMutation.isPending ||
                  stashChangesDisabledReason !== null ||
                  stashMessage.trim().length > 200
                }
              >
                Stash changes
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={stashDialogMode === "manage"}
        onOpenChange={(open) => {
          if (!applyStashMutation.isPending && !dropStashMutation.isPending) {
            setStashDialogMode(open ? "manage" : null);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Stashes</DialogTitle>
            <DialogDescription>
              Apply keeps a stash. Pop applies it and removes it only after a successful restore.
            </DialogDescription>
          </DialogHeader>
          {status?.hasWorkingTreeChanges ? (
            <div className="px-6 pt-4 text-xs leading-relaxed text-muted-foreground" role="note">
              Apply and Pop are unavailable while this checkout has uncommitted changes. If a
              recovery backup was already restored, keep it until you commit, then drop it.
            </div>
          ) : null}
          <div className="mt-4 border-y border-border">
            {stashesQuery.isPending ? (
              <div className="px-6 py-4 text-sm text-muted-foreground">Loading stashes...</div>
            ) : stashesQuery.isError ? (
              <div className="flex items-center justify-between gap-3 px-6 py-4">
                <span className="text-sm text-destructive">
                  {formatGitErrorMessage(stashesQuery.error)}
                </span>
                <Button size="xs" variant="outline" onClick={() => void stashesQuery.refetch()}>
                  Retry
                </Button>
              </div>
            ) : stashes.length === 0 ? (
              <div className="px-6 py-4 text-sm text-muted-foreground">No stashes yet.</div>
            ) : (
              stashes.map((stash, index) => (
                <div
                  key={`${stash.id}:${stash.selector}`}
                  className={cn(
                    "flex items-center gap-3 px-6 py-3",
                    index > 0 && "border-t border-border",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="truncate text-sm">
                        {stash.recoveryBranch
                          ? `Before pulling ${stash.recoveryBranch}`
                          : stash.message}
                      </div>
                      {stash.recoveryBranch ? (
                        <Badge variant="info" size="sm">
                          Recovery backup
                        </Badge>
                      ) : null}
                    </div>
                    {stash.recoveryBranch ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        Created automatically before pulling{" "}
                        <span className="font-mono">{stash.recoveryBranch}</span>.
                      </div>
                    ) : null}
                    <div className="mt-0.5 flex gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{stash.selector}</span>
                      <span>{new Date(stash.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={isGitActionRunning || Boolean(status?.hasWorkingTreeChanges)}
                      tooltip={
                        status?.hasWorkingTreeChanges
                          ? "Commit or stash current changes before applying another stash."
                          : "Apply this stash and keep it"
                      }
                      onClick={() => applySelectedStash(stash, false)}
                    >
                      Apply
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={isGitActionRunning || Boolean(status?.hasWorkingTreeChanges)}
                      tooltip={
                        status?.hasWorkingTreeChanges
                          ? "Commit or stash current changes before popping another stash."
                          : "Apply this stash, then remove it"
                      }
                      onClick={() => applySelectedStash(stash, true)}
                    >
                      Pop
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Drop ${stash.selector}`}
                      disabled={isGitActionRunning}
                      onClick={() => {
                        setStashDialogMode(null);
                        setPendingDropStash(stash);
                      }}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
          <DialogFooter className="mt-4">
            <Button
              variant="outline"
              size="sm"
              disabled={stashChangesDisabledReason !== null}
              onClick={() => setStashDialogMode("create")}
            >
              Stash changes...
            </Button>
            <Button size="sm" onClick={() => setStashDialogMode(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <AlertDialog
        open={pendingDropStash !== null}
        onOpenChange={(open) => {
          if (!open && !dropStashMutation.isPending) {
            setPendingDropStash(null);
          }
        }}
      >
        <AlertDialogPopup className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Drop this stash?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDropStash ? (
                <>
                  Permanently remove <span className="font-mono">{pendingDropStash.selector}</span>:{" "}
                  {pendingDropStash.message}. This cannot be undone.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="outline" size="sm" disabled={dropStashMutation.isPending} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={dropStashMutation.isPending || pendingDropStash === null}
              onClick={dropSelectedStash}
            >
              Drop stash
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <Dialog
        open={activeStashRecovery !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingStashRecovery(null);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlertIcon className="size-4 text-amber-500" />
              {activeStashRecovery?.title ?? "Protected changes need attention"}
            </DialogTitle>
            <DialogDescription>{activeStashRecovery?.detail}</DialogDescription>
          </DialogHeader>
          {activeStashRecovery ? (
            <div className="divide-y divide-border border-t border-border px-6 text-sm">
              {activeStashRecovery.conflictedPaths.length > 0 ? (
                <div className="py-3">
                  <div className="mb-1 text-xs text-muted-foreground">Conflicted files</div>
                  {activeStashRecovery.conflictedPaths.map((filePath) => (
                    <div key={filePath} className="truncate font-mono text-xs">
                      {filePath}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="py-3">
                <div className="text-xs text-muted-foreground">Protected stash</div>
                <div className="break-all font-mono text-xs">{activeStashRecovery.stashId}</div>
              </div>
              {activeStashRecovery.recoveryRef ? (
                <div className="py-3">
                  <div className="text-xs text-muted-foreground">Recovery ref</div>
                  <div className="break-all font-mono text-xs">
                    {activeStashRecovery.recoveryRef}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPendingStashRecovery(null);
                setStashDialogMode("manage");
              }}
            >
              View stashes
            </Button>
            {activeStashRecovery?.conflictedPaths[0] && onOpenDiff ? (
              <Button
                size="sm"
                onClick={() => {
                  const firstConflict = activeStashRecovery.conflictedPaths[0];
                  setPendingStashRecovery(null);
                  onOpenDiff(firstConflict);
                }}
              >
                Review conflicts
              </Button>
            ) : (
              <Button size="sm" onClick={() => setPendingStashRecovery(null)}>
                Done
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <PublishRepositoryDialog
        open={isPublishDialogOpen}
        onOpenChange={setIsPublishDialogOpen}
        environmentId={target.environmentId}
        gitCwd={target.cwd}
      />
      <AlertDialog
        open={activeHistoryReconciliation !== null}
        onOpenChange={(open) => {
          if (!open && !pullMutation.isPending) {
            setPendingHistoryReconciliation(null);
          }
        }}
      >
        <AlertDialogPopup className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlertIcon className="size-4 text-amber-500" />
              Branch histories are unrelated
            </AlertDialogTitle>
            <AlertDialogDescription>
              {activeHistoryReconciliation ? (
                <span className="space-y-2">
                  <span className="block">
                    <span className="font-mono">
                      {activeHistoryReconciliation.result.upstreamRef}
                    </span>{" "}
                    no longer shares commit history with your local{" "}
                    <span className="font-mono">{activeHistoryReconciliation.result.refName}</span>.
                    This usually means the upstream branch was force-pushed or recreated.
                  </span>
                  {activeHistoryReconciliation.result.equivalentUpstreamCommitSha ? (
                    <span className="block">
                      Threadlines found your current file snapshot in the rewritten upstream at{" "}
                      <span className="font-mono">
                        {activeHistoryReconciliation.result.equivalentUpstreamCommitSha.slice(
                          0,
                          12,
                        )}
                      </span>
                      . It can save your local HEAD under a recovery ref, then update the branch to
                      the rewritten upstream.
                    </span>
                  ) : (
                    <span className="block">
                      Threadlines could not match your current file snapshot in the rewritten
                      upstream. Continuing saves your current HEAD under a recovery ref, then
                      replaces the local branch with the upstream version.
                    </span>
                  )}
                  <span className="block">
                    The backup stays local and is never pushed automatically.
                  </span>
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="outline" size="sm" disabled={pullMutation.isPending} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={pullMutation.isPending || activeHistoryReconciliation === null}
              onClick={() => {
                if (
                  !activeHistoryReconciliation ||
                  !isSamePullRequestTarget(
                    activeHistoryReconciliation,
                    currentPullTargetRef.current,
                  )
                ) {
                  return;
                }
                executePull({
                  historyReconciliation: {
                    refName: activeHistoryReconciliation.result.refName,
                    upstreamRef: activeHistoryReconciliation.result.upstreamRef,
                    expectedLocalSha: activeHistoryReconciliation.result.localSha,
                    expectedUpstreamSha: activeHistoryReconciliation.result.upstreamSha,
                  },
                });
              }}
            >
              Back up local &amp; use upstream
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <GitAuthRemediationDialog
        open={authRemediationFailure !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAuthRemediationFailure(null);
          }
        }}
        environmentId={target.environmentId}
        gitCwd={target.cwd}
        failure={authRemediationFailure}
        onResolved={runPull}
      />
    </div>
  );
}

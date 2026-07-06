import {
  type ContextMenuItem,
  type EnvironmentId,
  type GitActionProgressEvent,
  type GitRemoteAuthFailure,
  type GitStackedAction,
  type ScopedThreadRef,
  type VcsCommitDetailsResult,
  type VcsCommitGraphCommit,
  type VcsRef,
  type VcsStatusResult,
  type VcsWorkingTreeFileChangeKind,
} from "@threadlines/contracts";
import { formatGitErrorMessage, gitRemoteAuthFailureFromError } from "@threadlines/shared/git";
import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CheckIcon,
  CloudIcon,
  CloudUploadIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FolderClosedIcon,
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

import { openInPreferredEditor } from "~/editorPreferences";
import { openFileInActiveViewer } from "~/fileViewerStore";
import { readEnvironmentApi } from "~/environmentApi";
import {
  gitBranchSearchInfiniteQueryOptions,
  gitCommitDetailsQueryOptions,
  gitCheckoutMutationOptions,
  gitCommitGraphQueryOptions,
  gitCreateTagMutationOptions,
  gitDeleteBranchMutationOptions,
  gitDiscardChangesMutationOptions,
  gitGenerateCommitMessageMutationOptions,
  gitInitMutationOptions,
  gitMergeRefMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitQueryKeys,
  gitRunStackedActionMutationOptions,
  gitStageChangesMutationOptions,
  gitUnstageChangesMutationOptions,
} from "~/lib/gitReactQuery";
import { refreshGitStatus, refreshLocalGitStatus, useGitStatus } from "~/lib/gitStatusState";
import { cn, newCommandId, randomUUID } from "~/lib/utils";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { readLocalApi } from "~/localApi";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useStore } from "~/store";
import { resolvePathLinkTarget } from "~/terminal-links";
import { PublishRepositoryDialog } from "../GitActionsControl";
import { GitAuthRemediationDialog } from "./GitAuthRemediationDialog";
import { SourceControlIcon } from "../Icons";
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
import { Button } from "../ui/button";
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
import { resolveBranchSelectionTarget } from "../BranchToolbar.logic";

export interface SourceControlProjectTarget {
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string;
  readonly cwd: string;
  readonly name: string;
  readonly environmentLabel: string | null;
  readonly worktreePath: string | null;
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
   * widths, where the sheet spans the full screen and the header toggle is
   * easy to miss.
   */
  readonly onClose?: () => void;
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
}): string | null {
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
      return "Commit or stash changes first.";
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
              isPinned && "bg-accent/70 ring-1 ring-primary/80",
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
}): string | null {
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

function SourceControlBranchMenu({
  target,
  activeThreadRef,
  onActiveBranchChange,
  status,
  isBusy,
  refreshPanel,
}: {
  readonly target: SourceControlProjectTarget;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly onActiveBranchChange?:
    | ((branch: string | null, worktreePath: string | null) => void)
    | undefined;
  readonly status: VcsStatusResult | null | undefined;
  readonly isBusy: boolean;
  readonly refreshPanel: () => void;
}) {
  const queryClient = useQueryClient();
  const setThreadBranch = useStore((store) => store.setThreadBranch);
  const [pendingMergeRef, setPendingMergeRef] = useState<VcsRef | null>(null);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
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
  const switchRefs = refs.slice(0, BRANCH_MENU_REF_LIMIT);
  const mergeRefs = refs
    .filter((ref) => ref.name !== currentBranch && !isRefOnCurrentBranch(ref.name, currentBranch))
    .slice(0, BRANCH_MENU_REF_LIMIT);
  const switchDisabledReason = getBranchActionDisabledReason({
    status,
    isBusy: isBusy || checkoutMutation.isPending || createBranchMutation.isPending,
    action: "switch",
  });
  const createDisabledReason = getBranchActionDisabledReason({
    status,
    isBusy: isBusy || checkoutMutation.isPending || createBranchMutation.isPending,
    action: "create",
  });
  const mergeDisabledReason = getBranchActionDisabledReason({
    status,
    isBusy: isBusy || mergeMutation.isPending,
    action: "merge",
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
      if (api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: activeThreadRef.threadId,
            branch,
            worktreePath,
          })
          .catch(() => undefined);
      }
      setThreadBranch(activeThreadRef, branch, worktreePath);
    },
    [
      activeThreadRef,
      onActiveBranchChange,
      setThreadBranch,
      target.environmentId,
      target.worktreePath,
    ],
  );

  const runSwitchRef = useCallback(
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
          syncActiveThreadBranch(nextBranch, selectionTarget.nextWorktreePath);
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
    [
      checkoutMutation,
      refreshPanel,
      syncActiveThreadBranch,
      target.projectCwd,
      target.worktreePath,
    ],
  );

  const runCreateBranch = useCallback(() => {
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
  }, [createBranchMutation, createBranchName, refreshPanel, syncActiveThreadBranch]);

  const runMergeRef = useCallback(() => {
    if (!pendingMergeRef) {
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
  }, [currentBranch, mergeMutation, pendingMergeRef, refreshPanel]);

  return (
    <>
      <div className="min-w-0">
        <Menu modal={false}>
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
                        {ref.current
                          ? "current"
                          : ref.isRemote
                            ? "remote"
                            : ref.isDefault
                              ? "default"
                              : ""}
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
          </MenuPopup>
        </Menu>
      </div>

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
            <Button size="sm" disabled={mergeMutation.isPending} onClick={runMergeRef}>
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
                disabled={createBranchMutation.isPending || createBranchName.trim().length === 0}
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
}: SourceControlPanelProps) {
  const queryClient = useQueryClient();
  const [commitMessage, setCommitMessage] = useState("");
  const [commitMessageEditorOpen, setCommitMessageEditorOpen] = useState(false);
  const [commitMessageEditorMounted, setCommitMessageEditorMounted] = useState(false);
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [authRemediationFailure, setAuthRemediationFailure] = useState<GitRemoteAuthFailure | null>(
    null,
  );
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<DefaultBranchConfirmableAction | null>(null);
  const [pendingDiscardChanges, setPendingDiscardChanges] = useState<PendingDiscardChanges | null>(
    null,
  );
  const [pendingCreateTagCommit, setPendingCreateTagCommit] = useState<VcsCommitGraphCommit | null>(
    null,
  );
  const [pendingDeleteBranch, setPendingDeleteBranch] = useState<PendingDeleteBranch | null>(null);
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
  >(SOURCE_CONTROL_CHANGES_VIEW_MODE_STORAGE_KEY, "list", SourceControlChangesViewMode, {
    legacyKeys: LEGACY_SOURCE_CONTROL_CHANGES_VIEW_MODE_STORAGE_KEYS,
  });
  const [changesPanelHeight, setChangesPanelHeight] = useState(DEFAULT_CHANGES_PANEL_HEIGHT);
  const [changesTreeExpansionState, setChangesTreeExpansionState] = useState<{
    readonly key: string;
    readonly overrides: Record<string, boolean>;
  }>(() => ({ key: "", overrides: {} }));
  const [commitGraphLimit, setCommitGraphLimit] = useState(GRAPH_INITIAL_LIMIT);
  const [pinnedCommitSha, setPinnedCommitSha] = useState<string | null>(null);
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
  const activeGitActionProgressView = useGitActionProgressView({ environmentId, cwd });
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const gitStatus = useGitStatus({ environmentId, cwd });
  const status = gitStatus.data;
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
  const isSourceControlRefreshing = gitStatus.isPending || isCommitGraphRefreshing;
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
  const isGitActionRunning =
    runningStackedActionCount > 0 ||
    runningPublishActionCount > 0 ||
    actionMutation.isPending ||
    initMutation.isPending ||
    pullMutation.isPending ||
    discardChangesMutation.isPending ||
    stageChangesMutation.isPending ||
    unstageChangesMutation.isPending ||
    createTagMutation.isPending ||
    deleteBranchMutation.isPending;
  const changedFiles = status?.workingTree.files ?? EMPTY_WORKING_TREE_FILES;
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
  });
  const commitAndPushDisabledReason = actionDisabledReason({
    status,
    action: "commit_push",
    isBusy: isGitActionRunning,
  });
  const pullDisabledReason = actionDisabledReason({
    status,
    action: "pull",
    isBusy: isGitActionRunning,
  });
  const pushDisabledReason = actionDisabledReason({
    status,
    action: "push",
    isBusy: isGitActionRunning,
  });
  const prDisabledReason = actionDisabledReason({
    status,
    action: "create_pr",
    isBusy: isGitActionRunning,
  });
  const generateCommitMessageDisabledReason = isGitActionRunning
    ? "Git action in progress."
    : changedFiles.length === 0
      ? "No working tree changes."
      : generateCommitMessageMutation.isPending
        ? "Commit message generation in progress."
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

  useEffect(() => {
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
      if (!environmentId || !cwd) {
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
      queryClient,
      sourceControlPresentation.terminology,
      status?.aheadCount,
      status?.hasUpstream,
      status?.hasWorkingTreeChanges,
      status?.isDefaultRef,
      threadToastData,
    ],
  );

  const runPull = useCallback(() => {
    const promise = pullMutation.mutateAsync();
    void toastManager.promise<
      Awaited<ReturnType<typeof pullMutation.mutateAsync>>,
      ThreadToastData
    >(promise, {
      loading: { title: "Pulling...", data: threadToastData },
      success: (result) => ({
        title: result.status === "pulled" ? "Pulled" : "Already up to date",
        description:
          result.status === "pulled"
            ? `Updated ${result.refName} from ${result.upstreamRef ?? "upstream"}`
            : `${result.refName} is already synchronized.`,
        data: threadToastData,
      }),
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
    void promise.then(refreshPanel, () => undefined);
  }, [pullMutation, refreshPanel, threadToastData]);

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
    [clearCommitMessageDraft, refreshPanel, stageChangesMutation, threadToastData],
  );

  const runUnstageChanges = useCallback(
    (filePaths: string[], label: string, count: number) => {
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
    [clearCommitMessageDraft, refreshPanel, threadToastData, unstageChangesMutation],
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

  const requestDiscardFileChanges = useCallback((entry: WorkingTreeSectionFile) => {
    setPendingDiscardChanges({
      filePaths: [entry.path],
      label: entry.path,
      count: 1,
      includesNewFiles: entry.status === "untracked",
      scope: "unstaged",
    });
  }, []);

  const requestDiscardAllUnstagedChanges = useCallback(() => {
    if (unstagedChangeFiles.length === 0) {
      return;
    }
    setPendingDiscardChanges({
      filePaths: unstagedChangeFiles.map((entry) => entry.path),
      label: "all unstaged changes",
      count: unstagedChangeFiles.length,
      includesNewFiles: unstagedChangeFiles.some((entry) => entry.status === "untracked"),
      scope: "unstaged",
    });
  }, [unstagedChangeFiles]);

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
    if (!pendingDiscardChanges) {
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
      if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to copy ${title.toLowerCase()}`,
            description: "Clipboard API unavailable.",
          }),
        );
        return Promise.resolve(false);
      }

      return navigator.clipboard.writeText(value).then(
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
    if (!pendingCreateTagCommit) {
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
  }, [createTagMutation, createTagName, pendingCreateTagCommit, refreshPanel, threadToastData]);

  const runDeleteBranch = useCallback(() => {
    if (!pendingDeleteBranch) {
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
  }, [deleteBranchMutation, pendingDeleteBranch, refreshPanel, threadToastData]);

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
            id: "create-tag",
            label: "Create tag...",
            disabled: createTagMutation.isPending,
          },
          ...deletableBranches.map((branchName) => ({
            id: `delete-branch:${branchName}` as const,
            label: `Delete branch '${branchName}'...`,
            disabled: !environmentId || !cwd || deleteBranchMutation.isPending,
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
      openCreateTagDialog,
      openCommitUrl,
      sourceControlPresentation.providerName,
      status?.sourceControlProvider?.kind,
      status?.refName,
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
          className="grid min-w-0 cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-center gap-x-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                      disabled={isGitActionRunning}
                      onClick={() => requestDiscardFileChanges(entry)}
                    />
                  }
                >
                  <Undo2Icon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Discard changes</TooltipPopup>
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
                      disabled={isGitActionRunning}
                      onClick={() => stageFileChanges(entry)}
                    />
                  }
                >
                  <PlusIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Stage changes</TooltipPopup>
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
                    disabled={isGitActionRunning}
                    onClick={() => unstageFileChanges(entry)}
                  />
                }
              >
                <MinusIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup side="top">Unstage changes</TooltipPopup>
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-rail">
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
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    aria-label={
                      isSourceControlRefreshing
                        ? "Refreshing source control"
                        : "Refresh source control"
                    }
                    variant="ghost"
                    size="icon-xs"
                    onClick={refreshPanel}
                  />
                }
              >
                <RefreshCwIcon
                  className={cn("size-3.5", isSourceControlRefreshing && "animate-spin")}
                />
              </TooltipTrigger>
              <TooltipPopup side="top">Refresh</TooltipPopup>
            </Tooltip>
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
        <div className="flex min-w-0 items-center gap-1.5 px-3 pt-0.5 pb-2">
          <span
            className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/85"
            title={headerTitle}
          >
            {target.name}
          </span>
          {status?.refName ? (
            <TooltipWrapper tooltip={`Branch: ${status.refName}`}>
              <span className="inline-flex min-w-0 max-w-[45%] shrink-0 items-center gap-1 rounded-sm border border-border/70 bg-muted/45 px-1.5 py-0.5 font-mono text-[10px] leading-none text-muted-foreground/80">
                <GitBranchIcon className="size-3 shrink-0 opacity-70" />
                <span className="min-w-0 truncate">{status.refName}</span>
              </span>
            </TooltipWrapper>
          ) : null}
        </div>
      </div>

      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-3">
        {status?.isRepo === false ? (
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
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={changedFiles.length === 0}
                  onPointerEnter={onPrefetchDiff}
                  onClick={() => onOpenDiff()}
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
          {changedFiles.length === 0 ? (
            <div className="rounded-md border border-border/70 bg-background/40 px-2.5 py-2 text-xs text-muted-foreground/70">
              No working tree changes
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
                          disabled={stagedChangeFiles.length === 0 || isGitActionRunning}
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
                            disabled={unstagedChangeFiles.length === 0 || isGitActionRunning}
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
                            disabled={unstagedChangeFiles.length === 0 || isGitActionRunning}
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
                  </MenuGroup>
                </MenuPopup>
              </Menu>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <ActionButton
                label="Pull"
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
                disabled={isGitActionRunning}
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
              refreshPanel={refreshPanel}
            />
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
                disabled={createTagMutation.isPending || createTagName.trim().length === 0}
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
              disabled={deleteBranchMutation.isPending}
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
              disabled={discardChangesMutation.isPending}
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
      <PublishRepositoryDialog
        open={isPublishDialogOpen}
        onOpenChange={setIsPublishDialogOpen}
        environmentId={target.environmentId}
        gitCwd={target.cwd}
      />
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

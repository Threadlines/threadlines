import {
  type EnvironmentId,
  type GitStackedAction,
  type ScopedThreadRef,
  type VcsCommitGraphCommit,
  type VcsRef,
  type VcsStatusResult,
  type VcsWorkingTreeFileChangeKind,
} from "@t3tools/contracts";
import {
  useInfiniteQuery,
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ChevronDownIcon,
  CloudUploadIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitGraphIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  DownloadIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
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
import { readEnvironmentApi } from "~/environmentApi";
import {
  gitBranchSearchInfiniteQueryOptions,
  gitCheckoutMutationOptions,
  gitCommitGraphQueryOptions,
  gitDiscardChangesMutationOptions,
  gitGenerateCommitMessageMutationOptions,
  gitInitMutationOptions,
  gitMergeRefMutationOptions,
  gitMutationKeys,
  gitPullMutationOptions,
  gitQueryKeys,
  gitRunStackedActionMutationOptions,
} from "~/lib/gitReactQuery";
import { refreshGitStatus, refreshLocalGitStatus, useGitStatus } from "~/lib/gitStatusState";
import { cn, newCommandId, randomUUID } from "~/lib/utils";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { readLocalApi } from "~/localApi";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useStore } from "~/store";
import { resolvePathLinkTarget } from "~/terminal-links";
import { PublishRepositoryDialog } from "../GitActionsControl";
import {
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  type DefaultBranchConfirmableAction,
} from "../GitActionsControl.logic";
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
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildCommitGraphRows,
  type CommitGraphLaneLayout,
  formatCommitCount,
  formatCommitGraphDateTime,
  formatCommitGraphParentSummary,
  formatCommitGraphTimestamp,
  getCommitGraphRefKind,
  getVisibleCommitGraphRefs,
  normalizeCommitGraphRefName,
  resolveSourceControlPrimaryAction,
} from "./SourceControlPanel.logic";

export interface SourceControlProjectTarget {
  readonly environmentId: EnvironmentId;
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
}

type WorkingTreeFile = VcsStatusResult["workingTree"]["files"][number];

const EMPTY_WORKING_TREE_FILES: readonly WorkingTreeFile[] = [];

interface PendingDiscardChanges {
  readonly filePaths: string[];
  readonly label: string;
  readonly count: number;
  readonly includesNewFiles: boolean;
}

const WORKING_TREE_CHANGE_STATUS_CODES: Record<VcsWorkingTreeFileChangeKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  unmerged: "U",
  untracked: "?",
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

function isUntrackedWorkingTreeFile(file: WorkingTreeFile): boolean {
  return file.worktreeStatus === "untracked";
}

function isNewWorkingTreeFile(file: WorkingTreeFile): boolean {
  return file.indexStatus === "added" || file.worktreeStatus === "untracked";
}

function workingTreeChangeStatusCode(kind: VcsWorkingTreeFileChangeKind | null | undefined) {
  return kind ? WORKING_TREE_CHANGE_STATUS_CODES[kind] : null;
}

function formatWorkingTreeFileStatus(file: WorkingTreeFile): string {
  if (isUntrackedWorkingTreeFile(file)) {
    return "?";
  }
  const indexCode = workingTreeChangeStatusCode(file.indexStatus);
  const worktreeCode = workingTreeChangeStatusCode(file.worktreeStatus);
  if (indexCode && worktreeCode && indexCode !== worktreeCode) {
    return `${indexCode}${worktreeCode}`;
  }
  return worktreeCode ?? indexCode ?? "M";
}

function describeWorkingTreeFileStatus(file: WorkingTreeFile): string {
  const parts: string[] = [];
  if (file.indexStatus) {
    parts.push(`Index: ${WORKING_TREE_CHANGE_STATUS_LABELS[file.indexStatus]}`);
  }
  if (file.worktreeStatus) {
    parts.push(
      file.worktreeStatus === "untracked"
        ? WORKING_TREE_CHANGE_STATUS_LABELS[file.worktreeStatus]
        : `Working tree: ${WORKING_TREE_CHANGE_STATUS_LABELS[file.worktreeStatus]}`,
    );
  }
  if (file.originalPath) {
    parts.push(`From ${file.originalPath}`);
  }
  return parts.length > 0 ? parts.join(". ") : "Changed";
}

function workingTreeFileStatusClassName(file: WorkingTreeFile): string {
  if (file.indexStatus === "unmerged" || file.worktreeStatus === "unmerged") {
    return "border-warning/25 bg-warning/8 text-warning-foreground";
  }
  if (file.indexStatus === "deleted" || file.worktreeStatus === "deleted") {
    return "border-destructive/25 bg-destructive/8 text-destructive-foreground";
  }
  if (file.indexStatus === "added" || file.worktreeStatus === "untracked") {
    return "border-success/25 bg-success/8 text-success-foreground";
  }
  return "border-border/70 bg-muted/50 text-muted-foreground";
}

function buildDiscardChangesDescription(pending: PendingDiscardChanges): string {
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

type CommitGraphContextAction = "copy-full-sha" | "copy-subject" | "create-tag";

function commitGraphRefClassName(refName: string, currentBranch: string | null | undefined) {
  const kind = getCommitGraphRefKind(refName, currentBranch);
  if (kind === "current") {
    return "border-primary/60 bg-primary/10 text-primary";
  }
  if (kind === "remote") {
    return "border-info/45 bg-info/10 text-info-foreground";
  }
  if (kind === "tag") {
    return "border-success/45 bg-success/10 text-success-foreground";
  }
  return "border-border/70 bg-background/60 text-muted-foreground";
}

function CommitGraphRefChip({
  refName,
  currentBranch,
  compact = false,
}: {
  readonly refName: string;
  readonly currentBranch: string | null | undefined;
  readonly compact?: boolean;
}) {
  return (
    <span
      className={cn(
        "min-w-0 shrink truncate rounded-sm border px-1 py-0.5 font-mono text-[10px] leading-none",
        compact ? "max-w-24" : "max-w-full",
        commitGraphRefClassName(refName, currentBranch),
      )}
    >
      {normalizeCommitGraphRefName(refName)}
    </span>
  );
}

const COMMIT_GRAPH_LANE_GAP = 12;
const COMMIT_GRAPH_LEFT_PADDING = 8;
const COMMIT_GRAPH_ROW_HEIGHT = 28;
const COMMIT_GRAPH_NODE_Y = 14;
const COMMIT_GRAPH_NODE_RADIUS = 4;
const COMMIT_GRAPH_NODE_GAP = COMMIT_GRAPH_NODE_RADIUS + 1;
const COMMIT_GRAPH_STROKE_WIDTH = 2;

// Lane 0 is reserved for the "main line" (the leftmost lane carrying the current branch
// in typical workflows). Side lanes rotate through distinct hues so adjacent branches
// stay visually distinguishable without looking decorative.
const COMMIT_GRAPH_LANE_STROKE = [
  "stroke-primary",
  "stroke-amber-400",
  "stroke-emerald-400",
  "stroke-pink-400",
  "stroke-cyan-400",
  "stroke-violet-400",
  "stroke-muted-foreground",
] as const;

const COMMIT_GRAPH_LANE_FILL = [
  "fill-primary",
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

function commitGraphLaneOpacity(lane: number) {
  return lane === 0 ? 0.95 : 0.8;
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
}: {
  readonly layout: CommitGraphLaneLayout;
  readonly highlighted: boolean;
}) {
  const width = commitGraphLaneX(layout.laneCount - 1) + COMMIT_GRAPH_LEFT_PADDING;
  const rowHeight = COMMIT_GRAPH_ROW_HEIGHT;
  const nodeY = COMMIT_GRAPH_NODE_Y;
  const radius = COMMIT_GRAPH_NODE_RADIUS;
  const gap = COMMIT_GRAPH_NODE_GAP;
  const nodeX = commitGraphLaneX(layout.lane);
  const isMergeCommit = layout.parentPaths.length > 1;
  const sameLaneParent = layout.parentPaths.some(
    (path) => path.fromLane === layout.lane && path.toLane === layout.lane,
  );
  const topLaneSet = new Set(layout.topLanes);
  const visibleBottomLanes = layout.bottomLanes.filter((bottomLane) => {
    if (bottomLane === layout.lane) {
      return sameLaneParent;
    }
    return topLaneSet.has(bottomLane);
  });
  const crossLanePaths = layout.parentPaths.filter((path) => path.fromLane !== path.toLane);

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
        const y2 = lane === layout.lane ? nodeY - gap : nodeY;
        return (
          <line
            key={`top-${lane}`}
            x1={x}
            y1={0}
            x2={x}
            y2={y2}
            className={commitGraphLaneStrokeClass(lane)}
            strokeWidth={COMMIT_GRAPH_STROKE_WIDTH}
            strokeLinecap="square"
            opacity={commitGraphLaneOpacity(lane)}
          />
        );
      })}
      {visibleBottomLanes.map((lane) => {
        const x = commitGraphLaneX(lane);
        const y1 = lane === layout.lane ? nodeY + gap : nodeY;
        return (
          <line
            key={`bottom-${lane}`}
            x1={x}
            y1={y1}
            x2={x}
            y2={rowHeight}
            className={commitGraphLaneStrokeClass(lane)}
            strokeWidth={COMMIT_GRAPH_STROKE_WIDTH}
            strokeLinecap="square"
            opacity={commitGraphLaneOpacity(lane)}
          />
        );
      })}
      {crossLanePaths.map((path) => {
        const fromX = commitGraphLaneX(path.fromLane);
        const toX = commitGraphLaneX(path.toLane);
        const startY = nodeY + gap;
        const midY = (startY + rowHeight) / 2;
        const curveLane = commitGraphCurveLane(path.fromLane, path.toLane);
        return (
          <path
            key={`path-${path.fromLane}-${path.toLane}`}
            d={`M ${fromX} ${startY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${rowHeight}`}
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
          <circle
            cx={nodeX}
            cy={nodeY}
            r={radius + 1.5}
            className="fill-background stroke-primary"
            strokeWidth={COMMIT_GRAPH_STROKE_WIDTH}
          />
          <circle cx={nodeX} cy={nodeY} r={radius - 1} className="fill-primary" />
        </>
      ) : isMergeCommit ? (
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

function CommitGraphHoverCard({
  commit,
  currentBranch,
  onCopyCommitValue,
}: {
  readonly commit: VcsCommitGraphCommit;
  readonly currentBranch: string | null | undefined;
  readonly onCopyCommitValue: (value: string, title: string) => void;
}) {
  const absoluteDate = formatCommitGraphDateTime(commit.committedAt);
  const relativeDate = formatCommitGraphTimestamp(commit.committedAt);
  const parentSummary = formatCommitGraphParentSummary(commit.parents.length);
  const visibleRefs = getVisibleCommitGraphRefs(commit.refs);

  return (
    <div className="w-80 max-w-[calc(100vw-2rem)] space-y-2.5 p-1 text-left">
      <div className="space-y-1">
        <div className="line-clamp-2 text-xs font-medium leading-snug text-popover-foreground">
          {commit.subject || "Untitled commit"}
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

      <div className="space-y-1.5 text-[11px] leading-tight">
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
        {visibleRefs.length > 0 ? (
          <CommitGraphDetailRow label="Refs">
            <span className="flex min-w-0 flex-wrap gap-1">
              {visibleRefs.map((ref) => (
                <CommitGraphRefChip key={ref} refName={ref} currentBranch={currentBranch} />
              ))}
            </span>
          </CommitGraphDetailRow>
        ) : null}
      </div>
    </div>
  );
}

function CommitGraphRow({
  commit,
  currentBranch,
  layout,
  visibleRefs,
  onCopyCommitValue,
  onCommitContextMenu,
}: {
  readonly commit: VcsCommitGraphCommit;
  readonly currentBranch: string | null | undefined;
  readonly layout: CommitGraphLaneLayout;
  readonly visibleRefs: readonly string[];
  readonly onCopyCommitValue: (value: string, title: string) => void;
  readonly onCommitContextMenu: (
    commit: VcsCommitGraphCommit,
    position: { readonly x: number; readonly y: number },
  ) => void;
}) {
  const isCurrentBranchCommit = visibleRefs.some(
    (ref) => getCommitGraphRefKind(ref, currentBranch) === "current",
  );
  const renderedRefs = visibleRefs.slice(0, 2);
  const hiddenRefCount = Math.max(0, visibleRefs.length - renderedRefs.length);
  const graphWidth = commitGraphLaneX(layout.laneCount - 1) + COMMIT_GRAPH_LEFT_PADDING;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            aria-label={`Commit ${commit.shortSha}: ${commit.subject || "Untitled commit"}`}
            role="listitem"
            tabIndex={0}
            onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
              event.preventDefault();
              event.stopPropagation();
              onCommitContextMenu(commit, { x: event.clientX, y: event.clientY });
            }}
            className={cn(
              "grid cursor-default items-center gap-2 px-2.5 transition-colors hover:bg-accent/60",
              isCurrentBranchCommit && "bg-primary/10 hover:bg-primary/15",
            )}
            style={{
              gridTemplateColumns: `${graphWidth}px minmax(0, 1fr)`,
              height: COMMIT_GRAPH_ROW_HEIGHT,
            }}
          >
            <CommitGraphGlyph layout={layout} highlighted={isCurrentBranchCommit} />
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs leading-tight text-foreground",
                  isCurrentBranchCommit && "font-medium",
                )}
              >
                {commit.subject || "Untitled commit"}
              </span>
              {renderedRefs.length > 0 ? (
                <span className="flex shrink-0 items-center gap-1">
                  {renderedRefs.map((ref) => (
                    <CommitGraphRefChip
                      key={ref}
                      refName={ref}
                      currentBranch={currentBranch}
                      compact
                    />
                  ))}
                  {hiddenRefCount > 0 ? (
                    <span className="shrink-0 rounded-sm border border-border/60 px-1 py-0.5 font-mono text-[10px] leading-none text-muted-foreground/60">
                      +{hiddenRefCount}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </span>
          </div>
        }
      />
      <TooltipPopup side="left" align="start" sideOffset={8} className="max-w-none">
        <CommitGraphHoverCard
          commit={commit}
          currentBranch={currentBranch}
          onCopyCommitValue={onCopyCommitValue}
        />
      </TooltipPopup>
    </Tooltip>
  );
}

const GRAPH_LIMIT = 24;
const BRANCH_MENU_REF_LIMIT = 14;
const SOURCE_CONTROL_STATUS_REFRESH_INTERVAL_MS = 3_000;
const DEFAULT_CHANGES_PANEL_HEIGHT = 150;
const DEFAULT_CHANGES_PANEL_RATIO = 0.4;
const MIN_CHANGES_PANEL_RATIO = 0.2;
const MAX_CHANGES_PANEL_RATIO = 0.8;
const MIN_GRAPH_PANEL_HEIGHT = 120;
const MIN_CHANGES_PANEL_HEIGHT = 96;
const SOURCE_CONTROL_SPLIT_VERTICAL_CHROME = 28;
const SOURCE_CONTROL_CHANGES_PANEL_RATIO_STORAGE_KEY =
  "badcode:source-control:changes-panel-ratio:v1";

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampChangesPanelRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHANGES_PANEL_RATIO;
  }
  return clampNumber(value, MIN_CHANGES_PANEL_RATIO, MAX_CHANGES_PANEL_RATIO);
}

function toGitActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
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
    (branch: string | null) => {
      if (onActiveBranchChange) {
        onActiveBranchChange(branch, target.worktreePath);
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
            worktreePath: target.worktreePath,
          })
          .catch(() => undefined);
      }
      setThreadBranch(activeThreadRef, branch, target.worktreePath);
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
      const promise = checkoutMutation.mutateAsync(ref.name).then((result) => {
        const nextBranch = result.refName ?? ref.name;
        syncActiveThreadBranch(nextBranch);
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
    [checkoutMutation, refreshPanel, syncActiveThreadBranch],
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
      <Menu>
        <MenuTrigger
          render={
            <Button
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
}: SourceControlPanelProps) {
  const queryClient = useQueryClient();
  const [commitMessage, setCommitMessage] = useState("");
  const [commitMessageEditorOpen, setCommitMessageEditorOpen] = useState(false);
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<DefaultBranchConfirmableAction | null>(null);
  const [pendingDiscardChanges, setPendingDiscardChanges] = useState<PendingDiscardChanges | null>(
    null,
  );
  const [changesPanelRatio, setChangesPanelRatio] = useLocalStorage(
    SOURCE_CONTROL_CHANGES_PANEL_RATIO_STORAGE_KEY,
    DEFAULT_CHANGES_PANEL_RATIO,
    Schema.Finite,
  );
  const [changesPanelHeight, setChangesPanelHeight] = useState(DEFAULT_CHANGES_PANEL_HEIGHT);
  const bodyRef = useRef<HTMLDivElement>(null);
  const changesSectionRef = useRef<HTMLElement>(null);
  const commitControlsRef = useRef<HTMLElement>(null);
  const environmentId = target?.environmentId ?? null;
  const cwd = target?.cwd ?? null;
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const gitStatus = useGitStatus({ environmentId, cwd });
  const status = gitStatus.data;
  const graphQuery = useQuery(
    gitCommitGraphQueryOptions({
      environmentId,
      cwd,
      limit: GRAPH_LIMIT,
      enabled: Boolean(status?.isRepo),
    }),
  );
  const commitGraphRows = useMemo(
    () => buildCommitGraphRows(graphQuery.data?.commits ?? []),
    [graphQuery.data?.commits],
  );
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
    discardChangesMutation.isPending;
  const changedFiles = status?.workingTree.files ?? EMPTY_WORKING_TREE_FILES;
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
  const generateCommitMessageDisabledReason =
    changedFiles.length === 0
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
      queryKey: gitQueryKeys.commitGraph(environmentId, cwd, GRAPH_LIMIT),
    });
  }, [cwd, environmentId, queryClient]);

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
      const toastId = toastManager.add({
        type: "loading",
        title:
          action === "commit"
            ? "Committing..."
            : action === "push"
              ? "Pushing..."
              : action === "commit_push"
                ? "Committing & pushing..."
                : action === "commit_push_pr"
                  ? `Committing, pushing & creating ${changeRequestLabel}...`
                  : `Creating ${changeRequestLabel}...`,
        timeout: 0,
        data: threadToastData,
      });

      try {
        const result = await actionMutation.mutateAsync({
          actionId,
          action,
          ...((action === "commit" || action === "commit_push" || action === "commit_push_pr") &&
          trimmedMessage.length > 0
            ? { commitMessage: trimmedMessage }
            : {}),
        });
        if (action === "commit" || action === "commit_push" || action === "commit_push_pr") {
          setCommitMessage("");
          setCommitMessageEditorOpen(false);
        }
        toastManager.update(toastId, {
          type: "success",
          title: result.toast.title,
          description: result.toast.description,
          timeout: 0,
          data: {
            ...threadToastData,
            dismissAfterVisibleMs: 10_000,
          },
        });
        void refreshGitStatus({ environmentId, cwd }).catch(() => undefined);
        void queryClient.invalidateQueries({
          queryKey: gitQueryKeys.commitGraph(environmentId, cwd, GRAPH_LIMIT),
        });
      } catch (error) {
        toastManager.update(
          toastId,
          stackedThreadToast({
            type: "error",
            title: "Action failed",
            description: error instanceof Error ? error.message : "An error occurred.",
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
      }
    },
    [
      actionMutation,
      changeRequestLabel,
      commitMessage,
      cwd,
      environmentId,
      queryClient,
      status?.isDefaultRef,
      threadToastData,
    ],
  );

  const runPull = useCallback(() => {
    const promise = pullMutation.mutateAsync();
    void toastManager.promise(promise, {
      loading: { title: "Pulling...", data: threadToastData },
      success: (result) => ({
        title: result.status === "pulled" ? "Pulled" : "Already up to date",
        description:
          result.status === "pulled"
            ? `Updated ${result.refName} from ${result.upstreamRef ?? "upstream"}`
            : `${result.refName} is already synchronized.`,
        data: threadToastData,
      }),
      error: (error) => ({
        title: "Pull failed",
        description: error instanceof Error ? error.message : "An error occurred.",
        data: threadToastData,
      }),
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

  const requestDiscardFileChanges = useCallback((file: WorkingTreeFile) => {
    setPendingDiscardChanges({
      filePaths: [file.path],
      label: file.path,
      count: 1,
      includesNewFiles: isNewWorkingTreeFile(file),
    });
  }, []);

  const requestDiscardAllChanges = useCallback(() => {
    if (changedFiles.length === 0) {
      return;
    }
    setPendingDiscardChanges({
      filePaths: changedFiles.map((file) => file.path),
      label: "all working tree changes",
      count: changedFiles.length,
      includesNewFiles: changedFiles.some(isNewWorkingTreeFile),
    });
  }, [changedFiles]);

  const runDiscardChanges = useCallback(() => {
    if (!pendingDiscardChanges) {
      return;
    }
    const discardRequest = pendingDiscardChanges;
    const promise = discardChangesMutation.mutateAsync({
      filePaths: discardRequest.filePaths,
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
  }, [discardChangesMutation, pendingDiscardChanges, refreshPanel, threadToastData]);

  const openChangedFile = useCallback(
    (filePath: string) => {
      const api = readLocalApi();
      if (!api || !cwd) {
        return;
      }
      void openInPreferredEditor(api, resolvePathLinkTarget(filePath, cwd)).catch(() => undefined);
    },
    [cwd],
  );

  const openExistingPr = useCallback(() => {
    const api = readLocalApi();
    if (!api || !openPullRequest) {
      return;
    }
    void api.shell.openExternal(openPullRequest.url).catch(() => undefined);
  }, [openPullRequest]);

  const copyCommitValue = useCallback((value: string, title: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to copy ${title.toLowerCase()}`,
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(value).then(
      () => {
        toastManager.add({
          type: "success",
          title: `${title} copied`,
          description: value,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to copy ${title.toLowerCase()}`,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);

  const handleCommitContextMenu = useCallback(
    async (commit: VcsCommitGraphCommit, position: { readonly x: number; readonly y: number }) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }

      const clicked = await api.contextMenu.show<CommitGraphContextAction>(
        [
          { id: "copy-full-sha", label: "Copy commit id" },
          { id: "copy-subject", label: "Copy commit message" },
          { id: "create-tag", label: "Create tag...", disabled: true },
        ],
        position,
      );

      if (clicked === "copy-full-sha") {
        copyCommitValue(commit.sha, "Commit id");
        return;
      }
      if (clicked === "copy-subject") {
        copyCommitValue(commit.subject, "Commit message");
      }
    },
    [copyCommitValue],
  );

  const generateCommitMessage = useCallback(async () => {
    if (!environmentId || !cwd || changedFileCount === 0) {
      return;
    }

    setCommitMessageEditorOpen(true);
    try {
      const result = await generateCommitMessageMutation.mutateAsync({});
      setCommitMessage(result.message);
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Commit message generation failed",
          description: error instanceof Error ? error.message : "An error occurred.",
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    }
  }, [changedFileCount, cwd, environmentId, generateCommitMessageMutation, threadToastData]);

  const hasCommitMessage = commitMessage.trim().length > 0;
  const showCommitMessageEditor = commitMessageEditorOpen || hasCommitMessage;
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

  if (!target) {
    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="drag-region flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-1 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-1.5">
            <GitGraphIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
            <h2 className="truncate text-xs font-medium uppercase tracking-wider text-muted-foreground/70">
              Source Control
            </h2>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground/60">
            {target.name}
            {status?.refName ? ` - ${status.refName}` : ""}
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                aria-label="Refresh source control"
                variant="ghost"
                size="icon-xs"
                onClick={refreshPanel}
              />
            }
          >
            <RefreshCwIcon className={cn("size-3.5", gitStatus.isPending && "animate-spin")} />
          </TooltipTrigger>
          <TooltipPopup side="top">Refresh</TooltipPopup>
        </Tooltip>
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
            <h3 className="text-xs font-medium text-foreground">Changes</h3>
            <div className="flex shrink-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      aria-label="Discard all changes"
                      variant="ghost"
                      size="icon-xs"
                      disabled={changedFiles.length === 0 || isGitActionRunning}
                      onClick={requestDiscardAllChanges}
                    />
                  }
                >
                  <Trash2Icon className="size-3.5 text-destructive-foreground" />
                </TooltipTrigger>
                <TooltipPopup side="top">Discard all changes</TooltipPopup>
              </Tooltip>
              {onOpenDiff ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={changedFiles.length === 0}
                  onClick={() => onOpenDiff()}
                >
                  <FileTextIcon className="size-3" />
                  Diff
                </Button>
              ) : null}
              <span className="font-mono text-[11px] text-muted-foreground">
                <span className="text-success">+{status?.workingTree.insertions ?? 0}</span>
                <span className="px-1 text-muted-foreground/60">/</span>
                <span className="text-destructive">-{status?.workingTree.deletions ?? 0}</span>
              </span>
            </div>
          </div>
          {changedFiles.length === 0 ? (
            <div className="rounded-md border border-border/70 bg-background/40 px-2.5 py-2 text-xs text-muted-foreground/70">
              No working tree changes
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/70 bg-background/35">
              <div className="divide-y divide-border/45">
                {changedFiles.map((file) => {
                  const pathParts = splitPath(file.path);
                  const statusLabel = formatWorkingTreeFileStatus(file);
                  const statusDescription = describeWorkingTreeFileStatus(file);
                  return (
                    <div
                      key={file.path}
                      className="group/change-file grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 px-2 py-1.5 transition-colors hover:bg-accent/60"
                    >
                      <button
                        type="button"
                        className="min-w-0 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => {
                          if (onOpenDiff) {
                            onOpenDiff(file.path);
                            return;
                          }
                          openChangedFile(file.path);
                        }}
                      >
                        <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
                          <span
                            className={cn(
                              "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border px-1 font-mono text-[10px] leading-none",
                              workingTreeFileStatusClassName(file),
                            )}
                            title={statusDescription}
                          >
                            {statusLabel}
                          </span>
                          <span className="truncate">{pathParts.name}</span>
                        </span>
                        {pathParts.directory ? (
                          <span className="block truncate pl-5.5 font-mono text-[10px] text-muted-foreground/55">
                            {pathParts.directory}
                          </span>
                        ) : null}
                      </button>
                      <span className="shrink-0 self-center font-mono text-[11px]">
                        <span className="text-success">+{file.insertions}</span>
                        <span className="px-1 text-muted-foreground/60">/</span>
                        <span className="text-destructive">-{file.deletions}</span>
                      </span>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              aria-label={`Discard changes to ${file.path}`}
                              variant="ghost"
                              size="icon-xs"
                              className="size-6 text-muted-foreground/60 hover:text-destructive-foreground"
                              disabled={isGitActionRunning}
                              onClick={() => requestDiscardFileChanges(file)}
                            />
                          }
                        >
                          <Trash2Icon className="size-3" />
                        </TooltipTrigger>
                        <TooltipPopup side="top">Discard changes</TooltipPopup>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
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
            {showCommitMessageEditor ? (
              <Textarea
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Commit message"
                size="sm"
                className="min-h-[4.5rem] resize-none text-xs"
                autoFocus={commitMessageEditorOpen}
              />
            ) : null}
            <div className="grid grid-cols-[minmax(0,1fr)_2rem] gap-1.5">
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
              <h3 className="text-xs font-medium text-foreground">Graph</h3>
              <span className="text-[11px] text-muted-foreground/60">
                {formatCommitCount(graphQuery.data?.commits.length ?? 0)}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/70 bg-background/35">
              {commitGraphRows.length === 0 ? (
                <div className="px-2.5 py-2 text-xs text-muted-foreground/70">No commits yet</div>
              ) : (
                <div role="list">
                  {commitGraphRows.map((row) => (
                    <CommitGraphRow
                      key={row.commit.sha}
                      commit={row.commit}
                      currentBranch={status?.refName}
                      layout={row.layout}
                      visibleRefs={row.visibleRefs}
                      onCopyCommitValue={copyCommitValue}
                      onCommitContextMenu={handleCommitContextMenu}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
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
    </div>
  );
}

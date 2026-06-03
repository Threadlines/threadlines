import type { GitStackedAction, VcsStatusResult } from "@t3tools/contracts";

export type SourceControlPrimaryActionIcon = "sparkles" | "upload";

export interface SourceControlPrimaryAction {
  readonly action: Extract<GitStackedAction, "commit_push" | "push">;
  readonly label: string;
  readonly disabledReason: string | null;
  readonly icon: SourceControlPrimaryActionIcon;
}

export interface SourceControlFileTreeFileInput {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
}

export interface SourceControlFileTreeDirectoryNode<TFile extends SourceControlFileTreeFileInput> {
  readonly kind: "directory";
  readonly name: string;
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
  readonly fileCount: number;
  readonly children: Array<SourceControlFileTreeNode<TFile>>;
}

export interface SourceControlFileTreeFileNode<TFile extends SourceControlFileTreeFileInput> {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
  readonly file: TFile;
}

export type SourceControlFileTreeNode<TFile extends SourceControlFileTreeFileInput> =
  | SourceControlFileTreeDirectoryNode<TFile>
  | SourceControlFileTreeFileNode<TFile>;

interface MutableSourceControlFileTreeDirectory<TFile extends SourceControlFileTreeFileInput> {
  name: string;
  path: string;
  insertions: number;
  deletions: number;
  fileCount: number;
  directories: Map<string, MutableSourceControlFileTreeDirectory<TFile>>;
  files: Array<SourceControlFileTreeFileNode<TFile>>;
}

const SORT_LOCALE_OPTIONS: Intl.CollatorOptions = { numeric: true, sensitivity: "base" };

function normalizePathSegments(pathValue: string): string[] {
  return pathValue
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0);
}

function compareSourceControlTreeEntries(
  a: { readonly name: string },
  b: { readonly name: string },
) {
  return a.name.localeCompare(b.name, undefined, SORT_LOCALE_OPTIONS);
}

function compactSourceControlDirectoryNode<TFile extends SourceControlFileTreeFileInput>(
  node: SourceControlFileTreeDirectoryNode<TFile>,
): SourceControlFileTreeDirectoryNode<TFile> {
  const compactedChildren = node.children.map((child) =>
    child.kind === "directory" ? compactSourceControlDirectoryNode(child) : child,
  );

  let compactedNode: SourceControlFileTreeDirectoryNode<TFile> = {
    kind: "directory",
    name: node.name,
    path: node.path,
    insertions: node.insertions,
    deletions: node.deletions,
    fileCount: node.fileCount,
    children: compactedChildren,
  };

  while (compactedNode.children.length === 1 && compactedNode.children[0]?.kind === "directory") {
    const onlyChild = compactedNode.children[0];
    compactedNode = {
      kind: "directory",
      name: `${compactedNode.name}/${onlyChild.name}`,
      path: onlyChild.path,
      insertions: onlyChild.insertions,
      deletions: onlyChild.deletions,
      fileCount: onlyChild.fileCount,
      children: onlyChild.children,
    };
  }

  return compactedNode;
}

function toSourceControlFileTreeNodes<TFile extends SourceControlFileTreeFileInput>(
  directory: MutableSourceControlFileTreeDirectory<TFile>,
): Array<SourceControlFileTreeNode<TFile>> {
  const subdirectories = Array.from(directory.directories.values())
    .toSorted(compareSourceControlTreeEntries)
    .map<SourceControlFileTreeDirectoryNode<TFile>>((subdirectory) => ({
      kind: "directory",
      name: subdirectory.name,
      path: subdirectory.path,
      insertions: subdirectory.insertions,
      deletions: subdirectory.deletions,
      fileCount: subdirectory.fileCount,
      children: toSourceControlFileTreeNodes(subdirectory),
    }))
    .map((subdirectory) => compactSourceControlDirectoryNode(subdirectory));

  return [...subdirectories, ...directory.files.toSorted(compareSourceControlTreeEntries)];
}

export function buildSourceControlFileTree<TFile extends SourceControlFileTreeFileInput>(
  files: readonly TFile[],
): Array<SourceControlFileTreeNode<TFile>> {
  const root: MutableSourceControlFileTreeDirectory<TFile> = {
    name: "",
    path: "",
    insertions: 0,
    deletions: 0,
    fileCount: 0,
    directories: new Map(),
    files: [],
  };

  for (const file of files) {
    const segments = normalizePathSegments(file.path);
    const fileName = segments.at(-1);
    if (!fileName) {
      continue;
    }

    let currentDirectory = root;
    const ancestors: Array<MutableSourceControlFileTreeDirectory<TFile>> = [root];

    for (const segment of segments.slice(0, -1)) {
      const nextPath = currentDirectory.path ? `${currentDirectory.path}/${segment}` : segment;
      const existingDirectory = currentDirectory.directories.get(segment);
      if (existingDirectory) {
        currentDirectory = existingDirectory;
      } else {
        const createdDirectory: MutableSourceControlFileTreeDirectory<TFile> = {
          name: segment,
          path: nextPath,
          insertions: 0,
          deletions: 0,
          fileCount: 0,
          directories: new Map(),
          files: [],
        };
        currentDirectory.directories.set(segment, createdDirectory);
        currentDirectory = createdDirectory;
      }
      ancestors.push(currentDirectory);
    }

    const normalizedPath = segments.join("/");
    currentDirectory.files.push({
      kind: "file",
      name: fileName,
      path: normalizedPath,
      insertions: file.insertions,
      deletions: file.deletions,
      file,
    });

    for (const ancestor of ancestors) {
      ancestor.insertions += file.insertions;
      ancestor.deletions += file.deletions;
      ancestor.fileCount += 1;
    }
  }

  return toSourceControlFileTreeNodes(root);
}

export function collectSourceControlFileTreeDirectoryPaths<
  TFile extends SourceControlFileTreeFileInput,
>(nodes: readonly SourceControlFileTreeNode<TFile>[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") {
      continue;
    }
    paths.push(node.path);
    for (const childPath of collectSourceControlFileTreeDirectoryPaths(node.children)) {
      paths.push(childPath);
    }
  }
  return paths;
}

export function formatCommitCount(count: number): string {
  return count === 1 ? "1 commit" : `${count} commits`;
}

export function resolveSourceControlPrimaryAction(input: {
  readonly status: VcsStatusResult | null;
  readonly hasCommitMessage: boolean;
  readonly commitAndPushDisabledReason: string | null;
  readonly pushDisabledReason: string | null;
}): SourceControlPrimaryAction {
  const status = input.status;
  if (status?.isRepo && !status.hasWorkingTreeChanges && input.pushDisabledReason === null) {
    const shouldPublishBranch =
      !status.hasUpstream && status.hasPrimaryRemote && !status.isDefaultRef;
    return {
      action: "push",
      label: shouldPublishBranch
        ? "Publish branch"
        : status.aheadCount > 0
          ? `Push ${formatCommitCount(status.aheadCount)}`
          : "Push",
      disabledReason: input.pushDisabledReason,
      icon: "upload",
    };
  }

  return {
    action: "commit_push",
    label: input.hasCommitMessage ? "Commit & push" : "Generate, commit & push",
    disabledReason: input.commitAndPushDisabledReason,
    icon: "sparkles",
  };
}

export function formatCommitGraphTimestamp(value: string, now = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (elapsedSeconds < 60) {
    return "just now";
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) {
    return `${elapsedDays}d ago`;
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function formatCommitGraphDateTime(
  value: string,
  locale?: string,
  timeZone?: string,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {}),
  });
}

export function formatCommitGraphParentSummary(parentCount: number): string {
  if (parentCount <= 0) {
    return "Root commit";
  }
  if (parentCount === 1) {
    return "1 parent";
  }
  return `${parentCount} parents - merge commit`;
}

export type CommitGraphRefKind = "branch" | "current" | "remote" | "tag";

export interface CommitGraphTopologyCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly refs?: readonly string[];
}

export interface CommitGraphLanePath {
  readonly fromLane: number;
  readonly toLane: number;
}

export interface CommitGraphLaneLayout {
  readonly lane: number;
  readonly topLanes: readonly number[];
  readonly bottomLanes: readonly number[];
  readonly parentPaths: readonly CommitGraphLanePath[];
  readonly laneCount: number;
  readonly isNewTip: boolean;
}

export interface CommitGraphDisplayRow<TCommit extends CommitGraphTopologyCommit> {
  readonly commit: TCommit;
  readonly layout: CommitGraphLaneLayout;
  readonly visibleRefs: readonly string[];
}

export function normalizeCommitGraphRefName(refName: string): string {
  return refName
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^refs\/tags\//, "")
    .replace(/^tags\//, "");
}

export function isVisibleCommitGraphRef(refName: string): boolean {
  const trimmed = refName.trim();
  if (trimmed.length === 0 || trimmed === "HEAD" || trimmed.includes(" -> ")) {
    return false;
  }

  const normalized = normalizeCommitGraphRefName(trimmed);
  return !/^[^/]+\/HEAD$/i.test(normalized);
}

export function getVisibleCommitGraphRefs(refs: readonly string[]): string[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (!isVisibleCommitGraphRef(ref)) {
      return false;
    }
    const normalized = normalizeCommitGraphRefName(ref);
    if (seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
}

export function getCommitGraphRefKind(
  refName: string,
  currentBranch: string | null | undefined,
): CommitGraphRefKind {
  const normalized = normalizeCommitGraphRefName(refName);
  if (currentBranch && (normalized === currentBranch || normalized === `origin/${currentBranch}`)) {
    return "current";
  }
  if (
    refName.startsWith("refs/tags/") ||
    refName.startsWith("tags/") ||
    normalized.startsWith("tag/")
  ) {
    return "tag";
  }
  if (
    refName.startsWith("refs/remotes/") ||
    normalized.startsWith("origin/") ||
    normalized.startsWith("upstream/") ||
    normalized.startsWith("fork/")
  ) {
    return "remote";
  }
  return "branch";
}

export function buildCommitGraphRows<TCommit extends CommitGraphTopologyCommit>(
  commits: readonly TCommit[],
): Array<CommitGraphDisplayRow<TCommit>> {
  let activeLanes: string[] = [];
  const rows: Array<CommitGraphDisplayRow<TCommit>> = [];

  for (const commit of commits) {
    let lane = activeLanes.indexOf(commit.sha);
    const isNewTip = lane < 0;
    if (isNewTip) {
      lane = activeLanes.length;
      activeLanes = [...activeLanes, commit.sha];
    }

    const topLanes = activeLanes
      .map((_, index) => index)
      .filter((index) => !isNewTip || index !== lane);
    let nextLanes = [...activeLanes];
    const parentPaths: CommitGraphLanePath[] = [];

    if (commit.parents.length === 0) {
      nextLanes.splice(lane, 1);
    } else {
      const [firstParent, ...additionalParents] = commit.parents;
      if (firstParent) {
        const existingParentLane = nextLanes.findIndex(
          (sha, index) => index !== lane && sha === firstParent,
        );
        if (existingParentLane >= 0) {
          const toLane = lane < existingParentLane ? existingParentLane - 1 : existingParentLane;
          nextLanes.splice(lane, 1);
          parentPaths.push({ fromLane: lane, toLane });
        } else {
          nextLanes[lane] = firstParent;
          parentPaths.push({ fromLane: lane, toLane: lane });
        }
      }

      for (const parent of additionalParents) {
        const existingParentLane = nextLanes.indexOf(parent);
        if (existingParentLane >= 0) {
          parentPaths.push({ fromLane: lane, toLane: existingParentLane });
          continue;
        }

        const parentLane = nextLanes.length;
        nextLanes.push(parent);
        parentPaths.push({ fromLane: lane, toLane: parentLane });
      }
    }

    const bottomLanes = nextLanes.map((_, index) => index);
    const rowLaneCount = Math.max(
      1,
      lane + 1,
      topLanes.length === 0 ? 0 : Math.max(...topLanes) + 1,
      bottomLanes.length === 0 ? 0 : Math.max(...bottomLanes) + 1,
      parentPaths.length === 0
        ? 0
        : Math.max(...parentPaths.flatMap((path) => [path.fromLane, path.toLane])) + 1,
    );

    rows.push({
      commit,
      layout: {
        lane,
        topLanes,
        bottomLanes,
        parentPaths,
        laneCount: rowLaneCount,
        isNewTip,
      },
      visibleRefs: getVisibleCommitGraphRefs(commit.refs ?? []),
    });
    activeLanes = nextLanes;
  }

  const laneCount = Math.max(1, ...rows.map((row) => row.layout.laneCount));
  return rows.map((row) => ({
    ...row,
    layout: {
      ...row.layout,
      laneCount,
    },
  }));
}

import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { type ContextMenuItem, TurnId } from "@t3tools/contracts";
import type { DiffRenderMode } from "@t3tools/contracts/settings";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  PilcrowIcon,
  Rows3Icon,
  SquareArrowOutUpRightIcon,
  TextWrapIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openInPreferredEditor } from "../editorPreferences";
import {
  gitDiscardChangesMutationOptions,
  gitQueryKeys,
  gitStageChangesMutationOptions,
  gitUnstageChangesMutationOptions,
  gitWorkingTreeDiffQueryOptions,
} from "~/lib/gitReactQuery";
import { refreshGitStatus, useGitStatus } from "~/lib/gitStatusState";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { readLocalApi } from "../localApi";
import { resolvePathLinkTarget } from "../terminal-links";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { useComposerDraftStore } from "../composerDraftStore";
import { useTheme } from "../hooks/useTheme";
import { buildPatchCacheKey } from "../lib/diffRendering";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import {
  buildWorkingTreeStatusDigest,
  computeFileDiffStat,
  type DiffFileStat,
  formatDiffFileCount,
  resolveActiveDiffFileIndex,
  resolveTurnDiffSummaryStats,
  sumDiffFileStats,
} from "./DiffPanel.logic";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { SourceControlIcon } from "./Icons";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { toastManager } from "./ui/toast";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

type DiffThemeType = "light" | "dark";

const DIFF_PANEL_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}

[data-title] {
  cursor: pointer;
  transition:
    color 120ms ease,
    text-decoration-color 120ms ease;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

[data-title]:hover {
  color: color-mix(in srgb, var(--foreground) 84%, var(--primary)) !important;
  text-decoration-color: currentColor;
}
`;

type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

function getDiffCollapseIconClassName(fileDiff: FileDiffMetadata): string {
  switch (fileDiff.type) {
    case "new":
      return "text-[var(--diffs-addition-base)]";
    case "deleted":
      return "text-[var(--diffs-deletion-base)]";
    case "change":
    case "rename-pure":
    case "rename-changed":
      return "text-[var(--diffs-modified-base)]";
    default:
      return "text-muted-foreground/80";
  }
}

function getFileDiffStatusBadge(fileDiff: FileDiffMetadata): {
  readonly label: string;
  readonly className: string;
} {
  switch (fileDiff.type) {
    case "new":
      return { label: "A", className: "border-success/25 bg-success/8 text-success-foreground" };
    case "deleted":
      return {
        label: "D",
        className: "border-destructive/25 bg-destructive/8 text-destructive-foreground",
      };
    case "rename-pure":
    case "rename-changed":
      return { label: "R", className: "border-border/70 bg-muted/50 text-muted-foreground" };
    default:
      return { label: "M", className: "border-border/70 bg-muted/50 text-muted-foreground" };
  }
}

/**
 * The panel unmounts whenever the rail swaps back to source control, so the
 * collapse choices live here, keyed by thread + diff source, to survive the
 * round trip.
 */
const COLLAPSED_DIFF_FILE_CACHE_LIMIT = 24;
const collapsedDiffFileKeysByScope = new Map<string, ReadonlySet<string>>();

function readCollapsedDiffFileKeys(scope: string): ReadonlySet<string> {
  return collapsedDiffFileKeysByScope.get(scope) ?? new Set<string>();
}

function writeCollapsedDiffFileKeys(scope: string, keys: ReadonlySet<string>): void {
  collapsedDiffFileKeysByScope.delete(scope);
  collapsedDiffFileKeysByScope.set(scope, keys);
  while (collapsedDiffFileKeysByScope.size > COLLAPSED_DIFF_FILE_CACHE_LIMIT) {
    const oldestScope = collapsedDiffFileKeysByScope.keys().next().value;
    if (oldestScope === undefined) {
      break;
    }
    collapsedDiffFileKeysByScope.delete(oldestScope);
  }
}

/** Sticky file headers cover the top of the scroller; read "active" below them. */
const ACTIVE_FILE_READING_OFFSET_PX = 48;
/** Below this toolbar width a split diff degrades to two unreadable columns. */
const NARROW_DIFF_PANEL_WIDTH_PX = 420;

type DiffFileContextAction = "open-editor" | "copy-path" | "stage" | "unstage" | "discard";

interface PendingDiscardDiffFile {
  readonly filePath: string;
  readonly isUntracked: boolean;
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
  onBackToSourceControl?: () => void;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({ mode = "inline", onBackToSourceControl }: DiffPanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [panelNarrow, setPanelNarrow] = useState(false);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [flashFilePath, setFlashFilePath] = useState<string | null>(null);
  const [pendingDiscardDiffFile, setPendingDiscardDiffFile] =
    useState<PendingDiscardDiffFile | null>(null);
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
  const pendingScrollFilePathRef = useRef<string | null>(null);
  const workingTreeDigestRef = useRef<string | null>(null);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const diffSearch = useSearch({ strict: false, select: (search) => parseDiffRouteSearch(search) });
  const diffOpen = diffSearch.diff === "1";
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const draftThread = useComposerDraftStore((store) =>
    routeThreadRef ? store.getDraftThreadByRef(routeThreadRef) : null,
  );
  const activeEnvironmentId = activeThread?.environmentId ?? draftThread?.environmentId ?? null;
  const activeProjectRef = useMemo(() => {
    if (activeThread) {
      return scopeProjectRef(activeThread.environmentId, activeThread.projectId);
    }
    if (draftThread) {
      return scopeProjectRef(draftThread.environmentId, draftThread.projectId);
    }
    return null;
  }, [activeThread, draftThread]);
  const activeProject = useStore(
    useMemo(() => createProjectSelectorByRef(activeProjectRef), [activeProjectRef]),
  );
  const activeCwd = activeThread
    ? (activeThread.worktreePath ?? activeProject?.cwd)
    : draftThread && activeProject
      ? projectScriptCwd({
          project: { cwd: activeProject.cwd },
          worktreePath: draftThread.worktreePath ?? null,
        })
      : undefined;
  const gitStatusQuery = useGitStatus({
    environmentId: activeEnvironmentId,
    cwd: activeCwd ?? null,
  });
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  const selectedTurnId = diffSearch.diffTurnId ?? null;
  // While pre-mounted hidden (no diff search params), warm the working-tree
  // view: that is what a source control file click opens.
  const diffMode = !diffOpen
    ? "workingTree"
    : diffSearch.diffMode === "workingTree"
      ? "workingTree"
      : "checkpoint";
  const selectedFilePath = diffSearch.diffFilePath ?? null;
  const selectedTurn =
    diffMode === "workingTree" || selectedTurnId === null
      ? undefined
      : orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId);
  const selectedTurnMissing =
    diffMode === "checkpoint" && selectedTurnId !== null && selectedTurn === undefined;
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const conversationCheckpointTurnCount = useMemo(() => {
    const turnCounts = orderedTurnDiffSummaries
      .map(
        (summary) =>
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      )
      .filter((value): value is number => typeof value === "number");
    if (turnCounts.length === 0) {
      return undefined;
    }
    const latest = Math.max(...turnCounts);
    return latest > 0 ? latest : undefined;
  }, [inferredCheckpointTurnCountByTurnId, orderedTurnDiffSummaries]);
  const conversationCheckpointRange = useMemo(
    () =>
      !selectedTurn && !selectedTurnMissing && typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, selectedTurn, selectedTurnMissing],
  );
  const activeCheckpointRange = selectedTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const conversationCacheScope = useMemo(() => {
    if (selectedTurn || selectedTurnMissing || orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [orderedTurnDiffSummaries, selectedTurn, selectedTurnMissing]);
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      rangeKind: selectedTurn ? "turn" : "fullThread",
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      enabled: isGitRepo && diffMode === "checkpoint" && !selectedTurnMissing,
    }),
  );
  const workingTreeDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      environmentId: activeEnvironmentId,
      cwd: activeCwd ?? null,
      filePaths: null,
      ignoreWhitespace: diffIgnoreWhitespace,
      enabled: isGitRepo && diffMode === "workingTree",
    }),
  );
  const selectedTurnCheckpointDiff = selectedTurn
    ? activeCheckpointDiffQuery.data?.diff
    : undefined;
  const conversationCheckpointDiff = selectedTurn
    ? undefined
    : activeCheckpointDiffQuery.data?.diff;
  const isLoadingCheckpointDiff = activeCheckpointDiffQuery.isLoading;
  const checkpointDiffError =
    activeCheckpointDiffQuery.error instanceof Error
      ? activeCheckpointDiffQuery.error.message
      : activeCheckpointDiffQuery.error
        ? "Failed to load checkpoint diff."
        : null;
  const workingTreeDiffError =
    workingTreeDiffQuery.error instanceof Error
      ? workingTreeDiffQuery.error.message
      : workingTreeDiffQuery.error
        ? "Failed to load working tree diff."
        : null;
  const hasWorkingTreeDiffContext =
    diffMode === "workingTree" && activeEnvironmentId !== null && activeCwd !== undefined;

  const selectedPatch =
    diffMode === "workingTree"
      ? workingTreeDiffQuery.data?.diff
      : selectedTurn
        ? selectedTurnCheckpointDiff
        : conversationCheckpointDiff;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () => getRenderablePatch(selectedPatch, `diff-panel:${diffMode}:${resolvedTheme}`),
    [diffMode, resolvedTheme, selectedPatch],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);
  const orderedFilePaths = useMemo(
    () => renderableFiles.map(resolveFileDiffPath),
    [renderableFiles],
  );
  const fileStatByKey = useMemo(() => {
    const stats = new Map<string, DiffFileStat>();
    for (const fileDiff of renderableFiles) {
      stats.set(buildFileDiffRenderKey(fileDiff), computeFileDiffStat(fileDiff));
    }
    return stats;
  }, [renderableFiles]);
  const totalDiffStat = useMemo(
    () => sumDiffFileStats([...fileStatByKey.values()]),
    [fileStatByKey],
  );
  // `diffFilePath` acts as an explicit single-file filter: entering from a
  // file row shows just that file, with the strip switching or clearing it.
  const fileFilterActive = selectedFilePath !== null;
  const displayedFiles = useMemo(
    () =>
      fileFilterActive
        ? renderableFiles.filter((fileDiff) => resolveFileDiffPath(fileDiff) === selectedFilePath)
        : renderableFiles,
    [fileFilterActive, renderableFiles, selectedFilePath],
  );

  // ── Collapse state (cached across panel remounts) ──────────────────
  const collapseScope = `${activeThreadId ?? "no-thread"}:${diffMode}:${selectedTurnId ?? "all"}`;
  const collapseScopeRef = useRef(collapseScope);
  const [collapsedDiffFileKeys, setCollapsedDiffFileKeysState] = useState<ReadonlySet<string>>(() =>
    readCollapsedDiffFileKeys(collapseScope),
  );
  useEffect(() => {
    if (collapseScopeRef.current === collapseScope) {
      return;
    }
    collapseScopeRef.current = collapseScope;
    setCollapsedDiffFileKeysState(readCollapsedDiffFileKeys(collapseScope));
  }, [collapseScope]);
  const setCollapsedDiffFileKeys = useCallback(
    (updater: (current: ReadonlySet<string>) => ReadonlySet<string>) => {
      setCollapsedDiffFileKeysState((current) => {
        const next = updater(current);
        if (next !== current) {
          writeCollapsedDiffFileKeys(collapseScopeRef.current, next);
        }
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    if (renderableFiles.length === 0) {
      return;
    }
    const visibleFileKeys = new Set(renderableFiles.map(buildFileDiffRenderKey));
    setCollapsedDiffFileKeys((current) => {
      const next = new Set([...current].filter((fileKey) => visibleFileKeys.has(fileKey)));
      return next.size === current.size ? current : next;
    });
  }, [renderableFiles, setCollapsedDiffFileKeys]);

  const toggleDiffFileCollapsed = useCallback(
    (fileKey: string) => {
      setCollapsedDiffFileKeys((current) => {
        const next = new Set(current);
        if (next.has(fileKey)) {
          next.delete(fileKey);
        } else {
          next.add(fileKey);
        }
        return next;
      });
    },
    [setCollapsedDiffFileKeys],
  );
  const allDiffFilesCollapsed =
    displayedFiles.length > 0 &&
    displayedFiles.every((fileDiff) => collapsedDiffFileKeys.has(buildFileDiffRenderKey(fileDiff)));
  const toggleAllDiffFilesCollapsed = useCallback(() => {
    setCollapsedDiffFileKeys((current) => {
      if (displayedFiles.length === 0) {
        return current;
      }
      const fileKeys = displayedFiles.map(buildFileDiffRenderKey);
      const next = new Set(current);
      if (fileKeys.every((fileKey) => current.has(fileKey))) {
        for (const fileKey of fileKeys) {
          next.delete(fileKey);
        }
      } else {
        for (const fileKey of fileKeys) {
          next.add(fileKey);
        }
      }
      return next;
    });
  }, [displayedFiles, setCollapsedDiffFileKeys]);

  // ── View settings ──────────────────────────────────────────────────
  const effectiveDiffRenderMode: DiffRenderMode = panelNarrow ? "stacked" : settings.diffRenderMode;
  const setDiffRenderMode = useCallback(
    (nextMode: DiffRenderMode) => {
      updateSettings({ diffRenderMode: nextMode });
    },
    [updateSettings],
  );

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
      setDiffIgnoreWhitespace(settings.diffIgnoreWhitespace);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffIgnoreWhitespace, settings.diffWordWrap]);

  useEffect(() => {
    const node = toolbarRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setPanelNarrow(width > 0 && width < NARROW_DIFF_PANEL_WIDTH_PX);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // ── File navigation ────────────────────────────────────────────────
  const scrollToDiffFile = useCallback((filePath: string) => {
    const viewport = patchViewportRef.current;
    if (!viewport) {
      return;
    }
    const target = Array.from(viewport.querySelectorAll<HTMLElement>("[data-diff-file-path]")).find(
      (element) => element.dataset.diffFilePath === filePath,
    );
    if (!target) {
      return;
    }
    target.scrollIntoView({ block: "start" });
    setFlashFilePath(filePath);
  }, []);

  useEffect(() => {
    if (!flashFilePath) {
      return;
    }
    const timeoutId = window.setTimeout(() => setFlashFilePath(null), 1400);
    return () => window.clearTimeout(timeoutId);
  }, [flashFilePath]);

  const setFileFilterPath = useCallback(
    (filePath: string | null) => {
      const targetThreadRef = activeThread
        ? scopeThreadRef(activeThread.environmentId, activeThread.id)
        : routeThreadRef;
      if (!targetThreadRef) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(targetThreadRef),
        replace: true,
        search: (previous) => ({ ...previous, diffFilePath: filePath ?? undefined }),
      });
    },
    [activeThread, navigate, routeThreadRef],
  );
  const clearFileFilter = useCallback(() => {
    pendingScrollFilePathRef.current = selectedFilePath;
    setFileFilterPath(null);
  }, [selectedFilePath, setFileFilterPath]);

  // After clearing the filter, land on the file the user was reading.
  useEffect(() => {
    const pending = pendingScrollFilePathRef.current;
    if (!pending || fileFilterActive || renderableFiles.length === 0) {
      return;
    }
    pendingScrollFilePathRef.current = null;
    if (!orderedFilePaths.includes(pending)) {
      return;
    }
    scrollToDiffFile(pending);
  }, [fileFilterActive, orderedFilePaths, renderableFiles.length, scrollToDiffFile]);

  useEffect(() => {
    const viewport = patchViewportRef.current;
    if (
      !viewport ||
      fileFilterActive ||
      !renderablePatch ||
      renderablePatch.kind !== "files" ||
      renderableFiles.length === 0
    ) {
      setActiveFilePath(null);
      return;
    }
    const scroller = viewport.querySelector<HTMLElement>(".diff-render-surface");
    if (!scroller) {
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const scrollerTop = scroller.getBoundingClientRect().top;
      const wrappers = Array.from(scroller.querySelectorAll<HTMLElement>("[data-diff-file-path]"));
      const fileTops = wrappers.map(
        (element) => element.getBoundingClientRect().top - scrollerTop + scroller.scrollTop,
      );
      const index = resolveActiveDiffFileIndex(
        fileTops,
        scroller.scrollTop,
        ACTIVE_FILE_READING_OFFSET_PX,
      );
      setActiveFilePath(index >= 0 ? (wrappers[index]?.dataset.diffFilePath ?? null) : null);
    };
    update();
    const onScroll = () => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(update);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [fileFilterActive, renderablePatch, renderableFiles]);

  // The file the strip considers "current": the filtered file, or the one in view.
  const activeListPath = fileFilterActive ? selectedFilePath : activeFilePath;
  const activeFileIndex = activeListPath ? orderedFilePaths.indexOf(activeListPath) : -1;
  const goToAdjacentFile = useCallback(
    (delta: number) => {
      if (orderedFilePaths.length === 0) {
        return;
      }
      const currentIndex = activeListPath ? orderedFilePaths.indexOf(activeListPath) : -1;
      const nextIndex = Math.min(
        orderedFilePaths.length - 1,
        Math.max(0, (currentIndex === -1 ? 0 : currentIndex) + delta),
      );
      const nextPath = orderedFilePaths[nextIndex];
      if (!nextPath || nextPath === activeListPath) {
        return;
      }
      if (fileFilterActive) {
        setFileFilterPath(nextPath);
      } else {
        scrollToDiffFile(nextPath);
      }
    },
    [activeListPath, fileFilterActive, orderedFilePaths, scrollToDiffFile, setFileFilterPath],
  );

  // ── Freshness: refetch the open diff when the working tree moves ───
  const workingTreeStatusDigest = useMemo(
    () => buildWorkingTreeStatusDigest(gitStatusQuery.data ?? null),
    [gitStatusQuery.data],
  );
  useEffect(() => {
    const previousDigest = workingTreeDigestRef.current;
    workingTreeDigestRef.current = workingTreeStatusDigest;
    if (
      diffMode !== "workingTree" ||
      workingTreeStatusDigest === null ||
      previousDigest === null ||
      previousDigest === workingTreeStatusDigest
    ) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: gitQueryKeys.workingTreeDiffPrefix(activeEnvironmentId, activeCwd ?? null),
    });
  }, [activeCwd, activeEnvironmentId, diffMode, queryClient, workingTreeStatusDigest]);

  // ── Per-file actions ───────────────────────────────────────────────
  const openDiffFileInEditor = useCallback(
    (filePath: string) => {
      const api = readLocalApi();
      if (!api) return;
      const targetPath = activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath;
      void openInPreferredEditor(api, targetPath).catch((error) => {
        console.warn("Failed to open diff file in editor.", error);
      });
    },
    [activeCwd],
  );
  const copyDiffFilePath = useCallback((filePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add({
        type: "error",
        title: "Failed to copy path",
        description: "Clipboard API unavailable.",
      });
      return;
    }
    void navigator.clipboard.writeText(filePath).then(
      () => {
        toastManager.add({ type: "success", title: "Path copied", description: filePath });
      },
      () => {
        toastManager.add({ type: "error", title: "Failed to copy path" });
      },
    );
  }, []);

  const stageChangesMutation = useMutation(
    gitStageChangesMutationOptions({
      environmentId: activeEnvironmentId,
      cwd: activeCwd ?? null,
      queryClient,
    }),
  );
  const unstageChangesMutation = useMutation(
    gitUnstageChangesMutationOptions({
      environmentId: activeEnvironmentId,
      cwd: activeCwd ?? null,
      queryClient,
    }),
  );
  const discardChangesMutation = useMutation(
    gitDiscardChangesMutationOptions({
      environmentId: activeEnvironmentId,
      cwd: activeCwd ?? null,
      queryClient,
    }),
  );
  const refreshDiffGitStatus = useCallback(() => {
    void refreshGitStatus({
      environmentId: activeEnvironmentId,
      cwd: activeCwd ?? null,
    }).catch(() => undefined);
  }, [activeCwd, activeEnvironmentId]);
  const runStageDiffFile = useCallback(
    (filePath: string) => {
      stageChangesMutation.mutateAsync({ filePaths: [filePath] }).then(
        () => refreshDiffGitStatus(),
        (error: unknown) => {
          refreshDiffGitStatus();
          toastManager.add({
            type: "error",
            title: "Stage changes failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        },
      );
    },
    [refreshDiffGitStatus, stageChangesMutation],
  );
  const runUnstageDiffFile = useCallback(
    (filePath: string) => {
      unstageChangesMutation.mutateAsync({ filePaths: [filePath] }).then(
        () => refreshDiffGitStatus(),
        (error: unknown) => {
          refreshDiffGitStatus();
          toastManager.add({
            type: "error",
            title: "Unstage changes failed",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        },
      );
    },
    [refreshDiffGitStatus, unstageChangesMutation],
  );
  const runDiscardDiffFile = useCallback(() => {
    if (!pendingDiscardDiffFile) {
      return;
    }
    const request = pendingDiscardDiffFile;
    setPendingDiscardDiffFile(null);
    const promise = discardChangesMutation.mutateAsync({
      filePaths: [request.filePath],
      scope: "unstaged",
    });
    void toastManager.promise(promise, {
      loading: { title: "Discarding changes..." },
      success: () => ({ title: "Changes discarded", description: request.filePath }),
      error: (error: unknown) => ({
        title: "Discard changes failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    });
    void promise.then(
      () => refreshDiffGitStatus(),
      () => refreshDiffGitStatus(),
    );
  }, [discardChangesMutation, pendingDiscardDiffFile, refreshDiffGitStatus]);

  const isFileMutationRunning =
    stageChangesMutation.isPending ||
    unstageChangesMutation.isPending ||
    discardChangesMutation.isPending;
  const handleDiffFileContextMenu = useCallback(
    async (filePath: string, position: { readonly x: number; readonly y: number }) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }
      const statusFile =
        diffMode === "workingTree"
          ? gitStatusQuery.data?.workingTree.files.find((file) => file.path === filePath)
          : undefined;
      const canMutate =
        diffMode === "workingTree" && activeEnvironmentId !== null && activeCwd !== undefined;
      const menuItems: ContextMenuItem<DiffFileContextAction>[] = [
        { id: "open-editor", label: "Open in editor" },
        { id: "copy-path", label: "Copy path" },
        ...(canMutate && statusFile?.worktreeStatus
          ? [{ id: "stage" as const, label: "Stage changes", disabled: isFileMutationRunning }]
          : []),
        ...(canMutate && statusFile?.indexStatus
          ? [{ id: "unstage" as const, label: "Unstage changes", disabled: isFileMutationRunning }]
          : []),
        ...(canMutate && statusFile?.worktreeStatus
          ? [
              {
                id: "discard" as const,
                label: "Discard changes...",
                disabled: isFileMutationRunning,
              },
            ]
          : []),
      ];
      const clicked = await api.contextMenu.show(menuItems, position);
      if (clicked === "open-editor") {
        openDiffFileInEditor(filePath);
      } else if (clicked === "copy-path") {
        copyDiffFilePath(filePath);
      } else if (clicked === "stage") {
        runStageDiffFile(filePath);
      } else if (clicked === "unstage") {
        runUnstageDiffFile(filePath);
      } else if (clicked === "discard") {
        setPendingDiscardDiffFile({
          filePath,
          isUntracked: statusFile?.worktreeStatus === "untracked",
        });
      }
    },
    [
      activeCwd,
      activeEnvironmentId,
      copyDiffFilePath,
      diffMode,
      gitStatusQuery.data,
      isFileMutationRunning,
      openDiffFileInEditor,
      runStageDiffFile,
      runUnstageDiffFile,
    ],
  );

  // ── Source selection ───────────────────────────────────────────────
  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffTurnId: turnId };
      },
    });
  };
  const selectWholeConversation = () => {
    if (!activeThread) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1" };
      },
    });
  };
  const selectWorkingTree = () => {
    const targetThreadRef = activeThread
      ? scopeThreadRef(activeThread.environmentId, activeThread.id)
      : routeThreadRef;
    if (!targetThreadRef) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffMode: "workingTree" };
      },
    });
  };

  const hasRenderableFiles = renderablePatch?.kind === "files" && renderableFiles.length > 0;
  const diffStatsSummary = hasRenderableFiles ? (
    <>
      {formatDiffFileCount(renderableFiles.length)}
      <span aria-hidden="true"> · </span>
      <span className="font-mono">
        <DiffStatLabel additions={totalDiffStat.additions} deletions={totalDiffStat.deletions} />
      </span>
    </>
  ) : null;
  const selectedTurnStats = selectedTurn ? resolveTurnDiffSummaryStats(selectedTurn) : null;
  const selectedDiffSourceLabel =
    diffMode === "workingTree"
      ? "Uncommitted changes"
      : selectedTurnMissing
        ? "Turn unavailable"
        : selectedTurn
          ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
          : "All agent turns";
  const selectedDiffSourceDescription =
    diffMode === "workingTree" ? (
      (diffStatsSummary ?? "Current uncommitted Git changes")
    ) : selectedTurnMissing ? (
      "This turn has no checkpoint in this thread"
    ) : selectedTurn ? (
      <>
        {formatShortTimestamp(selectedTurn.completedAt, settings.timestampFormat)}
        {selectedTurnStats && selectedTurnStats.fileCount > 0 ? (
          <>
            <span aria-hidden="true"> · </span>
            {formatDiffFileCount(selectedTurnStats.fileCount)}
            {selectedTurnStats.lineStats ? (
              <>
                <span aria-hidden="true"> · </span>
                <span className="font-mono">
                  <DiffStatLabel
                    additions={selectedTurnStats.lineStats.additions}
                    deletions={selectedTurnStats.lineStats.deletions}
                  />
                </span>
              </>
            ) : null}
          </>
        ) : null}
      </>
    ) : (
      (diffStatsSummary ?? "All checkpointed changes from this chat")
    );

  const headerRow = (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {onBackToSourceControl ? (
        <button
          type="button"
          aria-label="Back to source control"
          title="Back to source control (Esc)"
          className="-ml-1.5 flex min-w-0 cursor-pointer items-center gap-1 rounded-sm border-0 bg-transparent py-0.5 pl-0.5 pr-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onBackToSourceControl}
        >
          <ChevronLeftIcon className="size-3.5 shrink-0 opacity-80" />
          <SourceControlIcon className="size-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 truncate">
            <span className="source-control-title-short">SC</span>
            <span className="source-control-title-full">Source Control</span>
          </span>
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
          <SourceControlIcon className="size-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 truncate">
            <span className="source-control-title-short">SC</span>
            <span className="source-control-title-full">Source Control</span>
          </span>
        </span>
      )}
      <span aria-hidden="true" className="shrink-0 text-[11px] text-muted-foreground/40">
        /
      </span>
      <h2 className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-foreground/85">
        Diff
      </h2>
    </div>
  );

  const fileStripVisible = hasRenderableFiles && renderableFiles.length > 1;
  const activeFileName = activeListPath
    ? (activeListPath.split("/").at(-1) ?? activeListPath)
    : null;

  const toolbarRow = (
    <div
      ref={toolbarRef}
      className="@container/diff-toolbar space-y-1.5 border-b border-border px-2 py-2"
    >
      <div className="grid min-w-0 grid-cols-1 gap-1.5 @xs/diff-toolbar:grid-cols-[minmax(0,1fr)_auto] @xs/diff-toolbar:items-center">
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="h-8 w-full min-w-0 justify-between px-2 py-1 sm:h-8"
                aria-label="Select diff source"
              />
            }
          >
            <span className="flex min-w-0 flex-col items-start gap-0.5">
              <span className="truncate text-xs leading-tight">{selectedDiffSourceLabel}</span>
              <span className="truncate text-[10px] leading-tight text-muted-foreground/70">
                {selectedDiffSourceDescription}
              </span>
            </span>
            <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
          </MenuTrigger>
          <MenuPopup align="start" className="w-72">
            <MenuGroup className="pt-1">
              <MenuGroupLabel>Git changes</MenuGroupLabel>
              <MenuRadioGroup
                value={
                  diffMode === "workingTree" ? "workingTree" : selectedTurn ? "" : "checkpoint:all"
                }
                onValueChange={(value) => {
                  if (value === "workingTree") {
                    selectWorkingTree();
                  } else if (value === "checkpoint:all") {
                    selectWholeConversation();
                  }
                }}
              >
                <MenuRadioItem value="workingTree">Uncommitted changes</MenuRadioItem>
                <MenuRadioItem value="checkpoint:all">All agent turns</MenuRadioItem>
              </MenuRadioGroup>
            </MenuGroup>
            {orderedTurnDiffSummaries.length > 0 ? (
              <>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>Agent turns</MenuGroupLabel>
                  <MenuRadioGroup
                    value={
                      diffMode === "checkpoint" && selectedTurn ? `turn:${selectedTurn.turnId}` : ""
                    }
                    onValueChange={(value) => {
                      if (!value.startsWith("turn:")) return;
                      selectTurn(TurnId.make(value.slice("turn:".length)));
                    }}
                  >
                    {orderedTurnDiffSummaries.map((summary) => {
                      const turnCount =
                        summary.checkpointTurnCount ??
                        inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                        "?";
                      const turnStats = resolveTurnDiffSummaryStats(summary);
                      return (
                        <MenuRadioItem key={summary.turnId} value={`turn:${summary.turnId}`}>
                          <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                            <span className="min-w-0 truncate">
                              Turn {turnCount} ·{" "}
                              {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                            </span>
                            {turnStats.lineStats ? (
                              <span className="shrink-0 font-mono text-[10px]">
                                <DiffStatLabel
                                  additions={turnStats.lineStats.additions}
                                  deletions={turnStats.lineStats.deletions}
                                />
                              </span>
                            ) : null}
                          </span>
                        </MenuRadioItem>
                      );
                    })}
                  </MenuRadioGroup>
                </MenuGroup>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
        <div className="flex shrink-0 items-center justify-end gap-1 [-webkit-app-region:no-drag]">
          {panelNarrow ? null : (
            <ToggleGroup
              className="shrink-0"
              variant="outline"
              size="xs"
              value={[effectiveDiffRenderMode]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "stacked" || next === "split") {
                  setDiffRenderMode(next);
                }
              }}
            >
              <Toggle aria-label="Stacked diff view" value="stacked">
                <Rows3Icon className="size-3" />
              </Toggle>
              <Toggle aria-label="Split diff view" value="split">
                <Columns2Icon className="size-3" />
              </Toggle>
            </ToggleGroup>
          )}
          <Toggle
            aria-label={diffWordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
            title={diffWordWrap ? "Disable line wrapping" : "Enable line wrapping"}
            variant="outline"
            size="xs"
            pressed={diffWordWrap}
            onPressedChange={(pressed) => {
              setDiffWordWrap(Boolean(pressed));
            }}
          >
            <TextWrapIcon className="size-3" />
          </Toggle>
          <Toggle
            aria-label={
              diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
            }
            title={diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
            variant="outline"
            size="xs"
            pressed={diffIgnoreWhitespace}
            onPressedChange={(pressed) => {
              setDiffIgnoreWhitespace(Boolean(pressed));
            }}
          >
            <PilcrowIcon className="size-3" />
          </Toggle>
        </div>
      </div>
      {fileStripVisible ? (
        <div className="flex min-w-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Previous file"
            title="Previous file"
            className="text-muted-foreground/70 hover:text-foreground"
            disabled={activeFileIndex <= 0}
            onClick={() => goToAdjacentFile(-1)}
          >
            <ChevronUpIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Next file"
            title="Next file"
            className="text-muted-foreground/70 hover:text-foreground"
            disabled={activeFileIndex >= renderableFiles.length - 1}
            onClick={() => goToAdjacentFile(1)}
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="h-6 min-w-0 flex-1 justify-start gap-1.5 px-1.5"
                  aria-label="Jump to file"
                />
              }
            >
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                {(activeFileIndex >= 0 ? activeFileIndex : 0) + 1}/{renderableFiles.length}
              </span>
              <span className="min-w-0 truncate text-xs text-foreground/90">
                {activeFileName ?? ""}
              </span>
              <ChevronDownIcon className="ml-auto size-3 shrink-0 opacity-60" />
            </MenuTrigger>
            <MenuPopup align="start" className="max-h-80 w-80 overflow-y-auto">
              {fileFilterActive ? (
                <>
                  <MenuItem className="gap-1.5" onClick={clearFileFilter}>
                    <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                    <span className="min-w-0 flex-1 truncate text-xs">Show all files</span>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                      {renderableFiles.length}
                    </span>
                  </MenuItem>
                  <MenuSeparator />
                </>
              ) : null}
              <MenuGroup>
                <MenuGroupLabel>
                  {formatDiffFileCount(renderableFiles.length)}
                  <span aria-hidden="true"> · </span>
                  <span className="font-mono">
                    <DiffStatLabel
                      additions={totalDiffStat.additions}
                      deletions={totalDiffStat.deletions}
                    />
                  </span>
                </MenuGroupLabel>
                {renderableFiles.map((fileDiff) => {
                  const filePath = resolveFileDiffPath(fileDiff);
                  const fileKey = buildFileDiffRenderKey(fileDiff);
                  const fileStat = fileStatByKey.get(fileKey);
                  const badge = getFileDiffStatusBadge(fileDiff);
                  const isActive = filePath === activeListPath;
                  const pathSegments = filePath.split("/");
                  const fileName = pathSegments.at(-1) ?? filePath;
                  const fileDirectory = pathSegments.slice(0, -1).join("/");
                  return (
                    <MenuItem
                      key={fileKey}
                      className={cn("gap-1.5", isActive && "bg-accent/45")}
                      onClick={() =>
                        fileFilterActive ? setFileFilterPath(filePath) : scrollToDiffFile(filePath)
                      }
                    >
                      <span
                        className={cn(
                          "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded border px-1 font-mono text-[10px] leading-none",
                          badge.className,
                        )}
                      >
                        {badge.label}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {fileName}
                        {fileDirectory ? (
                          <span className="ml-1.5 font-mono text-[10px] text-muted-foreground/55">
                            {fileDirectory}
                          </span>
                        ) : null}
                      </span>
                      {fileStat ? (
                        <span className="shrink-0 font-mono text-[10px]">
                          <DiffStatLabel
                            additions={fileStat.additions}
                            deletions={fileStat.deletions}
                          />
                        </span>
                      ) : null}
                    </MenuItem>
                  );
                })}
              </MenuGroup>
            </MenuPopup>
          </Menu>
          {fileFilterActive ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Show all files"
              title={`Show all ${renderableFiles.length} files`}
              className="text-muted-foreground/70 hover:text-foreground"
              onClick={clearFileFilter}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
            title={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
            className="text-muted-foreground/70 hover:text-foreground"
            onClick={toggleAllDiffFilesCollapsed}
          >
            {allDiffFilesCollapsed ? (
              <ChevronsUpDownIcon className="size-3.5" />
            ) : (
              <ChevronsDownUpIcon className="size-3.5" />
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow} onEscape={onBackToSourceControl}>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col",
          mode !== "sheet" && "diff-panel-enter",
        )}
      >
        {toolbarRow}
        {!activeThread && !hasWorkingTreeDiffContext ? (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            Select a thread to inspect turn diffs.
          </div>
        ) : !isGitRepo ? (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            Turn diffs are unavailable because this project is not a git repository.
          </div>
        ) : selectedTurnMissing ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-5 text-center">
            <p className="text-xs text-muted-foreground/70">
              This turn has no checkpoint in this thread.
            </p>
            <Button type="button" variant="outline" size="xs" onClick={selectWholeConversation}>
              Show all turns
            </Button>
          </div>
        ) : diffMode !== "workingTree" && orderedTurnDiffSummaries.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
            No completed turns yet.
          </div>
        ) : (
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {diffMode === "checkpoint" && checkpointDiffError && !renderablePatch && (
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <p className="min-w-0 flex-1 text-[11px] text-red-500/80">{checkpointDiffError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void activeCheckpointDiffQuery.refetch()}
                >
                  Retry
                </Button>
              </div>
            )}
            {diffMode === "workingTree" && workingTreeDiffError && !renderablePatch && (
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <p className="min-w-0 flex-1 text-[11px] text-red-500/80">{workingTreeDiffError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void workingTreeDiffQuery.refetch()}
                >
                  Retry
                </Button>
              </div>
            )}
            {!renderablePatch ? (
              isLoadingCheckpointDiff || workingTreeDiffQuery.isLoading ? (
                <DiffPanelLoadingState
                  label={
                    diffMode === "workingTree"
                      ? "Loading working tree diff..."
                      : "Loading checkpoint diff..."
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {hasNoNetChanges
                      ? diffMode === "workingTree"
                        ? "No uncommitted changes in this selection."
                        : "No net changes in this selection."
                      : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : renderablePatch.kind === "files" ? (
              fileFilterActive && displayedFiles.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
                  <p className="text-xs text-muted-foreground/70">
                    No changes in {selectedFilePath} anymore.
                  </p>
                  <Button type="button" variant="outline" size="xs" onClick={clearFileFilter}>
                    Show all files
                  </Button>
                </div>
              ) : (
                <Virtualizer
                  className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                  config={{
                    overscrollSize: 600,
                    intersectionObserverMargin: 1200,
                  }}
                >
                  {displayedFiles.map((fileDiff) => {
                    const filePath = resolveFileDiffPath(fileDiff);
                    const fileKey = buildFileDiffRenderKey(fileDiff);
                    const themedFileKey = `${fileKey}:${resolvedTheme}`;
                    const collapsed = collapsedDiffFileKeys.has(fileKey);
                    return (
                      <div
                        key={themedFileKey}
                        data-diff-file-path={filePath}
                        className={cn(
                          "diff-render-file group/diff-file mb-2 rounded-md first:mt-2 last:mb-0",
                          flashFilePath === filePath && "diff-file-flash",
                        )}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void handleDiffFileContextMenu(filePath, {
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }}
                        onClickCapture={(event) => {
                          const nativeEvent = event.nativeEvent as MouseEvent;
                          const composedPath = nativeEvent.composedPath?.() ?? [];
                          const clickedHeader = composedPath.some((node) => {
                            if (!(node instanceof Element)) return false;
                            return node.hasAttribute("data-title");
                          });
                          if (!clickedHeader) return;
                          openDiffFileInEditor(filePath);
                        }}
                      >
                        <FileDiff
                          fileDiff={fileDiff}
                          renderHeaderPrefix={() => (
                            <button
                              type="button"
                              className={cn(
                                "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                                getDiffCollapseIconClassName(fileDiff),
                              )}
                              aria-label={collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
                              aria-expanded={!collapsed}
                              title={collapsed ? "Expand diff" : "Collapse diff"}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleDiffFileCollapsed(fileKey);
                              }}
                            >
                              {collapsed ? (
                                <ChevronRightIcon className="size-4" />
                              ) : (
                                <ChevronDownIcon className="size-4" />
                              )}
                            </button>
                          )}
                          renderHeaderMetadata={() => (
                            <span className="flex items-center pl-1.5">
                              <button
                                type="button"
                                aria-label={`Open ${filePath} in editor`}
                                title="Open in editor"
                                className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-muted-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-hidden"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openDiffFileInEditor(filePath);
                                }}
                              >
                                <SquareArrowOutUpRightIcon className="size-3" />
                              </button>
                            </span>
                          )}
                          options={{
                            collapsed,
                            diffStyle: effectiveDiffRenderMode === "split" ? "split" : "unified",
                            lineDiffType: "none",
                            overflow: diffWordWrap ? "wrap" : "scroll",
                            theme: resolveDiffThemeName(resolvedTheme),
                            themeType: resolvedTheme as DiffThemeType,
                            unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
                          }}
                        />
                      </div>
                    );
                  })}
                </Virtualizer>
              )
            ) : (
              <div className="h-full overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                      diffWordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <AlertDialog
        open={pendingDiscardDiffFile !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDiscardDiffFile(null);
          }
        }}
      >
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDiscardDiffFile
                ? `Discard unstaged changes to ${pendingDiscardDiffFile.filePath}. Staged changes will be preserved.${pendingDiscardDiffFile.isUntracked ? " Untracked files will be deleted." : ""} This cannot be undone.`
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
              onClick={runDiscardDiffFile}
            >
              Discard
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </DiffPanelShell>
  );
}

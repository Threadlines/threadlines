import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata, Virtualizer } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { TurnId } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  PilcrowIcon,
  Rows3Icon,
  TextWrapIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openInPreferredEditor } from "../editorPreferences";
import { gitWorkingTreeDiffQueryOptions } from "~/lib/gitReactQuery";
import { useGitStatus } from "~/lib/gitStatusState";
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
import { useSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { SourceControlIcon } from "./Icons";
import { Button } from "./ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { ToggleGroup, Toggle } from "./ui/toggle-group";

type DiffRenderMode = "stacked" | "split";
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

interface DiffPanelProps {
  mode?: DiffPanelMode;
  showBackToSourceControl?: boolean;
  onBackToSourceControl?: () => void;
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({
  mode = "inline",
  showBackToSourceControl = false,
  onBackToSourceControl,
}: DiffPanelProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const settings = useSettings();
  const [diffRenderMode, setDiffRenderMode] = useState<DiffRenderMode>("stacked");
  const [diffWordWrap, setDiffWordWrap] = useState(settings.diffWordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [collapsedDiffFileKeys, setCollapsedDiffFileKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const patchViewportRef = useRef<HTMLDivElement>(null);
  const previousDiffOpenRef = useRef(false);
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
  const diffMode = diffSearch.diffMode === "workingTree" ? "workingTree" : "checkpoint";
  const selectedFilePath = diffSearch.diffFilePath ?? null;
  const selectedTurn =
    diffMode === "workingTree" || selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
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
      !selectedTurn && typeof conversationCheckpointTurnCount === "number"
        ? {
            fromTurnCount: 0,
            toTurnCount: conversationCheckpointTurnCount,
          }
        : null,
    [conversationCheckpointTurnCount, selectedTurn],
  );
  const activeCheckpointRange = selectedTurn
    ? selectedCheckpointRange
    : conversationCheckpointRange;
  const conversationCacheScope = useMemo(() => {
    if (selectedTurn || orderedTurnDiffSummaries.length === 0) {
      return null;
    }
    return `conversation:${orderedTurnDiffSummaries.map((summary) => summary.turnId).join(",")}`;
  }, [orderedTurnDiffSummaries, selectedTurn]);
  const activeCheckpointDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: activeCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: activeCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      rangeKind: selectedTurn ? "turn" : "fullThread",
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : conversationCacheScope,
      enabled: isGitRepo && diffMode === "checkpoint",
    }),
  );
  const workingTreeDiffQuery = useQuery(
    gitWorkingTreeDiffQueryOptions({
      environmentId: activeEnvironmentId,
      cwd: activeCwd ?? null,
      filePaths: selectedFilePath ? [selectedFilePath] : null,
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

  useEffect(() => {
    if (renderableFiles.length === 0) {
      setCollapsedDiffFileKeys((current) => (current.size === 0 ? current : new Set()));
      return;
    }

    const visibleFileKeys = new Set(renderableFiles.map(buildFileDiffRenderKey));
    setCollapsedDiffFileKeys((current) => {
      const next = new Set([...current].filter((fileKey) => visibleFileKeys.has(fileKey)));
      return next.size === current.size ? current : next;
    });
  }, [renderableFiles]);

  useEffect(() => {
    if (diffOpen && !previousDiffOpenRef.current) {
      setDiffWordWrap(settings.diffWordWrap);
      setDiffIgnoreWhitespace(settings.diffIgnoreWhitespace);
    }
    previousDiffOpenRef.current = diffOpen;
  }, [diffOpen, settings.diffIgnoreWhitespace, settings.diffWordWrap]);

  useEffect(() => {
    if (!selectedFilePath || !patchViewportRef.current) {
      return;
    }
    const target = Array.from(
      patchViewportRef.current.querySelectorAll<HTMLElement>("[data-diff-file-path]"),
    ).find((element) => element.dataset.diffFilePath === selectedFilePath);
    target?.scrollIntoView({ block: "nearest" });
  }, [selectedFilePath, renderableFiles]);

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
  const toggleDiffFileCollapsed = useCallback((fileKey: string) => {
    setCollapsedDiffFileKeys((current) => {
      const next = new Set(current);
      if (next.has(fileKey)) {
        next.delete(fileKey);
      } else {
        next.add(fileKey);
      }
      return next;
    });
  }, []);

  const selectTurn = (turnId: TurnId) => {
    if (!activeThread) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
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
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return { ...rest, diff: "1", diffMode: "workingTree" };
      },
    });
  };
  const selectedDiffSourceLabel =
    diffMode === "workingTree"
      ? "Working tree"
      : selectedTurn
        ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
        : "All agent turns";
  const selectedDiffSourceDescription =
    diffMode === "workingTree"
      ? "Current uncommitted Git changes"
      : selectedTurn
        ? formatShortTimestamp(selectedTurn.completedAt, settings.timestampFormat)
        : "All checkpointed changes from this chat";

  const headerRow = (
    <>
      {showBackToSourceControl && onBackToSourceControl ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0 gap-0.5 px-1.5 [-webkit-app-region:no-drag]"
          aria-label="Back to source control panel"
          title="Back to source control"
          onClick={onBackToSourceControl}
        >
          <ChevronLeftIcon className="size-3" />
          <SourceControlIcon className="size-3" />
        </Button>
      ) : null}
      <div className="min-w-0 flex-1 [-webkit-app-region:no-drag]">
        <div className="truncate text-xs font-medium text-foreground">Diff</div>
        <div className="truncate text-[10px] text-muted-foreground/70">Review changes</div>
      </div>
    </>
  );

  const toolbarRow = (
    <div className="@container/diff-toolbar border-b border-border px-2 py-2">
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
                <MenuRadioItem value="workingTree">Working tree</MenuRadioItem>
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
                      return (
                        <MenuRadioItem key={summary.turnId} value={`turn:${summary.turnId}`}>
                          <span className="min-w-0 truncate">
                            Turn {turnCount} -{" "}
                            {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
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
          <ToggleGroup
            className="shrink-0"
            variant="outline"
            size="xs"
            value={[diffRenderMode]}
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
    </div>
  );

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {toolbarRow}
      {!activeThread && !hasWorkingTreeDiffContext ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : diffMode !== "workingTree" && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div
            ref={patchViewportRef}
            className="diff-panel-viewport min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            {diffMode === "checkpoint" && checkpointDiffError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-red-500/80">{checkpointDiffError}</p>
              </div>
            )}
            {diffMode === "workingTree" && workingTreeDiffError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-red-500/80">{workingTreeDiffError}</p>
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
                        ? "No working tree changes in this selection."
                        : "No net changes in this selection."
                      : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : renderablePatch.kind === "files" ? (
              <Virtualizer
                className="diff-render-surface h-full min-h-0 overflow-auto px-2 pb-2"
                config={{
                  overscrollSize: 600,
                  intersectionObserverMargin: 1200,
                }}
              >
                {renderableFiles.map((fileDiff) => {
                  const filePath = resolveFileDiffPath(fileDiff);
                  const fileKey = buildFileDiffRenderKey(fileDiff);
                  const themedFileKey = `${fileKey}:${resolvedTheme}`;
                  const collapsed = collapsedDiffFileKeys.has(fileKey);
                  return (
                    <div
                      key={themedFileKey}
                      data-diff-file-path={filePath}
                      className="diff-render-file group/diff-file mb-2 rounded-md first:mt-2 last:mb-0"
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
                        options={{
                          collapsed,
                          diffStyle: diffRenderMode === "split" ? "split" : "unified",
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
        </>
      )}
    </DiffPanelShell>
  );
}

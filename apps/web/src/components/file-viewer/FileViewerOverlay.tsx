import type { SelectedLineRange } from "@pierre/diffs";
import { File as PierreFile } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import type { ProjectEntry, ScopedThreadRef, ProjectTextFileContent } from "@threadlines/contracts";
import {
  ChevronDown,
  ChevronRight,
  FileImage,
  FileWarning,
  FileX,
  FolderTree,
  MessageSquarePlus,
  SearchIcon,
  SquareArrowOutUpRight,
  TextWrapIcon,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readLocalApi } from "../../localApi";
import { cn } from "~/lib/utils";
import { openInPreferredEditor } from "../../editorPreferences";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useFileViewerStore, type FileViewerContext } from "../../fileViewerStore";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import type { RevealLineNotice } from "./FileViewerOverlay.logic";
import {
  countRenderableTextLines,
  findRenderedPierreLineElement,
  formatRevealLineNoticeLabel,
  formatSelectedLineRangeLabel,
  resolveCoarseLineSelection,
  resolveRevealLineTarget,
} from "./FileViewerOverlay.logic";
import { formatFileSelectionLineRange, sliceFileSelection } from "../../lib/fileSelectionContext";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { DIFF_PANEL_UNSAFE_CSS } from "../DiffPanel.styles";

/**
 * Diff-panel tones plus hover affordances for selectable lines. Pierre marks
 * the hovered row's cells with `data-hovered` (it does not use CSS :hover)
 * and rows paint through the `--diffs-line-bg` variable; plain file lines
 * ship with no hovered rule, so we supply one.
 */
const FILE_VIEWER_UNSAFE_CSS = `${DIFF_PANEL_UNSAFE_CSS}
@media (pointer: fine) {
  /* Selected lines are excluded: pierre's own selected+hovered rule deepens
     the selection tint instead, so hovering never erases the blue. */
  [data-file]
    [data-hovered]:is([data-line], [data-column-number], [data-gutter-buffer]):not(
      [data-selected-line]
    ) {
    --diffs-line-bg: color-mix(in lab, var(--diffs-bg) 82%, var(--diffs-mixer)) !important;
  }
}
[data-file] [data-column-number] {
  cursor: pointer;
}
/* Line numbers are the selection control: brighten the hovered number and
   ease background changes so hover and selection read as one motion. */
[data-file] [data-column-number][data-hovered]:not([data-selected-line]) {
  color: var(--diffs-fg) !important;
}
[data-file] :is([data-line], [data-column-number]) {
  transition: background-color 100ms ease-out, color 100ms ease-out;
}
`;
import {
  projectListEntriesQueryOptions,
  projectReadFileQueryOptions,
  projectSearchEntriesQueryOptions,
} from "../../lib/projectReactQuery";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle } from "../ui/toggle";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { TooltipWrapper } from "../ui/tooltip";

interface FileTreeNode {
  entry: ProjectEntry;
  children: FileTreeNode[];
}

function buildFileTree(entries: ReadonlyArray<ProjectEntry>): FileTreeNode[] {
  const nodesByPath = new Map<string, FileTreeNode>();
  for (const entry of entries) {
    nodesByPath.set(entry.path, { entry, children: [] });
  }
  const roots: FileTreeNode[] = [];
  for (const node of nodesByPath.values()) {
    const parent = node.entry.parentPath ? nodesByPath.get(node.entry.parentPath) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.entry.kind !== right.entry.kind) {
        return left.entry.kind === "directory" ? -1 : 1;
      }
      return left.entry.path.localeCompare(right.entry.path);
    });
    for (const node of nodes) {
      sortNodes(node.children);
    }
  };
  sortNodes(roots);
  return roots;
}

function basenameOf(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function ancestorsOf(path: string): string[] {
  const segments = path.split("/");
  const ancestors: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }
  return ancestors;
}

function scrollElementToContainerCenter(container: HTMLElement, element: HTMLElement): void {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const targetTop =
    elementRect.top - containerRect.top + container.scrollTop - container.clientHeight / 2;
  container.scrollTop = Math.max(0, targetTop + elementRect.height / 2);
}

const TreeRow = memo(function TreeRow({
  node,
  depth,
  expandedPaths,
  activePath,
  theme,
  onToggleDirectory,
  onOpenFile,
}: {
  node: FileTreeNode;
  depth: number;
  expandedPaths: ReadonlySet<string>;
  activePath: string | null;
  theme: "light" | "dark";
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const isDirectory = node.entry.kind === "directory";
  const isExpanded = isDirectory && expandedPaths.has(node.entry.path);
  const isActive = node.entry.path === activePath;
  return (
    <>
      <button
        type="button"
        className={cn(
          "flex w-full cursor-pointer items-center gap-1.5 rounded-sm border-0 bg-transparent py-1 pr-2 text-left text-xs text-foreground/85 transition-colors hover:bg-foreground/8 pointer-coarse:py-2 pointer-coarse:text-sm",
          isActive && "bg-foreground/10 text-foreground",
        )}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() =>
          isDirectory ? onToggleDirectory(node.entry.path) : onOpenFile(node.entry.path)
        }
      >
        {isDirectory ? (
          isExpanded ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground/70" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground/70" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <VscodeEntryIcon
          pathValue={node.entry.path}
          kind={node.entry.kind}
          theme={theme}
          className="size-3.5 shrink-0"
        />
        <span className="truncate">{basenameOf(node.entry.path)}</span>
      </button>
      {isDirectory && isExpanded
        ? node.children.map((child) => (
            <TreeRow
              key={child.entry.path}
              node={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              activePath={activePath}
              theme={theme}
              onToggleDirectory={onToggleDirectory}
              onOpenFile={onOpenFile}
            />
          ))
        : null}
    </>
  );
});

const FILE_VIEWER_SEARCH_LIMIT = 60;

function FileViewerTree({
  context,
  onFileOpened,
}: {
  context: FileViewerContext;
  /** Fires on every file open, including re-opening the already-active file. */
  onFileOpened?: () => void;
}) {
  const activePath = useFileViewerStore((state) => state.activePath);
  const storeOpenFile = useFileViewerStore((state) => state.openFile);
  const { resolvedTheme } = useTheme();
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const entriesQuery = useQuery(
    projectListEntriesQueryOptions({
      environmentId: context.environmentId,
      cwd: context.cwd,
    }),
  );
  const searchQuery = useQuery(
    projectSearchEntriesQueryOptions({
      environmentId: context.environmentId,
      cwd: context.cwd,
      query: trimmedQuery,
      limit: FILE_VIEWER_SEARCH_LIMIT,
    }),
  );
  const tree = useMemo(() => buildFileTree(entriesQuery.data?.entries ?? []), [entriesQuery.data]);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(new Set());

  const openFile = useCallback(
    (path: string) => {
      storeOpenFile(path);
      onFileOpened?.();
    },
    [onFileOpened, storeOpenFile],
  );

  const expandPathWithAncestors = useCallback((path: string) => {
    setExpandedPaths((previous) => {
      const targets = [...ancestorsOf(path), path];
      if (targets.every((target) => previous.has(target))) {
        return previous;
      }
      const next = new Set(previous);
      for (const target of targets) {
        next.add(target);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!activePath) {
      return;
    }
    setExpandedPaths((previous) => {
      const ancestors = ancestorsOf(activePath);
      if (ancestors.every((ancestor) => previous.has(ancestor))) {
        return previous;
      }
      const next = new Set(previous);
      for (const ancestor of ancestors) {
        next.add(ancestor);
      }
      return next;
    });
  }, [activePath]);

  const handleToggleDirectory = useCallback((path: string) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleOpenSearchResult = useCallback(
    (entry: ProjectEntry) => {
      if (entry.kind === "file") {
        openFile(entry.path);
      } else {
        expandPathWithAncestors(entry.path);
      }
      setQuery("");
    },
    [expandPathWithAncestors, openFile],
  );

  const isSearching = trimmedQuery.length > 0;
  const searchResults = searchQuery.data?.entries ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 p-2">
        <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1 transition-colors focus-within:border-border">
          <SearchIcon className="size-3 shrink-0 text-muted-foreground/60" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && trimmedQuery.length > 0) {
                event.stopPropagation();
                setQuery("");
              }
              if (event.key === "Enter" && searchResults[0]) {
                handleOpenSearchResult(searchResults[0]);
              }
            }}
            placeholder="Go to file..."
            spellCheck={false}
            // 16px on coarse pointers: iOS Safari force-zooms focused inputs
            // below that size, which jolts the whole dialog.
            className="w-full border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60 pointer-coarse:text-base"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1 pr-1">
        {isSearching ? (
          searchQuery.isPending ? (
            <p className="px-3 py-2 text-xs text-muted-foreground/75">Searching...</p>
          ) : searchResults.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground/75">
              No files match "{trimmedQuery}".
            </p>
          ) : (
            searchResults.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-sm border-0 bg-transparent px-2 py-1 text-left text-xs text-foreground/85 transition-colors hover:bg-foreground/8 pointer-coarse:py-2 pointer-coarse:text-sm"
                onClick={() => handleOpenSearchResult(entry)}
              >
                <VscodeEntryIcon
                  pathValue={entry.path}
                  kind={entry.kind}
                  theme={resolvedTheme}
                  className="size-3.5 shrink-0"
                />
                <span className="shrink-0">{basenameOf(entry.path)}</span>
                <span className="truncate text-muted-foreground/55">{entry.path}</span>
              </button>
            ))
          )
        ) : entriesQuery.isPending ? (
          <p className="px-3 py-2 text-xs text-muted-foreground/75">Loading project files...</p>
        ) : entriesQuery.isError ? (
          <p className="px-3 py-2 text-xs text-muted-foreground/75">
            Unable to list project files.
          </p>
        ) : (
          tree.map((node) => (
            <TreeRow
              key={node.entry.path}
              node={node}
              depth={0}
              expandedPaths={expandedPaths}
              activePath={activePath}
              theme={resolvedTheme}
              onToggleDirectory={handleToggleDirectory}
              onOpenFile={openFile}
            />
          ))
        )}
      </div>
      {entriesQuery.data?.truncated ? (
        <p className="border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground/70">
          File list truncated; use search to find files outside the indexed set.
        </p>
      ) : null}
    </div>
  );
}

function AddSelectionToChatFooter({
  threadRef,
  activePath,
  file,
  selectedLines,
  revealLineNotice,
}: {
  threadRef: ScopedThreadRef;
  activePath: string;
  file: ProjectTextFileContent;
  selectedLines: SelectedLineRange | null;
  revealLineNotice: RevealLineNotice | null;
}) {
  const addFileSelectionContext = useComposerDraftStore((state) => state.addFileSelectionContext);
  const close = useFileViewerStore((state) => state.close);
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const selectionCount = selectedLines ? Math.abs(selectedLines.end - selectedLines.start) + 1 : 0;
  const selectionLabel = selectedLines ? formatSelectedLineRangeLabel(selectedLines) : null;
  const revealLineNoticeLabel = revealLineNotice
    ? formatRevealLineNoticeLabel(revealLineNotice)
    : null;

  const handleAddToChat = useCallback(() => {
    const startLine = selectedLines ? Math.min(selectedLines.start, selectedLines.end) : 1;
    const endLine = selectedLines ? Math.max(selectedLines.start, selectedLines.end) : 1;
    // Attached as a composer chip (like images and terminal contexts). With a
    // selection the quoted lines are serialized at send time; without one the
    // whole file is attached as an `@path` mention the agent reads itself.
    addFileSelectionContext(threadRef, {
      id: crypto.randomUUID(),
      threadId: threadRef.threadId,
      createdAt: new Date().toISOString(),
      relativePath: activePath,
      startLine,
      endLine,
      selectedText: selectedLines ? sliceFileSelection(file.content, startLine, endLine) : "",
      ...(selectedLines ? {} : { wholeFile: true }),
    });
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Added to chat",
        description: selectedLines
          ? `${basenameOf(activePath)} ${formatFileSelectionLineRange({ startLine, endLine })}`
          : `${basenameOf(activePath)} (whole file)`,
      }),
    );
    close();
  }, [activePath, addFileSelectionContext, close, file.content, selectedLines, threadRef]);

  return (
    // Bottom padding tracks the home-indicator inset on notched phones, where
    // the sheet runs to the screen edge.
    <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 max-sm:pb-[max(0.375rem,env(safe-area-inset-bottom))]">
      <span
        className={cn(
          "text-[11px]",
          revealLineNoticeLabel ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/70",
        )}
      >
        {revealLineNoticeLabel ??
          (selectionLabel
            ? isCoarsePointer
              ? `${selectionLabel} — tap another line number to extend, tap the selection to clear.`
              : selectionLabel
            : isCoarsePointer
              ? "Tap a line number to select it, or attach the whole file as a reference."
              : "Click a line number to select (drag for a range), or attach the whole file as a reference.")}
      </span>
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-foreground/10"
        onClick={handleAddToChat}
      >
        <MessageSquarePlus className="size-3.5" />
        {selectionCount > 0 ? "Add selection to chat" : "Attach file to chat"}
      </button>
    </div>
  );
}

function FileViewerPreview({
  context,
  wordWrap,
}: {
  context: FileViewerContext;
  wordWrap: boolean;
}) {
  const activePath = useFileViewerStore((state) => state.activePath);
  const revealLine = useFileViewerStore((state) => state.revealLine);
  const revealEndLine = useFileViewerStore((state) => state.revealEndLine);
  const revealRequestId = useFileViewerStore((state) => state.revealRequestId);
  const { resolvedTheme } = useTheme();
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
  const [revealLineNotice, setRevealLineNotice] = useState<RevealLineNotice | null>(null);

  const fileQuery = useQuery(
    projectReadFileQueryOptions({
      environmentId: context.environmentId,
      cwd: context.cwd,
      relativePath: activePath,
    }),
  );
  const file = fileQuery.data;

  useEffect(() => {
    setSelectedLines(null);
    setRevealLineNotice(null);
  }, [activePath]);

  // Reveal a requested line once content is available: select it only when it
  // exists, ratio-scroll immediately for fast feedback, then snap to the exact
  // row once pierre's (async, worker-highlighted) DOM carries it.
  useEffect(() => {
    if (!revealLine || !file || file.kind !== "text") {
      setRevealLineNotice(null);
      return;
    }
    const totalLines = countRenderableTextLines(file.content);
    const revealTarget = resolveRevealLineTarget({
      line: revealLine,
      endLine: revealEndLine,
      totalLines,
    });
    setSelectedLines(revealTarget.selectedRange);
    setRevealLineNotice(revealTarget.notice);

    const container = scrollContainerRef.current;
    if (container) {
      const ratio = (revealTarget.scrollRange.start - 1) / totalLines;
      container.scrollTop = Math.max(
        0,
        container.scrollHeight * ratio - container.clientHeight / 2,
      );
    }

    // Pierre stamps rows inside a shadow root with a 0-based `data-line-index`.
    const findLineElement = () =>
      scrollContainerRef.current
        ? findRenderedPierreLineElement(
            scrollContainerRef.current,
            revealTarget.scrollRange.start - 1,
          )
        : null;
    const deadline = performance.now() + 2_500;
    let cancelled = false;
    const attemptPreciseScroll = () => {
      if (cancelled) {
        return;
      }
      const lineElement = findLineElement();
      if (lineElement) {
        const container = scrollContainerRef.current;
        if (container) {
          scrollElementToContainerCenter(container, lineElement);
        }
        return;
      }
      if (performance.now() < deadline) {
        timer = window.setTimeout(attemptPreciseScroll, 120);
      }
    };
    let timer = window.setTimeout(attemptPreciseScroll, 60);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [file, revealEndLine, revealLine, revealRequestId]);

  const pierreOptions = useMemo(
    () => ({
      disableFileHeader: true,
      overflow: wordWrap ? ("wrap" as const) : ("scroll" as const),
      theme: resolveDiffThemeName(resolvedTheme),
      themeType: resolvedTheme,
      // Same background overrides as the diff panel so files render on the
      // app's card tone instead of the pierre theme's pure black/white, plus
      // row-hover styling so selectable lines read as interactive.
      unsafeCSS: FILE_VIEWER_UNSAFE_CSS,
      enableLineSelection: true,
      // Hover stamping (`data-hovered`) is opt-in; line numbers are the
      // selection affordance (GitHub-style), no gutter utility.
      lineHoverHighlight: "both" as const,
      onLineSelected: (range: SelectedLineRange | null) => {
        setRevealLineNotice(null);
        setSelectedLines((previous) =>
          isCoarsePointer ? resolveCoarseLineSelection(previous, range) : range,
        );
      },
    }),
    [isCoarsePointer, resolvedTheme, wordWrap],
  );

  if (!activePath) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground/70">
        Select a file to preview it.
      </div>
    );
  }

  if (fileQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground/70">
        Loading {basenameOf(activePath)}...
      </div>
    );
  }

  if (fileQuery.isError || !file) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground/75">
        <FileWarning className="size-5" />
        Unable to read {basenameOf(activePath)}.
      </div>
    );
  }

  if (file.kind === "missing") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center text-sm text-muted-foreground/75">
        <FileX className="mb-0.5 size-5" />
        <p>{`${basenameOf(activePath)} doesn't exist in this project.`}</p>
        <p className="text-xs text-muted-foreground/55">
          It may have been deleted or renamed since it was referenced.
        </p>
      </div>
    );
  }

  if (file.kind === "image") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-6">
        <img
          src={`data:${file.mimeType};base64,${file.base64}`}
          alt={basenameOf(activePath)}
          className="max-h-full max-w-full rounded-md border border-border/60 object-contain"
        />
      </div>
    );
  }

  if (file.kind === "binary") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground/75">
        <FileImage className="size-5" />
        <p>
          {basenameOf(activePath)} is a binary file ({Math.ceil(file.size / 1024)} KB).
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {file.truncated ? (
        <p className="border-b border-border/60 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          Large file: showing the first {Math.ceil(file.content.length / 1024)} KB of{" "}
          {Math.ceil(file.size / 1024)} KB, read-only.
        </p>
      ) : null}
      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-auto [background:color-mix(in_srgb,var(--card)_90%,var(--background))]"
      >
        {/* Keyed per file: the wrapper only force-renders on options changes,
            so in-place file switches would paint stale/blank content. */}
        <PierreFile
          key={`${context.cwd}:${activePath}`}
          file={{
            name: activePath,
            contents: file.content,
            cacheKey: `${context.cwd}:${activePath}:${file.size}`,
          }}
          selectedLines={selectedLines}
          options={pierreOptions}
        />
      </div>
      {context.threadRef ? (
        <AddSelectionToChatFooter
          threadRef={context.threadRef}
          activePath={activePath}
          file={file}
          selectedLines={selectedLines}
          revealLineNotice={revealLineNotice}
        />
      ) : null}
    </div>
  );
}

function FileViewerTabs({
  context,
  onTabSelected,
}: {
  context: FileViewerContext;
  /** Fires on every tab click, including re-selecting the active tab. */
  onTabSelected?: () => void;
}) {
  const tabs = useFileViewerStore((state) => state.tabs);
  const activePath = useFileViewerStore((state) => state.activePath);
  const setActivePath = useFileViewerStore((state) => state.setActivePath);
  const closeTab = useFileViewerStore((state) => state.closeTab);
  const closeOtherTabs = useFileViewerStore((state) => state.closeOtherTabs);
  const closeAllTabs = useFileViewerStore((state) => state.closeAllTabs);

  const handleTabContextMenu = useCallback(
    (event: React.MouseEvent, tab: string) => {
      event.preventDefault();
      const api = readLocalApi();
      if (!api) {
        return;
      }
      const position = { x: event.clientX, y: event.clientY };
      void (async () => {
        const clicked = await api.contextMenu.show(
          [
            { id: "close", label: "Close" },
            { id: "close-others", label: "Close others", disabled: tabs.length <= 1 },
            { id: "close-all", label: "Close all" },
            { id: "open-external", label: "Open in external editor" },
            { id: "copy-path", label: "Copy relative path" },
          ] as const,
          position,
        );
        if (clicked === "close") {
          closeTab(tab);
        } else if (clicked === "close-others") {
          closeOtherTabs(tab);
        } else if (clicked === "close-all") {
          closeAllTabs();
        } else if (clicked === "open-external") {
          const absolutePath = `${context.cwd.replace(/[/\\]+$/, "")}/${tab}`;
          void openInPreferredEditor(api, absolutePath).catch(() => undefined);
        } else if (clicked === "copy-path") {
          void navigator.clipboard?.writeText(tab).then(() => {
            toastManager.add({ type: "success", title: "Path copied", description: tab });
          });
        }
      })();
    },
    [closeAllTabs, closeOtherTabs, closeTab, context.cwd, tabs.length],
  );

  const handleOpenExternally = useCallback(() => {
    if (!activePath) {
      return;
    }
    const api = readLocalApi();
    if (!api) {
      return;
    }
    const absolutePath = `${context.cwd.replace(/[/\\]+$/, "")}/${activePath}`;
    void openInPreferredEditor(api, absolutePath).catch((error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file externally",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
  }, [activePath, context.cwd]);

  return (
    // ScrollArea gives overflow discoverability without geometry changes:
    // edge mask-fades appear only on sides with hidden tabs, and the overlay
    // scrollbar fades in on hover/scroll without occupying layout height.
    <ScrollArea
      scrollFade
      className="min-w-0 flex-1 self-stretch [&_[data-slot=scroll-area-scrollbar][data-orientation=horizontal]]:mx-1 [&_[data-slot=scroll-area-scrollbar][data-orientation=horizontal]]:my-0.5 [&_[data-slot=scroll-area-scrollbar][data-orientation=horizontal]]:h-1 [&_[data-slot=scroll-area-scrollbar][data-orientation=horizontal]]:opacity-100"
    >
      <div className="flex h-full items-center gap-1">
        {tabs.map((tab) => (
          <div
            key={tab}
            className={cn(
              "flex shrink-0 items-center gap-0.5 rounded-md border border-transparent py-0.5 pl-2 pr-0.5 text-xs text-muted-foreground/80 transition-colors hover:bg-foreground/8",
              tab === activePath && "border-border/70 bg-foreground/8 text-foreground",
            )}
            onContextMenu={(event) => handleTabContextMenu(event, tab)}
          >
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 py-0.5 text-inherit pointer-coarse:py-1.5"
              onClick={() => {
                setActivePath(tab);
                onTabSelected?.();
              }}
            >
              {basenameOf(tab)}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab}`}
              className={cn(
                "inline-flex cursor-pointer items-center rounded-sm border-0 bg-transparent p-1 text-muted-foreground/45 transition-colors hover:bg-foreground/10 hover:text-foreground pointer-coarse:p-2",
                tab !== activePath && "text-muted-foreground/30",
              )}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab);
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        {activePath ? (
          <TooltipWrapper tooltip="Open in external editor">
            <button
              type="button"
              aria-label="Open in external editor"
              className="ml-1 inline-flex shrink-0 cursor-pointer items-center rounded-sm border-0 bg-transparent p-1 text-muted-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground pointer-coarse:p-2"
              onClick={handleOpenExternally}
            >
              <SquareArrowOutUpRight className="size-3.5" />
            </button>
          </TooltipWrapper>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function FileViewerLayout({ context }: { context: FileViewerContext }) {
  const activePath = useFileViewerStore((state) => state.activePath);
  const close = useFileViewerStore((state) => state.close);
  const isCoarsePointer = useMediaQuery({ pointer: "coarse" });
  // Persisted preference: the toggle writes straight to settings (optimistic
  // local apply + fire-and-forget RPC), so it sticks until toggled again.
  // Coarse pointers instead default to wrap and toggle a session-scoped
  // override, so a phone never rewrites the shared desktop preference.
  const wordWrapSetting = useSettings((settings) => settings.fileViewerWordWrap);
  const coarsePointerWordWrap = useFileViewerStore((state) => state.coarsePointerWordWrap);
  const setCoarsePointerWordWrap = useFileViewerStore((state) => state.setCoarsePointerWordWrap);
  const { updateSettings } = useUpdateSettings();
  const wordWrap = isCoarsePointer ? (coarsePointerWordWrap ?? true) : wordWrapSetting;

  // Below the `sm` breakpoint the tree and preview share the screen one at a
  // time (a 256px tree beside code is unusable on a phone); every file-open
  // interaction lands on the preview, and the header's tree button goes back.
  // Desktop ignores this state entirely — both panes stay visible.
  const [mobilePane, setMobilePane] = useState<"tree" | "preview">(activePath ? "preview" : "tree");
  const showPreviewPane = useCallback(() => setMobilePane("preview"), []);
  useEffect(() => {
    setMobilePane(activePath ? "preview" : "tree");
  }, [activePath]);

  return (
    <>
      {/* Fixed-height header so it doesn't collapse when no tabs are
          open, with an inline close button that centers with the row. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        {mobilePane === "preview" ? (
          <button
            type="button"
            aria-label="Show project files"
            className="inline-flex shrink-0 cursor-pointer items-center rounded-md border-0 bg-transparent p-1.5 text-muted-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground pointer-coarse:p-2.5 sm:hidden"
            onClick={() => setMobilePane("tree")}
          >
            <FolderTree className="size-4" />
          </button>
        ) : null}
        <FileViewerTabs context={context} onTabSelected={showPreviewPane} />
        {activePath ? (
          <Toggle
            aria-label={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
            tooltip={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
            variant="outline"
            size="xs"
            className="shrink-0"
            pressed={wordWrap}
            onPressedChange={(pressed) => {
              if (isCoarsePointer) {
                setCoarsePointerWordWrap(Boolean(pressed));
              } else {
                updateSettings({ fileViewerWordWrap: Boolean(pressed) });
              }
            }}
          >
            <TextWrapIcon className="size-3" />
          </Toggle>
        ) : null}
        {activePath ? (
          <span className="max-w-[36ch] shrink-0 truncate text-[11px] text-muted-foreground/60 max-sm:hidden">
            {activePath}
          </span>
        ) : null}
        <button
          type="button"
          aria-label="Close file viewer"
          className="inline-flex shrink-0 cursor-pointer items-center rounded-md border-0 bg-transparent p-1.5 text-muted-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground pointer-coarse:p-2.5"
          onClick={close}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "w-64 shrink-0 border-r border-border/60 max-sm:w-full max-sm:border-r-0",
            mobilePane === "preview" && "max-sm:hidden",
          )}
        >
          <FileViewerTree context={context} onFileOpened={showPreviewPane} />
        </div>
        <div className={cn("min-w-0 flex-1", mobilePane === "tree" && "max-sm:hidden")}>
          <FileViewerPreview context={context} wordWrap={wordWrap} />
        </div>
      </div>
    </>
  );
}

export default function FileViewerOverlay() {
  const isOpen = useFileViewerStore((state) => state.isOpen);
  const context = useFileViewerStore((state) => state.context);
  const close = useFileViewerStore((state) => state.close);

  if (!context) {
    return null;
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          close();
        }
      }}
    >
      {/* Desktop sizes are `sm:`-scoped so the popup's bottom-sheet mobile
          styling wins below that: a full-width sheet filling the viewport
          under the 3rem (pt-12) backdrop reveal. */}
      <DialogPopup
        showCloseButton={false}
        className="flex h-[calc(100dvh-3rem)] flex-col gap-0 overflow-hidden p-0 sm:h-[86vh] sm:w-[calc(100vw-4rem)] sm:max-w-[1400px]"
      >
        <DialogTitle className="sr-only">Project files</DialogTitle>
        <DiffWorkerPoolProvider>
          <FileViewerLayout context={context} />
        </DiffWorkerPoolProvider>
      </DialogPopup>
    </Dialog>
  );
}

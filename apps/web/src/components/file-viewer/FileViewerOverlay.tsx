import type { SelectedLineRange } from "@pierre/diffs";
import { File as PierreFile } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import type { ProjectEntry, ScopedThreadRef, ProjectTextFileContent } from "@threadlines/contracts";
import {
  ChevronDown,
  ChevronRight,
  FileImage,
  FileWarning,
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
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
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
          "flex w-full cursor-pointer items-center gap-1.5 rounded-sm border-0 bg-transparent py-1 pr-2 text-left text-xs text-foreground/85 transition-colors hover:bg-foreground/8",
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

function FileViewerTree({ context }: { context: FileViewerContext }) {
  const activePath = useFileViewerStore((state) => state.activePath);
  const openFile = useFileViewerStore((state) => state.openFile);
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
            className="w-full border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
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
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-sm border-0 bg-transparent px-2 py-1 text-left text-xs text-foreground/85 transition-colors hover:bg-foreground/8"
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
}: {
  threadRef: ScopedThreadRef;
  activePath: string;
  file: ProjectTextFileContent;
  selectedLines: SelectedLineRange | null;
}) {
  const addFileSelectionContext = useComposerDraftStore((state) => state.addFileSelectionContext);
  const close = useFileViewerStore((state) => state.close);
  const selectionCount = selectedLines ? Math.abs(selectedLines.end - selectedLines.start) + 1 : 0;

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
    <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5">
      <span className="text-[11px] text-muted-foreground/70">
        {selectionCount > 0
          ? `${selectionCount} line${selectionCount === 1 ? "" : "s"} selected`
          : "Click a line number to select (drag for a range), or attach the whole file as a reference."}
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
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);

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
  }, [activePath]);

  // Reveal a requested line once content is available: highlight it via the
  // selection, ratio-scroll immediately for fast feedback, then snap to the
  // exact row once pierre's (async, worker-highlighted) DOM carries it.
  useEffect(() => {
    if (!revealLine || !file || file.kind !== "text") {
      return;
    }
    const totalLines = Math.max(1, file.content.split("\n").length);
    const clampedLine = Math.min(Math.max(1, revealLine), totalLines);
    const clampedEndLine = revealEndLine
      ? Math.min(Math.max(clampedLine, revealEndLine), totalLines)
      : clampedLine;
    setSelectedLines({ start: clampedLine, end: clampedEndLine });

    const container = scrollContainerRef.current;
    if (container) {
      const ratio = (clampedLine - 1) / totalLines;
      container.scrollTop = Math.max(
        0,
        container.scrollHeight * ratio - container.clientHeight / 2,
      );
    }

    // Pierre stamps rows with a 0-based `data-line-index`.
    const findLineElement = () =>
      scrollContainerRef.current?.querySelector(`[data-line-index="${clampedLine - 1}"]`) ?? null;
    const deadline = performance.now() + 2_500;
    let cancelled = false;
    const attemptPreciseScroll = () => {
      if (cancelled) {
        return;
      }
      const lineElement = findLineElement();
      if (lineElement) {
        lineElement.scrollIntoView({ block: "center" });
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
        setSelectedLines(range);
      },
    }),
    [resolvedTheme, wordWrap],
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
        />
      ) : null}
    </div>
  );
}

function FileViewerTabs({ context }: { context: FileViewerContext }) {
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
              className="cursor-pointer border-0 bg-transparent p-0 py-0.5 text-inherit"
              onClick={() => setActivePath(tab)}
            >
              {basenameOf(tab)}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab}`}
              className={cn(
                "inline-flex cursor-pointer items-center rounded-sm border-0 bg-transparent p-1 text-muted-foreground/45 transition-colors hover:bg-foreground/10 hover:text-foreground",
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
              className="ml-1 inline-flex shrink-0 cursor-pointer items-center rounded-sm border-0 bg-transparent p-1 text-muted-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground"
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

export default function FileViewerOverlay() {
  const isOpen = useFileViewerStore((state) => state.isOpen);
  const context = useFileViewerStore((state) => state.context);
  const activePath = useFileViewerStore((state) => state.activePath);
  const close = useFileViewerStore((state) => state.close);
  // Persisted preference: the toggle writes straight to settings (optimistic
  // local apply + fire-and-forget RPC), so it sticks until toggled again.
  const wordWrap = useSettings((settings) => settings.fileViewerWordWrap);
  const { updateSettings } = useUpdateSettings();

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
      <DialogPopup
        showCloseButton={false}
        className="flex h-[86vh] w-[calc(100vw-4rem)] max-w-[1400px] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">Project files</DialogTitle>
        <DiffWorkerPoolProvider>
          {/* Fixed-height header so it doesn't collapse when no tabs are
              open, with an inline close button that centers with the row. */}
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            <FileViewerTabs context={context} />
            {activePath ? (
              <Toggle
                aria-label={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
                tooltip={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
                variant="outline"
                size="xs"
                className="shrink-0"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  updateSettings({ fileViewerWordWrap: Boolean(pressed) });
                }}
              >
                <TextWrapIcon className="size-3" />
              </Toggle>
            ) : null}
            {activePath ? (
              <span className="max-w-[36ch] shrink-0 truncate text-[11px] text-muted-foreground/60">
                {activePath}
              </span>
            ) : null}
            <button
              type="button"
              aria-label="Close file viewer"
              className="inline-flex shrink-0 cursor-pointer items-center rounded-md border-0 bg-transparent p-1.5 text-muted-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground"
              onClick={close}
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="w-64 shrink-0 border-r border-border/60">
              <FileViewerTree context={context} />
            </div>
            <div className="min-w-0 flex-1">
              <FileViewerPreview context={context} wordWrap={wordWrap} />
            </div>
          </div>
        </DiffWorkerPoolProvider>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * File viewer overlay state.
 *
 * The internal file viewer is a large overlay that browses and previews
 * project files without leaving Threadlines. It is the default destination
 * for file-opening interactions (chat file chips, diff-panel files, the
 * terminal-adjacent entry point); `openFileInViewer` is the single routing
 * helper those call sites share so file-reference handling is not duplicated.
 */
import { create } from "zustand";

import type { EnvironmentId, ScopedThreadRef } from "@threadlines/contracts";
import { isWindowsAbsolutePath } from "@threadlines/shared/path";

export interface FileViewerContext {
  environmentId: EnvironmentId;
  /** Workspace root (or worktree path) that relative file paths resolve against. */
  cwd: string;
  /** Thread whose composer receives "add to chat" selections, when available. */
  threadRef: ScopedThreadRef | null;
}

interface FileViewerState {
  isOpen: boolean;
  context: FileViewerContext | null;
  /** Open files, in tab order. Paths are workspace-relative. */
  tabs: string[];
  activePath: string | null;
  /** 1-based line to reveal in the active file. */
  revealLine: number | null;
  /** Optional inclusive end of the reveal range (selection restore). */
  revealEndLine: number | null;
  /** Bumped on every reveal request so re-opening the same line re-scrolls. */
  revealRequestId: number;
  /**
   * Word-wrap override for coarse pointers, where wrap defaults on (panning
   * code sideways on a phone is worse than wrapping). Session-scoped on
   * purpose: the persisted `fileViewerWordWrap` setting is shared across
   * devices, so a phone toggling wrap must not clobber the desktop choice.
   */
  coarsePointerWordWrap: boolean | null;
  setCoarsePointerWordWrap: (wrap: boolean) => void;
  open: (
    context: FileViewerContext,
    target?: { path: string; line?: number; endLine?: number },
  ) => void;
  openFile: (path: string, line?: number, endLine?: number) => void;
  setActivePath: (path: string) => void;
  closeTab: (path: string) => void;
  closeOtherTabs: (path: string) => void;
  closeAllTabs: () => void;
  close: () => void;
}

/** Open-tab cap: the leftmost non-active tab is evicted FIFO beyond this. */
const MAX_OPEN_TABS = 10;

function withTabCap(tabs: string[], activePath: string | null): string[] {
  if (tabs.length <= MAX_OPEN_TABS) {
    return tabs;
  }
  const evictable = tabs.find((tab) => tab !== activePath);
  return evictable ? tabs.filter((tab) => tab !== evictable) : tabs;
}

export const useFileViewerStore = create<FileViewerState>((set) => ({
  isOpen: false,
  context: null,
  tabs: [],
  activePath: null,
  revealLine: null,
  revealEndLine: null,
  revealRequestId: 0,
  coarsePointerWordWrap: null,

  setCoarsePointerWordWrap: (wrap) => set({ coarsePointerWordWrap: wrap }),

  open: (context, target) =>
    set((state) => {
      const sameWorkspace =
        state.context?.environmentId === context.environmentId && state.context.cwd === context.cwd;
      const tabs = sameWorkspace ? [...state.tabs] : [];
      let activePath = sameWorkspace ? state.activePath : null;
      if (target) {
        if (!tabs.includes(target.path)) {
          tabs.push(target.path);
        }
        activePath = target.path;
      }
      const nextActivePath = activePath ?? tabs[0] ?? null;
      return {
        isOpen: true,
        context,
        tabs: withTabCap(tabs, nextActivePath),
        activePath: nextActivePath,
        revealLine: target?.line ?? null,
        revealEndLine: target?.endLine ?? null,
        revealRequestId: state.revealRequestId + 1,
      };
    }),

  openFile: (path, line, endLine) =>
    set((state) => ({
      tabs: withTabCap(state.tabs.includes(path) ? state.tabs : [...state.tabs, path], path),
      activePath: path,
      revealLine: line ?? null,
      revealEndLine: endLine ?? null,
      revealRequestId: state.revealRequestId + 1,
    })),

  setActivePath: (path) => set({ activePath: path, revealLine: null, revealEndLine: null }),

  closeTab: (path) =>
    set((state) => {
      const index = state.tabs.indexOf(path);
      const tabs = state.tabs.filter((tab) => tab !== path);
      const activePath =
        state.activePath === path
          ? (tabs[Math.min(index, tabs.length - 1)] ?? null)
          : state.activePath;
      return { tabs, activePath, revealLine: null };
    }),

  closeOtherTabs: (path) =>
    set((state) => ({
      tabs: state.tabs.includes(path) ? [path] : [],
      activePath: state.tabs.includes(path) ? path : null,
      revealLine: null,
      revealEndLine: null,
    })),

  closeAllTabs: () => set({ tabs: [], activePath: null, revealLine: null, revealEndLine: null }),

  close: () => set({ isOpen: false, revealLine: null }),
}));

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

/**
 * Convert an absolute path into a workspace-relative one, or return null when
 * the path lives outside the workspace root (those fall back to the external
 * editor — the server refuses reads outside the root).
 */
export function relativePathWithinCwd(targetPath: string, cwd: string): string | null {
  const normalizedTarget = toPosixPath(targetPath);
  const normalizedCwd = toPosixPath(cwd).replace(/\/+$/, "");
  if (normalizedTarget === normalizedCwd) {
    return null;
  }
  if (!normalizedTarget.startsWith(`${normalizedCwd}/`)) {
    return null;
  }
  const relativePath = normalizedTarget.slice(normalizedCwd.length + 1);
  return relativePath.length > 0 ? relativePath : null;
}

/**
 * Context registered by the active thread route so deeply nested call sites
 * (chat file chips, diff rows) can open the viewer without prop-drilling the
 * environment/workspace identity through every renderer.
 */
let activeFileViewerContext: FileViewerContext | null = null;

export function setActiveFileViewerContext(context: FileViewerContext | null): void {
  activeFileViewerContext = context;
}

export function getActiveFileViewerContext(): FileViewerContext | null {
  return activeFileViewerContext;
}

/**
 * Open the viewer on the registered workspace without targeting a file (the
 * browse entry point next to the terminal toggle). Returns false when no
 * workspace context is registered.
 */
export function openActiveFileViewer(): boolean {
  if (!activeFileViewerContext) {
    return false;
  }
  useFileViewerStore.getState().open(activeFileViewerContext);
  return true;
}

/**
 * Open a file in the viewer using the route-registered context. Returns false
 * when no context is registered or the path is outside the workspace; callers
 * fall back to the external editor.
 */
export function openFileInActiveViewer(input: {
  path: string;
  line?: number | undefined;
  endLine?: number | undefined;
}): boolean {
  if (!activeFileViewerContext) {
    return false;
  }
  return openFileInViewer({
    environmentId: activeFileViewerContext.environmentId,
    cwd: activeFileViewerContext.cwd,
    threadRef: activeFileViewerContext.threadRef,
    path: input.path,
    line: input.line,
    ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
  });
}

/**
 * Inline-code text that reads as a file reference: an optionally-pathed file
 * name with a letter-led extension and an optional `:line[:column]` suffix.
 * (`v0.1.0` and package names like `effect/Schema` deliberately do not match.)
 */
const CHAT_FILE_REFERENCE_PATTERN =
  /^(?<path>[\w.@~-]+(?:\/[\w.@~-]+)*\.[A-Za-z][A-Za-z0-9]{0,7})(?::(?<line>\d+)(?::\d+)?)?$/;

export function parseChatFileReference(
  text: string,
): { path: string; line: number | undefined } | null {
  const match = CHAT_FILE_REFERENCE_PATTERN.exec(text.trim());
  if (!match?.groups?.path) {
    return null;
  }
  const line = match.groups.line ? Number.parseInt(match.groups.line, 10) : undefined;
  return { path: match.groups.path, line };
}

/**
 * Open an inline-code file reference from the chat transcript.
 *
 * Pathed references open directly; bare file names are resolved through the
 * workspace search index (models frequently cite `ChatComposer.tsx:1010`
 * without the directory). Returns false when nothing could be opened.
 */
export async function openChatFileReference(text: string): Promise<boolean> {
  const parsed = parseChatFileReference(text);
  const context = activeFileViewerContext;
  if (!parsed || !context) {
    return false;
  }
  if (parsed.path.includes("/")) {
    return openFileInActiveViewer({ path: parsed.path, line: parsed.line });
  }

  const { ensureEnvironmentApi } = await import("./environmentApi");
  try {
    const api = ensureEnvironmentApi(context.environmentId);
    const result = await api.projects.searchEntries({
      cwd: context.cwd,
      query: parsed.path,
      limit: 8,
    });
    const basename = parsed.path.toLowerCase();
    const fileMatches = result.entries.filter((entry) => entry.kind === "file");
    const bestMatch =
      fileMatches.find((entry) => entry.path.toLowerCase().endsWith(`/${basename}`)) ??
      fileMatches.find((entry) => entry.path.toLowerCase() === basename) ??
      fileMatches[0];
    if (!bestMatch) {
      return false;
    }
    return openFileInActiveViewer({ path: bestMatch.path, line: parsed.line });
  } catch {
    return false;
  }
}

export interface OpenFileInViewerInput {
  environmentId: EnvironmentId;
  cwd: string;
  threadRef?: ScopedThreadRef | null;
  /** Workspace-relative or absolute path; absolute paths are relativized. */
  path: string;
  line?: number | undefined;
  endLine?: number | undefined;
}

/**
 * Route a file-open interaction into the internal viewer.
 *
 * Returns false when the target cannot be shown internally (outside the
 * workspace root); callers should fall back to the external editor.
 */
export function openFileInViewer(input: OpenFileInViewerInput): boolean {
  // Editor-style targets carry the line as a `path:12[:4]` suffix (that is
  // what external editors expect); strip it before hitting the read API.
  let targetPath = input.path;
  let line = input.line;
  const lineSuffix = /:(\d+)(?::\d+)?$/.exec(targetPath);
  if (lineSuffix) {
    targetPath = targetPath.slice(0, lineSuffix.index);
    if (line === undefined) {
      line = Number.parseInt(lineSuffix[1] ?? "", 10) || undefined;
    }
  }
  const normalizedPath = toPosixPath(targetPath);
  const relativePath =
    normalizedPath.startsWith("/") || isWindowsAbsolutePath(targetPath)
      ? relativePathWithinCwd(normalizedPath, input.cwd)
      : normalizedPath;
  if (!relativePath) {
    return false;
  }
  useFileViewerStore.getState().open(
    {
      environmentId: input.environmentId,
      cwd: input.cwd,
      threadRef: input.threadRef ?? null,
    },
    {
      path: relativePath,
      ...(line !== undefined ? { line } : {}),
      ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
    },
  );
  return true;
}

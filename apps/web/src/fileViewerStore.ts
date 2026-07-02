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
  /** Bumped on every reveal request so re-opening the same line re-scrolls. */
  revealRequestId: number;
  open: (context: FileViewerContext, target?: { path: string; line?: number }) => void;
  openFile: (path: string, line?: number) => void;
  setActivePath: (path: string) => void;
  closeTab: (path: string) => void;
  close: () => void;
}

export const useFileViewerStore = create<FileViewerState>((set) => ({
  isOpen: false,
  context: null,
  tabs: [],
  activePath: null,
  revealLine: null,
  revealRequestId: 0,

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
      return {
        isOpen: true,
        context,
        tabs,
        activePath: activePath ?? tabs[0] ?? null,
        revealLine: target?.line ?? null,
        revealRequestId: state.revealRequestId + 1,
      };
    }),

  openFile: (path, line) =>
    set((state) => ({
      tabs: state.tabs.includes(path) ? state.tabs : [...state.tabs, path],
      activePath: path,
      revealLine: line ?? null,
      revealRequestId: state.revealRequestId + 1,
    })),

  setActivePath: (path) => set({ activePath: path, revealLine: null }),

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
  });
}

export interface OpenFileInViewerInput {
  environmentId: EnvironmentId;
  cwd: string;
  threadRef?: ScopedThreadRef | null;
  /** Workspace-relative or absolute path; absolute paths are relativized. */
  path: string;
  line?: number | undefined;
}

/**
 * Route a file-open interaction into the internal viewer.
 *
 * Returns false when the target cannot be shown internally (outside the
 * workspace root); callers should fall back to the external editor.
 */
export function openFileInViewer(input: OpenFileInViewerInput): boolean {
  const normalizedPath = toPosixPath(input.path);
  const relativePath =
    normalizedPath.startsWith("/") || isWindowsAbsolutePath(input.path)
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
    { path: relativePath, ...(input.line !== undefined ? { line: input.line } : {}) },
  );
  return true;
}

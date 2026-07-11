/**
 * File viewer overlay state.
 *
 * The internal file viewer is a large overlay that browses and previews
 * project files without leaving Threadlines. It is the default destination
 * for file-opening interactions (chat file chips, diff-panel files, the
 * terminal-adjacent entry point); the routing helpers below keep file and
 * directory targets distinct so only actual files reach the preview pane.
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

/**
 * Unsaved-edit lifecycle of a file in edit mode. Absence from the map means
 * the file matches disk. `pending` = debounced write scheduled, `saving` =
 * write in flight, `error` = last write failed (retried on the next change
 * or explicit save), `conflict` = the file changed on disk since this
 * buffer's baseline — autosave is latched until the user reloads or
 * overwrites.
 */
export type FileEditSaveState = "pending" | "saving" | "error" | "conflict";

type FileViewerOpenTarget =
  | { kind: "file"; path: string; line?: number; endLine?: number }
  | { kind: "directory"; path: string };

interface FileViewerState {
  isOpen: boolean;
  context: FileViewerContext | null;
  /** Open files, in tab order. Paths are workspace-relative. */
  tabs: string[];
  activePath: string | null;
  /** Directory the tree should reveal. An empty string targets the workspace root. */
  treeRevealPath: string | null;
  /** Bumped so repeatedly opening the same directory still re-focuses it. */
  treeRevealRequestId: number;
  /** 1-based line to reveal in the active file. */
  revealLine: number | null;
  /** Optional inclusive end of the reveal range (selection restore). */
  revealEndLine: number | null;
  /** Bumped on every reveal request so re-opening the same line re-scrolls. */
  revealRequestId: number;
  /**
   * Edit mode replaces the read-only preview (line selection for chat) with
   * an editable surface — pierre disables line selection while an editor is
   * attached, so the two are exclusive by design. Session-scoped preference.
   */
  editMode: boolean;
  /** Per-path save lifecycle, mirrored here for tab dots and footer status. */
  editSaveState: Record<string, FileEditSaveState>;
  /**
   * Bumped when a conflict is resolved by reloading from disk, so the active
   * edit pane remounts and re-seeds its editor from the refreshed cache.
   */
  editReloadNonce: number;
  /**
   * Word-wrap override for coarse pointers, where wrap defaults on (panning
   * code sideways on a phone is worse than wrapping). Session-scoped on
   * purpose: the persisted `fileViewerWordWrap` setting is shared across
   * devices, so a phone toggling wrap must not clobber the desktop choice.
   */
  coarsePointerWordWrap: boolean | null;
  setCoarsePointerWordWrap: (wrap: boolean) => void;
  setEditMode: (editMode: boolean) => void;
  setEditSaveState: (path: string, state: FileEditSaveState | null) => void;
  bumpEditReloadNonce: () => void;
  open: (context: FileViewerContext, target?: FileViewerOpenTarget) => void;
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
  treeRevealPath: null,
  treeRevealRequestId: 0,
  revealLine: null,
  revealEndLine: null,
  revealRequestId: 0,
  editMode: false,
  editSaveState: {},
  editReloadNonce: 0,
  coarsePointerWordWrap: null,

  setCoarsePointerWordWrap: (wrap) => set({ coarsePointerWordWrap: wrap }),

  setEditMode: (editMode) => set({ editMode }),

  bumpEditReloadNonce: () => set((state) => ({ editReloadNonce: state.editReloadNonce + 1 })),

  setEditSaveState: (path, saveState) =>
    set((state) => {
      if (saveState === null) {
        if (!(path in state.editSaveState)) {
          return state;
        }
        const { [path]: _removed, ...editSaveState } = state.editSaveState;
        return { editSaveState };
      }
      return { editSaveState: { ...state.editSaveState, [path]: saveState } };
    }),

  open: (context, target) =>
    set((state) => {
      const sameWorkspace =
        state.context?.environmentId === context.environmentId && state.context.cwd === context.cwd;
      const tabs = sameWorkspace ? [...state.tabs] : [];
      let activePath = sameWorkspace ? state.activePath : null;
      if (target?.kind === "file") {
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
        treeRevealPath: target?.kind === "directory" ? target.path : null,
        treeRevealRequestId: state.treeRevealRequestId + (target?.kind === "directory" ? 1 : 0),
        revealLine: target?.kind === "file" ? (target.line ?? null) : null,
        revealEndLine: target?.kind === "file" ? (target.endLine ?? null) : null,
        revealRequestId: state.revealRequestId + 1,
        ...(sameWorkspace ? {} : { editSaveState: {} }),
      };
    }),

  openFile: (path, line, endLine) =>
    set((state) => ({
      tabs: withTabCap(state.tabs.includes(path) ? state.tabs : [...state.tabs, path], path),
      activePath: path,
      treeRevealPath: null,
      revealLine: line ?? null,
      revealEndLine: endLine ?? null,
      revealRequestId: state.revealRequestId + 1,
    })),

  setActivePath: (path) =>
    set({ activePath: path, treeRevealPath: null, revealLine: null, revealEndLine: null }),

  closeTab: (path) =>
    set((state) => {
      const index = state.tabs.indexOf(path);
      const tabs = state.tabs.filter((tab) => tab !== path);
      const activePath =
        state.activePath === path
          ? (tabs[Math.min(index, tabs.length - 1)] ?? null)
          : state.activePath;
      const { [path]: _removed, ...editSaveState } = state.editSaveState;
      return { tabs, activePath, revealLine: null, editSaveState };
    }),

  closeOtherTabs: (path) =>
    set((state) => ({
      tabs: state.tabs.includes(path) ? [path] : [],
      activePath: state.tabs.includes(path) ? path : null,
      revealLine: null,
      revealEndLine: null,
      editSaveState:
        path in state.editSaveState
          ? { [path]: state.editSaveState[path] as FileEditSaveState }
          : {},
    })),

  closeAllTabs: () =>
    set({ tabs: [], activePath: null, revealLine: null, revealEndLine: null, editSaveState: {} }),

  close: () => set({ isOpen: false, revealLine: null }),
}));

function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

function normalizeFileViewerPath(input: string): string {
  const posixPath = toPosixPath(input);
  const gitBashDriveMatch = /^\/([A-Za-z])(?=\/|$)/.exec(posixPath);
  if (!gitBashDriveMatch) {
    return posixPath;
  }
  return `${gitBashDriveMatch[1]?.toUpperCase() ?? ""}:${posixPath.slice(2)}`;
}

function normalizePathForComparison(input: string): string {
  const normalized = normalizeFileViewerPath(input);
  return isWindowsAbsolutePath(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function relativePathWithinCwdOrRoot(targetPath: string, cwd: string): string | null {
  const normalizedTarget = normalizeFileViewerPath(targetPath).replace(/\/+$/u, "");
  const normalizedCwd = normalizeFileViewerPath(cwd).replace(/\/+$/, "");
  const comparableTarget = normalizePathForComparison(normalizedTarget);
  const comparableCwd = normalizePathForComparison(normalizedCwd);
  if (comparableTarget === comparableCwd) {
    return "";
  }
  if (!comparableTarget.startsWith(`${comparableCwd}/`)) {
    return null;
  }
  const relativePath = normalizedTarget.slice(normalizedCwd.length + 1);
  return relativePath.length > 0 ? relativePath : null;
}

/**
 * Convert an absolute file path into a workspace-relative one, or return null
 * when the path is the workspace root or lives outside it.
 */
export function relativePathWithinCwd(targetPath: string, cwd: string): string | null {
  const relativePath = relativePathWithinCwdOrRoot(targetPath, cwd);
  return relativePath && relativePath.length > 0 ? relativePath : null;
}

function resolveViewerWorkspacePath(targetPath: string, cwd: string): string | null {
  const normalizedTarget = normalizeFileViewerPath(targetPath);
  const isAbsolute =
    normalizedTarget.startsWith("/") ||
    isWindowsAbsolutePath(targetPath) ||
    isWindowsAbsolutePath(normalizedTarget);
  const pathWithoutTrailingSeparators = normalizedTarget.replace(/\/+$/u, "");
  return isAbsolute
    ? relativePathWithinCwdOrRoot(pathWithoutTrailingSeparators, cwd)
    : pathWithoutTrailingSeparators;
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
 * Reveal a directory in the active workspace's file tree without treating it
 * as an open file. Returns false when no viewer context is registered or the
 * directory is outside the workspace.
 */
export function openDirectoryInActiveViewer(input: { path: string }): boolean {
  if (!activeFileViewerContext) {
    return false;
  }
  return openDirectoryInViewer({
    environmentId: activeFileViewerContext.environmentId,
    cwd: activeFileViewerContext.cwd,
    threadRef: activeFileViewerContext.threadRef,
    path: input.path,
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

export type OpenDirectoryInViewerInput = Omit<OpenFileInViewerInput, "line" | "endLine">;

/**
 * Open the viewer with a directory revealed in the project tree. Directories
 * never become tabs or active preview paths, so no file read is attempted.
 */
export function openDirectoryInViewer(input: OpenDirectoryInViewerInput): boolean {
  const relativePath = resolveViewerWorkspacePath(input.path, input.cwd);
  if (relativePath === null) {
    return false;
  }
  useFileViewerStore.getState().open(
    {
      environmentId: input.environmentId,
      cwd: input.cwd,
      threadRef: input.threadRef ?? null,
    },
    { kind: "directory", path: relativePath },
  );
  return true;
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
  const relativePath = resolveViewerWorkspacePath(targetPath, input.cwd);
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
      kind: "file",
      path: relativePath,
      ...(line !== undefined ? { line } : {}),
      ...(input.endLine !== undefined ? { endLine: input.endLine } : {}),
    },
  );
  return true;
}

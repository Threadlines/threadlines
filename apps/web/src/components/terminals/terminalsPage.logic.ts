/**
 * The Terminals page (docs/terminal.md, "The Terminals page"): each computer
 * keeps its page's tabs on its own server, under one reserved terminal thread
 * id no thread has. Here: that key, the folder each new tab was asked to
 * start in, and what a tab is named after.
 */
import { scopeThreadRef } from "@threadlines/client-runtime";
import {
  type EnvironmentId,
  type ScopedThreadRef,
  TERMINALS_PAGE_THREAD_ID,
  ThreadId,
} from "@threadlines/contracts";
import { areFilesystemPathsEqual } from "@threadlines/shared/path";

import { terminalKey } from "../../terminalStateStore";

export const TERMINALS_PAGE_THREAD = ThreadId.make(TERMINALS_PAGE_THREAD_ID);

/** Where one computer's Terminals page keeps its tabs. */
export function terminalsPageThreadRef(environmentId: EnvironmentId): ScopedThreadRef {
  return scopeThreadRef(environmentId, TERMINALS_PAGE_THREAD);
}

export function isTerminalsPageThreadId(threadId: string): boolean {
  return threadId === TERMINALS_PAGE_THREAD_ID;
}

/**
 * The folder each tab made here was asked to start in, until the server
 * lists the tab with its own. Kept for the app's lifetime, so a tab still
 * opening when the page closes starts where it was asked to when it comes
 * back, whatever the picker says by then.
 */
const requestedFolderByKey = new Map<string, string>();

export function requestTabFolder(
  threadRef: ScopedThreadRef,
  terminalId: string,
  cwd: string,
): void {
  requestedFolderByKey.set(terminalKey(threadRef, terminalId), cwd);
}

export function requestedTabFolder(threadRef: ScopedThreadRef, terminalId: string): string | null {
  return requestedFolderByKey.get(terminalKey(threadRef, terminalId)) ?? null;
}

export function forgetRequestedTabFolder(threadRef: ScopedThreadRef, terminalId: string): void {
  requestedFolderByKey.delete(terminalKey(threadRef, terminalId));
}

/**
 * What a tab names first: the project whose folder its shell started in, or
 * that folder's own name (a project removed since, or a folder `cd`-ed into
 * before a restart).
 */
export function tabFolderLabel(
  cwd: string | null,
  projects: ReadonlyArray<{ readonly name: string; readonly cwd: string }>,
): string | null {
  if (cwd === null) return null;
  const project = projects.find((entry) => areFilesystemPathsEqual(entry.cwd, cwd));
  if (project) return project.name;
  const trimmed = cwd.length > 1 ? cwd.replace(/[\\/]+$/, "") : cwd;
  return trimmed.split(/[\\/]/).at(-1) || trimmed;
}

/** `?environment=<id>`: show that computer's tabs (a port notice's Show goes there). */
export interface TerminalsSearch {
  readonly environment?: string;
}

export function parseTerminalsSearch(search: Record<string, unknown>): TerminalsSearch {
  const environment =
    typeof search.environment === "string" && search.environment.trim().length > 0
      ? search.environment.trim()
      : undefined;
  return environment === undefined ? {} : { environment };
}

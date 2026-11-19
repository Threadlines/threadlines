/**
 * Each computer's project context on the web side (docs/design/
 * project-brief-notes.md): its briefs, its kept notes and the suggestions
 * waiting, as `projectContext.subscribe` sends them. One subscription per
 * computer, shared by every view that follows it (Settings › Instructions,
 * an open thread's suggestion rows) and dropped when the last one leaves. A
 * computer whose connection is replaced (a reconnect) is followed again on
 * the new one; one that drops keeps its last snapshot until it comes back.
 *
 * Also the note actions, which name the computer the note is on: notes stay
 * on the computer whose agents wrote them.
 */
import type {
  EnvironmentId,
  ProjectContextSnapshot,
  ProjectNote,
  ProjectNoteApproveInput,
  ProjectNoteReadInput,
  ProjectNoteRemoveInput,
  ProjectNoteSaveInput,
  ProjectNoteSuggestion,
  ProjectNoteSuggestionResolveInput,
  ThreadId,
} from "@threadlines/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { readEnvironmentConnection, subscribeEnvironmentConnections } from "./environments/runtime";

interface Followed {
  refs: number;
  connection: object | null;
  unsubscribe: (() => void) | null;
}

const followed = new Map<EnvironmentId, Followed>();
let snapshots: Readonly<Record<string, ProjectContextSnapshot>> = {};
const listeners = new Set<() => void>();
let stopWatchingConnections: (() => void) | null = null;

function emit() {
  for (const listener of listeners) listener();
}

function setSnapshot(environmentId: EnvironmentId, snapshot: ProjectContextSnapshot) {
  snapshots = { ...snapshots, [environmentId]: snapshot };
  emit();
}

/** Subscribes each followed computer on its current connection, once. */
function syncConnections() {
  for (const [environmentId, entry] of followed) {
    const connection = readEnvironmentConnection(environmentId);
    if (entry.connection === connection) continue;
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    entry.connection = connection;
    if (!connection) continue;
    entry.unsubscribe = connection.client.projectContext.subscribe((snapshot) => {
      // A late answer from a subscription already dropped is not this one's.
      if (followed.get(environmentId) !== entry || entry.connection !== connection) return;
      setSnapshot(environmentId, snapshot);
    });
  }
}

/**
 * Follows a computer's project context until the returned function runs.
 * Only for a computer whose server reports `projectContext`.
 */
function follow(environmentId: EnvironmentId): () => void {
  let entry = followed.get(environmentId);
  if (entry === undefined) {
    entry = { refs: 0, connection: null, unsubscribe: null };
    followed.set(environmentId, entry);
  }
  entry.refs += 1;
  stopWatchingConnections ??= subscribeEnvironmentConnections(syncConnections);
  syncConnections();
  const held = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.refs -= 1;
    if (held.refs > 0) return;
    held.unsubscribe?.();
    followed.delete(environmentId);
    if (environmentId in snapshots) {
      const { [environmentId]: _dropped, ...rest } = snapshots;
      snapshots = rest;
      emit();
    }
    if (followed.size === 0) {
      stopWatchingConnections?.();
      stopWatchingConnections = null;
    }
  };
}

function subscribeSnapshots(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const readSnapshots = () => snapshots;

/**
 * The latest project context of each listed computer, followed while
 * mounted. List only computers whose server keeps it (`projectContext`).
 * Keyed by environment id; a computer that hasn't answered yet is absent.
 */
export function useProjectContextSnapshots(
  environmentIds: readonly EnvironmentId[],
): Readonly<Record<string, ProjectContextSnapshot>> {
  const environmentKey = environmentIds.join("\0");
  useEffect(() => {
    if (environmentKey === "") return;
    const releases = (environmentKey.split("\0") as EnvironmentId[]).map(follow);
    return () => {
      for (const release of releases) release();
    };
  }, [environmentKey]);
  return useSyncExternalStore(subscribeSnapshots, readSnapshots, readSnapshots);
}

const NO_SUGGESTIONS: readonly ProjectNoteSuggestion[] = [];

/**
 * The suggestions an agent wrote in one thread and the user hasn't kept or
 * discarded, from the thread's own computer. Client-side only: nothing that
 * decides whether a thread needs the user reads them. Empty while
 * `supported` is false (an older server). Re-renders only when that
 * computer's snapshot changes.
 */
export function useThreadNoteSuggestions(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  supported: boolean,
): readonly ProjectNoteSuggestion[] {
  const following = supported && threadId !== null;
  useEffect(() => (following ? follow(environmentId) : undefined), [environmentId, following]);
  const readOwn = useCallback(() => snapshots[environmentId], [environmentId]);
  const snapshot = useSyncExternalStore(subscribeSnapshots, readOwn, readOwn);
  const suggestions = following ? snapshot?.suggestions : undefined;
  return useMemo(() => {
    if (suggestions === undefined || threadId === null) return NO_SUGGESTIONS;
    const mine = suggestions.filter((suggestion) => suggestion.author.threadId === threadId);
    return mine.length === 0 ? NO_SUGGESTIONS : mine;
  }, [suggestions, threadId]);
}

function projectContextClient(environmentId: EnvironmentId) {
  const connection = readEnvironmentConnection(environmentId);
  if (connection === null) {
    throw new Error("That computer is offline. Try again when it is back.");
  }
  return connection.client.projectContext;
}

/** What went wrong with a note action, in words the page can show. */
export function noteActionErrorText(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "That did not work. Try again.";
}

export function readProjectNote(
  environmentId: EnvironmentId,
  input: ProjectNoteReadInput,
): Promise<ProjectNote> {
  return projectContextClient(environmentId).readNote(input);
}

export function saveProjectNote(
  environmentId: EnvironmentId,
  input: ProjectNoteSaveInput,
): Promise<ProjectNote> {
  return projectContextClient(environmentId).saveNote(input);
}

export async function removeProjectNote(
  environmentId: EnvironmentId,
  input: ProjectNoteRemoveInput,
): Promise<void> {
  await projectContextClient(environmentId).removeNote(input);
}

export async function approveProjectNote(
  environmentId: EnvironmentId,
  input: ProjectNoteApproveInput,
): Promise<void> {
  await projectContextClient(environmentId).approveNote(input);
}

export async function resolveNoteSuggestion(
  environmentId: EnvironmentId,
  input: ProjectNoteSuggestionResolveInput,
): Promise<void> {
  await projectContextClient(environmentId).resolveSuggestion(input);
}

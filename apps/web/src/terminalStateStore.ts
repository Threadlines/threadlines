/**
 * Single Zustand store for terminal UI state keyed by scoped thread identity:
 * which tabs a thread's drawer shows and how (docs/terminal.md), and what
 * their shells are doing. The tab list follows the server's when it keeps
 * one; how the drawer is laid out (splits, the active tab, open, height)
 * stays per device. Output never comes through here (terminalStreams.ts).
 *
 * Terminal transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import { parseScopedThreadKey, scopedThreadKey } from "@threadlines/client-runtime";
import {
  type EnvironmentId,
  type ScopedThreadRef,
  type TerminalEvent,
  type TerminalTab,
  type TerminalThreadTabs,
  ThreadId,
} from "@threadlines/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage, withLegacyFallbackStorage } from "./lib/storage";
import { normalizeSubmittedTerminalCommand } from "./terminalCommandTracker";
import { terminalRunningSubprocessFromEvent } from "./terminalActivity";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "./types";

interface ThreadTerminalState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
}

const TERMINAL_STATE_STORAGE_KEY = "threadlines:terminal-state:v1";
const LEGACY_TERMINAL_STATE_STORAGE_KEYS = ["t3code:terminal-state:v1"] as const;
/**
 * A tab this device opened stays in its list this long while the server's
 * list doesn't have it yet (its shell is still starting).
 */
const PENDING_TERMINAL_TTL_MS = 60_000;
const EMPTY_TERMINAL_TABS: ReadonlyArray<TerminalTab> = [];

interface PersistedTerminalStateStoreState {
  terminalStateByThreadKey?: Record<string, ThreadTerminalState>;
}

export function migratePersistedTerminalStateStoreState(
  persistedState: unknown,
  version: number,
): PersistedTerminalStateStoreState {
  if (version === 1 && persistedState && typeof persistedState === "object") {
    const candidate = persistedState as PersistedTerminalStateStoreState;
    const nextTerminalStateByThreadKey = Object.fromEntries(
      Object.entries(candidate.terminalStateByThreadKey ?? {}).filter(([threadKey]) =>
        parseScopedThreadKey(threadKey),
      ),
    );
    return { terminalStateByThreadKey: nextTerminalStateByThreadKey };
  }
  return { terminalStateByThreadKey: {} };
}

function createTerminalStateStorage() {
  return withLegacyFallbackStorage(
    resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    TERMINAL_STATE_STORAGE_KEY,
    LEGACY_TERMINAL_STATE_STORAGE_KEYS,
  );
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const ids = [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  return ids.length > 0 ? ids : [DEFAULT_THREAD_TERMINAL_ID];
}

function normalizeRunningTerminalIds(
  runningTerminalIds: string[],
  terminalIds: string[],
): string[] {
  if (runningTerminalIds.length === 0) return [];
  const validTerminalIdSet = new Set(terminalIds);
  return [...new Set(runningTerminalIds)]
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && validTerminalIdSet.has(id));
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return [...new Set(terminalIds.map((id) => id.trim()).filter((id) => id.length > 0))];
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[],
  terminalIds: string[],
): ThreadTerminalGroup[] {
  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  if (nextGroups.length === 0) {
    return [
      {
        id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
        terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
      },
    ];
  }

  return nextGroups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(left: ThreadTerminalGroup[], right: ThreadTerminalGroup[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
  }
  return true;
}

function threadTerminalStateEqual(left: ThreadTerminalState, right: ThreadTerminalState): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    arraysEqual(left.runningTerminalIds, right.runningTerminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

const DEFAULT_THREAD_TERMINAL_STATE: ThreadTerminalState = Object.freeze({
  terminalOpen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
  runningTerminalIds: [],
  activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
  terminalGroups: [
    {
      id: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
      terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
    },
  ],
  activeTerminalGroupId: fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
});

function createDefaultThreadTerminalState(): ThreadTerminalState {
  return {
    ...DEFAULT_THREAD_TERMINAL_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.terminalIds],
    runningTerminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.runningTerminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_STATE.terminalGroups),
  };
}

function getDefaultThreadTerminalState(): ThreadTerminalState {
  return DEFAULT_THREAD_TERMINAL_STATE;
}

function normalizeThreadTerminalState(state: ThreadTerminalState): ThreadTerminalState {
  const terminalIds = normalizeTerminalIds(state.terminalIds);
  const nextTerminalIds = terminalIds.length > 0 ? terminalIds : [DEFAULT_THREAD_TERMINAL_ID];
  const runningTerminalIds = normalizeRunningTerminalIds(state.runningTerminalIds, nextTerminalIds);
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? DEFAULT_THREAD_TERMINAL_ID);
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: ThreadTerminalState = {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    runningTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ??
      activeGroupIdFromTerminal ??
      terminalGroups[0]?.id ??
      fallbackGroupId(DEFAULT_THREAD_TERMINAL_ID),
  };
  return threadTerminalStateEqual(state, normalized) ? state : normalized;
}

function isDefaultThreadTerminalState(state: ThreadTerminalState): boolean {
  const normalized = normalizeThreadTerminalState(state);
  return threadTerminalStateEqual(normalized, DEFAULT_THREAD_TERMINAL_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function terminalThreadKey(threadRef: ScopedThreadRef): string {
  return scopedThreadKey(threadRef);
}

/** One tab of one thread, as a record key. */
export function terminalKey(threadRef: ScopedThreadRef, terminalId: string): string {
  return `${terminalThreadKey(threadRef)}\u0000${terminalId}`;
}

function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
  }));
}

function upsertTerminalIntoGroups(
  state: ThreadTerminalState,
  terminalId: string,
  mode: "split" | "new",
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, terminalId);
  if (existingGroupIndex >= 0) {
    terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
      existingGroupIndex
    ]!.terminalIds.filter((id) => id !== terminalId);
    if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (mode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push({ id: nextGroupId, terminalIds: [terminalId] });
    return normalizeThreadTerminalState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      usedGroupIds,
    );
    terminalGroups.push({ id: nextGroupId, terminalIds: [normalized.activeTerminalId] });
    activeGroupIndex = terminalGroups.length - 1;
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }

  if (
    isNewTerminal &&
    !destinationGroup.terminalIds.includes(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (!destinationGroup.terminalIds.includes(terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(normalized.activeTerminalId);
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId);
    } else {
      destinationGroup.terminalIds.push(terminalId);
    }
  }

  return normalizeThreadTerminalState({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}

function setThreadTerminalOpen(state: ThreadTerminalState, open: boolean): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

function setThreadTerminalHeight(state: ThreadTerminalState, height: number): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

function splitThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "split");
}

function newThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

function setThreadActiveTerminal(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
  };
}

function closeThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    return createDefaultThreadTerminalState();
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        DEFAULT_THREAD_TERMINAL_ID)
      : normalized.activeTerminalId;

  const terminalGroups = normalized.terminalGroups
    .map((group) => ({
      ...group,
      terminalIds: group.terminalIds.filter((id) => id !== terminalId),
    }))
    .filter((group) => group.terminalIds.length > 0);

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeThreadTerminalState({
    terminalOpen: normalized.terminalOpen,
    terminalHeight: normalized.terminalHeight,
    terminalIds: remainingTerminalIds,
    runningTerminalIds: normalized.runningTerminalIds.filter((id) => id !== terminalId),
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
  });
}

function setThreadTerminalActivity(
  state: ThreadTerminalState,
  terminalId: string,
  hasRunningSubprocess: boolean,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const alreadyRunning = normalized.runningTerminalIds.includes(terminalId);
  if (hasRunningSubprocess === alreadyRunning) {
    return normalized;
  }
  const runningTerminalIds = new Set(normalized.runningTerminalIds);
  if (hasRunningSubprocess) {
    runningTerminalIds.add(terminalId);
  } else {
    runningTerminalIds.delete(terminalId);
  }
  return { ...normalized, runningTerminalIds: [...runningTerminalIds] };
}

export function selectThreadTerminalState(
  terminalStateByThreadKey: Record<string, ThreadTerminalState>,
  threadRef: ScopedThreadRef | null | undefined,
): ThreadTerminalState {
  if (!threadRef || threadRef.threadId.length === 0) {
    return getDefaultThreadTerminalState();
  }
  return terminalStateByThreadKey[terminalThreadKey(threadRef)] ?? getDefaultThreadTerminalState();
}

function updateTerminalStateByThreadKey(
  terminalStateByThreadKey: Record<string, ThreadTerminalState>,
  threadRef: ScopedThreadRef,
  updater: (state: ThreadTerminalState) => ThreadTerminalState,
): Record<string, ThreadTerminalState> {
  if (threadRef.threadId.length === 0) {
    return terminalStateByThreadKey;
  }

  const threadKey = terminalThreadKey(threadRef);
  const current = selectThreadTerminalState(terminalStateByThreadKey, threadRef);
  const next = updater(current);
  if (next === current) {
    return terminalStateByThreadKey;
  }

  if (isDefaultThreadTerminalState(next)) {
    if (terminalStateByThreadKey[threadKey] === undefined) {
      return terminalStateByThreadKey;
    }
    const { [threadKey]: _removed, ...rest } = terminalStateByThreadKey;
    return rest;
  }

  return {
    ...terminalStateByThreadKey,
    [threadKey]: next,
  };
}

export function selectTerminalActivityStartedAt(
  terminalActivityStartedAtByKey: Record<string, string>,
  threadRef: ScopedThreadRef | null | undefined,
  terminalId: string,
): string | null {
  if (!threadRef || threadRef.threadId.length === 0 || terminalId.trim().length === 0) {
    return null;
  }
  return terminalActivityStartedAtByKey[terminalKey(threadRef, terminalId)] ?? null;
}

export function selectTerminalActivityCommand(
  terminalActivityCommandByKey: Record<string, string>,
  threadRef: ScopedThreadRef | null | undefined,
  terminalId: string,
): string | null {
  if (!threadRef || threadRef.threadId.length === 0 || terminalId.trim().length === 0) {
    return null;
  }
  return terminalActivityCommandByKey[terminalKey(threadRef, terminalId)] ?? null;
}

/**
 * A thread's tab list after the server said which tabs it has: those, in its
 * order, plus tabs this device just opened that the server doesn't list yet.
 * Splits, the active tab, open and height stay as they were where they can.
 */
function reconcileThreadTerminalIds(
  state: ThreadTerminalState,
  serverTerminalIds: ReadonlyArray<string>,
  pendingSince: Readonly<Record<string, number>>,
  nowMs: number,
  server: {
    /** Listed tabs whose shell runs nothing (ended, or not started since a restart). */
    readonly idleIds: ReadonlySet<string>;
    /** The server listed tabs for the thread before this. */
    readonly hadTabs: boolean;
  },
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const listed = new Set(serverTerminalIds);
  const kept = normalized.terminalIds.filter((terminalId) => {
    if (listed.has(terminalId)) return false;
    const since = pendingSince[terminalId];
    return since !== undefined && nowMs - since < PENDING_TERMINAL_TTL_MS;
  });
  const terminalIds = [...serverTerminalIds, ...kept];
  if (terminalIds.length === 0) {
    // Nothing listed: the first tab's placeholder. When the last tabs were
    // just closed (on another device), the drawer closes too; left open, it
    // would start a shell in the placeholder and undo that.
    return normalizeThreadTerminalState({
      ...createDefaultThreadTerminalState(),
      terminalOpen: server.hadTabs ? false : normalized.terminalOpen,
      terminalHeight: normalized.terminalHeight,
    });
  }
  const previousIndex = normalized.terminalIds.indexOf(normalized.activeTerminalId);
  const activeTerminalId = terminalIds.includes(normalized.activeTerminalId)
    ? normalized.activeTerminalId
    : (terminalIds[Math.min(Math.max(previousIndex, 0), terminalIds.length - 1)] ??
      terminalIds[0] ??
      DEFAULT_THREAD_TERMINAL_ID);
  const next = normalizeThreadTerminalState({
    ...normalized,
    terminalIds,
    activeTerminalId,
    runningTerminalIds: normalized.runningTerminalIds.filter(
      (id) => terminalIds.includes(id) && !server.idleIds.has(id),
    ),
    terminalGroups: normalized.terminalGroups,
  });
  return threadTerminalStateEqual(next, normalized) ? normalized : next;
}

/**
 * What each tab is called ("Terminal 2"): the number the server gave it,
 * or for a tab it doesn't list yet, the lowest one free.
 */
export function terminalTabNumbers(
  terminalIds: ReadonlyArray<string>,
  tabs: ReadonlyArray<TerminalTab>,
): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const tab of tabs) numbers.set(tab.terminalId, tab.number);
  const taken = new Set(numbers.values());
  let next = 1;
  for (const terminalId of terminalIds) {
    if (numbers.has(terminalId)) continue;
    while (taken.has(next)) next += 1;
    numbers.set(terminalId, next);
    taken.add(next);
  }
  return numbers;
}

export interface BusyTerminal {
  readonly threadKey: string;
  readonly terminalId: string;
  /** What it runs, when known (the line typed, or the process's name). */
  readonly command: string | null;
}

/**
 * Terminals on one server that run something, or just had a command entered:
 * the work stopping that server stops. In thread order, then tab order.
 */
export function selectBusyTerminals(
  state: Pick<
    TerminalStateStoreState,
    "terminalStateByThreadKey" | "terminalActivityCommandByKey" | "terminalCommandPendingByKey"
  >,
  environmentId: EnvironmentId | null,
): BusyTerminal[] {
  if (environmentId === null) return [];
  const busy: BusyTerminal[] = [];
  for (const [threadKey, thread] of Object.entries(state.terminalStateByThreadKey)) {
    if (parseScopedThreadKey(threadKey)?.environmentId !== environmentId) continue;
    for (const terminalId of thread.terminalIds) {
      const key = `${threadKey}\u0000${terminalId}`;
      if (
        !thread.runningTerminalIds.includes(terminalId) &&
        state.terminalCommandPendingByKey[key] !== true
      ) {
        continue;
      }
      busy.push({
        threadKey,
        terminalId,
        command: state.terminalActivityCommandByKey[key] ?? null,
      });
    }
  }
  return busy;
}

export function selectTerminalTabs(
  terminalTabsByThreadKey: Record<string, ReadonlyArray<TerminalTab>>,
  threadRef: ScopedThreadRef | null | undefined,
): ReadonlyArray<TerminalTab> {
  if (!threadRef || threadRef.threadId.length === 0) return EMPTY_TERMINAL_TABS;
  return terminalTabsByThreadKey[terminalThreadKey(threadRef)] ?? EMPTY_TERMINAL_TABS;
}

interface TerminalStateStoreState {
  terminalStateByThreadKey: Record<string, ThreadTerminalState>;
  /** The server's tab list of each thread, when it keeps one. */
  terminalTabsByThreadKey: Record<string, ReadonlyArray<TerminalTab>>;
  /** Tabs this device opened that the server may not list yet, with when. */
  pendingTerminalIdsByThreadKey: Record<string, Record<string, number>>;
  terminalActivityCommandByKey: Record<string, string>;
  /** When each terminal's running subprocess started, as the server saw it. */
  terminalActivityStartedAtByKey: Record<string, string>;
  /** Tabs where a command was entered and not yet seen running or done. */
  terminalCommandPendingByKey: Record<string, true>;
  setTerminalOpen: (threadRef: ScopedThreadRef, open: boolean) => void;
  setTerminalHeight: (threadRef: ScopedThreadRef, height: number) => void;
  splitTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  newTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  ensureTerminal: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    options?: { open?: boolean; active?: boolean },
  ) => void;
  setActiveTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  closeTerminal: (threadRef: ScopedThreadRef, terminalId: string) => void;
  setTerminalActivity: (
    threadRef: ScopedThreadRef,
    terminalId: string,
    hasRunningSubprocess: boolean,
  ) => void;
  applyTerminalEvent: (threadRef: ScopedThreadRef, event: TerminalEvent) => void;
  /** Every thread's tabs on one server (the start of its stream). */
  applyTerminalCatalog: (
    environmentId: EnvironmentId,
    threads: ReadonlyArray<TerminalThreadTabs>,
  ) => void;
  /** One thread's tabs changed on the server. */
  applyTerminalTabs: (threadRef: ScopedThreadRef, tabs: ReadonlyArray<TerminalTab>) => void;
  clearTerminalState: (threadRef: ScopedThreadRef) => void;
  removeTerminalState: (threadRef: ScopedThreadRef) => void;
  removeOrphanedTerminalStates: (activeThreadKeys: Set<string>) => void;
}

type TerminalKeyedRecords = Pick<
  TerminalStateStoreState,
  "terminalActivityCommandByKey" | "terminalActivityStartedAtByKey" | "terminalCommandPendingByKey"
>;

const TERMINAL_KEYED_RECORD_NAMES = [
  "terminalActivityCommandByKey",
  "terminalActivityStartedAtByKey",
  "terminalCommandPendingByKey",
] as const satisfies ReadonlyArray<keyof TerminalKeyedRecords>;

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (record[key] === undefined) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
}

/** The per-tab records without one tab, or every tab of some threads. */
function pruneKeyedRecords(
  state: TerminalKeyedRecords,
  drop: (key: string) => boolean,
): Partial<TerminalKeyedRecords> {
  const next: Partial<TerminalKeyedRecords> = {};
  for (const name of TERMINAL_KEYED_RECORD_NAMES) {
    const { entries, removed } = removeKeyedEntries<string | true>(state[name], drop);
    if (removed) Object.assign(next, { [name]: entries });
  }
  return next;
}

function removeKeyedEntries<T>(
  entries: Record<string, T>,
  drop: (key: string) => boolean,
): { entries: Record<string, T>; removed: boolean } {
  let nextEntries = entries;
  let removed = false;
  for (const key of Object.keys(entries)) {
    if (!drop(key)) continue;
    if (!removed) {
      nextEntries = { ...entries };
      removed = true;
    }
    delete nextEntries[key];
  }
  return { entries: nextEntries, removed };
}

function withPendingTerminal(
  pending: Record<string, Record<string, number>>,
  threadRef: ScopedThreadRef,
  terminalId: string,
): Record<string, Record<string, number>> {
  const threadKey = terminalThreadKey(threadRef);
  return {
    ...pending,
    [threadKey]: { ...pending[threadKey], [terminalId]: Date.now() },
  };
}

/** Tabs the server made for this device (a script, a suggested command) not listed yet. */
const madeOnServerKeys = new Set<string>();

/** The server made this tab (it picked it for a run): it is shown, never made again. */
export function noteTerminalMadeOnServer(threadRef: ScopedThreadRef, terminalId: string): void {
  madeOnServerKeys.add(terminalKey(threadRef, terminalId));
}

/**
 * Whether this device asked for the tab and the server doesn't list it yet:
 * the only tab a viewer makes on the server. Any other is shown as the server
 * has it, or found gone (closed on another device).
 */
export function shouldMakeTerminal(threadRef: ScopedThreadRef, terminalId: string): boolean {
  const pending =
    useTerminalStateStore.getState().pendingTerminalIdsByThreadKey[terminalThreadKey(threadRef)];
  return (
    pending?.[terminalId] !== undefined && !madeOnServerKeys.has(terminalKey(threadRef, terminalId))
  );
}

/**
 * Lines entered on this device that the server hasn't answered yet. Until it
 * says the tab has a command pending or running (or its shell ended),
 * stopping the tab asks first, even when that word is slow to arrive. Word
 * that the tab is idle may be about an earlier line, so it doesn't count.
 */
const LINE_ENTERED_TTL_MS = 10_000;
const lineEnteredAtByKey = new Map<string, number>();

export function noteTerminalLineEntered(threadRef: ScopedThreadRef, terminalId: string): void {
  lineEnteredAtByKey.set(terminalKey(threadRef, terminalId), Date.now());
}

export function terminalLineRecentlyEntered(
  threadRef: ScopedThreadRef,
  terminalId: string,
): boolean {
  const key = terminalKey(threadRef, terminalId);
  const enteredAt = lineEnteredAtByKey.get(key);
  if (enteredAt === undefined) return false;
  if (Date.now() - enteredAt < LINE_ENTERED_TTL_MS) return true;
  lineEnteredAtByKey.delete(key);
  return false;
}

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist(
    (set) => {
      const updateTerminal = (
        threadRef: ScopedThreadRef,
        updater: (state: ThreadTerminalState) => ThreadTerminalState,
      ) => {
        set((state) => {
          const nextTerminalStateByThreadKey = updateTerminalStateByThreadKey(
            state.terminalStateByThreadKey,
            threadRef,
            updater,
          );
          if (nextTerminalStateByThreadKey === state.terminalStateByThreadKey) {
            return state;
          }
          return {
            terminalStateByThreadKey: nextTerminalStateByThreadKey,
          };
        });
      };

      /** Takes in one thread's server list. */
      const reconcileThread = (
        state: TerminalStateStoreState,
        threadKey: string,
        tabs: ReadonlyArray<TerminalTab>,
        nowMs: number,
      ): Partial<TerminalStateStoreState> => {
        const threadRef = parseScopedThreadKey(threadKey);
        if (!threadRef) return {};
        const serverIds = tabs.map((tab) => tab.terminalId);
        const listed = new Set(serverIds);
        for (const terminalId of serverIds)
          madeOnServerKeys.delete(`${threadKey}\u0000${terminalId}`);
        const idleIds = new Set(
          tabs.filter((tab) => tab.status !== "running").map((tab) => tab.terminalId),
        );
        const hadTabs = (state.terminalTabsByThreadKey[threadKey]?.length ?? 0) > 0;
        const pending = state.pendingTerminalIdsByThreadKey[threadKey] ?? {};
        const stillPending = Object.fromEntries(
          Object.entries(pending).filter(
            ([terminalId, since]) =>
              !listed.has(terminalId) && nowMs - since < PENDING_TERMINAL_TTL_MS,
          ),
        );
        const nextTerminalStateByThreadKey = updateTerminalStateByThreadKey(
          state.terminalStateByThreadKey,
          threadRef,
          (current) =>
            reconcileThreadTerminalIds(current, serverIds, stillPending, nowMs, {
              idleIds,
              hadTabs,
            }),
        );
        const visible = new Set(
          selectThreadTerminalState(nextTerminalStateByThreadKey, threadRef).terminalIds,
        );
        const prefix = `${threadKey}\u0000`;
        return {
          terminalStateByThreadKey: nextTerminalStateByThreadKey,
          terminalTabsByThreadKey: { ...state.terminalTabsByThreadKey, [threadKey]: tabs },
          pendingTerminalIdsByThreadKey: {
            ...state.pendingTerminalIdsByThreadKey,
            [threadKey]: stillPending,
          },
          // What a tab was running is gone with its shell (after a server
          // restart, its tabs come back with nothing running).
          ...pruneKeyedRecords(state, (key) => {
            if (!key.startsWith(prefix)) return false;
            const terminalId = key.slice(prefix.length);
            return !visible.has(terminalId) || idleIds.has(terminalId);
          }),
        };
      };

      return {
        terminalStateByThreadKey: {},
        terminalTabsByThreadKey: {},
        pendingTerminalIdsByThreadKey: {},
        terminalActivityCommandByKey: {},
        terminalActivityStartedAtByKey: {},
        terminalCommandPendingByKey: {},
        setTerminalOpen: (threadRef, open) =>
          set((state) => {
            const terminalStateByThreadKey = updateTerminalStateByThreadKey(
              state.terminalStateByThreadKey,
              threadRef,
              (current) => setThreadTerminalOpen(current, open),
            );
            if (terminalStateByThreadKey === state.terminalStateByThreadKey) return state;
            if (!open) return { terminalStateByThreadKey };
            // Opening a drawer that shows none of the server's tabs asks for a
            // shell: its first tab is made, not looked for.
            const thread = selectThreadTerminalState(terminalStateByThreadKey, threadRef);
            const listed = selectTerminalTabs(state.terminalTabsByThreadKey, threadRef);
            if (listed.some((tab) => thread.terminalIds.includes(tab.terminalId))) {
              return { terminalStateByThreadKey };
            }
            return {
              terminalStateByThreadKey,
              pendingTerminalIdsByThreadKey: withPendingTerminal(
                state.pendingTerminalIdsByThreadKey,
                threadRef,
                thread.activeTerminalId,
              ),
            };
          }),
        setTerminalHeight: (threadRef, height) =>
          updateTerminal(threadRef, (state) => setThreadTerminalHeight(state, height)),
        splitTerminal: (threadRef, terminalId) =>
          set((state) => ({
            pendingTerminalIdsByThreadKey: withPendingTerminal(
              state.pendingTerminalIdsByThreadKey,
              threadRef,
              terminalId,
            ),
            terminalStateByThreadKey: updateTerminalStateByThreadKey(
              state.terminalStateByThreadKey,
              threadRef,
              (current) => splitThreadTerminal(current, terminalId),
            ),
          })),
        newTerminal: (threadRef, terminalId) =>
          set((state) => ({
            pendingTerminalIdsByThreadKey: withPendingTerminal(
              state.pendingTerminalIdsByThreadKey,
              threadRef,
              terminalId,
            ),
            terminalStateByThreadKey: updateTerminalStateByThreadKey(
              state.terminalStateByThreadKey,
              threadRef,
              (current) => newThreadTerminal(current, terminalId),
            ),
          })),
        ensureTerminal: (threadRef, terminalId, options) =>
          set((state) => {
            const listed = selectTerminalTabs(state.terminalTabsByThreadKey, threadRef).some(
              (tab) => tab.terminalId === terminalId,
            );
            return {
              ...(listed
                ? {}
                : {
                    pendingTerminalIdsByThreadKey: withPendingTerminal(
                      state.pendingTerminalIdsByThreadKey,
                      threadRef,
                      terminalId,
                    ),
                  }),
              terminalStateByThreadKey: updateTerminalStateByThreadKey(
                state.terminalStateByThreadKey,
                threadRef,
                (current) => {
                  let nextState = current;
                  if (!current.terminalIds.includes(terminalId)) {
                    nextState = newThreadTerminal(nextState, terminalId);
                  }
                  if (options?.active === false) {
                    nextState = {
                      ...nextState,
                      activeTerminalId: current.activeTerminalId,
                      activeTerminalGroupId: current.activeTerminalGroupId,
                    };
                  }
                  if (options?.active ?? true) {
                    nextState = setThreadActiveTerminal(nextState, terminalId);
                  }
                  if (options?.open) {
                    nextState = setThreadTerminalOpen(nextState, true);
                  }
                  return normalizeThreadTerminalState(nextState);
                },
              ),
            };
          }),
        setActiveTerminal: (threadRef, terminalId) =>
          updateTerminal(threadRef, (state) => setThreadActiveTerminal(state, terminalId)),
        closeTerminal: (threadRef, terminalId) =>
          set((state) => {
            const key = terminalKey(threadRef, terminalId);
            const threadKey = terminalThreadKey(threadRef);
            const pending = state.pendingTerminalIdsByThreadKey[threadKey];
            return {
              terminalStateByThreadKey: updateTerminalStateByThreadKey(
                state.terminalStateByThreadKey,
                threadRef,
                (current) => closeThreadTerminal(current, terminalId),
              ),
              ...(pending?.[terminalId] !== undefined
                ? {
                    pendingTerminalIdsByThreadKey: {
                      ...state.pendingTerminalIdsByThreadKey,
                      [threadKey]: withoutKey(pending, terminalId),
                    },
                  }
                : {}),
              ...pruneKeyedRecords(state, (candidate) => candidate === key),
            };
          }),
        setTerminalActivity: (threadRef, terminalId, hasRunningSubprocess) =>
          updateTerminal(threadRef, (state) =>
            setThreadTerminalActivity(state, terminalId, hasRunningSubprocess),
          ),
        applyTerminalEvent: (threadRef, event) =>
          set((state) => {
            const key = terminalKey(threadRef, event.terminalId);
            if (
              event.type === "activity"
                ? event.hasRunningSubprocess || event.commandPending === true
                : event.type !== "output" && event.type !== "cleared"
            ) {
              lineEnteredAtByKey.delete(key);
            }
            let nextTerminalStateByThreadKey = state.terminalStateByThreadKey;
            let nextActivityCommandByKey = state.terminalActivityCommandByKey;
            let nextActivityStartedAtByKey = state.terminalActivityStartedAtByKey;
            let nextCommandPendingByKey = state.terminalCommandPendingByKey;

            const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
            if (hasRunningSubprocess !== null) {
              if (hasRunningSubprocess && event.type === "activity") {
                const command = event.command
                  ? normalizeSubmittedTerminalCommand(event.command)
                  : null;
                nextActivityCommandByKey =
                  command === null
                    ? withoutKey(nextActivityCommandByKey, key)
                    : nextActivityCommandByKey[key] === command
                      ? nextActivityCommandByKey
                      : { ...nextActivityCommandByKey, [key]: command };
                if (event.startedAt && nextActivityStartedAtByKey[key] !== event.startedAt) {
                  nextActivityStartedAtByKey = {
                    ...nextActivityStartedAtByKey,
                    [key]: event.startedAt,
                  };
                }
              } else {
                nextActivityCommandByKey = withoutKey(nextActivityCommandByKey, key);
                nextActivityStartedAtByKey = withoutKey(nextActivityStartedAtByKey, key);
              }
              // Activity is only news for tabs the drawer lists: a tab of
              // another device's (on a server without tab lists) isn't added.
              nextTerminalStateByThreadKey = updateTerminalStateByThreadKey(
                nextTerminalStateByThreadKey,
                threadRef,
                (current) =>
                  setThreadTerminalActivity(current, event.terminalId, hasRunningSubprocess),
              );
            }

            const pending =
              event.type === "activity" &&
              !event.hasRunningSubprocess &&
              event.commandPending === true;
            nextCommandPendingByKey = pending
              ? nextCommandPendingByKey[key]
                ? nextCommandPendingByKey
                : { ...nextCommandPendingByKey, [key]: true }
              : event.type === "output" || event.type === "cleared"
                ? nextCommandPendingByKey
                : withoutKey(nextCommandPendingByKey, key);

            if (event.type === "exited" || event.type === "error") {
              nextActivityCommandByKey = withoutKey(nextActivityCommandByKey, key);
              nextActivityStartedAtByKey = withoutKey(nextActivityStartedAtByKey, key);
            }

            if (
              nextTerminalStateByThreadKey === state.terminalStateByThreadKey &&
              nextActivityCommandByKey === state.terminalActivityCommandByKey &&
              nextActivityStartedAtByKey === state.terminalActivityStartedAtByKey &&
              nextCommandPendingByKey === state.terminalCommandPendingByKey
            ) {
              return state;
            }
            return {
              terminalStateByThreadKey: nextTerminalStateByThreadKey,
              terminalActivityCommandByKey: nextActivityCommandByKey,
              terminalActivityStartedAtByKey: nextActivityStartedAtByKey,
              terminalCommandPendingByKey: nextCommandPendingByKey,
            };
          }),
        applyTerminalCatalog: (environmentId, threads) =>
          set((state) => {
            const nowMs = Date.now();
            const tabsByThreadKey = new Map<string, ReadonlyArray<TerminalTab>>();
            for (const thread of threads) {
              tabsByThreadKey.set(
                terminalThreadKey({ environmentId, threadId: ThreadId.make(thread.threadId) }),
                thread.tabs,
              );
            }
            // Threads the server lists nothing for have no tabs there now.
            for (const threadKey of Object.keys(state.terminalStateByThreadKey)) {
              const threadRef = parseScopedThreadKey(threadKey);
              if (threadRef?.environmentId === environmentId && !tabsByThreadKey.has(threadKey)) {
                tabsByThreadKey.set(threadKey, EMPTY_TERMINAL_TABS);
              }
            }
            const next: TerminalStateStoreState = { ...state };
            for (const [threadKey, tabs] of tabsByThreadKey) {
              Object.assign(next, reconcileThread(next, threadKey, tabs, nowMs));
            }
            return next;
          }),
        applyTerminalTabs: (threadRef, tabs) =>
          set((state) => reconcileThread(state, terminalThreadKey(threadRef), tabs, Date.now())),
        clearTerminalState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const prefix = `${threadKey}\u0000`;
            const next = {
              terminalStateByThreadKey: updateTerminalStateByThreadKey(
                state.terminalStateByThreadKey,
                threadRef,
                () => createDefaultThreadTerminalState(),
              ),
              terminalTabsByThreadKey: withoutKey(state.terminalTabsByThreadKey, threadKey),
              pendingTerminalIdsByThreadKey: withoutKey(
                state.pendingTerminalIdsByThreadKey,
                threadKey,
              ),
              ...pruneKeyedRecords(state, (key) => key.startsWith(prefix)),
            };
            const unchanged =
              next.terminalStateByThreadKey === state.terminalStateByThreadKey &&
              next.terminalTabsByThreadKey === state.terminalTabsByThreadKey &&
              next.pendingTerminalIdsByThreadKey === state.pendingTerminalIdsByThreadKey &&
              Object.keys(next).length === 3;
            return unchanged ? state : next;
          }),
        removeTerminalState: (threadRef) =>
          set((state) => {
            const threadKey = terminalThreadKey(threadRef);
            const prefix = `${threadKey}\u0000`;
            return {
              terminalStateByThreadKey: withoutKey(state.terminalStateByThreadKey, threadKey),
              terminalTabsByThreadKey: withoutKey(state.terminalTabsByThreadKey, threadKey),
              pendingTerminalIdsByThreadKey: withoutKey(
                state.pendingTerminalIdsByThreadKey,
                threadKey,
              ),
              ...pruneKeyedRecords(state, (key) => key.startsWith(prefix)),
            };
          }),
        removeOrphanedTerminalStates: (activeThreadKeys) =>
          set((state) => {
            const orphaned = (threadKey: string) => !activeThreadKeys.has(threadKey);
            const { entries: terminalStateByThreadKey, removed: removedStates } =
              removeKeyedEntries(state.terminalStateByThreadKey, orphaned);
            const { entries: terminalTabsByThreadKey, removed: removedTabs } = removeKeyedEntries(
              state.terminalTabsByThreadKey,
              orphaned,
            );
            const keyed = pruneKeyedRecords(state, (key) => {
              const [threadKey] = key.split("\u0000");
              return threadKey !== undefined && orphaned(threadKey);
            });
            if (!removedStates && !removedTabs && Object.keys(keyed).length === 0) {
              return state;
            }
            return {
              terminalStateByThreadKey,
              terminalTabsByThreadKey,
              ...keyed,
            };
          }),
      };
    },
    {
      name: TERMINAL_STATE_STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(createTerminalStateStorage),
      migrate: migratePersistedTerminalStateStoreState,
      partialize: (state) => ({
        terminalStateByThreadKey: state.terminalStateByThreadKey,
      }),
    },
  ),
);

import { Debouncer } from "@tanstack/react-pacer";
import { create } from "zustand";

export const PERSISTED_STATE_KEY = "threadlines:ui-state:v1";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:ui-state:v1",
  "t3code:renderer-state:v8",
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;

export interface PersistedUiState {
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  defaultAdvertisedEndpointKey?: string | null;
  threadChangedFilesExpandedById?: Record<string, Record<string, boolean>>;
  /**
   * Legacy: inbox lifecycle state lived here before it moved onto the thread
   * on the server, which is why a phone and a desktop disagreed about the
   * Active/Wrapped split. Read once for migration, never written again.
   */
  doneThreadOverrides?: Record<string, { state: "done" | "active"; at: string }>;
  /** Legacy, see `doneThreadOverrides`. */
  threadLastVisitedAtById?: Record<string, string>;
  inboxProjectScopeKey?: string | null;
  inboxEnvironmentScopeId?: string | null;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
}

/**
 * An unconfirmed local write to server-held thread lifecycle state. It shows
 * instantly, then retires: `baselineAt` is the server value at the moment the
 * write was made, so once the server moves off that baseline the write has
 * either landed or been superseded, and the overlay stops speaking either way.
 * Nothing here survives a reload -- the server holds the truth.
 */
export interface ThreadOverlayWrite {
  readonly at: string;
  readonly baselineAt: string | null;
  /** True once the dispatch resolved; only settled overlays are retired. */
  readonly settled: boolean;
}

export interface ThreadDoneOverlayWrite extends ThreadOverlayWrite {
  readonly state: "done" | "active";
}

export interface UiThreadState {
  /** Unconfirmed local "seen" writes, by scoped thread key. */
  seenThreadOverlays: Record<string, ThreadOverlayWrite>;
  /**
   * Seen-as-of stamp for threads the server has no visit recorded for,
   * captured the first time this device sees the thread so a backlog does not
   * arrive all-unread. Frozen once set; any server value supersedes it.
   */
  threadSeedVisitedAtById: Record<string, string>;
  threadChangedFilesExpandedById: Record<string, Record<string, boolean>>;
}

export interface UiInboxState {
  /**
   * Unconfirmed local Mark done / Reopen writes, by scoped thread key. The
   * confirmed word lives on the thread itself (`doneOverride`) so every device
   * sees it; this only covers the gap until the server echoes the write back.
   * An override never decides on its own -- isThreadDone resolves it against
   * the thread's live state, so activity blockers always win.
   */
  doneThreadOverlays: Record<string, ThreadDoneOverlayWrite>;
  /** Which project chip is selected; null is All. */
  inboxProjectScopeKey: string | null;
  /** Which machine the list is narrowed to; null is All machines. */
  inboxEnvironmentScopeId: string | null;
}

export interface UiEndpointState {
  defaultAdvertisedEndpointKey: string | null;
}

export interface UiState extends UiProjectState, UiThreadState, UiInboxState, UiEndpointState {}

export interface SyncProjectInput {
  /** Physical project key (env + cwd). Used for manual sort order. */
  key: string;
  /** Logical group key. Used for expand/collapse state. */
  logicalKey: string;
  cwd: string;
}

export interface SyncThreadInput {
  key: string;
  seedVisitedAt?: string | undefined;
  /** Current server-held stamps, used to retire settled overlays. */
  serverLastSeenAt?: string | null | undefined;
  serverDoneOverrideAt?: string | null | undefined;
}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  seenThreadOverlays: {},
  threadSeedVisitedAtById: {},
  threadChangedFilesExpandedById: {},
  doneThreadOverlays: {},
  inboxProjectScopeKey: null,
  inboxEnvironmentScopeId: null,
  defaultAdvertisedEndpointKey: null,
};

const persistedCollapsedProjectCwds = new Set<string>();
const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
// Pre-fix persisted shape only listed expanded cwds, so anything not listed
// was treated as collapsed. Track whether the loaded blob carried the new
// `collapsedProjectCwds` field so we can preserve that legacy semantic for
// one session after upgrade, until persistState rewrites in the new shape.
let persistedProjectStateUsesLegacyShape = false;
const currentProjectCwdById = new Map<string, string>();
const currentProjectCwdsByLogicalKey = new Map<string, string[]>();
const currentLogicalKeyByPhysicalKey = new Map<string, string>();
let legacyKeysCleanedUp = false;

export function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        hydratePersistedProjectState(JSON.parse(legacyRaw) as PersistedUiState);
        return initialState;
      }
      return initialState;
    }
    const parsed = JSON.parse(raw) as PersistedUiState;
    hydratePersistedProjectState(parsed);
    return {
      ...initialState,
      defaultAdvertisedEndpointKey:
        typeof parsed.defaultAdvertisedEndpointKey === "string" &&
        parsed.defaultAdvertisedEndpointKey.length > 0
          ? parsed.defaultAdvertisedEndpointKey
          : null,
      threadChangedFilesExpandedById: sanitizePersistedThreadChangedFilesExpanded(
        parsed.threadChangedFilesExpandedById,
      ),
      inboxProjectScopeKey:
        typeof parsed.inboxProjectScopeKey === "string" && parsed.inboxProjectScopeKey.length > 0
          ? parsed.inboxProjectScopeKey
          : null,
      inboxEnvironmentScopeId:
        typeof parsed.inboxEnvironmentScopeId === "string" &&
        parsed.inboxEnvironmentScopeId.length > 0
          ? parsed.inboxEnvironmentScopeId
          : null,
    };
  } catch {
    return initialState;
  }
}

/**
 * The inbox lifecycle state a pre-sync build left in localStorage. Returned
 * for one-time migration onto the server; see `migrateLegacyInboxState`.
 */
export function readLegacyInboxState(): {
  doneThreadOverrides: Record<string, { state: "done" | "active"; at: string }>;
  threadLastVisitedAtById: Record<string, string>;
} {
  if (typeof window === "undefined") {
    return { doneThreadOverrides: {}, threadLastVisitedAtById: {} };
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      return { doneThreadOverrides: {}, threadLastVisitedAtById: {} };
    }
    const parsed = JSON.parse(raw) as PersistedUiState;
    return {
      doneThreadOverrides: sanitizePersistedDoneOverrides(parsed.doneThreadOverrides),
      threadLastVisitedAtById: sanitizePersistedVisitedAt(parsed.threadLastVisitedAtById),
    };
  } catch {
    return { doneThreadOverrides: {}, threadLastVisitedAtById: {} };
  }
}

/**
 * Drop the given threads' legacy inbox entries once the server holds them.
 * Scoped to specific keys because the legacy blob spans every environment and
 * migration runs per environment -- clearing it wholesale would throw away
 * entries belonging to an environment that has not connected yet.
 */
export function dropLegacyInboxState(threadKeys: readonly string[]): void {
  if (typeof window === "undefined" || threadKeys.length === 0) {
    return;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as PersistedUiState;
    const dropped = new Set(threadKeys);
    const pruneRecord = <T>(record: Record<string, T> | undefined) => {
      if (record === undefined || record === null || typeof record !== "object") {
        return undefined;
      }
      const next = Object.fromEntries(
        Object.entries(record).filter(([threadKey]) => !dropped.has(threadKey)),
      );
      return Object.keys(next).length > 0 ? next : undefined;
    };
    const nextDoneThreadOverrides = pruneRecord(parsed.doneThreadOverrides);
    const nextThreadLastVisitedAtById = pruneRecord(parsed.threadLastVisitedAtById);
    const { doneThreadOverrides: _done, threadLastVisitedAtById: _visited, ...rest } = parsed;
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        ...rest,
        ...(nextDoneThreadOverrides ? { doneThreadOverrides: nextDoneThreadOverrides } : {}),
        ...(nextThreadLastVisitedAtById
          ? { threadLastVisitedAtById: nextThreadLastVisitedAtById }
          : {}),
      } satisfies PersistedUiState),
    );
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

function sanitizePersistedVisitedAt(
  value: PersistedUiState["threadLastVisitedAtById"],
): Record<string, string> {
  if (value === undefined || value === null || typeof value !== "object") {
    return {};
  }
  const sanitized: Record<string, string> = {};
  for (const [key, at] of Object.entries(value)) {
    if (typeof key === "string" && key.length > 0 && typeof at === "string" && at.length > 0) {
      sanitized[key] = at;
    }
  }
  return sanitized;
}

function sanitizePersistedDoneOverrides(
  value: PersistedUiState["doneThreadOverrides"],
): Record<string, { state: "done" | "active"; at: string }> {
  if (value === undefined || value === null || typeof value !== "object") {
    return {};
  }
  const sanitized: Record<string, { state: "done" | "active"; at: string }> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof key === "string" &&
      key.length > 0 &&
      entry !== null &&
      typeof entry === "object" &&
      (entry.state === "done" || entry.state === "active") &&
      typeof entry.at === "string"
    ) {
      sanitized[key] = { state: entry.state, at: entry.at };
    }
  }
  return sanitized;
}

function sanitizePersistedThreadChangedFilesExpanded(
  value: PersistedUiState["threadChangedFilesExpandedById"],
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextState: Record<string, Record<string, boolean>> = {};
  for (const [threadId, turns] of Object.entries(value)) {
    if (!threadId || !turns || typeof turns !== "object") {
      continue;
    }

    const nextTurns: Record<string, boolean> = {};
    for (const [turnId, expanded] of Object.entries(turns)) {
      if (turnId && typeof expanded === "boolean") {
        nextTurns[turnId] = expanded;
      }
    }

    if (Object.keys(nextTurns).length > 0) {
      nextState[threadId] = nextTurns;
    }
  }

  return nextState;
}

export function hydratePersistedProjectState(parsed: PersistedUiState): void {
  persistedCollapsedProjectCwds.clear();
  persistedExpandedProjectCwds.clear();
  persistedProjectOrderCwds.length = 0;
  persistedProjectStateUsesLegacyShape = !Array.isArray(parsed.collapsedProjectCwds);
  for (const cwd of parsed.collapsedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedCollapsedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.expandedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedExpandedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.projectOrderCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwds.includes(cwd)) {
      persistedProjectOrderCwds.push(cwd);
    }
  }
}

export function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    // Persist collapsed cwds explicitly so an empty/missing field unambiguously
    // means "first install" rather than "user collapsed everything"; without
    // this, the syncProjects fallback would re-expand all rows on next launch.
    const collapsedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => !expanded)
      .flatMap(([logicalKey]) => currentProjectCwdsByLogicalKey.get(logicalKey) ?? []);
    const expandedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => expanded)
      .flatMap(([logicalKey]) => currentProjectCwdsByLogicalKey.get(logicalKey) ?? []);
    const projectOrderCwds = state.projectOrder.flatMap((projectId) => {
      const cwd = currentProjectCwdById.get(projectId);
      return cwd ? [cwd] : [];
    });
    const threadChangedFilesExpandedById = Object.fromEntries(
      Object.entries(state.threadChangedFilesExpandedById).flatMap(([threadId, turns]) => {
        const nextTurns = Object.fromEntries(
          Object.entries(turns).filter(([, expanded]) => typeof expanded === "boolean"),
        );
        return Object.keys(nextTurns).length > 0 ? [[threadId, nextTurns]] : [];
      }),
    );
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        collapsedProjectCwds,
        expandedProjectCwds,
        projectOrderCwds,
        defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
        threadChangedFilesExpandedById,
        inboxProjectScopeKey: state.inboxProjectScopeKey,
        inboxEnvironmentScopeId: state.inboxEnvironmentScopeId,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

function recordsEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (right[key] !== value) {
      return false;
    }
  }
  return true;
}

function orderedListsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function nestedBooleanRecordsEqual(
  left: Record<string, Record<string, boolean>>,
  right: Record<string, Record<string, boolean>>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (!(key in right) || !recordsEqual(value, right[key]!)) {
      return false;
    }
  }
  return true;
}

export function syncProjects(state: UiState, projects: readonly SyncProjectInput[]): UiState {
  const previousProjectCwdById = new Map(currentProjectCwdById);
  const previousLogicalKeyByPhysicalKey = new Map(currentLogicalKeyByPhysicalKey);
  currentProjectCwdById.clear();
  currentLogicalKeyByPhysicalKey.clear();
  for (const project of projects) {
    currentProjectCwdById.set(project.key, project.cwd);
    currentLogicalKeyByPhysicalKey.set(project.key, project.logicalKey);
  }
  currentProjectCwdsByLogicalKey.clear();
  for (const project of projects) {
    const cwds = currentProjectCwdsByLogicalKey.get(project.logicalKey);
    if (cwds) {
      if (!cwds.includes(project.cwd)) {
        cwds.push(project.cwd);
      }
    } else {
      currentProjectCwdsByLogicalKey.set(project.logicalKey, [project.cwd]);
    }
  }
  // Build reverse map: for each new logical key, which previous logical keys
  // did its member projects live under? Lets us preserve expand state when a
  // project's logical key changes (e.g. late-arriving repo metadata flips the
  // group identity).
  const previousLogicalKeysByNewLogicalKey = new Map<string, Set<string>>();
  for (const project of projects) {
    const previousLogicalKey = previousLogicalKeyByPhysicalKey.get(project.key);
    if (!previousLogicalKey || previousLogicalKey === project.logicalKey) {
      continue;
    }
    const set = previousLogicalKeysByNewLogicalKey.get(project.logicalKey);
    if (set) {
      set.add(previousLogicalKey);
    } else {
      previousLogicalKeysByNewLogicalKey.set(project.logicalKey, new Set([previousLogicalKey]));
    }
  }
  const cwdMappingChanged =
    previousProjectCwdById.size !== currentProjectCwdById.size ||
    projects.some((project) => previousProjectCwdById.get(project.key) !== project.cwd);

  const nextExpandedById: Record<string, boolean> = {};
  const previousExpandedById = state.projectExpandedById;
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const mappedProjects = projects.map((project, index) => {
    if (!(project.logicalKey in nextExpandedById)) {
      const groupCwds = currentProjectCwdsByLogicalKey.get(project.logicalKey) ?? [project.cwd];
      const fallbackFromPreviousLogicalKey = (() => {
        const previousKeys = previousLogicalKeysByNewLogicalKey.get(project.logicalKey);
        if (!previousKeys) {
          return undefined;
        }
        for (const previousKey of previousKeys) {
          if (previousKey in previousExpandedById) {
            return previousExpandedById[previousKey];
          }
        }
        return undefined;
      })();
      const fallbackFromPersistedShape = (() => {
        if (groupCwds.some((cwd) => persistedExpandedProjectCwds.has(cwd))) {
          return true;
        }
        if (groupCwds.some((cwd) => persistedCollapsedProjectCwds.has(cwd))) {
          return false;
        }
        if (persistedProjectStateUsesLegacyShape && persistedExpandedProjectCwds.size > 0) {
          return false;
        }
        return true;
      })();
      const expanded =
        previousExpandedById[project.logicalKey] ??
        fallbackFromPreviousLogicalKey ??
        fallbackFromPersistedShape;
      nextExpandedById[project.logicalKey] = expanded;
    }
    return {
      id: project.key,
      cwd: project.cwd,
      incomingIndex: index,
    };
  });

  const nextProjectOrder =
    state.projectOrder.length > 0
      ? (() => {
          const currentProjectIds = new Set(mappedProjects.map((project) => project.id));
          const nextProjectIdByCwd = new Map(
            mappedProjects.map((project) => [project.cwd, project.id] as const),
          );
          const usedProjectIds = new Set<string>();
          const orderedProjectIds: string[] = [];

          for (const projectId of state.projectOrder) {
            const matchedProjectId =
              (currentProjectIds.has(projectId) ? projectId : undefined) ??
              (() => {
                const previousCwd = previousProjectCwdById.get(projectId);
                return previousCwd ? nextProjectIdByCwd.get(previousCwd) : undefined;
              })();
            if (!matchedProjectId || usedProjectIds.has(matchedProjectId)) {
              continue;
            }
            usedProjectIds.add(matchedProjectId);
            orderedProjectIds.push(matchedProjectId);
          }

          for (const project of mappedProjects) {
            if (usedProjectIds.has(project.id)) {
              continue;
            }
            orderedProjectIds.push(project.id);
          }

          return orderedProjectIds;
        })()
      : mappedProjects
          .map((project) => ({
            id: project.id,
            incomingIndex: project.incomingIndex,
            orderIndex:
              persistedOrderByCwd.get(project.cwd) ??
              persistedProjectOrderCwds.length + project.incomingIndex,
          }))
          .toSorted((left, right) => {
            const byOrder = left.orderIndex - right.orderIndex;
            if (byOrder !== 0) {
              return byOrder;
            }
            return left.incomingIndex - right.incomingIndex;
          })
          .map((project) => project.id);

  if (
    recordsEqual(state.projectExpandedById, nextExpandedById) &&
    orderedListsEqual(state.projectOrder, nextProjectOrder) &&
    !cwdMappingChanged
  ) {
    return state;
  }

  return {
    ...state,
    projectExpandedById: nextExpandedById,
    projectOrder: nextProjectOrder,
  };
}

/**
 * Whether a settled overlay has done its job. The write is only made when it
 * would change what the server holds, so the server value moving off the
 * baseline means the write either landed or was overtaken by another device;
 * either way the server is now the better answer.
 */
function shouldRetireOverlay(
  overlay: ThreadOverlayWrite,
  serverAt: string | null | undefined,
): boolean {
  return overlay.settled && (serverAt ?? null) !== overlay.baselineAt;
}

export function syncThreads(state: UiState, threads: readonly SyncThreadInput[]): UiState {
  const retainedThreadKeys = new Set(threads.map((thread) => thread.key));

  const nextSeedVisitedAtById = Object.fromEntries(
    Object.entries(state.threadSeedVisitedAtById).filter(([threadKey]) =>
      retainedThreadKeys.has(threadKey),
    ),
  );
  for (const thread of threads) {
    if (
      nextSeedVisitedAtById[thread.key] === undefined &&
      thread.seedVisitedAt !== undefined &&
      thread.seedVisitedAt.length > 0
    ) {
      nextSeedVisitedAtById[thread.key] = thread.seedVisitedAt;
    }
  }

  const serverSeenAtByKey = new Map(
    threads.map((thread) => [thread.key, thread.serverLastSeenAt ?? null] as const),
  );
  const serverDoneAtByKey = new Map(
    threads.map((thread) => [thread.key, thread.serverDoneOverrideAt ?? null] as const),
  );
  const nextSeenThreadOverlays = Object.fromEntries(
    Object.entries(state.seenThreadOverlays).filter(
      ([threadKey, overlay]) =>
        retainedThreadKeys.has(threadKey) &&
        !shouldRetireOverlay(overlay, serverSeenAtByKey.get(threadKey)),
    ),
  );
  const nextDoneThreadOverlays = Object.fromEntries(
    Object.entries(state.doneThreadOverlays).filter(
      ([threadKey, overlay]) =>
        retainedThreadKeys.has(threadKey) &&
        !shouldRetireOverlay(overlay, serverDoneAtByKey.get(threadKey)),
    ),
  );

  const nextThreadChangedFilesExpandedById = Object.fromEntries(
    Object.entries(state.threadChangedFilesExpandedById).filter(([threadKey]) =>
      retainedThreadKeys.has(threadKey),
    ),
  );
  if (
    recordsEqual(state.threadSeedVisitedAtById, nextSeedVisitedAtById) &&
    recordsEqual(state.seenThreadOverlays, nextSeenThreadOverlays) &&
    recordsEqual(state.doneThreadOverlays, nextDoneThreadOverlays) &&
    nestedBooleanRecordsEqual(
      state.threadChangedFilesExpandedById,
      nextThreadChangedFilesExpandedById,
    )
  ) {
    return state;
  }
  return {
    ...state,
    threadSeedVisitedAtById: nextSeedVisitedAtById,
    seenThreadOverlays: nextSeenThreadOverlays,
    doneThreadOverlays: nextDoneThreadOverlays,
    threadChangedFilesExpandedById: nextThreadChangedFilesExpandedById,
  };
}

/**
 * Show the user's word on a thread's lifecycle before the server has echoed
 * it back. The stamp is the caller's, because the same stamp is sent to the
 * server -- overlay and confirmed value must agree or the row would move
 * twice.
 */
export function setDoneOverlay(
  state: UiState,
  threadKey: string,
  overlay: ThreadDoneOverlayWrite,
): UiState {
  return {
    ...state,
    doneThreadOverlays: { ...state.doneThreadOverlays, [threadKey]: overlay },
  };
}

export function setSeenOverlay(
  state: UiState,
  threadKey: string,
  overlay: ThreadOverlayWrite,
): UiState {
  return {
    ...state,
    seenThreadOverlays: { ...state.seenThreadOverlays, [threadKey]: overlay },
  };
}

/**
 * Close out a dispatched overlay write. A confirmed write stands until the
 * server value moves off its baseline; a failed one is dropped immediately,
 * so a dead connection can never strand the row in a state the server has
 * never heard of.
 */
export function resolveDoneOverlay(
  state: UiState,
  threadKey: string,
  at: string,
  outcome: "confirmed" | "failed",
): UiState {
  const overlay = state.doneThreadOverlays[threadKey];
  if (overlay === undefined || overlay.at !== at) {
    return state;
  }
  const nextOverlays = { ...state.doneThreadOverlays };
  if (outcome === "failed") {
    delete nextOverlays[threadKey];
  } else {
    nextOverlays[threadKey] = { ...overlay, settled: true };
  }
  return { ...state, doneThreadOverlays: nextOverlays };
}

export function resolveSeenOverlay(
  state: UiState,
  threadKey: string,
  at: string,
  outcome: "confirmed" | "failed",
): UiState {
  const overlay = state.seenThreadOverlays[threadKey];
  if (overlay === undefined || overlay.at !== at) {
    return state;
  }
  const nextOverlays = { ...state.seenThreadOverlays };
  if (outcome === "failed") {
    delete nextOverlays[threadKey];
  } else {
    nextOverlays[threadKey] = { ...overlay, settled: true };
  }
  return { ...state, seenThreadOverlays: nextOverlays };
}

export function clearThreadUi(state: UiState, threadKey: string): UiState {
  const hasSeenOverlay = threadKey in state.seenThreadOverlays;
  const hasDoneOverlay = threadKey in state.doneThreadOverlays;
  const hasSeedState = threadKey in state.threadSeedVisitedAtById;
  const hasChangedFilesState = threadKey in state.threadChangedFilesExpandedById;
  if (!hasSeenOverlay && !hasDoneOverlay && !hasSeedState && !hasChangedFilesState) {
    return state;
  }
  const nextSeenThreadOverlays = { ...state.seenThreadOverlays };
  const nextDoneThreadOverlays = { ...state.doneThreadOverlays };
  const nextSeedVisitedAtById = { ...state.threadSeedVisitedAtById };
  const nextThreadChangedFilesExpandedById = { ...state.threadChangedFilesExpandedById };
  delete nextSeenThreadOverlays[threadKey];
  delete nextDoneThreadOverlays[threadKey];
  delete nextSeedVisitedAtById[threadKey];
  delete nextThreadChangedFilesExpandedById[threadKey];
  return {
    ...state,
    seenThreadOverlays: nextSeenThreadOverlays,
    doneThreadOverlays: nextDoneThreadOverlays,
    threadSeedVisitedAtById: nextSeedVisitedAtById,
    threadChangedFilesExpandedById: nextThreadChangedFilesExpandedById,
  };
}

export function setThreadChangedFilesExpanded(
  state: UiState,
  threadId: string,
  turnId: string,
  expanded: boolean,
  defaultExpanded: boolean,
): UiState {
  const currentThreadState = state.threadChangedFilesExpandedById[threadId] ?? {};
  const currentExpanded = currentThreadState[turnId] ?? defaultExpanded;
  if (currentExpanded === expanded) {
    return state;
  }

  if (expanded === defaultExpanded) {
    if (!(turnId in currentThreadState)) {
      return state;
    }

    const nextThreadState = { ...currentThreadState };
    delete nextThreadState[turnId];
    if (Object.keys(nextThreadState).length === 0) {
      const nextState = { ...state.threadChangedFilesExpandedById };
      delete nextState[threadId];
      return {
        ...state,
        threadChangedFilesExpandedById: nextState,
      };
    }

    return {
      ...state,
      threadChangedFilesExpandedById: {
        ...state.threadChangedFilesExpandedById,
        [threadId]: nextThreadState,
      },
    };
  }

  return {
    ...state,
    threadChangedFilesExpandedById: {
      ...state.threadChangedFilesExpandedById,
      [threadId]: {
        ...currentThreadState,
        [turnId]: expanded,
      },
    },
  };
}

export function setDefaultAdvertisedEndpointKey(state: UiState, key: string | null): UiState {
  const nextKey = key && key.length > 0 ? key : null;
  if (state.defaultAdvertisedEndpointKey === nextKey) {
    return state;
  }
  return {
    ...state,
    defaultAdvertisedEndpointKey: nextKey,
  };
}

export function toggleProject(state: UiState, projectId: string): UiState {
  const expanded = state.projectExpandedById[projectId] ?? true;
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: !expanded,
    },
  };
}

export function setProjectExpanded(state: UiState, projectId: string, expanded: boolean): UiState {
  if ((state.projectExpandedById[projectId] ?? true) === expanded) {
    return state;
  }
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: expanded,
    },
  };
}

export function reorderProjects(
  state: UiState,
  draggedProjectIds: readonly string[],
  targetProjectIds: readonly string[],
): UiState {
  if (draggedProjectIds.length === 0) {
    return state;
  }
  const draggedSet = new Set(draggedProjectIds);
  const targetSet = new Set(targetProjectIds);
  if (draggedProjectIds.every((id) => targetSet.has(id))) {
    return state;
  }

  const originalTargetIndex = state.projectOrder.findIndex((id) => targetSet.has(id));
  if (originalTargetIndex < 0) {
    return state;
  }

  const projectOrder = [...state.projectOrder];

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = projectOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(projectOrder[i]!)) {
      removed.unshift(projectOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return state;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  projectOrder.splice(insertIndex, 0, ...removed);
  return {
    ...state,
    projectOrder,
  };
}

interface UiStateStore extends UiState {
  syncProjects: (projects: readonly SyncProjectInput[]) => void;
  syncThreads: (threads: readonly SyncThreadInput[]) => void;
  setDoneOverlay: (threadKey: string, overlay: ThreadDoneOverlayWrite) => void;
  setSeenOverlay: (threadKey: string, overlay: ThreadOverlayWrite) => void;
  resolveDoneOverlay: (threadKey: string, at: string, outcome: "confirmed" | "failed") => void;
  resolveSeenOverlay: (threadKey: string, at: string, outcome: "confirmed" | "failed") => void;
  setInboxProjectScope: (projectKey: string | null) => void;
  setInboxEnvironmentScope: (environmentId: string | null) => void;
  clearThreadUi: (threadKey: string) => void;
  setThreadChangedFilesExpanded: (
    threadId: string,
    turnId: string,
    expanded: boolean,
    defaultExpanded: boolean,
  ) => void;
  setDefaultAdvertisedEndpointKey: (key: string | null) => void;
  toggleProject: (projectId: string) => void;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  reorderProjects: (
    draggedProjectIds: readonly string[],
    targetProjectIds: readonly string[],
  ) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  syncProjects: (projects) => set((state) => syncProjects(state, projects)),
  syncThreads: (threads) => set((state) => syncThreads(state, threads)),
  setDoneOverlay: (threadKey, overlay) => set((state) => setDoneOverlay(state, threadKey, overlay)),
  setSeenOverlay: (threadKey, overlay) => set((state) => setSeenOverlay(state, threadKey, overlay)),
  resolveDoneOverlay: (threadKey, at, outcome) =>
    set((state) => resolveDoneOverlay(state, threadKey, at, outcome)),
  resolveSeenOverlay: (threadKey, at, outcome) =>
    set((state) => resolveSeenOverlay(state, threadKey, at, outcome)),
  setInboxProjectScope: (projectKey) =>
    set((state) =>
      state.inboxProjectScopeKey === projectKey
        ? state
        : { ...state, inboxProjectScopeKey: projectKey },
    ),
  setInboxEnvironmentScope: (environmentId) =>
    set((state) =>
      state.inboxEnvironmentScopeId === environmentId
        ? state
        : { ...state, inboxEnvironmentScopeId: environmentId },
    ),
  clearThreadUi: (threadKey) => set((state) => clearThreadUi(state, threadKey)),
  setThreadChangedFilesExpanded: (threadId, turnId, expanded, defaultExpanded) =>
    set((state) =>
      setThreadChangedFilesExpanded(state, threadId, turnId, expanded, defaultExpanded),
    ),
  setDefaultAdvertisedEndpointKey: (key) =>
    set((state) => setDefaultAdvertisedEndpointKey(state, key)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  reorderProjects: (draggedProjectIds, targetProjectIds) =>
    set((state) => reorderProjects(state, draggedProjectIds, targetProjectIds)),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}

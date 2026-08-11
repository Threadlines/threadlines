import { MessageId, TurnId } from "@threadlines/contracts";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffMode?: "workingTree" | undefined;
  sourceControl?: "1" | "0" | undefined;
  /** The agents panel shares the right-panel slot with source control, so it
   *  carries the same explicit open/closed tri-state. */
  agents?: "1" | "0" | undefined;
  sourceControlReturn?: "1" | undefined;
  diffTurnId?: TurnId | undefined;
  diffFilePath?: string | undefined;
  focusMessageId?: MessageId | undefined;
  focusQuery?: string | undefined;
  focusRequest?: string | undefined;
}

function isDiffOpenValue(value: unknown): boolean {
  return value === "1" || value === 1 || value === true;
}

function isExplicitClosedValue(value: unknown): boolean {
  return value === "0" || value === 0 || value === false;
}

function normalizeSearchString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function stripDiffSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, "diff" | "diffMode" | "diffTurnId" | "diffFilePath"> & {
  diff?: undefined;
  diffMode?: undefined;
  diffTurnId?: undefined;
  diffFilePath?: undefined;
} {
  const {
    diff: _diff,
    diffMode: _diffMode,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    ...rest
  } = params;
  return {
    ...rest,
    diff: undefined,
    diffMode: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
  } as Omit<T, "diff" | "diffMode" | "diffTurnId" | "diffFilePath"> & {
    diff?: undefined;
    diffMode?: undefined;
    diffTurnId?: undefined;
    diffFilePath?: undefined;
  };
}

type RightPanelSearchKey =
  | "diff"
  | "diffMode"
  | "sourceControl"
  | "agents"
  | "sourceControlReturn"
  | "diffTurnId"
  | "diffFilePath";

interface ClearedRightPanelSearchParams {
  diff?: undefined;
  diffMode?: undefined;
  sourceControl?: undefined;
  agents?: undefined;
  sourceControlReturn?: undefined;
  diffTurnId?: undefined;
  diffFilePath?: undefined;
}

/**
 * The right panel is one slot: opening any panel in it clears the others, so
 * every "open panel X" navigation starts from this.
 */
export function stripRightPanelSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, RightPanelSearchKey> & ClearedRightPanelSearchParams {
  const {
    diff: _diff,
    diffMode: _diffMode,
    sourceControl: _sourceControl,
    agents: _agents,
    sourceControlReturn: _sourceControlReturn,
    diffTurnId: _diffTurnId,
    diffFilePath: _diffFilePath,
    ...rest
  } = params;
  return {
    ...rest,
    diff: undefined,
    diffMode: undefined,
    sourceControl: undefined,
    agents: undefined,
    sourceControlReturn: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
  } as Omit<T, RightPanelSearchKey> & ClearedRightPanelSearchParams;
}

export function closeRightPanelSearchParams<T extends Record<string, unknown>>(params: T) {
  return {
    ...stripRightPanelSearchParams(params),
    sourceControl: "0" as const,
  };
}

/**
 * Closing the agents panel only records that the agents panel is closed. The
 * slot then falls back to whatever source control would show on its own, which
 * is the state the thread was in before the panel was opened.
 */
export function closeAgentsPanelSearchParams<T extends Record<string, unknown>>(params: T) {
  return {
    ...stripRightPanelSearchParams(params),
    agents: "0" as const,
  };
}

/**
 * Navigating into a draft carries only explicit panel state (`sourceControl`
 * set to "1" or "0" by a user toggle or deep link). Implicit defaults are not
 * baked into the URL; the destination route applies its own default.
 */
export function preserveRightPanelSearchParamsForDraftNavigation<T extends Record<string, unknown>>(
  params: T,
) {
  const { sourceControl, agents } = parseDiffRouteSearch(params);
  const stripped = stripRightPanelSearchParams(params);
  return {
    ...stripped,
    ...(sourceControl ? { sourceControl } : {}),
    ...(agents ? { agents } : {}),
  };
}

/**
 * Closed unless asked for. Explicit URL state (a toggle press or a deep link)
 * always wins; `defaultOpen` only decides what a thread with no panel state
 * shows. UI code should not call this directly — `useSourceControlPanelOpen`
 * in rightPanelLayout.ts is the single place that resolves `defaultOpen` from
 * the user's setting and the layout, so every surface agrees.
 */
export function isSourceControlPanelOpen(
  search: DiffRouteSearch,
  options: { defaultOpen?: boolean } = {},
): boolean {
  // An open agents panel holds the slot, so it also suppresses a source
  // control panel that would otherwise open from its default.
  if (search.diff === "1" || search.sourceControl === "0" || search.agents === "1") {
    return false;
  }
  if (search.sourceControl === "1") {
    return true;
  }
  return options.defaultOpen ?? false;
}

/**
 * Closed unless asked for, like source control, but with no settings default
 * behind it — the agents panel only opens when something opens it. Callers go
 * through `useAgentsPanelOpen` in rightPanelLayout.ts so the routes and the
 * header chip agree.
 */
export function isAgentsPanelOpen(
  search: DiffRouteSearch,
  options: { defaultOpen?: boolean } = {},
): boolean {
  if (search.diff === "1" || search.agents === "0") {
    return false;
  }
  if (search.agents === "1") {
    return true;
  }
  return options.defaultOpen ?? false;
}

export function parseDiffRouteSearch(search: Record<string, unknown>): DiffRouteSearch {
  const diff = isDiffOpenValue(search.diff) ? "1" : undefined;
  const diffMode = diff && search.diffMode === "workingTree" ? "workingTree" : undefined;
  const sourceControl =
    !diff && isDiffOpenValue(search.sourceControl)
      ? "1"
      : !diff && isExplicitClosedValue(search.sourceControl)
        ? "0"
        : undefined;
  const agents =
    !diff && isDiffOpenValue(search.agents)
      ? "1"
      : !diff && isExplicitClosedValue(search.agents)
        ? "0"
        : undefined;
  const sourceControlReturn = diff && isDiffOpenValue(search.sourceControlReturn) ? "1" : undefined;
  const diffTurnIdRaw =
    diff && diffMode !== "workingTree" ? normalizeSearchString(search.diffTurnId) : undefined;
  const diffTurnId = diffTurnIdRaw ? TurnId.make(diffTurnIdRaw) : undefined;
  const diffFilePath = diff ? normalizeSearchString(search.diffFilePath) : undefined;
  const focusMessageIdRaw = normalizeSearchString(search.focusMessageId);
  const focusMessageId = focusMessageIdRaw ? MessageId.make(focusMessageIdRaw) : undefined;
  const focusQuery = focusMessageId
    ? normalizeSearchString(search.focusQuery)?.slice(0, 256)
    : undefined;
  const focusRequest = focusMessageId ? normalizeSearchString(search.focusRequest) : undefined;

  return {
    ...(diff ? { diff } : {}),
    ...(diffMode ? { diffMode } : {}),
    ...(sourceControl ? { sourceControl } : {}),
    ...(agents ? { agents } : {}),
    ...(sourceControlReturn ? { sourceControlReturn } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(focusMessageId ? { focusMessageId } : {}),
    ...(focusQuery ? { focusQuery } : {}),
    ...(focusRequest ? { focusRequest } : {}),
  };
}

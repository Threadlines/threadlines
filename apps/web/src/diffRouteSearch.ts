import { MessageId, TurnId } from "@threadlines/contracts";

/**
 * The right sidebar's tabs are filed under the params they have always used:
 * `sourceControl=1` is the Changes tab, `diff=1` the Diff tab, `agents=1` the
 * Agents tab. At most one reads as open, and that one is the active tab; an
 * explicit `0` means the sidebar is closed.
 */
export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffMode?: "workingTree" | undefined;
  sourceControl?: "1" | "0" | undefined;
  agents?: "1" | "0" | undefined;
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
  | "diffTurnId"
  | "diffFilePath";

interface ClearedRightPanelSearchParams {
  diff?: undefined;
  diffMode?: undefined;
  sourceControl?: undefined;
  agents?: undefined;
  diffTurnId?: undefined;
  diffFilePath?: undefined;
}

/**
 * Only one tab is active at a time, so every "activate tab X" navigation
 * starts by clearing the params the other tabs are filed under.
 */
export function stripRightPanelSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<T, RightPanelSearchKey> & ClearedRightPanelSearchParams {
  const {
    diff: _diff,
    diffMode: _diffMode,
    sourceControl: _sourceControl,
    agents: _agents,
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
    diffTurnId: undefined,
    diffFilePath: undefined,
  } as Omit<T, RightPanelSearchKey> & ClearedRightPanelSearchParams;
}

/**
 * Hiding the sidebar. Both tab keys are recorded closed so neither the
 * default-open setting nor a remembered tab reopens it behind the dismissal.
 */
export function closeRightPanelSearchParams<T extends Record<string, unknown>>(params: T) {
  return {
    ...stripRightPanelSearchParams(params),
    sourceControl: "0" as const,
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
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(focusMessageId ? { focusMessageId } : {}),
    ...(focusQuery ? { focusQuery } : {}),
    ...(focusRequest ? { focusRequest } : {}),
  };
}

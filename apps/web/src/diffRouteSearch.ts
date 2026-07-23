import { MessageId, TurnId } from "@threadlines/contracts";

export interface DiffRouteSearch {
  diff?: "1" | undefined;
  diffMode?: "workingTree" | undefined;
  sourceControl?: "1" | "0" | undefined;
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

export function stripRightPanelSearchParams<T extends Record<string, unknown>>(
  params: T,
): Omit<
  T,
  "diff" | "diffMode" | "sourceControl" | "sourceControlReturn" | "diffTurnId" | "diffFilePath"
> & {
  diff?: undefined;
  diffMode?: undefined;
  sourceControl?: undefined;
  sourceControlReturn?: undefined;
  diffTurnId?: undefined;
  diffFilePath?: undefined;
} {
  const {
    diff: _diff,
    diffMode: _diffMode,
    sourceControl: _sourceControl,
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
    sourceControlReturn: undefined,
    diffTurnId: undefined,
    diffFilePath: undefined,
  } as Omit<
    T,
    "diff" | "diffMode" | "sourceControl" | "sourceControlReturn" | "diffTurnId" | "diffFilePath"
  > & {
    diff?: undefined;
    diffMode?: undefined;
    sourceControl?: undefined;
    sourceControlReturn?: undefined;
    diffTurnId?: undefined;
    diffFilePath?: undefined;
  };
}

export function closeRightPanelSearchParams<T extends Record<string, unknown>>(params: T) {
  return {
    ...stripRightPanelSearchParams(params),
    sourceControl: "0" as const,
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
  const { sourceControl } = parseDiffRouteSearch(params);
  const stripped = stripRightPanelSearchParams(params);
  return sourceControl ? { ...stripped, sourceControl } : stripped;
}

export function isSourceControlPanelOpen(
  search: DiffRouteSearch,
  options: { defaultOpen?: boolean } = {},
): boolean {
  if (search.diff === "1" || search.sourceControl === "0") {
    return false;
  }
  if (search.sourceControl === "1") {
    return true;
  }
  return options.defaultOpen ?? true;
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
    ...(sourceControlReturn ? { sourceControlReturn } : {}),
    ...(diffTurnId ? { diffTurnId } : {}),
    ...(diffFilePath ? { diffFilePath } : {}),
    ...(focusMessageId ? { focusMessageId } : {}),
    ...(focusQuery ? { focusQuery } : {}),
    ...(focusRequest ? { focusRequest } : {}),
  };
}

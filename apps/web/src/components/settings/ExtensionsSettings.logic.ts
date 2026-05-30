export type ExtensionItemKind = "plugin" | "skill" | "mcp" | "app";

export function extensionProviderDriverSortRank(driverKind: string): number {
  if (driverKind === "codex") return 0;
  if (driverKind === "claudeAgent") return 1;
  return 2;
}

export interface ExtensionProviderThreadProject {
  readonly environmentId: string;
  readonly id: string;
  readonly cwd: string;
}

export interface ExtensionProviderThreadCandidate {
  readonly key: string;
  readonly environmentId: string;
  readonly id: string;
  readonly projectId: string;
  readonly provider: string;
  readonly providerInstanceId?: string | undefined;
  readonly providerThreadId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly sessionUpdatedAt?: string | undefined;
}

export function extensionTextMatchesFilter(
  values: ReadonlyArray<string | null | undefined>,
  filterText: string,
): boolean {
  const normalizedFilter = filterText.trim().toLowerCase();
  if (normalizedFilter.length === 0) return true;

  return values.some((value) => value?.toLowerCase().includes(normalizedFilter) ?? false);
}

export function isLikelyLocalPath(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(trimmed);
}

function normalizedCwdKey(value: string): string {
  return value.trim().replaceAll("\\", "/").toLowerCase();
}

function scopedLocalKey(environmentId: string, localId: string): string {
  return `${environmentId}:${localId}`;
}

function parsedTime(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

export function deriveDetectedProviderThreadId({
  cwd,
  providerDriver,
  providerInstanceId,
  projects,
  threads,
  threadLastVisitedAtById,
}: {
  readonly cwd: string;
  readonly providerDriver: string;
  readonly providerInstanceId: string;
  readonly projects: ReadonlyArray<ExtensionProviderThreadProject>;
  readonly threads: ReadonlyArray<ExtensionProviderThreadCandidate>;
  readonly threadLastVisitedAtById: Readonly<Record<string, string>>;
}): string {
  const cwdKey = normalizedCwdKey(cwd);
  const selectedProviderDriver = providerDriver.trim();
  const selectedProviderInstanceId = providerInstanceId.trim();
  if (!cwdKey || !selectedProviderDriver || !selectedProviderInstanceId) return "";

  const projectRefs = new Set(
    projects
      .filter((project) => normalizedCwdKey(project.cwd) === cwdKey)
      .map((project) => scopedLocalKey(project.environmentId, project.id)),
  );
  if (projectRefs.size === 0) return "";

  let best: {
    readonly providerThreadId: string;
    readonly instanceRank: number;
    readonly timestamp: number;
  } | null = null;

  for (const thread of threads) {
    if (!projectRefs.has(scopedLocalKey(thread.environmentId, thread.projectId))) continue;
    if (thread.provider !== selectedProviderDriver) continue;

    const providerThreadId = thread.providerThreadId?.trim();
    if (!providerThreadId) continue;

    const candidateInstanceId = thread.providerInstanceId?.trim();
    if (candidateInstanceId && candidateInstanceId !== selectedProviderInstanceId) continue;

    const instanceRank = candidateInstanceId === selectedProviderInstanceId ? 1 : 0;
    const timestamp = Math.max(
      parsedTime(threadLastVisitedAtById[thread.key]),
      parsedTime(thread.sessionUpdatedAt),
      parsedTime(thread.updatedAt),
      parsedTime(thread.createdAt),
    );

    if (
      !best ||
      instanceRank > best.instanceRank ||
      (instanceRank === best.instanceRank && timestamp > best.timestamp)
    ) {
      best = { providerThreadId, instanceRank, timestamp };
    }
  }

  return best?.providerThreadId ?? "";
}

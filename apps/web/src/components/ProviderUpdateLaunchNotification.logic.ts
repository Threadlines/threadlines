import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateStatus,
} from "@threadlines/contracts";

export type ProviderUpdateCandidate = ServerProvider & {
  readonly versionAdvisory: NonNullable<ServerProvider["versionAdvisory"]> & {
    readonly status: "behind_latest";
    readonly latestVersion: string;
  };
};

export type ProviderUpdateToastType = "warning" | "loading" | "error" | "success";
export type ProviderUpdateToastPhase = "initial" | "running" | "failed" | "unchanged" | "succeeded";

export interface ProviderUpdateToastView {
  readonly phase: ProviderUpdateToastPhase;
  readonly type: ProviderUpdateToastType;
  readonly title: string;
  readonly description: string;
  readonly dismissAfterVisibleMs?: number;
}

export type ProviderUpdateSidebarPillTone = "loading" | "warning" | "error" | "success";
export type ProviderUpdateSidebarPillItemTone =
  | "queued"
  | "running"
  | "warning"
  | "error"
  | "success";

type ProviderUpdateSidebarPillItemStatus = Exclude<ServerProviderUpdateStatus, "idle">;

export interface ProviderUpdateSidebarPillItem {
  readonly key: string;
  readonly label: string;
  readonly status: ProviderUpdateSidebarPillItemStatus;
  readonly statusLabel: string;
  readonly tone: ProviderUpdateSidebarPillItemTone;
}

export interface ProviderUpdateSidebarPillView {
  readonly key: string;
  readonly tone: ProviderUpdateSidebarPillTone;
  readonly title: string;
  readonly summary?: string;
  readonly description: string;
  readonly progressIndeterminate?: boolean;
  readonly progressLabel?: string;
  readonly progressPercent: number;
  readonly items?: readonly ProviderUpdateSidebarPillItem[];
  readonly dismissible?: boolean;
  readonly dismissAfterVisibleMs?: number;
}

interface ProviderUpdateSidebarPillOptions {
  readonly visibleAfterIso?: string;
  readonly dismissedKeys?: ReadonlySet<string>;
}

const PROVIDER_UPDATE_SUCCESS_VISIBLE_MS = 3_000;

function formatVersion(value: string): string {
  return value.startsWith("v") ? value : `v${value}`;
}

function chooseRepresentativeProvider(
  current: ServerProvider | undefined,
  candidate: ServerProvider,
): ServerProvider {
  if (!current) {
    return candidate;
  }
  const defaultInstanceId = defaultInstanceIdForDriver(candidate.driver);
  if (candidate.instanceId === defaultInstanceId) {
    return candidate;
  }
  if (current.instanceId === defaultInstanceId) {
    return current;
  }
  return candidate.checkedAt.localeCompare(current.checkedAt) >= 0 ? candidate : current;
}

function dedupeProvidersByDriver<T extends ServerProvider>(providers: ReadonlyArray<T>): T[] {
  const latestProviderByDriver = new Map<ProviderDriverKind, T>();

  for (const provider of providers) {
    latestProviderByDriver.set(
      provider.driver,
      chooseRepresentativeProvider(latestProviderByDriver.get(provider.driver), provider) as T,
    );
  }

  return [...latestProviderByDriver.values()];
}

function dedupeProvidersByInstanceId<T extends ServerProvider>(providers: ReadonlyArray<T>): T[] {
  const latestProviderByInstanceId = new Map<ProviderInstanceId, T>();

  for (const provider of providers) {
    const current = latestProviderByInstanceId.get(provider.instanceId);
    if (!current || provider.checkedAt.localeCompare(current.checkedAt) >= 0) {
      latestProviderByInstanceId.set(provider.instanceId, provider);
    }
  }

  return [...latestProviderByInstanceId.values()];
}

function getProviderUpdatedTitle(provider: Pick<ServerProvider, "driver" | "version">): string {
  const providerName = getProviderDisplayName(provider);
  return provider.version
    ? `${providerName} updated: ${formatVersion(provider.version)}`
    : `${providerName} updated`;
}

function getProviderUpdatedDescription(providerCount: number): string {
  return providerCount === 1
    ? "New sessions will use the updated provider."
    : "New sessions will use the updated providers.";
}

function getProviderFailedUpdateTitle(
  provider: Pick<ServerProvider, "driver" | "versionAdvisory">,
): string {
  const providerName = getProviderDisplayName(provider);
  const attemptedVersion = provider.versionAdvisory?.latestVersion;
  return attemptedVersion
    ? `${providerName} ${formatVersion(attemptedVersion)} update failed`
    : `${providerName} update failed`;
}

function getProviderDisplayName(provider: Pick<ServerProvider, "driver">): string {
  return PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
}

export function isProviderUpdateCandidate(
  provider: ServerProvider,
): provider is ProviderUpdateCandidate {
  return (
    provider.enabled &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.latestVersion !== null
  );
}

export function isProviderUpdateActive(provider: Pick<ServerProvider, "updateState">): boolean {
  return provider.updateState?.status === "queued" || provider.updateState?.status === "running";
}

export function collectProviderUpdateCandidates(
  providers: ReadonlyArray<ServerProvider>,
): ProviderUpdateCandidate[] {
  return dedupeProvidersByDriver(providers.filter(isProviderUpdateCandidate));
}

export function hasOneClickUpdateProviderCandidate(
  candidate: ProviderUpdateCandidate,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  if (
    candidate.versionAdvisory.canUpdate !== true ||
    candidate.versionAdvisory.updateCommand === null
  ) {
    return false;
  }

  const driverProviders = providers.filter((provider) => provider.driver === candidate.driver);
  if (driverProviders.length === 0) {
    return false;
  }

  const updateCommands = new Set<string>();
  for (const provider of driverProviders) {
    if (!isProviderUpdateCandidate(provider)) {
      continue;
    }
    const advisory = provider.versionAdvisory;
    if (!advisory || advisory.canUpdate !== true || advisory.updateCommand === null) {
      return false;
    }
    updateCommands.add(advisory.updateCommand);
  }

  return updateCommands.size === 1;
}

export function canOneClickUpdateProviderCandidate(
  candidate: ProviderUpdateCandidate,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  return (
    !isProviderUpdateActive(candidate) && hasOneClickUpdateProviderCandidate(candidate, providers)
  );
}

export function providerUpdateNotificationKey(
  providers: ReadonlyArray<ProviderUpdateCandidate>,
): string | null {
  const parts = dedupeProvidersByDriver(providers)
    .map((provider) => {
      const advisory = provider.versionAdvisory;
      return [provider.driver, advisory.latestVersion].join(":");
    })
    .toSorted();

  return parts.length > 0 ? parts.join("|") : null;
}

export function providerUpdateCandidateKey(provider: ProviderUpdateCandidate): string {
  return providerUpdateNotificationKey([provider])!;
}

export function formatProviderList(providers: ReadonlyArray<Pick<ServerProvider, "driver">>) {
  const names = providers.map(
    (provider) => PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver,
  );
  if (names.length <= 2) {
    return names.join(" and ");
  }
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function getProviderUpdateInitialToastView(input: {
  readonly updateProviders: ReadonlyArray<ProviderUpdateCandidate>;
  readonly oneClickProviders: ReadonlyArray<ProviderUpdateCandidate>;
}): ProviderUpdateToastView {
  const hasMultipleProviders = input.updateProviders.length > 1;
  return {
    phase: "initial",
    type: "warning",
    title: getProviderUpdateInitialToastTitle(input.updateProviders),
    description:
      input.oneClickProviders.length > 0
        ? hasMultipleProviders
          ? `${formatProviderList(input.updateProviders)} can be updated.`
          : "Install the update now or review provider settings."
        : `${formatProviderList(input.updateProviders)} can be updated from provider settings.`,
  };
}

export function getProviderUpdateRunningToastView(providerCount: number): ProviderUpdateToastView {
  return {
    phase: "running",
    type: "loading",
    title: providerCount === 1 ? "Updating provider" : "Updating providers",
    description:
      providerCount === 1
        ? "Running provider update command."
        : "Progress is shown in the sidebar.",
  };
}

export function getProviderUpdateRejectedToastView(
  providerCount: number,
  message: string,
): ProviderUpdateToastView {
  return {
    phase: "failed",
    type: "error",
    title: providerCount === 1 ? "Provider update failed" : "Provider updates failed",
    description: message,
  };
}

export function getProviderUpdateProgressToastView(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerCount: number;
}): ProviderUpdateToastView {
  const providers = dedupeProvidersByDriver(input.providers);
  const failedProviders = providers.filter((provider) => provider.updateState?.status === "failed");
  if (failedProviders.length > 0) {
    return {
      phase: "failed",
      type: "error",
      title: failedProviders.length === 1 ? "Provider update failed" : "Provider updates failed",
      description: getFailedProviderUpdateDescription(failedProviders),
    };
  }

  const unchangedProviders = providers.filter(
    (provider) => provider.updateState?.status === "unchanged",
  );
  if (unchangedProviders.length > 0) {
    return {
      phase: "unchanged",
      type: "warning",
      title:
        unchangedProviders.length === 1
          ? "Provider still needs an update"
          : "Providers still need updates",
      description: `${formatProviderList(unchangedProviders)} ${
        unchangedProviders.length === 1 ? "still appears" : "still appear"
      } outdated. Check provider settings for details.`,
    };
  }

  if (providers.some(isProviderUpdateActive)) {
    return getProviderUpdateRunningToastView(input.providerCount);
  }

  const hasCompleteProviderSnapshots = providers.length >= input.providerCount;
  const allProvidersUpdated =
    hasCompleteProviderSnapshots &&
    providers.every(
      (provider) =>
        provider.updateState?.status === "succeeded" || !isProviderUpdateCandidate(provider),
    );
  if (allProvidersUpdated) {
    return {
      phase: "succeeded",
      type: "success",
      title: input.providerCount === 1 ? "Provider updated" : "Provider updates finished",
      description: getProviderUpdatedDescription(input.providerCount),
      dismissAfterVisibleMs: PROVIDER_UPDATE_SUCCESS_VISIBLE_MS,
    };
  }

  return getProviderUpdateRunningToastView(input.providerCount);
}

export function getSingleProviderUpdateProgressToastView(
  provider: ServerProvider,
): ProviderUpdateToastView {
  const view = getProviderUpdateProgressToastView({
    providers: [provider],
    providerCount: 1,
  });
  const providerName = getProviderDisplayName(provider);

  switch (view.phase) {
    case "running":
      return {
        ...view,
        title: `Updating ${providerName}`,
      };
    case "failed":
      return {
        ...view,
        title: getProviderFailedUpdateTitle(provider),
      };
    case "unchanged":
      return {
        ...view,
        title: `${providerName} still needs an update`,
      };
    case "succeeded":
      return {
        ...view,
        title: getProviderUpdatedTitle(provider),
      };
    default:
      return view;
  }
}

export function collectUpdatedProviderSnapshots(input: {
  readonly results: ReadonlyArray<
    PromiseSettledResult<{ readonly providers: ReadonlyArray<ServerProvider> }>
  >;
  readonly providerInstanceIds: ReadonlySet<ProviderInstanceId>;
}): ServerProvider[] {
  const matchedProviders: ServerProvider[] = [];

  for (const result of input.results) {
    if (result.status !== "fulfilled") {
      continue;
    }
    for (const provider of result.value.providers) {
      if (input.providerInstanceIds.has(provider.instanceId)) {
        matchedProviders.push(provider);
      }
    }
  }

  return dedupeProvidersByInstanceId(matchedProviders);
}

export function firstRejectedProviderUpdateMessage(
  results: ReadonlyArray<PromiseSettledResult<unknown>>,
): string | null {
  const rejected = results.find((result) => result.status === "rejected");
  if (!rejected) {
    return null;
  }
  return rejected.reason instanceof Error ? rejected.reason.message : "Provider update failed.";
}

function getUpdateFinishedAt(provider: ServerProvider): string | null {
  return provider.updateState?.finishedAt ?? null;
}

function isRecentTerminalProvider(
  provider: ServerProvider,
  visibleAfterIso: string | undefined,
): boolean {
  const status = provider.updateState?.status;
  if (status !== "failed" && status !== "unchanged" && status !== "succeeded") {
    return false;
  }
  if (visibleAfterIso === undefined) {
    return true;
  }
  const finishedAt = getUpdateFinishedAt(provider);
  return finishedAt !== null && finishedAt >= visibleAfterIso;
}

function latestFinishedAtForProviders(providers: ReadonlyArray<ServerProvider>): string | null {
  return providers.reduce<string | null>((latest, provider) => {
    const finishedAt = getUpdateFinishedAt(provider);
    if (finishedAt === null) {
      return latest;
    }
    return latest === null || finishedAt > latest ? finishedAt : latest;
  }, null);
}

function isProviderUpdateSidebarItemStatus(
  status: ServerProviderUpdateStatus | undefined,
): status is ProviderUpdateSidebarPillItemStatus {
  return (
    status === "queued" ||
    status === "running" ||
    status === "succeeded" ||
    status === "failed" ||
    status === "unchanged"
  );
}

function getProviderUpdateSidebarItemTone(
  status: ProviderUpdateSidebarPillItemStatus,
): ProviderUpdateSidebarPillItemTone {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "success";
    case "failed":
      return "error";
    case "unchanged":
      return "warning";
  }
}

function isTerminalProviderUpdateSidebarItemStatus(
  status: ProviderUpdateSidebarPillItemStatus,
): boolean {
  return status === "succeeded" || status === "failed" || status === "unchanged";
}

function getProviderUpdateSidebarStatusLabel(
  provider: Pick<ServerProvider, "version">,
  status: ProviderUpdateSidebarPillItemStatus,
): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "running":
      return "Updating";
    case "succeeded":
      return provider.version ? formatVersion(provider.version) : "Updated";
    case "failed":
      return "Failed";
    case "unchanged":
      return "Needs update";
  }
}

function collectProviderUpdateSidebarItems(
  providers: ReadonlyArray<ServerProvider>,
): ProviderUpdateSidebarPillItem[] {
  return providers.flatMap((provider) => {
    const status = provider.updateState?.status;
    if (!isProviderUpdateSidebarItemStatus(status)) {
      return [];
    }
    return [
      {
        key: `${provider.driver}:${status}:${provider.updateState?.finishedAt ?? "pending"}`,
        label: getProviderDisplayName(provider),
        status,
        statusLabel: getProviderUpdateSidebarStatusLabel(provider, status),
        tone: getProviderUpdateSidebarItemTone(status),
      },
    ];
  });
}

function formatProviderUpdateSidebarItemDescription(
  items: ReadonlyArray<ProviderUpdateSidebarPillItem>,
): string {
  return items.map((item) => `${item.label} ${item.statusLabel.toLowerCase()}.`).join(" ");
}

function formatCountLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatProviderUpdateSidebarSummary(
  items: ReadonlyArray<ProviderUpdateSidebarPillItem>,
): string | undefined {
  const failedCount = items.filter((item) => item.status === "failed").length;
  if (failedCount > 0) {
    return formatCountLabel(failedCount, "failed", "failed");
  }

  const unchangedCount = items.filter((item) => item.status === "unchanged").length;
  if (unchangedCount > 0) {
    return formatCountLabel(unchangedCount, "needs attention", "need attention");
  }

  const activeCount = items.filter(
    (item) => item.status === "running" || item.status === "queued",
  ).length;
  if (activeCount > 0) {
    return formatCountLabel(activeCount, "active", "active");
  }

  const succeededCount = items.filter((item) => item.status === "succeeded").length;
  if (succeededCount > 0) {
    return formatCountLabel(succeededCount, "done", "done");
  }

  return undefined;
}

function optionalProviderUpdateSidebarSummary(
  summary: string | undefined,
): { readonly summary: string } | Record<string, never> {
  return summary === undefined ? {} : { summary };
}

function getProviderUpdateSidebarProgress(
  items: ReadonlyArray<ProviderUpdateSidebarPillItem>,
): Pick<
  ProviderUpdateSidebarPillView,
  "progressIndeterminate" | "progressLabel" | "progressPercent"
> {
  if (items.length === 0) {
    return { progressPercent: 0 };
  }

  const completeCount = items.filter((item) =>
    isTerminalProviderUpdateSidebarItemStatus(item.status),
  ).length;
  const progressPercent = Math.max(0, Math.min(100, (completeCount / items.length) * 100));
  const hasActiveItem = items.some((item) => item.status === "queued" || item.status === "running");
  const progressLabel =
    items.length > 1 ? `${completeCount}/${items.length} done` : `${Math.floor(progressPercent)}%`;

  return {
    ...(hasActiveItem && items.length === 1 ? { progressIndeterminate: true } : {}),
    progressLabel,
    progressPercent,
  };
}

export function getProviderUpdateSidebarPillView(
  providers: ReadonlyArray<ServerProvider>,
  options?: ProviderUpdateSidebarPillOptions,
): ProviderUpdateSidebarPillView | null {
  const dedupedProviders = dedupeProvidersByDriver(providers);
  const activeProviders = dedupedProviders.filter(isProviderUpdateActive);
  if (activeProviders.length > 0) {
    const activeProvider = activeProviders[0]!;
    const activeProviderName = getProviderDisplayName(activeProvider);
    const visibleProviders = dedupedProviders.filter(
      (provider) =>
        isProviderUpdateActive(provider) ||
        isRecentTerminalProvider(provider, options?.visibleAfterIso),
    );
    const items = collectProviderUpdateSidebarItems(visibleProviders);
    const showItemDetails = items.length > 1;
    return {
      key: `loading:${visibleProviders
        .map(
          (provider) =>
            `${provider.driver}:${provider.updateState?.status ?? "idle"}:${provider.updateState?.finishedAt ?? "pending"}`,
        )
        .toSorted()
        .join("|")}`,
      tone: "loading",
      title: showItemDetails ? "Provider updates" : `Updating ${activeProviderName}`,
      ...getProviderUpdateSidebarProgress(items),
      ...(showItemDetails
        ? optionalProviderUpdateSidebarSummary(formatProviderUpdateSidebarSummary(items))
        : {}),
      description: showItemDetails
        ? formatProviderUpdateSidebarItemDescription(items)
        : `${formatProviderList(activeProviders)} update in progress.`,
      ...(items.length > 0 ? { items } : {}),
    };
  }

  const recentTerminalProviders = dedupedProviders.filter((provider) =>
    isRecentTerminalProvider(provider, options?.visibleAfterIso),
  );
  const terminalCandidates: ProviderUpdateSidebarPillView[] = [];

  const failedProviders = recentTerminalProviders.filter(
    (provider) => provider.updateState?.status === "failed",
  );
  if (failedProviders.length > 0) {
    const failedProvider = failedProviders[0]!;
    const items = collectProviderUpdateSidebarItems(failedProviders);
    terminalCandidates.push({
      key: `failed:${failedProviders
        .map(
          (provider) =>
            `${provider.driver}:${provider.updateState?.finishedAt ?? "pending"}:${provider.updateState?.message ?? ""}`,
        )
        .toSorted()
        .join("|")}`,
      tone: "error",
      title:
        failedProviders.length === 1
          ? getProviderFailedUpdateTitle(failedProvider)
          : `${failedProviders.length} provider updates failed`,
      ...getProviderUpdateSidebarProgress(items),
      ...(failedProviders.length > 1
        ? optionalProviderUpdateSidebarSummary(formatProviderUpdateSidebarSummary(items))
        : {}),
      description: getFailedProviderUpdateDescription(failedProviders),
      ...(items.length > 0 ? { items } : {}),
      dismissible: true,
    });
  }

  const unchangedProviders = recentTerminalProviders.filter(
    (provider) => provider.updateState?.status === "unchanged",
  );
  if (unchangedProviders.length > 0) {
    const unchangedProvider = unchangedProviders[0]!;
    const unchangedProviderName = getProviderDisplayName(unchangedProvider);
    const items = collectProviderUpdateSidebarItems(unchangedProviders);
    terminalCandidates.push({
      key: `unchanged:${unchangedProviders
        .map(
          (provider) =>
            `${provider.driver}:${provider.updateState?.finishedAt ?? "pending"}:${provider.updateState?.message ?? ""}`,
        )
        .toSorted()
        .join("|")}`,
      tone: "warning",
      title:
        unchangedProviders.length === 1
          ? `${unchangedProviderName} still needs an update`
          : `${unchangedProviders.length} providers still need updates`,
      ...getProviderUpdateSidebarProgress(items),
      ...(unchangedProviders.length > 1
        ? optionalProviderUpdateSidebarSummary(formatProviderUpdateSidebarSummary(items))
        : {}),
      description: `${formatProviderList(unchangedProviders)} ${
        unchangedProviders.length === 1 ? "still appears" : "still appear"
      } outdated. Review provider settings for details.`,
      ...(items.length > 0 ? { items } : {}),
      dismissible: true,
    });
  }

  const succeededProviders = recentTerminalProviders.filter(
    (provider) => provider.updateState?.status === "succeeded",
  );
  if (succeededProviders.length > 0) {
    const succeededProvider = succeededProviders[0]!;
    const items = collectProviderUpdateSidebarItems(succeededProviders);
    terminalCandidates.push({
      key: `succeeded:${succeededProviders
        .map(
          (provider) =>
            `${provider.driver}:${provider.updateState?.finishedAt ?? "pending"}:${provider.updateState?.message ?? ""}`,
        )
        .toSorted()
        .join("|")}`,
      tone: "success",
      title:
        succeededProviders.length === 1
          ? `${getProviderDisplayName(succeededProvider)} updated`
          : `${succeededProviders.length} providers updated`,
      ...getProviderUpdateSidebarProgress(items),
      ...(succeededProviders.length > 1
        ? optionalProviderUpdateSidebarSummary(formatProviderUpdateSidebarSummary(items))
        : {}),
      description: getProviderUpdatedDescription(succeededProviders.length),
      ...(items.length > 0 ? { items } : {}),
      dismissAfterVisibleMs: PROVIDER_UPDATE_SUCCESS_VISIBLE_MS,
    });
  }

  return (
    terminalCandidates
      .toSorted((left, right) => {
        const leftProviders =
          left.tone === "error"
            ? failedProviders
            : left.tone === "warning"
              ? unchangedProviders
              : succeededProviders;
        const rightProviders =
          right.tone === "error"
            ? failedProviders
            : right.tone === "warning"
              ? unchangedProviders
              : succeededProviders;
        const leftFinishedAt = latestFinishedAtForProviders(leftProviders) ?? "";
        const rightFinishedAt = latestFinishedAtForProviders(rightProviders) ?? "";
        return rightFinishedAt.localeCompare(leftFinishedAt);
      })
      .find((candidate) => !options?.dismissedKeys?.has(candidate.key)) ?? null
  );
}

function getProviderUpdateInitialToastTitle(
  providers: ReadonlyArray<ProviderUpdateCandidate>,
): string {
  if (providers.length === 1) {
    const provider = providers[0]!;
    const providerName = getProviderDisplayName(provider);
    return `Update Available: ${providerName} ${formatVersion(provider.versionAdvisory.latestVersion)}`;
  }
  return "Updates available";
}

function getFailedProviderUpdateDescription(providers: ReadonlyArray<ServerProvider>): string {
  if (providers.length === 1) {
    const provider = providers[0]!;
    if (provider.updateState?.message) {
      return provider.updateState.message;
    }
  }
  return `${formatProviderList(providers)} failed to update. Check provider settings for details.`;
}

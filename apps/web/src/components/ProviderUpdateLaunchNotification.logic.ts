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
  /** Failure/unchanged detail shown inline under the row. */
  readonly message?: string;
}

export interface ProviderUpdateSidebarPillView {
  readonly key: string;
  readonly tone: ProviderUpdateSidebarPillTone;
  readonly title: string;
  /** Worst-state chip beside the title ("1 failed", "2 updating", "v1.2.0"). */
  readonly statusChipLabel: string;
  readonly statusChipTone: ProviderUpdateSidebarPillItemTone;
  readonly description: string;
  readonly items: readonly ProviderUpdateSidebarPillItem[];
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

/** "Claude v1.2.0" — the provider plus the version the update attempted. */
function getProviderAttemptedVersionTitle(
  provider: Pick<ServerProvider, "driver" | "versionAdvisory">,
): string {
  const providerName = getProviderDisplayName(provider);
  const attemptedVersion = provider.versionAdvisory?.latestVersion;
  return attemptedVersion ? `${providerName} ${formatVersion(attemptedVersion)}` : providerName;
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
    const message = provider.updateState?.message;
    return [
      {
        // Providers are deduped by driver, so the driver is a stable row
        // identity that survives status transitions within an update batch.
        key: provider.driver,
        label: getProviderDisplayName(provider),
        status,
        statusLabel: getProviderUpdateSidebarStatusLabel(provider, status),
        tone: getProviderUpdateSidebarItemTone(status),
        ...((status === "failed" || status === "unchanged") && message ? { message } : {}),
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

/**
 * Chip beside the card title. Single-provider cards echo the row's status
 * ("Updating", "v1.2.0", "Failed"); multi-provider cards surface the worst
 * state so a failure is visible even while other updates are still running.
 */
function getProviderUpdateSidebarChip(items: ReadonlyArray<ProviderUpdateSidebarPillItem>): {
  readonly label: string;
  readonly tone: ProviderUpdateSidebarPillItemTone;
} {
  if (items.length === 1) {
    const item = items[0]!;
    return { label: item.statusLabel, tone: item.tone };
  }

  const failedCount = items.filter((item) => item.status === "failed").length;
  if (failedCount > 0) {
    return { label: formatCountLabel(failedCount, "failed", "failed"), tone: "error" };
  }

  const unchangedCount = items.filter((item) => item.status === "unchanged").length;
  if (unchangedCount > 0) {
    return {
      label: formatCountLabel(unchangedCount, "needs update", "need update"),
      tone: "warning",
    };
  }

  const activeCount = items.filter(
    (item) => item.status === "running" || item.status === "queued",
  ).length;
  if (activeCount > 0) {
    return { label: formatCountLabel(activeCount, "updating", "updating"), tone: "running" };
  }

  const succeededCount = items.filter((item) => item.status === "succeeded").length;
  return { label: formatCountLabel(succeededCount, "updated", "updated"), tone: "success" };
}

export function getProviderUpdateSidebarPillView(
  providers: ReadonlyArray<ServerProvider>,
  options?: ProviderUpdateSidebarPillOptions,
): ProviderUpdateSidebarPillView | null {
  const dedupedProviders = dedupeProvidersByDriver(providers);
  const activeProviders = dedupedProviders.filter(isProviderUpdateActive);
  if (activeProviders.length > 0) {
    const visibleProviders = dedupedProviders.filter(
      (provider) =>
        isProviderUpdateActive(provider) ||
        isRecentTerminalProvider(provider, options?.visibleAfterIso),
    );
    const items = collectProviderUpdateSidebarItems(visibleProviders);
    const chip = getProviderUpdateSidebarChip(items);
    return {
      // Keyed by batch membership only: status transitions within the batch
      // morph the card in place instead of re-keying (and re-animating) it.
      key: `updating:${visibleProviders
        .map((provider) => provider.driver)
        .toSorted()
        .join("|")}`,
      tone: "loading",
      title: items.length === 1 ? getProviderDisplayName(activeProviders[0]!) : "Provider updates",
      statusChipLabel: chip.label,
      statusChipTone: chip.tone,
      description:
        items.length > 1
          ? formatProviderUpdateSidebarItemDescription(items)
          : `${formatProviderList(activeProviders)} update in progress.`,
      items,
    };
  }

  const recentTerminalProviders = dedupedProviders.filter((provider) =>
    isRecentTerminalProvider(provider, options?.visibleAfterIso),
  );
  const items = collectProviderUpdateSidebarItems(recentTerminalProviders);
  if (items.length === 0) {
    return null;
  }

  const key = `done:${recentTerminalProviders
    .map(
      (provider) =>
        `${provider.driver}:${provider.updateState?.status ?? "idle"}:${provider.updateState?.finishedAt ?? "pending"}`,
    )
    .toSorted()
    .join("|")}`;
  if (options?.dismissedKeys?.has(key)) {
    return null;
  }

  const failedProviders = recentTerminalProviders.filter(
    (provider) => provider.updateState?.status === "failed",
  );
  const unchangedProviders = recentTerminalProviders.filter(
    (provider) => provider.updateState?.status === "unchanged",
  );
  const succeededProviders = recentTerminalProviders.filter(
    (provider) => provider.updateState?.status === "succeeded",
  );
  const tone =
    failedProviders.length > 0 ? "error" : unchangedProviders.length > 0 ? "warning" : "success";
  const chip = getProviderUpdateSidebarChip(items);

  // The chip already carries the status word, so single-provider titles are
  // identity only ("Claude v1.2.0" + [Failed]) and never truncate on it.
  const title =
    items.length > 1
      ? "Provider updates"
      : tone === "error"
        ? getProviderAttemptedVersionTitle(failedProviders[0]!)
        : tone === "warning"
          ? getProviderDisplayName(unchangedProviders[0]!)
          : `${getProviderDisplayName(succeededProviders[0]!)} updated`;
  const description =
    tone === "error"
      ? getFailedProviderUpdateDescription(failedProviders)
      : tone === "warning"
        ? `${formatProviderList(unchangedProviders)} ${
            unchangedProviders.length === 1 ? "still appears" : "still appear"
          } outdated. Review provider settings for details.`
        : getProviderUpdatedDescription(succeededProviders.length);

  return {
    key,
    tone,
    title,
    statusChipLabel: chip.label,
    statusChipTone: chip.tone,
    description,
    items,
    // Fully-successful batches auto-hide; anything needing attention sticks
    // around until explicitly dismissed.
    ...(tone === "success"
      ? { dismissAfterVisibleMs: PROVIDER_UPDATE_SUCCESS_VISIBLE_MS }
      : { dismissible: true }),
  };
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

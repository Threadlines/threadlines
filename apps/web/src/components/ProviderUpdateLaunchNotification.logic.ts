import {
  ACP_REGISTRY_DRIVER_KIND,
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ServerProvider,
  type ServerProviderUpdateStatus,
} from "@threadlines/contracts";

export type ProviderUpdateCandidate = ServerProvider & {
  readonly versionAdvisory: NonNullable<ServerProvider["versionAdvisory"]> & {
    readonly status: "behind_latest";
    readonly latestVersion: string;
  };
};

/** What the launch prompt says before anything runs. */
export interface ProviderUpdatePromptView {
  readonly title: string;
  readonly description: string;
}

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

/**
 * Which instances one update covers. Every instance of a driver runs the same
 * program, so they update together; a community agent is a program of its
 * own, and updates alone.
 */
export function providerUpdateGroupKey(
  provider: Pick<ServerProvider, "driver" | "instanceId">,
): string {
  return provider.driver === ACP_REGISTRY_DRIVER_KIND
    ? `${provider.driver}:${provider.instanceId}`
    : provider.driver;
}

function dedupeProvidersByDriver<T extends ServerProvider>(providers: ReadonlyArray<T>): T[] {
  const latestProviderByGroup = new Map<string, T>();

  for (const provider of providers) {
    const key = providerUpdateGroupKey(provider);
    latestProviderByGroup.set(
      key,
      chooseRepresentativeProvider(latestProviderByGroup.get(key), provider) as T,
    );
  }

  return [...latestProviderByGroup.values()];
}

/** The agent's name: a community agent's own, the driver's for the rest. */
function getProviderDisplayName(provider: Pick<ServerProvider, "driver" | "displayName">): string {
  if (provider.driver === ACP_REGISTRY_DRIVER_KIND && provider.displayName) {
    return provider.displayName;
  }
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

  const groupKey = providerUpdateGroupKey(candidate);
  const driverProviders = providers.filter(
    (provider) => providerUpdateGroupKey(provider) === groupKey,
  );
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
      return [providerUpdateGroupKey(provider), advisory.latestVersion].join(":");
    })
    .toSorted();

  return parts.length > 0 ? parts.join("|") : null;
}

/**
 * Whether the launch prompt ("Updates available") may open right now.
 *
 * The last clause is the interesting one: while setup is pending, not yet
 * known (the app is still loading), or on screen, the user is being told what
 * to install and sign in to, and a toast offering a different install on top
 * of that is stacking noise. The prompt is deferred, not dropped -- once setup
 * is completed or skipped this turns true and the prompt opens then. Only this
 * informational prompt waits; a running or failed update still reports itself,
 * because that is progress the user asked for.
 */
export function shouldOpenProviderUpdatePrompt(input: {
  readonly notificationKey: string | null;
  readonly isDismissed: boolean;
  /** Already shown once this session, whether or not it is still on screen. */
  readonly isAlreadySeen: boolean;
  readonly hasActiveToast: boolean;
  readonly isHeldForSetup: boolean;
}): boolean {
  return (
    input.notificationKey !== null &&
    !input.isDismissed &&
    !input.isAlreadySeen &&
    !input.hasActiveToast &&
    !input.isHeldForSetup
  );
}

export function providerUpdateCandidateKey(provider: ProviderUpdateCandidate): string {
  return providerUpdateNotificationKey([provider])!;
}

export function formatProviderList(
  providers: ReadonlyArray<Pick<ServerProvider, "driver" | "displayName">>,
) {
  const names = providers.map(getProviderDisplayName);
  if (names.length <= 2) {
    return names.join(" and ");
  }
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * Like `formatProviderList` but with each provider's target version, so the
 * multi-provider update card says what it will install without growing past
 * one line: "Claude v2.1.230 and Codex v0.146.1".
 */
export function formatProviderUpdateList(providers: ReadonlyArray<ProviderUpdateCandidate>) {
  const names = providers.map(
    (provider) =>
      `${getProviderDisplayName(provider)} ${formatVersion(provider.versionAdvisory.latestVersion)}`,
  );
  if (names.length <= 2) {
    return names.join(" and ");
  }
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

export function getProviderUpdatePromptView(input: {
  readonly updateProviders: ReadonlyArray<ProviderUpdateCandidate>;
  readonly oneClickProviders: ReadonlyArray<ProviderUpdateCandidate>;
}): ProviderUpdatePromptView {
  const single = input.updateProviders.length === 1 ? input.updateProviders[0]! : null;
  return {
    title: single
      ? `${getProviderDisplayName(single)} ${formatVersion(single.versionAdvisory.latestVersion)} is available`
      : "Updates available",
    description:
      input.oneClickProviders.length === 0
        ? `${formatProviderUpdateList(input.updateProviders)} can be updated from Settings.`
        : single
          ? "Install it now, or see the details in Settings."
          : `${formatProviderUpdateList(input.updateProviders)} are ready to install.`,
  };
}

/**
 * One agent in an update run. `baseline` is its update state when it joined:
 * a finished state other than that one, or any finished state after it was
 * seen updating, is this run's result for it, so an old result never counts.
 */
export interface ProviderUpdateRunMember {
  readonly key: string;
  /** Which request this is: a late answer to an earlier one must not settle it. */
  readonly attempt: number;
  readonly baseline: string;
  readonly seenActive: boolean;
  /** Its program was missing when it joined, so the run installs it. */
  readonly installing: boolean;
  /** Its version when it joined, so "updated to" is only said of a real change. */
  readonly fromVersion: string | null;
  /**
   * The update request failed before the server reported on it. `uncertain`
   * when the connection dropped first: the server may still be running it.
   */
  readonly startFailure: { readonly message: string; readonly uncertain: boolean } | null;
}

/**
 * Agents updating together on one computer, from the first one to start until
 * the last one finishes. Anything can start an update (the launch notice,
 * Settings, setup, another window or device), so a run is built from what the
 * server reports, plus the agents a caller says it just asked for.
 */
export interface ProviderUpdateRun {
  readonly environmentId: string;
  readonly members: readonly ProviderUpdateRunMember[];
}

export type ProviderUpdateProgressStatus = Exclude<ServerProviderUpdateStatus, "idle">;

/** One agent's row in the progress notice. */
export interface ProviderUpdateProgressItem {
  readonly key: string;
  readonly label: string;
  readonly status: ProviderUpdateProgressStatus;
  /** "Waiting", "Updating", "v2.1.230", "Failed", "Not updated". */
  readonly statusLabel: string;
  /** The server's explanation for a failed or unfinished update. */
  readonly message: string | null;
}

type ProviderUpdateRunTitle =
  | {
      readonly phase: "failed";
      readonly title: `Couldn't ${string}`;
    }
  | {
      readonly phase: "running" | "succeeded" | "unchanged";
      readonly title: string;
    };

export type ProviderUpdateRunView = ProviderUpdateRunTitle & {
  /** One line under the title; a run of several agents shows its rows instead. */
  readonly detail: string | null;
  readonly items: readonly ProviderUpdateProgressItem[];
};

function updateStateKey(state: ServerProvider["updateState"]): string {
  return state ? `${state.status}|${state.startedAt ?? ""}|${state.finishedAt ?? ""}` : "idle";
}

function moreRelevantForProgress(current: ServerProvider, candidate: ServerProvider) {
  const currentActive = isProviderUpdateActive(current);
  if (currentActive !== isProviderUpdateActive(candidate)) {
    return currentActive ? current : candidate;
  }
  const currentFinished = current.updateState?.finishedAt ?? "";
  const candidateFinished = candidate.updateState?.finishedAt ?? "";
  if (currentFinished !== candidateFinished) {
    return currentFinished > candidateFinished ? current : candidate;
  }
  if ((current.updateState === undefined) !== (candidate.updateState === undefined)) {
    return current.updateState ? current : candidate;
  }
  return chooseRepresentativeProvider(current, candidate);
}

/**
 * The instance whose update state speaks for each update group. The server
 * records an update on the instance it ran against, which needn't be the
 * group's default one, so an instance that is updating wins, then the one
 * that finished last.
 */
export function selectProviderUpdateGroups(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyMap<string, ServerProvider> {
  const byGroup = new Map<string, ServerProvider>();
  for (const provider of providers) {
    const key = providerUpdateGroupKey(provider);
    const current = byGroup.get(key);
    byGroup.set(key, current ? moreRelevantForProgress(current, provider) : provider);
  }
  return byGroup;
}

let nextRunAttempt = 1;

function newRunMember(key: string, provider: ServerProvider | undefined): ProviderUpdateRunMember {
  return {
    key,
    attempt: nextRunAttempt++,
    baseline: updateStateKey(provider?.updateState),
    seenActive: provider ? isProviderUpdateActive(provider) : false,
    installing: provider ? !provider.installed : false,
    fromVersion: provider?.version ?? null,
    startFailure: null,
  };
}

function isRunMemberDone(member: ProviderUpdateRunMember, provider: ServerProvider | undefined) {
  if (!member.seenActive && member.startFailure !== null) return true;
  // Removed while it ran: nothing more will come.
  if (!provider) return true;
  const state = provider.updateState;
  if (state && isProviderUpdateActive(provider)) return false;
  // Seen updating, then no state at all: the server lost track of it (a restart, say).
  if (!state) return member.seenActive;
  return member.seenActive || updateStateKey(state) !== member.baseline;
}

/**
 * The run after a new provider snapshot: agents now updating join it (opening
 * one if none is open), and members are marked once seen updating. Returns the
 * same run when nothing changed. A run on another computer is dropped.
 */
export function advanceProviderUpdateRun(
  run: ProviderUpdateRun | null,
  environmentId: string,
  providers: ReadonlyArray<ServerProvider>,
): ProviderUpdateRun | null {
  const current = run?.environmentId === environmentId ? run : null;
  const groups = selectProviderUpdateGroups(providers);
  let changed = current !== run;
  const members = (current?.members ?? []).map((member) => {
    const provider = groups.get(member.key);
    if (member.seenActive || !provider || !isProviderUpdateActive(provider)) return member;
    changed = true;
    return { ...member, seenActive: true };
  });
  for (const [key, provider] of groups) {
    if (isProviderUpdateActive(provider) && !members.some((member) => member.key === key)) {
      members.push(newRunMember(key, provider));
      changed = true;
    }
  }
  if (members.length === 0) return null;
  return changed ? { environmentId, members } : current;
}

/**
 * Puts agents a caller just asked to update into the run, before the server
 * reports on them, so even an update that finishes between two snapshots is
 * seen. An agent whose earlier attempt in this run already finished starts
 * over; one asked for again before the server reported on it gets a new
 * attempt, so only the latest request's failure can settle it.
 */
export function joinProviderUpdateRun(
  run: ProviderUpdateRun | null,
  environmentId: string,
  providers: ReadonlyArray<ServerProvider>,
  keys: ReadonlyArray<string>,
): ProviderUpdateRun {
  const groups = selectProviderUpdateGroups(providers);
  const members = [...(run?.environmentId === environmentId ? run.members : [])];
  for (const key of keys) {
    const provider = groups.get(key);
    const index = members.findIndex((member) => member.key === key);
    const member = index === -1 ? null : members[index]!;
    if (!member) {
      members.push(newRunMember(key, provider));
    } else if (isRunMemberDone(member, provider)) {
      members[index] = newRunMember(key, provider);
    } else if (!member.seenActive) {
      members[index] = { ...member, attempt: nextRunAttempt++ };
    }
  }
  return { environmentId, members };
}

/**
 * Records that request `attempt` to update `key` on `environmentId` failed
 * before the server reported on it. Ignored once the server has (it knows
 * better), and for any other computer or a later request.
 */
export function failProviderUpdateRunStart(
  run: ProviderUpdateRun | null,
  input: {
    readonly environmentId: string;
    readonly key: string;
    readonly attempt: number;
    readonly message: string;
    readonly uncertain: boolean;
  },
): ProviderUpdateRun | null {
  const matches = (member: ProviderUpdateRunMember) =>
    member.key === input.key && member.attempt === input.attempt && !member.seenActive;
  if (run?.environmentId !== input.environmentId || !run.members.some(matches)) return run;
  return {
    ...run,
    members: run.members.map((member) =>
      matches(member)
        ? { ...member, startFailure: { message: input.message, uncertain: input.uncertain } }
        : member,
    ),
  };
}

function describeRunMember(
  member: ProviderUpdateRunMember,
  provider: ServerProvider | undefined,
): ProviderUpdateProgressItem & { readonly done: boolean } {
  const label = provider ? getProviderDisplayName(provider) : member.key;
  const done = isRunMemberDone(member, provider);
  const state = provider?.updateState;
  const startFailure = !member.seenActive ? member.startFailure : null;
  const status: ProviderUpdateProgressStatus = !done
    ? state?.status === "running"
      ? "running"
      : "queued"
    : startFailure
      ? startFailure.uncertain
        ? "unchanged"
        : "failed"
      : state && state.status !== "queued" && state.status !== "running" && state.status !== "idle"
        ? state.status
        : "unchanged";
  const message =
    status === "failed" || status === "unchanged"
      ? (startFailure?.message ?? state?.message ?? null)
      : null;
  const statusLabel = startFailure?.uncertain
    ? "Unconfirmed"
    : status === "queued"
      ? "Waiting"
      : status === "running"
        ? member.installing
          ? "Installing"
          : "Updating"
        : status === "succeeded"
          ? provider?.version
            ? formatVersion(provider.version)
            : member.installing
              ? "Installed"
              : "Updated"
          : status === "failed"
            ? "Failed"
            : member.installing
              ? "Not installed"
              : "Not updated";
  return { key: member.key, label, status, statusLabel, message, done };
}

function nameAgents(labels: ReadonlyArray<string>): string {
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.length} agents`;
}

/** What the progress notice says about a run. */
export function describeProviderUpdateRun(
  run: ProviderUpdateRun,
  providers: ReadonlyArray<ServerProvider>,
): ProviderUpdateRunView {
  const groups = selectProviderUpdateGroups(providers);
  const described = run.members.map((member) => ({
    member,
    provider: groups.get(member.key),
    item: describeRunMember(member, groups.get(member.key)),
  }));
  const items = described.map(({ item: { done: _done, ...item } }) => item);
  const activeCount = described.filter(({ item }) => !item.done).length;
  const allInstalling = run.members.every((member) => member.installing);
  const single = described.length === 1 ? described[0]! : null;

  if (activeCount > 0) {
    const running = single?.provider?.updateState?.status === "running";
    const target = single?.provider?.versionAdvisory?.latestVersion ?? null;
    return {
      phase: "running",
      title: `${allInstalling ? "Installing" : "Updating"} ${nameAgents(items.map((item) => item.label))}`,
      detail: !single
        ? null
        : !running
          ? "Waiting for another update to finish."
          : target && !single.member.installing
            ? `Getting ${formatVersion(target)}.`
            : "This can take a minute.",
      items,
    };
  }

  const failed = described.filter(({ item }) => item.status === "failed");
  const unchanged = described.filter(({ item }) => item.status === "unchanged");
  const singleMessage = single?.item.message ?? null;
  if (failed.length > 0) {
    const only = failed.length === 1 ? failed[0]! : null;
    return {
      phase: "failed",
      title: only
        ? `Couldn't ${only.member.installing ? "install" : "update"} ${only.item.label}`
        : `Couldn't update ${failed.length} agents`,
      detail: single ? (singleMessage ?? "The update stopped before it finished.") : null,
      items,
    };
  }
  if (unchanged.length > 0) {
    const only = unchanged.length === 1 ? unchanged[0]! : null;
    const unconfirmed = only?.member.seenActive === false && only.member.startFailure?.uncertain;
    return {
      phase: "unchanged",
      title: only
        ? unconfirmed
          ? `Couldn't confirm ${only.item.label}'s update`
          : only.member.installing
            ? `${only.item.label} isn't installed yet`
            : `${only.item.label} still needs an update`
        : `${unchanged.length} agents still need an update`,
      detail: single
        ? unconfirmed
          ? `${singleMessage ?? "Lost the connection."} It may still finish; Settings shows where it stands.`
          : (singleMessage ?? "The update finished without a new version.")
        : null,
      items,
    };
  }
  // "Updated to" only for a version that changed; the server's success alone
  // doesn't prove one did.
  const changed = described.every(
    ({ member, provider }) =>
      member.installing || (provider?.version != null && provider.version !== member.fromVersion),
  );
  const singleVersion = single?.provider?.version ?? null;
  return {
    phase: "succeeded",
    title: single
      ? single.member.installing
        ? `${single.item.label} installed`
        : changed && singleVersion
          ? `${single.item.label} updated to ${formatVersion(singleVersion)}`
          : `${single.item.label} update finished`
      : changed
        ? `${nameAgents(items.map((item) => item.label))} ${allInstalling ? "installed" : "updated"}`
        : "Updates finished",
    detail: single
      ? single.member.installing
        ? "It's ready to use."
        : changed
          ? "New chats use the new version."
          : singleVersion
            ? `It's on ${formatVersion(singleVersion)}.`
            : null
      : changed
        ? "New chats use the new versions."
        : null,
    items,
  };
}

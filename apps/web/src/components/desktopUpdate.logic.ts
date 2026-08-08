import type { DesktopUpdateActionResult, DesktopUpdateState } from "@threadlines/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";
export type SidebarDesktopUpdateTagTone =
  | "idle"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface SidebarDesktopUpdateTagPresentation {
  readonly action: DesktopUpdateButtonAction;
  readonly disabled: boolean;
  readonly indicatorLabel: string | null;
  readonly label: string;
  readonly progressPercent: number;
  readonly tone: SidebarDesktopUpdateTagTone;
  readonly tooltip: string;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (state.downloadedVersion) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return "This Mac has Apple Silicon, but Threadlines is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.";
  }
  if (action === "install") {
    return "This Mac has Apple Silicon, but Threadlines is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.";
  }
  return "This Mac has Apple Silicon, but Threadlines is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.errorContext === "download" && state.availableVersion) {
    return `Download failed for ${state.availableVersion}. Click to retry.`;
  }
  if (state.errorContext === "install" && state.downloadedVersion) {
    return `Install failed for ${state.downloadedVersion}. Click to retry.`;
  }
  if (state.status === "available") {
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Click to restart and install.`;
  }
  if (state.status === "error") {
    return state.message ?? "Update failed";
  }
  return "Up to date";
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Install update${version ? ` ${version}` : ""} and restart Threadlines?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state) return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

/**
 * "1.2.3-nightly.4+abc" → "v1.2.3". Prerelease/build tails stay in tooltips so
 * compact chips never crowd the controls beside them.
 */
export function compactVersionLabel(version: string): string {
  const releaseTriple = version.split(/[-+]/)[0] ?? version;
  return releaseTriple.startsWith("v") ? releaseTriple : `v${releaseTriple}`;
}

const NIGHTLY_VERSION_PATTERN = /^v?(\d+\.\d+\.\d+)-nightly\.(\d{8})\.(\d+)$/;

/**
 * Label for a target version shown beside the one already running. Stripping
 * a nightly to its base triple made "v0.3.2 available" ambiguous on the
 * nightly channel (stable 0.3.2? which of today's nightlies?), while the full
 * string is too long for a chip. The nightly run number is the release
 * workflow's run counter — monotonic across days, so it alone distinguishes
 * any two nightlies of the same base: ".222". A different base keeps the
 * triple plus the channel ("v0.3.3-nightly") so it can never read as a
 * stable release; non-nightly targets keep the compact triple, which is
 * exact for stables. Tooltips carry the full string either way.
 */
export function discriminatingVersionLabel(target: string, current: string): string {
  const targetNightly = NIGHTLY_VERSION_PATTERN.exec(target);
  if (!targetNightly) {
    return compactVersionLabel(target);
  }
  const [, base, , run] = targetNightly;
  const currentNightly = NIGHTLY_VERSION_PATTERN.exec(current);
  if (currentNightly && currentNightly[1] === base) {
    return `.${run}`;
  }
  return `${compactVersionLabel(target)}-nightly`;
}

/**
 * Chip variant of `discriminatingVersionLabel`. The sidebar chip is a fixed
 * 68px box that fits about eleven characters, so "v0.3.3-nightly" would
 * ellipsize into exactly the part that mattered. The feed only ever serves
 * the selected channel, so on the chip a cross-base target can drop the
 * channel suffix: on the nightly track "v0.3.3" can only mean a nightly, and
 * the popout row plus tooltip still spell it out.
 */
export function discriminatingChipVersionLabel(target: string, current: string): string {
  const label = discriminatingVersionLabel(target, current);
  return label.endsWith("-nightly") ? compactVersionLabel(target) : label;
}

function getSidebarDesktopUpdateTagTooltip(input: {
  readonly action: DesktopUpdateButtonAction;
  readonly isDownloading: boolean;
  readonly isError: boolean;
  readonly downloadPercent: number | null;
  /** Full target version string: the tooltip is where ambiguity goes to die. */
  readonly targetVersion: string | null;
}): string {
  const fullLabel = input.targetVersion
    ? input.targetVersion.startsWith("v")
      ? input.targetVersion
      : `v${input.targetVersion}`
    : null;
  if (input.isDownloading) {
    const subject = fullLabel ? `Downloading ${fullLabel}` : "Downloading";
    return input.downloadPercent !== null
      ? `${subject} · ${Math.floor(input.downloadPercent)}%`
      : subject;
  }
  if (input.isError) {
    return input.action === "install" ? "Install failed" : "Download failed";
  }
  if (input.action === "install") {
    return fullLabel ? `Restart to install ${fullLabel}` : "Restart to install";
  }
  return fullLabel ? `${fullLabel} available` : "Update available";
}

export function getSidebarDesktopUpdateTagPresentation(
  state: DesktopUpdateState | null,
  appVersion: string,
): SidebarDesktopUpdateTagPresentation {
  const idlePresentation = {
    action: "none",
    disabled: true,
    indicatorLabel: null,
    label: compactVersionLabel(appVersion),
    progressPercent: 0,
    tone: "idle",
    tooltip: "Up to date",
  } satisfies SidebarDesktopUpdateTagPresentation;

  if (!state || !shouldShowDesktopUpdateButton(state)) {
    return idlePresentation;
  }

  const action = resolveDesktopUpdateButtonAction(state);
  const isDownloaded = action === "install" || state.status === "downloaded";
  const isDownloading = state.status === "downloading";
  const isError = shouldHighlightDesktopUpdateError(state);
  // Active states label the chip with the version the action concerns, so
  // "ready to restart" reads as the incoming release, not the running one.
  const targetVersion = state.downloadedVersion ?? state.availableVersion;
  const targetLabel = targetVersion
    ? discriminatingChipVersionLabel(targetVersion, state.currentVersion ?? appVersion)
    : null;
  const downloadPercent = typeof state.downloadPercent === "number" ? state.downloadPercent : null;
  const progressPercent = isDownloaded
    ? 100
    : isDownloading && downloadPercent !== null
      ? Math.max(0, Math.min(100, downloadPercent))
      : 0;

  return {
    action,
    disabled: isDesktopUpdateButtonDisabled(state),
    indicatorLabel:
      isDownloading && downloadPercent !== null ? `${Math.floor(progressPercent)}%` : null,
    label: targetLabel ?? compactVersionLabel(appVersion),
    progressPercent,
    tone: isError
      ? "error"
      : isDownloaded
        ? "downloaded"
        : isDownloading
          ? "downloading"
          : "available",
    tooltip: getSidebarDesktopUpdateTagTooltip({
      action,
      isDownloading,
      isError,
      downloadPercent: isDownloading && downloadPercent !== null ? progressPercent : null,
      targetVersion: targetVersion ?? null,
    }),
  };
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" &&
    state.status !== "downloading" &&
    state.status !== "downloaded" &&
    state.status !== "disabled"
  );
}

export type DesktopUpdateActionKind = "check" | "download" | "install" | "none";

/**
 * What the single adaptive update action does right now: the pending
 * download/install when one exists, otherwise a manual update check when the
 * updater can accept one.
 */
export function resolveDesktopUpdateActionKind(
  state: DesktopUpdateState | null,
): DesktopUpdateActionKind {
  if (!state) return "none";
  const action = resolveDesktopUpdateButtonAction(state);
  if (action !== "none") return action;
  return canCheckForUpdate(state) ? "check" : "none";
}

export function isDesktopUpdateActionKindDisabled(state: DesktopUpdateState | null): boolean {
  if (resolveDesktopUpdateActionKind(state) === "none") return true;
  return isDesktopUpdateButtonDisabled(state);
}

export interface DesktopUpdateStatusLine {
  readonly text: string;
  /** Keys into the shared updater tone palette (updateStatusVisuals). */
  readonly tone: "neutral" | "progress" | "success" | "error";
}

/**
 * One-line updater status for the version hover card. Null when there is
 * nothing worth saying beyond the version itself (fresh idle state, or no
 * updater bridge at all).
 */
export function getDesktopUpdateStatusLine(
  state: DesktopUpdateState | null,
): DesktopUpdateStatusLine | null {
  if (!state) return null;
  if (state.status === "error") {
    return { text: state.message ?? "Update failed", tone: "error" };
  }
  const targetVersion = state.downloadedVersion ?? state.availableVersion;
  const targetLabel =
    targetVersion && state.currentVersion
      ? discriminatingVersionLabel(targetVersion, state.currentVersion)
      : targetVersion
        ? compactVersionLabel(targetVersion)
        : null;
  if (state.downloadedVersion || state.status === "downloaded") {
    // "restart to install" lives on the action button right below.
    return { text: `${targetLabel ?? "Update"} downloaded`, tone: "success" };
  }
  if (state.status === "downloading") {
    const subject = targetLabel ? `Downloading ${targetLabel}` : "Downloading update";
    return {
      text:
        typeof state.downloadPercent === "number"
          ? `${subject} · ${Math.floor(state.downloadPercent)}%`
          : subject,
      tone: "progress",
    };
  }
  if (state.status === "available") {
    return { text: `${targetLabel ?? "Update"} available`, tone: "progress" };
  }
  if (state.status === "checking") {
    return { text: "Checking for updates…", tone: "neutral" };
  }
  // "up-to-date" stays silent: the card's "Checked … ago" line already says it.
  if (!state.enabled || state.status === "disabled") {
    return {
      text: state.message ?? "Updates unavailable in this build",
      tone: "neutral",
    };
  }
  return null;
}

/**
 * Whether the version card should show updater controls (update track, action
 * button). False when the updater can never run in this build — the status
 * line alone explains why.
 */
export function shouldShowDesktopUpdaterControls(state: DesktopUpdateState | null): boolean {
  return state !== null && state.enabled && state.status !== "disabled";
}

/** Label for the version card's adaptive action button. */
export function getDesktopUpdateCardActionLabel(state: DesktopUpdateState | null): string {
  const kind = resolveDesktopUpdateActionKind(state);
  if (kind === "download") return "Download update";
  if (kind === "install") return "Restart to install";
  if (state?.status === "checking") return "Checking…";
  if (state?.status === "downloading") return "Downloading…";
  return "Check for updates";
}

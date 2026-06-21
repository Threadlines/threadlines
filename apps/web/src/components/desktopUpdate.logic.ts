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

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state) return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function getSidebarDesktopUpdateTagPresentation(
  state: DesktopUpdateState | null,
  compactAppVersion: string,
): SidebarDesktopUpdateTagPresentation {
  const idlePresentation = {
    action: "none",
    disabled: true,
    indicatorLabel: null,
    label: `v${compactAppVersion}`,
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
  const downloadPercent = typeof state.downloadPercent === "number" ? state.downloadPercent : null;
  const progressPercent = isDownloaded
    ? 100
    : isDownloading && downloadPercent !== null
      ? Math.max(0, Math.min(100, downloadPercent))
      : 0;
  const tooltip = isDownloading
    ? downloadPercent !== null
      ? `Downloading ${Math.floor(progressPercent)}%`
      : "Downloading"
    : isError
      ? action === "install"
        ? "Retry install"
        : "Retry download"
      : action === "install"
        ? "Restart to install"
        : "Update available";

  return {
    action,
    disabled: isDesktopUpdateButtonDisabled(state),
    indicatorLabel:
      isDownloading && downloadPercent !== null ? `${Math.floor(progressPercent)}%` : null,
    label: `v${compactAppVersion}`,
    progressPercent,
    tone: isError
      ? "error"
      : isDownloaded
        ? "downloaded"
        : isDownloading
          ? "downloading"
          : "available",
    tooltip,
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

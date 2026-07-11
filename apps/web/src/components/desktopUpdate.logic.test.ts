import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@threadlines/contracts";

import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateCardActionLabel,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateStatusLine,
  getSidebarDesktopUpdateTagPresentation,
  isDesktopUpdateActionKindDisabled,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateActionKind,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldShowDesktopUpdateButton,
  shouldShowDesktopUpdaterControls,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("shows a download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("keeps retry copy when a failed download returns to available state", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toBe("Download failed for 1.1.0. Click to retry.");
  });

  it("keeps install action available after an install error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("keeps retry copy when a failed install returns to downloaded state", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      downloadedVersion: "1.1.0",
      availableVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
    expect(getDesktopUpdateButtonTooltip(state)).toBe("Install failed for 1.1.0. Click to retry.");
  });

  it("prefers install when a downloaded version already exists", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("install");
  });

  it("hides the button for non-actionable check errors", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      message: "network unavailable",
      errorContext: "check",
      canRetry: true,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(false);
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });

  it("disables the button while downloading", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 42.5,
    };
    expect(shouldShowDesktopUpdateButton(state)).toBe(true);
    expect(isDesktopUpdateButtonDisabled(state)).toBe(true);
    expect(getDesktopUpdateButtonTooltip(state)).toContain("42%");
  });
});

describe("getDesktopUpdateActionError", () => {
  it("returns user-visible message for accepted failed attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: false,
      state: {
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
        message: "checksum mismatch",
        errorContext: "download",
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBe("checksum mismatch");
  });

  it("ignores messages for non-accepted attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: false,
      completed: false,
      state: {
        ...baseState,
        status: "error",
        message: "background failure",
        errorContext: "check",
        canRetry: false,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });

  it("ignores messages for successful attempts", () => {
    const result: DesktopUpdateActionResult = {
      accepted: true,
      completed: true,
      state: {
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
        availableVersion: "1.1.0",
        message: null,
        errorContext: null,
        canRetry: true,
      },
    };
    expect(getDesktopUpdateActionError(result)).toBeNull();
  });
});

describe("desktop update UI helpers", () => {
  it("shows an Apple Silicon warning for Intel builds under Rosetta", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
    };

    expect(shouldShowArm64IntelBuildWarning(state)).toBe(true);
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Apple Silicon");
    expect(getArm64IntelBuildWarningDescription(state)).toContain("Intel build");
  });

  it("changes the warning copy when a native build update is ready to download", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      hostArch: "arm64",
      appArch: "x64",
      runningUnderArm64Translation: true,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getArm64IntelBuildWarningDescription(state)).toContain("Download the available update");
  });

  it("includes the downloaded version in the install confirmation copy", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.1",
      }),
    ).toContain("Install update 1.1.1 and restart Threadlines?");
  });

  it("falls back to generic install confirmation copy when no version is available", () => {
    expect(
      getDesktopUpdateInstallConfirmationMessage({
        availableVersion: null,
        downloadedVersion: null,
      }),
    ).toContain("Install update and restart Threadlines?");
  });
});

describe("getSidebarDesktopUpdateTagPresentation", () => {
  it("shows the compact app version when no update action is available", () => {
    expect(getSidebarDesktopUpdateTagPresentation(baseState, "1.0.0")).toEqual({
      action: "none",
      disabled: true,
      indicatorLabel: null,
      label: "v1.0.0",
      progressPercent: 0,
      tone: "idle",
      tooltip: "Up to date",
    });
  });

  it("turns the version tag into an update prompt", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getSidebarDesktopUpdateTagPresentation(state, "1.0.0")).toMatchObject({
      action: "download",
      disabled: false,
      indicatorLabel: null,
      label: "v1.1.0",
      progressPercent: 0,
      tone: "available",
      tooltip: "v1.1.0 available",
    });
  });

  it("shows download failures as a retry prompt in the compact tag", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };

    expect(getSidebarDesktopUpdateTagPresentation(state, "1.0.0")).toMatchObject({
      action: "download",
      disabled: false,
      indicatorLabel: null,
      label: "v1.1.0",
      progressPercent: 0,
      tone: "error",
      tooltip: "Download failed",
    });
  });

  it("renders bounded download progress in the compact tag", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 142.2,
    };

    expect(getSidebarDesktopUpdateTagPresentation(state, "1.0.0")).toMatchObject({
      action: "none",
      disabled: true,
      indicatorLabel: "100%",
      label: "v1.1.0",
      progressPercent: 100,
      tone: "downloading",
      tooltip: "Downloading v1.1.0 · 100%",
    });
  });

  it("keeps unknown download progress unlabeled in the compact tag", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: null,
    };

    expect(getSidebarDesktopUpdateTagPresentation(state, "1.0.0")).toMatchObject({
      action: "none",
      disabled: true,
      indicatorLabel: null,
      label: "v1.1.0",
      progressPercent: 0,
      tone: "downloading",
      tooltip: "Downloading v1.1.0",
    });
  });

  it("shows install failures as a retry prompt in the compact tag", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      message: "shutdown timeout",
      errorContext: "install",
      canRetry: true,
    };

    expect(getSidebarDesktopUpdateTagPresentation(state, "1.0.0")).toMatchObject({
      action: "install",
      disabled: false,
      indicatorLabel: null,
      label: "v1.1.0",
      progressPercent: 100,
      tone: "error",
      tooltip: "Install failed",
    });
  });

  it("marks downloaded updates as ready to restart", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };

    expect(getSidebarDesktopUpdateTagPresentation(state, "1.0.0")).toMatchObject({
      action: "install",
      disabled: false,
      indicatorLabel: null,
      label: "v1.1.0",
      progressPercent: 100,
      tone: "downloaded",
      tooltip: "Restart to install v1.1.0",
    });
  });

  it("compacts prerelease tails out of the target version label", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloaded",
      availableVersion: "1.1.0-nightly.4",
      downloadedVersion: "1.1.0-nightly.4",
    };

    expect(getSidebarDesktopUpdateTagPresentation(state, "1.0.0-nightly.2")).toMatchObject({
      label: "v1.1.0",
      tooltip: "Restart to install v1.1.0",
    });
  });
});

describe("canCheckForUpdate", () => {
  it("returns false for null state", () => {
    expect(canCheckForUpdate(null)).toBe(false);
  });

  it("returns false when updates are disabled", () => {
    expect(canCheckForUpdate({ ...baseState, enabled: false, status: "disabled" })).toBe(false);
  });

  it("returns false while checking", () => {
    expect(canCheckForUpdate({ ...baseState, status: "checking" })).toBe(false);
  });

  it("returns false while downloading", () => {
    expect(canCheckForUpdate({ ...baseState, status: "downloading", downloadPercent: 50 })).toBe(
      false,
    );
  });

  it("returns false once an update has been downloaded", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(false);
  });

  it("returns true when idle", () => {
    expect(canCheckForUpdate({ ...baseState, status: "idle" })).toBe(true);
  });

  it("returns true when up-to-date", () => {
    expect(canCheckForUpdate({ ...baseState, status: "up-to-date" })).toBe(true);
  });

  it("returns true when an update is available", () => {
    expect(
      canCheckForUpdate({ ...baseState, status: "available", availableVersion: "1.1.0" }),
    ).toBe(true);
  });

  it("returns true on error so the user can retry", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "error",
        errorContext: "check",
        message: "network",
      }),
    ).toBe(true);
  });
});

describe("getDesktopUpdateButtonTooltip", () => {
  it("returns 'Up to date' for non-actionable states", () => {
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "idle" })).toBe("Up to date");
    expect(getDesktopUpdateButtonTooltip({ ...baseState, status: "up-to-date" })).toBe(
      "Up to date",
    );
  });
});

describe("resolveDesktopUpdateActionKind", () => {
  it("returns none for null state", () => {
    expect(resolveDesktopUpdateActionKind(null)).toBe("none");
  });

  it("falls back to a manual check when no update action is pending", () => {
    expect(resolveDesktopUpdateActionKind(baseState)).toBe("check");
    expect(resolveDesktopUpdateActionKind({ ...baseState, status: "up-to-date" })).toBe("check");
  });

  it("prefers the pending download or install over a check", () => {
    expect(
      resolveDesktopUpdateActionKind({
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
      }),
    ).toBe("download");
    expect(
      resolveDesktopUpdateActionKind({
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
      }),
    ).toBe("install");
  });

  it("returns none while busy or disabled", () => {
    expect(resolveDesktopUpdateActionKind({ ...baseState, status: "checking" })).toBe("none");
    expect(resolveDesktopUpdateActionKind({ ...baseState, status: "downloading" })).toBe("none");
    expect(resolveDesktopUpdateActionKind({ ...baseState, enabled: false })).toBe("none");
  });
});

describe("isDesktopUpdateActionKindDisabled", () => {
  it("disables the action when there is nothing to run", () => {
    expect(isDesktopUpdateActionKindDisabled(null)).toBe(true);
    expect(isDesktopUpdateActionKindDisabled({ ...baseState, status: "checking" })).toBe(true);
    expect(isDesktopUpdateActionKindDisabled({ ...baseState, enabled: false })).toBe(true);
  });

  it("keeps check, download, and install actions enabled", () => {
    expect(isDesktopUpdateActionKindDisabled(baseState)).toBe(false);
    expect(
      isDesktopUpdateActionKindDisabled({
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
      }),
    ).toBe(false);
    expect(
      isDesktopUpdateActionKindDisabled({
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(false);
  });
});

describe("getDesktopUpdateStatusLine", () => {
  it("stays silent for fresh idle state and missing bridges", () => {
    expect(getDesktopUpdateStatusLine(null)).toBeNull();
    expect(getDesktopUpdateStatusLine(baseState)).toBeNull();
  });

  it("surfaces the updater error message", () => {
    expect(
      getDesktopUpdateStatusLine({
        ...baseState,
        status: "error",
        message: "network timeout",
        errorContext: "download",
      }),
    ).toEqual({ text: "network timeout", tone: "error" });
    expect(getDesktopUpdateStatusLine({ ...baseState, status: "error" })).toEqual({
      text: "Update failed",
      tone: "error",
    });
  });

  it("describes the pending update lifecycle", () => {
    expect(
      getDesktopUpdateStatusLine({
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
      }),
    ).toEqual({ text: "v1.1.0 available", tone: "progress" });
    expect(
      getDesktopUpdateStatusLine({
        ...baseState,
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 42.7,
      }),
    ).toEqual({ text: "Downloading v1.1.0 · 42%", tone: "progress" });
    expect(
      getDesktopUpdateStatusLine({
        ...baseState,
        status: "downloading",
        availableVersion: "1.1.0",
      }),
    ).toEqual({ text: "Downloading v1.1.0", tone: "progress" });
    expect(
      getDesktopUpdateStatusLine({
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0-nightly.4",
      }),
    ).toEqual({ text: "v1.1.0 downloaded", tone: "success" });
  });

  it("reports check activity and stays silent once up to date", () => {
    expect(getDesktopUpdateStatusLine({ ...baseState, status: "checking" })).toEqual({
      text: "Checking for updates…",
      tone: "neutral",
    });
    expect(getDesktopUpdateStatusLine({ ...baseState, status: "up-to-date" })).toBeNull();
  });

  it("explains disabled updaters", () => {
    expect(getDesktopUpdateStatusLine({ ...baseState, status: "disabled" })).toEqual({
      text: "Updates unavailable in this build",
      tone: "neutral",
    });
    expect(
      getDesktopUpdateStatusLine({ ...baseState, enabled: false, message: "unsupported install" }),
    ).toEqual({ text: "unsupported install", tone: "neutral" });
  });
});

describe("shouldShowDesktopUpdaterControls", () => {
  it("shows controls only for operational updaters", () => {
    expect(shouldShowDesktopUpdaterControls(null)).toBe(false);
    expect(shouldShowDesktopUpdaterControls({ ...baseState, enabled: false })).toBe(false);
    expect(shouldShowDesktopUpdaterControls({ ...baseState, status: "disabled" })).toBe(false);
    expect(shouldShowDesktopUpdaterControls(baseState)).toBe(true);
    expect(shouldShowDesktopUpdaterControls({ ...baseState, status: "downloading" })).toBe(true);
  });
});

describe("getDesktopUpdateCardActionLabel", () => {
  it("labels the adaptive action for each kind", () => {
    expect(getDesktopUpdateCardActionLabel(null)).toBe("Check for updates");
    expect(getDesktopUpdateCardActionLabel(baseState)).toBe("Check for updates");
    expect(
      getDesktopUpdateCardActionLabel({
        ...baseState,
        status: "available",
        availableVersion: "1.1.0",
      }),
    ).toBe("Download update");
    expect(
      getDesktopUpdateCardActionLabel({
        ...baseState,
        status: "downloaded",
        downloadedVersion: "1.1.0",
      }),
    ).toBe("Restart to install");
  });

  it("labels busy states while the action is unavailable", () => {
    expect(getDesktopUpdateCardActionLabel({ ...baseState, status: "checking" })).toBe("Checking…");
    expect(getDesktopUpdateCardActionLabel({ ...baseState, status: "downloading" })).toBe(
      "Downloading…",
    );
  });
});

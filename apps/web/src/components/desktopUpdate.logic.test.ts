import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@threadlines/contracts";

import {
  canCheckForUpdate,
  describeRailUpdateCard,
  discriminatingVersionLabel,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateButtonTooltip,
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

describe("discriminatingVersionLabel", () => {
  it("keeps only the run suffix across days too, since the counter never resets", () => {
    expect(
      discriminatingVersionLabel("0.3.2-nightly.20260808.225", "0.3.2-nightly.20260807.221"),
    ).toBe(".225");
  });

  it("names the channel when a nightly's base version moved", () => {
    expect(
      discriminatingVersionLabel("0.3.3-nightly.20260808.1", "0.3.2-nightly.20260807.221"),
    ).toBe("v0.3.3-nightly");
  });

  it("keeps the exact compact triple for stable targets", () => {
    expect(discriminatingVersionLabel("0.3.3", "0.3.2-nightly.20260807.221")).toBe("v0.3.3");
  });

  it("marks a nightly target as nightly when running a stable", () => {
    expect(discriminatingVersionLabel("0.3.2-nightly.20260807.222", "0.3.1")).toBe(
      "v0.3.2-nightly",
    );
  });
});

describe("getSidebarDesktopUpdateTagPresentation", () => {
  it("shows the compact app version when no update action is available", () => {
    expect(getSidebarDesktopUpdateTagPresentation(baseState, "1.0.0")).toEqual({
      action: "none",
      disabled: true,
      label: "v1.0.0",
      progressPercent: 0,
      tone: "idle",
      tooltip: "Up to date",
    });
  });

  it("names the download action when an update is available", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.1.0",
    };

    expect(getSidebarDesktopUpdateTagPresentation(state, "1.0.0")).toMatchObject({
      action: "download",
      disabled: false,
      label: "Update",
      progressPercent: 0,
      tone: "available",
      tooltip: "Download v1.1.0",
    });
  });

  it("shows download failures as a retry prompt", () => {
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
      label: "Retry",
      progressPercent: 0,
      tone: "error",
      tooltip: "Retry downloading v1.1.0",
    });
  });

  it("renders bounded download progress as the label", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: 142.2,
    };

    expect(getSidebarDesktopUpdateTagPresentation(state, "1.0.0")).toMatchObject({
      action: "none",
      disabled: true,
      label: "100%",
      progressPercent: 100,
      tone: "downloading",
      tooltip: "Downloading v1.1.0 · 100%",
    });
  });

  it("does not invent a percentage for unknown download progress", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "downloading",
      availableVersion: "1.1.0",
      downloadPercent: null,
    };

    expect(getSidebarDesktopUpdateTagPresentation(state, "1.0.0")).toMatchObject({
      action: "none",
      disabled: true,
      label: "Downloading",
      progressPercent: 0,
      tone: "downloading",
      tooltip: "Downloading v1.1.0",
    });
  });

  it("shows install failures as a retry prompt", () => {
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
      label: "Retry",
      progressPercent: 100,
      tone: "error",
      tooltip: "Retry installing v1.1.0",
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
      label: "Restart",
      progressPercent: 100,
      tone: "downloaded",
      tooltip: "Restart to install v1.1.0",
    });
  });

  it("keeps the full target version in the tooltip", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      currentVersion: "0.3.2-nightly.20260807.221",
      status: "available",
      availableVersion: "0.3.2-nightly.20260807.222",
    };

    // The chip only names the action; the tooltip carries the exact target so
    // a nightly can never be mistaken for the stable of the same base.
    expect(
      getSidebarDesktopUpdateTagPresentation(state, "0.3.2-nightly.20260807.221"),
    ).toMatchObject({
      label: "Update",
      tooltip: "Download v0.3.2-nightly.20260807.222",
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

describe("describeRailUpdateCard", () => {
  const now = Date.parse("2026-10-23T12:00:00.000Z");
  const card = (
    state: Partial<DesktopUpdateState> | null,
    appVersion = "0.7.1",
    buildChannel: "Stable" | "Nightly" | "Dev" = "Stable",
  ) =>
    describeRailUpdateCard({
      state: state === null ? null : { ...baseState, currentVersion: appVersion, ...state },
      appVersion,
      buildChannel,
      checkedAgo: "5 min ago",
      nowMs: now,
      runs: true,
    });

  it("names the version the user has, then the one an update brings, in the same place", () => {
    expect(card({ status: "idle" })).toMatchObject({
      lead: "Threadlines",
      version: { triple: "0.7.1", build: null },
      channel: null,
      line: "Checked 5 min ago · click to check",
    });
    expect(card({ status: "checking" })).toMatchObject({
      version: { triple: "0.7.1" },
      checking: true,
      line: "Checking for a newer version…",
    });
    expect(card({ status: "available", availableVersion: "0.8.0" })).toMatchObject({
      lead: "Update to",
      version: { triple: "0.8.0" },
      changed: { triple: true, build: false },
      checking: false,
      line: "Click to download · you have v0.7.1",
    });
    // A fresh answer says so; an old one goes back to when it was checked.
    const justNow = new Date(now - 10_000).toISOString();
    expect(card({ status: "up-to-date", checkedAt: justNow }).line).toBe(
      "Up to date · checked just now",
    );
    const earlier = new Date(now - 5 * 60_000).toISOString();
    expect(card({ status: "up-to-date", checkedAt: earlier }).line).toBe(
      "Checked 5 min ago · click to check",
    );
  });

  it("tags a nightly with its build, and rolls the version too when it changes", () => {
    const nightly = "0.8.0-nightly.20261022.345";
    expect(card({ status: "idle" }, nightly, "Nightly")).toMatchObject({
      version: { triple: "0.8.0", build: "345" },
      channel: "Nightly",
    });
    expect(
      card(
        { status: "available", availableVersion: "0.8.0-nightly.20261023.352" },
        nightly,
        "Nightly",
      ),
    ).toMatchObject({
      version: { triple: "0.8.0", build: "352" },
      changed: { triple: false, build: true },
      line: "Click to download · you have 345",
    });
    expect(
      card(
        { status: "available", availableVersion: "0.8.1-nightly.20261023.352" },
        nightly,
        "Nightly",
      ),
    ).toMatchObject({
      version: { triple: "0.8.1", build: "352" },
      changed: { triple: true, build: true },
      line: "Click to download · you have v0.8.0",
    });
    expect(card({ status: "idle" }, "0.7.1-dev", "Dev").channel).toBe("Dev");
  });

  it("keeps the target in view while it downloads, waits, or fails to install", () => {
    expect(
      card({ status: "downloading", availableVersion: "0.8.0", downloadPercent: 42.7 }),
    ).toMatchObject({ lead: "Update to", line: "Downloading · 42%" });
    expect(card({ status: "downloaded", downloadedVersion: "0.8.0" })).toMatchObject({
      lead: "Update to",
      version: { triple: "0.8.0" },
      line: "Click to restart · running work is listed first",
    });
    expect(
      card({
        status: "error",
        errorContext: "install",
        downloadedVersion: "0.8.0",
        message: "Couldn't install",
      }),
    ).toMatchObject({
      lead: "Update to",
      lineTone: "error",
      line: "Couldn't install · click to try again",
    });
    // A check that failed is about the version the user has.
    expect(card({ status: "error", errorContext: "check", message: "Offline" })).toMatchObject({
      lead: "Threadlines",
      line: "Offline · click to try again",
    });
  });
});

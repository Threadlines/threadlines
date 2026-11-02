import { describe, expect, it } from "vite-plus/test";

import {
  classifyUpdateDownloadFailure,
  createInitialDesktopUpdateState,
  describeUpdateDownloadFailure,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

describe("classifyUpdateDownloadFailure", () => {
  it.each([
    ['Cannot download "https://github.com/a.exe", status 504: ', "server"],
    ['Cannot download "https://github.com/a.exe", status 429: ', "server"],
    [Object.assign(new Error("HTTP error"), { statusCode: 503 }), "server"],
    ["net::ERR_INTERNET_DISCONNECTED", "network"],
    ["connect ETIMEDOUT 140.82.114.3:443", "network"],
    ['Cannot download "https://github.com/a.exe", status 404: ', "other"],
    ["sha512 checksum mismatch, expected abc", "other"],
    ["net::ERR_CONNECTION_RESET", "network"],
    ["net::ERR_CERT_AUTHORITY_INVALID", "other"],
    ["net::ERR_ABORTED", "other"],
    ["cancelled", "other"],
  ])("reads %s as %s", (cause, kind) => {
    expect(classifyUpdateDownloadFailure(cause)).toBe(kind);
  });

  it("names the problem only when it knows it", () => {
    expect(describeUpdateDownloadFailure(new Error("status 504"), "fallback")).toBe(
      "GitHub's download server had a problem. Try again in a minute.",
    );
    expect(describeUpdateDownloadFailure(new Error("checksum mismatch"), "fallback")).toBe(
      "fallback",
    );
  });
});

const runtimeInfo = {
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
} as const;

describe("updateMachine", () => {
  it("clears transient errors when a check starts", () => {
    const state = reduceDesktopUpdateStateOnCheckStart(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "error",
        message: "network",
        errorContext: "check",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("checking");
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
    expect(state.canRetry).toBe(false);
  });

  it("records a check failure without exposing an action", () => {
    const state = reduceDesktopUpdateStateOnCheckFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "checking",
      },
      "network unavailable",
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("error");
    expect(state.errorContext).toBe("check");
    expect(state.canRetry).toBe(true);
  });

  it("preserves available version on download failure for retry", () => {
    const state = reduceDesktopUpdateStateOnDownloadFailure(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
        downloadPercent: 43,
      },
      "checksum mismatch",
    );

    expect(state.status).toBe("available");
    expect(state.availableVersion).toBe("1.1.0");
    expect(state.errorContext).toBe("download");
    expect(state.canRetry).toBe(true);
  });

  it("transitions to downloaded and then preserves install retry state", () => {
    const downloaded = reduceDesktopUpdateStateOnDownloadComplete(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "downloading",
        availableVersion: "1.1.0",
      },
      "1.1.0",
    );
    const failedInstall = reduceDesktopUpdateStateOnInstallFailure(
      downloaded,
      "backend shutdown timed out",
    );

    expect(downloaded.status).toBe("downloaded");
    expect(downloaded.downloadedVersion).toBe("1.1.0");
    expect(failedInstall.status).toBe("downloaded");
    expect(failedInstall.errorContext).toBe("install");
    expect(failedInstall.canRetry).toBe(true);
  });

  it("clears stale download state when no update is available", () => {
    const state = reduceDesktopUpdateStateOnNoUpdate(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "error",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
        message: "old failure",
        errorContext: "download",
        canRetry: true,
      },
      "2026-03-04T00:00:00.000Z",
    );

    expect(state.status).toBe("up-to-date");
    expect(state.availableVersion).toBeNull();
    expect(state.downloadedVersion).toBeNull();
    expect(state.message).toBeNull();
    expect(state.errorContext).toBeNull();
  });

  it("tracks available, download start, and progress cleanly", () => {
    const available = reduceDesktopUpdateStateOnUpdateAvailable(
      {
        ...createInitialDesktopUpdateState("1.0.0", runtimeInfo, "latest"),
        enabled: true,
        status: "checking",
      },
      "1.1.0",
      "2026-03-04T00:00:00.000Z",
    );
    const downloading = reduceDesktopUpdateStateOnDownloadStart(available);
    const progress = reduceDesktopUpdateStateOnDownloadProgress(downloading, 55.5);

    expect(available.status).toBe("available");
    expect(available.channel).toBe("latest");
    expect(downloading.status).toBe("downloading");
    expect(downloading.downloadPercent).toBeNull();
    expect(progress.downloadPercent).toBe(55.5);
    expect(progress.errorContext).toBeNull();
  });
});

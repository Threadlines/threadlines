import type {
  DesktopRuntimeInfo,
  DesktopUpdateChannel,
  DesktopUpdateState,
} from "@threadlines/contracts";

export function nextStatusAfterDownloadFailure(
  currentState: DesktopUpdateState,
): DesktopUpdateState["status"] {
  return currentState.availableVersion ? "available" : "error";
}

export function getCanRetryAfterDownloadFailure(currentState: DesktopUpdateState): boolean {
  return currentState.availableVersion !== null;
}

export function createInitialDesktopUpdateState(
  currentVersion: string,
  runtimeInfo: DesktopRuntimeInfo,
  channel: DesktopUpdateChannel,
): DesktopUpdateState {
  return {
    enabled: false,
    status: "disabled",
    channel,
    currentVersion,
    hostArch: runtimeInfo.hostArch,
    appArch: runtimeInfo.appArch,
    runningUnderArm64Translation: runtimeInfo.runningUnderArm64Translation,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnCheckStart(
  state: DesktopUpdateState,
  checkedAt: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "checking",
    checkedAt,
    message: null,
    downloadPercent: null,
    errorContext: null,
    canRetry: false,
  };
}

/**
 * Whether Restart can install now: an update is downloaded. The client's
 * Restart button reads the same field, so a button that shows always works.
 */
export function hasInstallableUpdate(state: DesktopUpdateState): boolean {
  return state.downloadedVersion !== null;
}

/**
 * A check that failed. A downloaded update stays ready: its installer is
 * still on disk, and one GitHub hiccup on a later re-check must not take
 * Restart away.
 */
export function reduceDesktopUpdateStateOnCheckFailure(
  state: DesktopUpdateState,
  message: string,
  checkedAt: string,
): DesktopUpdateState {
  if (state.status === "downloaded") return state;
  return {
    ...state,
    status: "error",
    message,
    checkedAt,
    downloadPercent: null,
    errorContext: "check",
    canRetry: true,
  };
}

export function reduceDesktopUpdateStateOnUpdateAvailable(
  state: DesktopUpdateState,
  version: string,
  checkedAt: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "available",
    availableVersion: version,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnNoUpdate(
  state: DesktopUpdateState,
  checkedAt: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "up-to-date",
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadStart(
  state: DesktopUpdateState,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloading",
    downloadPercent: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

/**
 * Why an update check or download failed, by what the updater's error says:
 * `server` answered "not now" (5xx, 408, 429), `network` got no answer at
 * all, and `other` is anything a second try won't change, like a missing
 * file or a bad checksum.
 */
export type UpdaterRequestFailureKind = "server" | "network" | "other";

export function classifyUpdaterRequestFailure(cause: unknown): UpdaterRequestFailureKind {
  const message = cause instanceof Error ? cause.message : String(cause);
  // A check's failed request is an HttpError carrying `statusCode`; a
  // download's says "status 504", and an error that wraps an HttpError
  // keeps its "HttpError: 504" line.
  const statusCode =
    typeof cause === "object" && cause !== null && "statusCode" in cause
      ? Number(cause.statusCode)
      : Number(/\b(?:status|HttpError:) (\d{3})\b/u.exec(message)?.[1]);
  if (Number.isInteger(statusCode)) {
    return statusCode >= 500 || statusCode === 408 || statusCode === 429 ? "server" : "other";
  }
  // Named one by one: other `net::ERR_` errors, like a certificate this
  // computer doesn't trust, stay the same however often it tries.
  return /net::ERR_(?:INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|CONNECTION_\w+|TIMED_OUT|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|EMPTY_RESPONSE)\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|socket hang up/iu.test(
    message,
  )
    ? "network"
    : "other";
}

/** What the user reads for a check or download that failed for good, or `fallback` when there's nothing plainer to say. */
export function describeUpdaterRequestFailure(cause: unknown, fallback: string): string {
  switch (classifyUpdaterRequestFailure(cause)) {
    case "server":
      return "GitHub's download server had a problem. Try again in a minute.";
    case "network":
      return "Couldn't reach GitHub. Check your connection and try again.";
    case "other":
      return fallback;
  }
}

export function reduceDesktopUpdateStateOnDownloadFailure(
  state: DesktopUpdateState,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: nextStatusAfterDownloadFailure(state),
    message,
    downloadPercent: null,
    errorContext: "download",
    canRetry: getCanRetryAfterDownloadFailure(state),
  };
}

export function reduceDesktopUpdateStateOnDownloadProgress(
  state: DesktopUpdateState,
  percent: number,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloading",
    downloadPercent: percent,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

export function reduceDesktopUpdateStateOnDownloadComplete(
  state: DesktopUpdateState,
  version: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloaded",
    availableVersion: version,
    downloadedVersion: version,
    downloadPercent: 100,
    message: null,
    errorContext: null,
    canRetry: true,
  };
}

export function reduceDesktopUpdateStateOnInstallFailure(
  state: DesktopUpdateState,
  message: string,
): DesktopUpdateState {
  return {
    ...state,
    status: "downloaded",
    message,
    errorContext: "install",
    canRetry: true,
  };
}

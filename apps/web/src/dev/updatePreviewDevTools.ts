import type { QueryClient } from "@tanstack/react-query";
import type {
  DesktopUpdateCheckResult,
  DesktopUpdateState,
  ServerConfig,
  ServerProviderUpdateStatus,
} from "@threadlines/contracts";

import { APP_VERSION } from "../branding";
import {
  desktopUpdateQueryKeys,
  setDesktopUpdateStateQueryData,
} from "../lib/desktopUpdateReactQuery";
import { getServerConfig, setServerConfigSnapshot } from "../rpc/serverState";

/**
 * Console-driven previews for the sidebar updater surfaces, installed as
 * `window.threadlinesUpdatePreview` in dev builds only (see getRouter).
 *
 * The previews write straight into client state: the desktop update query
 * cache and the server-config atom. Nothing is sent to the desktop bridge or
 * the server, and a real state push from either simply overwrites the
 * preview.
 *
 * Dev sessions also boot directly into a pinned desktop-updater preview so
 * the updater surfaces are visible without setup: "up-to-date" by default,
 * another mode via `?updatePreview=<mode>` or
 * `localStorage["threadlines:update-preview"]`, and none with the value
 * "off". Unlike the console calls, a boot preview is pinned — startup
 * refetches and bridge pushes cannot overwrite it — until a console preview
 * call releases it for the session.
 */
const DESKTOP_UPDATE_PREVIEW_MODES = [
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
] as const;

export type DesktopUpdatePreviewMode = (typeof DESKTOP_UPDATE_PREVIEW_MODES)[number];

export const DESKTOP_UPDATE_PREVIEW_PARAM = "updatePreview";
export const DESKTOP_UPDATE_PREVIEW_STORAGE_KEY = "threadlines:update-preview";

function readBootDesktopUpdatePreviewMode(): DesktopUpdatePreviewMode | null {
  const raw =
    new URLSearchParams(window.location.search).get(DESKTOP_UPDATE_PREVIEW_PARAM) ??
    window.localStorage.getItem(DESKTOP_UPDATE_PREVIEW_STORAGE_KEY);
  if (raw === null) return "up-to-date";
  if (raw === "off") return null;
  const mode = DESKTOP_UPDATE_PREVIEW_MODES.find((candidate) => candidate === raw);
  if (!mode) {
    console.warn(
      `[threadlines] update preview: unknown mode "${raw}" — expected "off" or one of: ${DESKTOP_UPDATE_PREVIEW_MODES.join(", ")}`,
    );
  }
  return mode ?? null;
}

export interface DesktopUpdatePreviewOptions {
  /** Incoming version shown on the chip. Defaults to the next patch release. */
  readonly version?: string;
  /** Download percent; pass null for the indeterminate shimmer. Defaults to 42. */
  readonly percent?: number | null;
}

export type ProviderUpdatePreviewStatus = Exclude<ServerProviderUpdateStatus, "idle">;

export interface UpdatePreviewDevTools {
  desktopUpdate(mode?: DesktopUpdatePreviewMode, options?: DesktopUpdatePreviewOptions): void;
  animateDesktopDownload(durationMs?: number): void;
  clearDesktopUpdate(): void;
  providerUpdates(
    statuses?: ProviderUpdatePreviewStatus | ReadonlyArray<ProviderUpdatePreviewStatus>,
  ): void;
  animateProviderUpdates(): void;
  clearProviderUpdates(): void;
}

declare global {
  interface Window {
    threadlinesUpdatePreview?: UpdatePreviewDevTools;
  }
}

const DESKTOP_ANIMATION_TICK_MS = 250;
const DESKTOP_CHECK_PREVIEW_DELAY_MS = 1_200;
const PROVIDER_ANIMATION_TICK_MS = 400;

function nextPatchVersion(version: string): string {
  const releaseTriple = version.split(/[-+]/)[0] ?? version;
  const parts = releaseTriple.split(".").map((part) => Number.parseInt(part, 10));
  const [major, minor, patch] = parts;
  if (parts.length !== 3 || major === undefined || minor === undefined || patch === undefined) {
    return "0.0.2";
  }
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    return "0.0.2";
  }
  return `${major}.${minor}.${patch + 1}`;
}

function makeDesktopUpdatePreviewState(
  mode: DesktopUpdatePreviewMode,
  options?: DesktopUpdatePreviewOptions,
): DesktopUpdateState {
  const version = options?.version ?? nextPatchVersion(APP_VERSION);
  const availableState: DesktopUpdateState = {
    enabled: true,
    status: "available",
    channel: "latest",
    currentVersion: APP_VERSION,
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: version,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: new Date().toISOString(),
    message: null,
    errorContext: null,
    canRetry: false,
  };

  switch (mode) {
    case "up-to-date":
      // Idle operational updater: the version card shows the update track
      // and the "Check for updates" action.
      return { ...availableState, status: "up-to-date", availableVersion: null };
    case "available":
      return availableState;
    case "downloading":
      return {
        ...availableState,
        status: "downloading",
        downloadPercent: options?.percent === undefined ? 42 : options.percent,
      };
    case "downloaded":
      return {
        ...availableState,
        status: "downloaded",
        downloadedVersion: version,
        downloadPercent: 100,
      };
    case "error":
      return {
        ...availableState,
        status: "error",
        message: "Preview download failure.",
        errorContext: "download",
        canRetry: true,
      };
  }
}

function isSameDesktopUpdateState(
  left: DesktopUpdateState | null | undefined,
  right: DesktopUpdateState,
) {
  return (
    left !== null &&
    left !== undefined &&
    left.enabled === right.enabled &&
    left.status === right.status &&
    left.channel === right.channel &&
    left.currentVersion === right.currentVersion &&
    left.hostArch === right.hostArch &&
    left.appArch === right.appArch &&
    left.runningUnderArm64Translation === right.runningUnderArm64Translation &&
    left.availableVersion === right.availableVersion &&
    left.downloadedVersion === right.downloadedVersion &&
    left.downloadPercent === right.downloadPercent &&
    left.checkedAt === right.checkedAt &&
    left.message === right.message &&
    left.errorContext === right.errorContext &&
    left.canRetry === right.canRetry
  );
}

function isRealUpdateActivityState(state: unknown): state is DesktopUpdateState {
  if (typeof state !== "object" || state === null) return false;
  const status = (state as Partial<DesktopUpdateState>).status;
  return (
    status === "checking" ||
    status === "available" ||
    status === "downloading" ||
    status === "downloaded" ||
    status === "error"
  );
}

function withProviderUpdateStates(
  baseline: ServerConfig,
  statuses: ReadonlyArray<ProviderUpdatePreviewStatus | undefined>,
  finishedAtByIndex: Map<number, string>,
): ServerConfig {
  const providers = baseline.providers.map((provider, index) => {
    const status = statuses[index];
    if (status === undefined) {
      return provider;
    }
    const isTerminal = status === "succeeded" || status === "failed" || status === "unchanged";
    let finishedAt: string | null = null;
    if (isTerminal) {
      finishedAt = finishedAtByIndex.get(index) ?? new Date().toISOString();
      finishedAtByIndex.set(index, finishedAt);
    }
    return {
      ...provider,
      updateState: {
        status,
        startedAt: new Date().toISOString(),
        finishedAt,
        message: status === "failed" ? "Preview: update command failed." : null,
        output: null,
      },
    };
  });

  return { ...baseline, providers };
}

export function installUpdatePreviewDevTools(queryClient: QueryClient): void {
  let desktopTimer: number | null = null;
  let providerTimer: number | null = null;
  let releaseBootPreviewPin: (() => void) | null = null;
  let desktopPreviewCheckEnabled = false;
  let applyDesktopPreviewState = (state: DesktopUpdateState) => {
    setDesktopUpdateStateQueryData(queryClient, state);
  };
  let previewDesktopActionActive = false;

  const releaseBootPreview = () => {
    releaseBootPreviewPin?.();
    releaseBootPreviewPin = null;
    applyDesktopPreviewState = (state) => {
      setDesktopUpdateStateQueryData(queryClient, state);
    };
  };

  const simulateDesktopCheckForUpdate = async (): Promise<DesktopUpdateCheckResult | null> => {
    const currentState =
      queryClient.getQueryData<DesktopUpdateState | null>(desktopUpdateQueryKeys.state()) ?? null;
    if (!desktopPreviewCheckEnabled || !currentState?.enabled || currentState.status === "disabled")
      return null;

    previewDesktopActionActive = true;
    try {
      const checkingState: DesktopUpdateState = {
        ...currentState,
        status: "checking",
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        message: null,
        errorContext: null,
        canRetry: false,
      };
      applyDesktopPreviewState(checkingState);

      await new Promise((resolve) => window.setTimeout(resolve, DESKTOP_CHECK_PREVIEW_DELAY_MS));
      const latestState =
        queryClient.getQueryData<DesktopUpdateState | null>(desktopUpdateQueryKeys.state()) ??
        checkingState;
      if (
        !desktopPreviewCheckEnabled ||
        !latestState.enabled ||
        latestState.status === "disabled"
      ) {
        return null;
      }

      const resultState: DesktopUpdateState = {
        ...latestState,
        status: "up-to-date",
        availableVersion: null,
        downloadedVersion: null,
        downloadPercent: null,
        checkedAt: new Date().toISOString(),
        message: null,
        errorContext: null,
        canRetry: false,
      };
      applyDesktopPreviewState(resultState);
      return { checked: true, state: resultState };
    } finally {
      previewDesktopActionActive = false;
    }
  };

  const pinBootDesktopPreview = () => {
    const mode = readBootDesktopUpdatePreviewMode();
    if (!mode) return;
    let pinnedState = makeDesktopUpdatePreviewState(mode);
    const stateKey = JSON.stringify(desktopUpdateQueryKeys.state());
    let released = false;
    let reapplyQueued = false;

    const setPinnedState = (state: DesktopUpdateState) => {
      pinnedState = state;
      setDesktopUpdateStateQueryData(queryClient, state);
    };

    const queuePinnedStateReapply = () => {
      if (released || reapplyQueued) return;
      reapplyQueued = true;
      window.queueMicrotask(() => {
        reapplyQueued = false;
        if (released) return;
        const currentState = queryClient.getQueryData<DesktopUpdateState | null>(
          desktopUpdateQueryKeys.state(),
        );
        if (isSameDesktopUpdateState(currentState, pinnedState)) return;
        setDesktopUpdateStateQueryData(queryClient, pinnedState);
      });
    };

    applyDesktopPreviewState = setPinnedState;
    desktopPreviewCheckEnabled = true;
    setPinnedState(pinnedState);
    // The initial mount fetch (and any desktop-bridge push) overwrites the
    // cache, so re-apply inert states until a console preview call or a real
    // update check releases the pin.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      if (JSON.stringify(event.query.queryKey) !== stateKey) return;
      if (
        isSameDesktopUpdateState(event.query.state.data as DesktopUpdateState | null, pinnedState)
      ) {
        return;
      }
      if (isRealUpdateActivityState(event.query.state.data)) {
        if (previewDesktopActionActive) return;
        desktopPreviewCheckEnabled = false;
        releaseBootPreview();
        return;
      }
      queuePinnedStateReapply();
    });
    releaseBootPreviewPin = () => {
      released = true;
      unsubscribe();
    };
    console.debug(
      `[threadlines] desktop update preview "${mode}" pinned (dev default; pick a mode or "off" via ?${DESKTOP_UPDATE_PREVIEW_PARAM}= or localStorage["${DESKTOP_UPDATE_PREVIEW_STORAGE_KEY}"]). Release for this session with threadlinesUpdatePreview.clearDesktopUpdate().`,
    );
  };

  const stopDesktopTimer = () => {
    if (desktopTimer !== null) {
      window.clearInterval(desktopTimer);
      desktopTimer = null;
    }
  };
  const stopProviderTimer = () => {
    if (providerTimer !== null) {
      window.clearInterval(providerTimer);
      providerTimer = null;
    }
  };
  const requireProviderConfig = (): ServerConfig | null => {
    const config = getServerConfig();
    if (!config || config.providers.length === 0) {
      console.warn(
        "[threadlines] update preview: no providers in server config yet — wait for the server connection.",
      );
      return null;
    }
    return config;
  };

  window.threadlinesUpdatePreview = {
    desktopUpdate(mode = "downloading", options) {
      releaseBootPreview();
      stopDesktopTimer();
      desktopPreviewCheckEnabled = true;
      applyDesktopPreviewState(makeDesktopUpdatePreviewState(mode, options));
    },

    animateDesktopDownload(durationMs = 6_000) {
      releaseBootPreview();
      stopDesktopTimer();
      desktopPreviewCheckEnabled = true;
      const version = nextPatchVersion(APP_VERSION);
      const startedAt = Date.now();
      const tick = () => {
        const percent = Math.min(100, ((Date.now() - startedAt) / durationMs) * 100);
        if (percent >= 100) {
          stopDesktopTimer();
          applyDesktopPreviewState(makeDesktopUpdatePreviewState("downloaded", { version }));
          return;
        }
        applyDesktopPreviewState(
          makeDesktopUpdatePreviewState("downloading", { version, percent }),
        );
      };
      tick();
      desktopTimer = window.setInterval(tick, DESKTOP_ANIMATION_TICK_MS);
    },

    clearDesktopUpdate() {
      releaseBootPreview();
      stopDesktopTimer();
      desktopPreviewCheckEnabled = false;
      setDesktopUpdateStateQueryData(queryClient, null);
      void queryClient.invalidateQueries({ queryKey: desktopUpdateQueryKeys.state() });
    },

    providerUpdates(statuses = "running") {
      const config = requireProviderConfig();
      if (!config) return;
      stopProviderTimer();
      const statusList = typeof statuses === "string" ? [statuses] : statuses;
      setServerConfigSnapshot(withProviderUpdateStates(config, statusList, new Map()));
    },

    animateProviderUpdates() {
      const baseline = requireProviderConfig();
      if (!baseline) return;
      stopProviderTimer();
      const startedAt = Date.now();
      const finishedAtByIndex = new Map<number, string>();
      const runningAtMs = (index: number) => 500 + index * 900;
      const succeededAtMs = (index: number) => 3_200 + index * 1_100;
      let lastKey = "";
      const tick = () => {
        const elapsed = Date.now() - startedAt;
        const statuses = baseline.providers.map((_, index): ProviderUpdatePreviewStatus => {
          if (elapsed >= succeededAtMs(index)) return "succeeded";
          if (elapsed >= runningAtMs(index)) return "running";
          return "queued";
        });
        const key = statuses.join("|");
        if (key !== lastKey) {
          lastKey = key;
          setServerConfigSnapshot(withProviderUpdateStates(baseline, statuses, finishedAtByIndex));
        }
        if (statuses.every((status) => status === "succeeded")) {
          stopProviderTimer();
        }
      };
      tick();
      providerTimer = window.setInterval(tick, PROVIDER_ANIMATION_TICK_MS);
    },

    clearProviderUpdates() {
      stopProviderTimer();
      const config = getServerConfig();
      if (!config) return;
      // Strips updateState from every provider (preview or real) — the next
      // server push restores the true state.
      setServerConfigSnapshot({
        ...config,
        providers: config.providers.map(({ updateState: _updateState, ...provider }) => provider),
      });
    },
  };

  window.__threadlinesDesktopUpdatePreviewCheckForUpdate = simulateDesktopCheckForUpdate;

  pinBootDesktopPreview();

  console.debug(
    "[threadlines] update preview dev tools installed: window.threadlinesUpdatePreview",
  );
}

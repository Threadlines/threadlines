import type { QueryClient } from "@tanstack/react-query";
import type {
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
 */
export type DesktopUpdatePreviewMode = "available" | "downloading" | "downloaded" | "error";

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
      stopDesktopTimer();
      setDesktopUpdateStateQueryData(queryClient, makeDesktopUpdatePreviewState(mode, options));
    },

    animateDesktopDownload(durationMs = 6_000) {
      stopDesktopTimer();
      const version = nextPatchVersion(APP_VERSION);
      const startedAt = Date.now();
      const tick = () => {
        const percent = Math.min(100, ((Date.now() - startedAt) / durationMs) * 100);
        if (percent >= 100) {
          stopDesktopTimer();
          setDesktopUpdateStateQueryData(
            queryClient,
            makeDesktopUpdatePreviewState("downloaded", { version }),
          );
          return;
        }
        setDesktopUpdateStateQueryData(
          queryClient,
          makeDesktopUpdatePreviewState("downloading", { version, percent }),
        );
      };
      tick();
      desktopTimer = window.setInterval(tick, DESKTOP_ANIMATION_TICK_MS);
    },

    clearDesktopUpdate() {
      stopDesktopTimer();
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

  console.debug(
    "[threadlines] update preview dev tools installed: window.threadlinesUpdatePreview",
  );
}

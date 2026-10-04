/// <reference types="vite/client" />

import type {
  DesktopBridge,
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  LocalApi,
} from "@threadlines/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly VITE_HOSTED_APP_CHANNEL: string;
  /** Relay for "Connect a device" code joins from the hosted app (self-hosted relays). */
  readonly VITE_RELAY_URL?: string;
  readonly VITE_APP_VERSION: string;
  readonly APP_VERSION: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    nativeApi?: LocalApi;
    desktopBridge?: DesktopBridge;
    __threadlinesDesktopUpdatePreviewCheckForUpdate?: () => Promise<DesktopUpdateCheckResult | null>;
    __threadlinesDesktopUpdatePreviewAction?: (
      kind: "download" | "install",
    ) => DesktopUpdateActionResult | null;
  }
}

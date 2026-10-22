import type {
  DesktopBridge,
  DesktopMenuActionPayload,
  DesktopQuitConfirmationRequest,
} from "@threadlines/contracts";
import { contextBridge, ipcRenderer } from "electron";

import * as IpcChannels from "./ipc/channels.ts";

function decodeMenuActionPayload(payload: unknown): DesktopMenuActionPayload | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const decoded: { environmentId?: string; threadId?: string } = {};
  if ("environmentId" in payload && typeof payload.environmentId === "string") {
    decoded.environmentId = payload.environmentId;
  }
  if ("threadId" in payload && typeof payload.threadId === "string") {
    decoded.threadId = payload.threadId;
  }
  return decoded;
}

function unwrapEnsureSshEnvironmentResult(result: unknown) {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === IpcChannels.SSH_PASSWORD_PROMPT_CANCELLED_RESULT
  ) {
    const message =
      "message" in result && typeof result.message === "string"
        ? result.message
        : "SSH authentication cancelled.";
    throw new Error(message);
  }
  return result as Awaited<ReturnType<DesktopBridge["ensureSshEnvironment"]>>;
}

// The window's focus, pushed by the main process. Kept here so a page that
// asks between changes still gets the answer.
let windowFocused: boolean | null = null;
const windowFocusListeners = new Set<(focused: boolean) => void>();
ipcRenderer.on(IpcChannels.WINDOW_FOCUS_CHANNEL, (_event, focused: unknown) => {
  if (typeof focused !== "boolean") return;
  windowFocused = focused;
  for (const listener of windowFocusListeners) listener(focused);
});

contextBridge.exposeInMainWorld("desktopBridge", {
  getAppBranding: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_APP_BRANDING_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<DesktopBridge["getAppBranding"]>;
  },
  isMarketingCaptureMode: () =>
    ipcRenderer.sendSync(IpcChannels.IS_MARKETING_CAPTURE_MODE_CHANNEL) === true,
  getLocalEnvironmentBootstrap: () => {
    const result = ipcRenderer.sendSync(IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL);
    if (typeof result !== "object" || result === null) {
      return null;
    }
    return result as ReturnType<DesktopBridge["getLocalEnvironmentBootstrap"]>;
  },
  getClientSettings: () => ipcRenderer.invoke(IpcChannels.GET_CLIENT_SETTINGS_CHANNEL),
  setClientSettings: (settings) =>
    ipcRenderer.invoke(IpcChannels.SET_CLIENT_SETTINGS_CHANNEL, settings),
  getSavedEnvironmentRegistry: () =>
    ipcRenderer.invoke(IpcChannels.GET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL),
  setSavedEnvironmentRegistry: (records) =>
    ipcRenderer.invoke(IpcChannels.SET_SAVED_ENVIRONMENT_REGISTRY_CHANNEL, records),
  getSavedEnvironmentSecret: (environmentId) =>
    ipcRenderer.invoke(IpcChannels.GET_SAVED_ENVIRONMENT_SECRET_CHANNEL, environmentId),
  setSavedEnvironmentSecret: (environmentId, secret) =>
    ipcRenderer.invoke(IpcChannels.SET_SAVED_ENVIRONMENT_SECRET_CHANNEL, { environmentId, secret }),
  removeSavedEnvironmentSecret: (environmentId) =>
    ipcRenderer.invoke(IpcChannels.REMOVE_SAVED_ENVIRONMENT_SECRET_CHANNEL, environmentId),
  discoverSshHosts: () => ipcRenderer.invoke(IpcChannels.DISCOVER_SSH_HOSTS_CHANNEL),
  ensureSshEnvironment: async (target, options) =>
    unwrapEnsureSshEnvironmentResult(
      await ipcRenderer.invoke(IpcChannels.ENSURE_SSH_ENVIRONMENT_CHANNEL, {
        target,
        ...(options === undefined ? {} : { options }),
      }),
    ),
  disconnectSshEnvironment: (target) =>
    ipcRenderer.invoke(IpcChannels.DISCONNECT_SSH_ENVIRONMENT_CHANNEL, target),
  fetchSshEnvironmentDescriptor: (httpBaseUrl) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_ENVIRONMENT_DESCRIPTOR_CHANNEL, { httpBaseUrl }),
  bootstrapSshBearerSession: (httpBaseUrl, credential) =>
    ipcRenderer.invoke(IpcChannels.BOOTSTRAP_SSH_BEARER_SESSION_CHANNEL, {
      httpBaseUrl,
      credential,
    }),
  fetchSshSessionState: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(IpcChannels.FETCH_SSH_SESSION_STATE_CHANNEL, { httpBaseUrl, bearerToken }),
  issueSshWebSocketToken: (httpBaseUrl, bearerToken) =>
    ipcRenderer.invoke(IpcChannels.ISSUE_SSH_WEBSOCKET_TOKEN_CHANNEL, { httpBaseUrl, bearerToken }),
  onSshPasswordPrompt: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (typeof request !== "object" || request === null) return;
      listener(request as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.SSH_PASSWORD_PROMPT_CHANNEL, wrappedListener);
    };
  },
  resolveSshPasswordPrompt: (requestId, password) =>
    ipcRenderer.invoke(IpcChannels.RESOLVE_SSH_PASSWORD_PROMPT_CHANNEL, { requestId, password }),
  getServerExposureState: () => ipcRenderer.invoke(IpcChannels.GET_SERVER_EXPOSURE_STATE_CHANNEL),
  setServerExposureMode: (mode) =>
    ipcRenderer.invoke(IpcChannels.SET_SERVER_EXPOSURE_MODE_CHANNEL, mode),
  setTailscaleServeEnabled: (input) =>
    ipcRenderer.invoke(IpcChannels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL, input),
  getAdvertisedEndpoints: () => ipcRenderer.invoke(IpcChannels.GET_ADVERTISED_ENDPOINTS_CHANNEL),
  getRetiredPhoneLinkNotice: () =>
    ipcRenderer.invoke(IpcChannels.GET_RETIRED_PHONE_LINK_NOTICE_CHANNEL),
  dismissRetiredPhoneLinkNotice: () =>
    ipcRenderer.invoke(IpcChannels.DISMISS_RETIRED_PHONE_LINK_NOTICE_CHANNEL),
  pickFolder: (options) => ipcRenderer.invoke(IpcChannels.PICK_FOLDER_CHANNEL, options),
  confirm: (message) => ipcRenderer.invoke(IpcChannels.CONFIRM_CHANNEL, message),
  captureScreenshot: (input) => ipcRenderer.invoke(IpcChannels.CAPTURE_SCREENSHOT_CHANNEL, input),
  previewAttach: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_ATTACH_CHANNEL, input),
  previewDetach: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_DETACH_CHANNEL, input),
  previewStatus: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_STATUS_CHANNEL, input),
  previewEvaluate: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_EVALUATE_CHANNEL, input),
  previewSnapshot: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_SNAPSHOT_CHANNEL, input),
  previewClick: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_CLICK_CHANNEL, input),
  previewMove: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_MOVE_CHANNEL, input),
  previewDrag: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_DRAG_CHANNEL, input),
  previewType: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_TYPE_CHANNEL, input),
  previewPress: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_PRESS_CHANNEL, input),
  previewScroll: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_SCROLL_CHANNEL, input),
  previewWaitFor: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_WAIT_FOR_CHANNEL, input),
  previewScreenshot: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_SCREENSHOT_CHANNEL, input),
  previewOpenDevTools: (input) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL, input),
  previewSetColorScheme: (input) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL, input),
  previewSetLifecycle: (input) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_SET_LIFECYCLE_CHANNEL, input),
  previewMemory: () => ipcRenderer.invoke(IpcChannels.PREVIEW_MEMORY_CHANNEL),
  previewSetViewport: (input) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_SET_VIEWPORT_CHANNEL, input),
  previewSetNavigationPolicy: (input) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_SET_NAVIGATION_POLICY_CHANNEL, input),
  onPreviewNavigationBlocked: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, blocked: unknown) => {
      if (typeof blocked !== "object" || blocked === null) return;
      listener(blocked as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.PREVIEW_NAVIGATION_BLOCKED_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.PREVIEW_NAVIGATION_BLOCKED_CHANNEL, wrappedListener);
    };
  },
  onPreviewCertificateUntrusted: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, untrusted: unknown) => {
      if (typeof untrusted !== "object" || untrusted === null) return;
      listener(untrusted as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.PREVIEW_CERTIFICATE_UNTRUSTED_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(
        IpcChannels.PREVIEW_CERTIFICATE_UNTRUSTED_CHANNEL,
        wrappedListener,
      );
    };
  },
  onPreviewOpenTab: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (typeof request !== "object" || request === null) return;
      listener(request as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.PREVIEW_OPEN_TAB_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.PREVIEW_OPEN_TAB_CHANNEL, wrappedListener);
    };
  },
  onPreviewPopup: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, popup: unknown) => {
      if (typeof popup !== "object" || popup === null) return;
      listener(popup as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.PREVIEW_POPUP_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.PREVIEW_POPUP_CHANNEL, wrappedListener);
    };
  },
  onPreviewSiteAllowed: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, allowed: unknown) => {
      if (typeof allowed !== "object" || allowed === null) return;
      listener(allowed as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.PREVIEW_SITE_ALLOWED_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.PREVIEW_SITE_ALLOWED_CHANNEL, wrappedListener);
    };
  },
  onPreviewUserControl: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, control: unknown) => {
      if (typeof control !== "object" || control === null) return;
      listener(control as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.PREVIEW_USER_CONTROL_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.PREVIEW_USER_CONTROL_CHANNEL, wrappedListener);
    };
  },
  onPreviewBrowserCommand: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, command: unknown) => {
      if (typeof command !== "string") return;
      listener(command as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.PREVIEW_BROWSER_COMMAND_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.PREVIEW_BROWSER_COMMAND_CHANNEL, wrappedListener);
    };
  },
  previewPickElement: (input) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL, input),
  previewCancelPick: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_CANCEL_PICK_CHANNEL, input),
  previewSetAnnotationMode: (input) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_SET_ANNOTATION_MODE_CHANNEL, input),
  previewAwaitDrawing: (input) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_AWAIT_DRAWING_CHANNEL, input),
  previewRevealElement: (input) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_REVEAL_ELEMENT_CHANNEL, input),
  previewProfilePartition: (input) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_PROFILE_PARTITION_CHANNEL, input),
  servePreviewTunnels: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (typeof request !== "object" || request === null) return;
      listener(request as Parameters<typeof listener>[0]);
    };
    ipcRenderer.on(IpcChannels.PREVIEW_TUNNEL_REQUEST_CHANNEL, wrappedListener);
    ipcRenderer.send(IpcChannels.PREVIEW_TUNNEL_SERVE_CHANNEL, "start");
    return {
      send: (reply) => ipcRenderer.send(IpcChannels.PREVIEW_TUNNEL_REPLY_CHANNEL, reply),
      stop: () => {
        ipcRenderer.removeListener(IpcChannels.PREVIEW_TUNNEL_REQUEST_CHANNEL, wrappedListener);
        ipcRenderer.send(IpcChannels.PREVIEW_TUNNEL_SERVE_CHANNEL, "stop");
      },
    };
  },
  getSystemIdleMs: () => ipcRenderer.invoke(IpcChannels.SYSTEM_IDLE_MS_CHANNEL),
  previewListProfiles: () => ipcRenderer.invoke(IpcChannels.PREVIEW_LIST_PROFILES_CHANNEL),
  previewForgetProfile: (input) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_FORGET_PROFILE_CHANNEL, input),
  previewClearBrowsingData: (input) =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_BROWSING_DATA_CHANNEL, input),
  previewClearCache: (input) => ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL, input),
  previewClearAllBrowsingData: () =>
    ipcRenderer.invoke(IpcChannels.PREVIEW_CLEAR_ALL_BROWSING_DATA_CHANNEL),
  setTheme: (theme) => ipcRenderer.invoke(IpcChannels.SET_THEME_CHANNEL, theme),
  setTaskbarStatus: (input) => ipcRenderer.invoke(IpcChannels.SET_TASKBAR_STATUS_CHANNEL, input),
  isWindowFocused: () => windowFocused,
  onWindowFocusChange: (listener) => {
    windowFocusListeners.add(listener);
    return () => {
      windowFocusListeners.delete(listener);
    };
  },
  onQuitConfirmationRequested: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, request: unknown) => {
      if (request === null) {
        listener(null);
        return;
      }
      if (typeof request !== "object") return;
      const question = request as DesktopQuitConfirmationRequest;
      listener(question);
      // The app waits for this before trusting the page with the question, and
      // asks natively when it never comes: a page still loading or signed out
      // has no listener here, and a hung one never runs this.
      void ipcRenderer
        .invoke(IpcChannels.QUIT_CONFIRMATION_SHOWN_CHANNEL, question.requestId)
        .catch(() => undefined);
    };

    ipcRenderer.on(IpcChannels.QUIT_CONFIRMATION_REQUEST_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.QUIT_CONFIRMATION_REQUEST_CHANNEL, wrappedListener);
    };
  },
  resolveQuitConfirmation: (confirmed) =>
    ipcRenderer.invoke(IpcChannels.QUIT_CONFIRMATION_RESOLVE_CHANNEL, confirmed),
  showContextMenu: (items, position) =>
    ipcRenderer.invoke(IpcChannels.CONTEXT_MENU_CHANNEL, {
      items,
      ...(position === undefined ? {} : { position }),
    }),
  openExternal: (url: string) => ipcRenderer.invoke(IpcChannels.OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) => {
    const wrappedListener = (
      _event: Electron.IpcRendererEvent,
      action: unknown,
      payload: unknown,
    ) => {
      if (typeof action !== "string") return;
      listener(action, decodeMenuActionPayload(payload));
    };

    ipcRenderer.on(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(IpcChannels.UPDATE_GET_STATE_CHANNEL),
  setUpdateChannel: (channel) =>
    ipcRenderer.invoke(IpcChannels.UPDATE_SET_CHANNEL_CHANNEL, channel),
  checkForUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_CHECK_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(IpcChannels.UPDATE_INSTALL_CHANNEL),
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(IpcChannels.UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
} satisfies DesktopBridge);

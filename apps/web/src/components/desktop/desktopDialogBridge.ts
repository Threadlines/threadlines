import type {
  DesktopQuitConfirmationRequest,
  DesktopSshPasswordPromptRequest,
} from "@threadlines/contracts";

/**
 * Buffers early Electron IPC dialog requests (`onQuitConfirmationRequested`
 * and `onSshPasswordPrompt`) while the lazy `DesktopRootDialogs` chunk is
 * loading, so a saved SSH connection or a reload during "Move and quit" can
 * never drop a request before the dialog mounts.
 */
type QuitConfirmationListener = (request: DesktopQuitConfirmationRequest | null) => void;
type SshPromptListener = (request: DesktopSshPasswordPromptRequest) => void;

let quitBridgeActive = false;
let bufferedQuitRequest: {
  hasValue: boolean;
  value: DesktopQuitConfirmationRequest | null;
} = { hasValue: false, value: null };
let quitConsumer: QuitConfirmationListener | null = null;

let sshBridgeActive = false;
let bufferedSshQueue: readonly DesktopSshPasswordPromptRequest[] = [];
const sshConsumers = new Set<SshPromptListener>();

/**
 * Subscribes synchronously to Electron's quit and SSH password prompt bridges
 * once the authenticated root shell mounts. Returns a cleanup that detaches
 * both listeners and clears any buffered requests.
 */
export function attachDesktopDialogBridgeListeners(): () => void {
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  if (!bridge) {
    return () => undefined;
  }

  let disposeQuit: (() => void) | undefined;
  if (bridge.onQuitConfirmationRequested) {
    quitBridgeActive = true;
    bufferedQuitRequest = { hasValue: false, value: null };
    disposeQuit = bridge.onQuitConfirmationRequested((next) => {
      bufferedQuitRequest = { hasValue: true, value: next };
      quitConsumer?.(next);
    });
  }

  let disposeSsh: (() => void) | undefined;
  if (bridge.onSshPasswordPrompt) {
    sshBridgeActive = true;
    bufferedSshQueue = [];
    disposeSsh = bridge.onSshPasswordPrompt((request) => {
      if (bufferedSshQueue.some((existing) => existing.requestId === request.requestId)) {
        return;
      }
      bufferedSshQueue = [...bufferedSshQueue, request];
      for (const consumer of sshConsumers) {
        consumer(request);
      }
    });
  }

  return () => {
    disposeQuit?.();
    disposeSsh?.();
    quitBridgeActive = false;
    bufferedQuitRequest = { hasValue: false, value: null };
    quitConsumer = null;
    sshBridgeActive = false;
    bufferedSshQueue = [];
    sshConsumers.clear();
  };
}

/**
 * Subscribes `QuitConfirmationDialog` to quit requests. When the root host is
 * active, replays any request buffered while the dialog chunk was loading;
 * otherwise attaches directly to `window.desktopBridge` for standalone mounts.
 */
export function subscribeQuitConfirmation(listener: QuitConfirmationListener): () => void {
  if (!quitBridgeActive) {
    const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
    if (!bridge?.onQuitConfirmationRequested) {
      return () => undefined;
    }
    return bridge.onQuitConfirmationRequested(listener);
  }

  quitConsumer = listener;
  if (bufferedQuitRequest.hasValue) {
    listener(bufferedQuitRequest.value);
  }
  return () => {
    if (quitConsumer === listener) {
      quitConsumer = null;
    }
  };
}

/** Clears the buffered quit request once the dialog has settled it. */
export function clearBufferedQuitConfirmation(): void {
  bufferedQuitRequest = { hasValue: false, value: null };
}

/**
 * Subscribes `SshPasswordPromptDialog` to SSH password prompts. When the root
 * host is active, replays every request buffered while the dialog chunk was
 * loading; otherwise attaches directly to `window.desktopBridge`.
 */
export function subscribeSshPasswordPrompt(listener: SshPromptListener): () => void {
  if (!sshBridgeActive) {
    const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
    if (!bridge?.onSshPasswordPrompt) {
      return () => undefined;
    }
    return bridge.onSshPasswordPrompt(listener);
  }

  sshConsumers.add(listener);
  for (const request of bufferedSshQueue) {
    listener(request);
  }
  return () => {
    sshConsumers.delete(listener);
  };
}

/** Removes a resolved, cancelled, or dismissed SSH prompt from the shared buffer. */
export function removeBufferedSshPasswordPrompt(requestId: string): void {
  if (!sshBridgeActive) return;
  bufferedSshQueue = bufferedSshQueue.filter((item) => item.requestId !== requestId);
}

/**
 * Fails open if the lazy `DesktopRootDialogs` chunk cannot load: cancels any
 * buffered quit or SSH prompt so the main process never hangs waiting on a
 * dialog that cannot mount.
 */
export function cancelBufferedDesktopDialogRequests(): void {
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  if (bufferedQuitRequest.hasValue && bufferedQuitRequest.value !== null) {
    bufferedQuitRequest = { hasValue: false, value: null };
    void bridge?.resolveQuitConfirmation?.(false).catch(() => undefined);
  }
  if (bufferedSshQueue.length > 0) {
    const queued = bufferedSshQueue;
    bufferedSshQueue = [];
    for (const item of queued) {
      void bridge?.resolveSshPasswordPrompt?.(item.requestId, null).catch(() => undefined);
    }
  }
}

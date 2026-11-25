import type {
  DesktopQuitConfirmationRequest,
  DesktopSshPasswordPromptRequest,
  DesktopUpdateState,
} from "@threadlines/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmDesktopUpdateInstall,
  registerDesktopUpdateInstallDialogLoader,
  resolveDesktopUpdateInstallConfirmation,
  subscribeDesktopUpdateInstallConfirmation,
} from "../../lib/desktopUpdateInstallConfirmation";
import {
  attachDesktopDialogBridgeListeners,
  cancelBufferedDesktopDialogRequests,
  clearBufferedQuitConfirmation,
  removeBufferedSshPasswordPrompt,
  subscribeQuitConfirmation,
  subscribeSshPasswordPrompt,
} from "./desktopDialogBridge";

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");

function installMockDesktopBridge() {
  let quitListener: ((request: DesktopQuitConfirmationRequest | null) => void) | null = null;
  let sshListener: ((request: DesktopSshPasswordPromptRequest) => void) | null = null;
  const resolveQuitConfirmation = vi.fn(async () => undefined);
  const resolveSshPasswordPrompt = vi.fn(async () => undefined);

  const mockBridge = {
    onQuitConfirmationRequested: vi.fn((listener: NonNullable<typeof quitListener>) => {
      quitListener = listener;
      return () => {
        if (quitListener === listener) quitListener = null;
      };
    }),
    onSshPasswordPrompt: vi.fn((listener: NonNullable<typeof sshListener>) => {
      sshListener = listener;
      return () => {
        if (sshListener === listener) sshListener = null;
      };
    }),
    resolveQuitConfirmation,
    resolveSshPasswordPrompt,
  };

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktopBridge: mockBridge,
      confirm: vi.fn(() => true),
    },
  });

  return {
    mockBridge,
    emitQuit: (request: DesktopQuitConfirmationRequest | null) => quitListener?.(request),
    emitSsh: (request: DesktopSshPasswordPromptRequest) => sshListener?.(request),
    resolveQuitConfirmation,
    resolveSshPasswordPrompt,
  };
}

describe("desktopDialogBridge", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, "window", originalWindowDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
    vi.restoreAllMocks();
  });

  it("replays a buffered SSH password prompt that arrived before the dialog mounted", () => {
    const bridge = installMockDesktopBridge();
    cleanups.push(attachDesktopDialogBridgeListeners());

    const prompt: DesktopSshPasswordPromptRequest = {
      requestId: "ssh-1",
      destination: "build-box.local",
      username: "will",
      prompt: "Password:",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    bridge.emitSsh(prompt);

    const received: DesktopSshPasswordPromptRequest[] = [];
    cleanups.push(
      subscribeSshPasswordPrompt((request) => {
        received.push(request);
      }),
    );

    expect(received).toEqual([prompt]);

    // Still replays on a remount until explicitly dismissed.
    const remountReceived: DesktopSshPasswordPromptRequest[] = [];
    cleanups.push(
      subscribeSshPasswordPrompt((request) => {
        remountReceived.push(request);
      }),
    );
    expect(remountReceived).toEqual([prompt]);

    removeBufferedSshPasswordPrompt("ssh-1");
    const afterRemove: DesktopSshPasswordPromptRequest[] = [];
    cleanups.push(
      subscribeSshPasswordPrompt((request) => {
        afterRemove.push(request);
      }),
    );
    expect(afterRemove).toEqual([]);
  });

  it("replays a buffered quit-after-moves request that arrived before QuitConfirmationDialog mounted", () => {
    const bridge = installMockDesktopBridge();
    cleanups.push(attachDesktopDialogBridgeListeners());

    const quitRequest: DesktopQuitConfirmationRequest = {
      requestId: "quit-1",
      runningThreadCount: 2,
      busyTerminalCount: 0,
      quitAfterMoves: { batchId: "batch-42" },
    };
    bridge.emitQuit(quitRequest);

    const received: Array<DesktopQuitConfirmationRequest | null> = [];
    cleanups.push(
      subscribeQuitConfirmation((request) => {
        received.push(request);
      }),
    );

    expect(received).toEqual([quitRequest]);

    clearBufferedQuitConfirmation();
    const afterClear: Array<DesktopQuitConfirmationRequest | null> = [];
    cleanups.push(
      subscribeQuitConfirmation((request) => {
        afterClear.push(request);
      }),
    );
    expect(afterClear).toEqual([]);
  });

  it("cancels buffered quit and SSH requests if the lazy dialog chunk fails to load", () => {
    const bridge = installMockDesktopBridge();
    cleanups.push(attachDesktopDialogBridgeListeners());

    bridge.emitQuit({
      requestId: "quit-fail",
      runningThreadCount: 1,
      busyTerminalCount: 0,
    });
    bridge.emitSsh({
      requestId: "ssh-fail",
      destination: "dev.local",
      username: "will",
      prompt: "Password:",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    cancelBufferedDesktopDialogRequests();

    expect(bridge.resolveQuitConfirmation).toHaveBeenCalledWith(false);
    expect(bridge.resolveSshPasswordPrompt).toHaveBeenCalledWith("ssh-fail", null);
  });

  it("waits for the lazy DesktopUpdateInstallDialog to mount before using window.confirm", async () => {
    installMockDesktopBridge();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const state = {
      status: "downloaded",
      currentVersion: "0.11.0",
      availableVersion: "0.12.0",
      downloadedVersion: "0.12.0",
    } as DesktopUpdateState;

    const onDialogUpdate = vi.fn();
    cleanups.push(
      registerDesktopUpdateInstallDialogLoader(async () => {
        await Promise.resolve();
        // Simulate React mounting DesktopUpdateInstallDialog right after chunk load.
        queueMicrotask(() => {
          cleanups.push(subscribeDesktopUpdateInstallConfirmation(onDialogUpdate));
        });
      }),
    );

    const pending = confirmDesktopUpdateInstall(state);
    await vi.waitFor(() => {
      expect(onDialogUpdate).toHaveBeenCalled();
    });
    expect(confirmSpy).not.toHaveBeenCalled();

    resolveDesktopUpdateInstallConfirmation(true);
    expect(await pending).toBe(true);
  });

  it("falls back to window.confirm when the lazy DesktopUpdateInstallDialog loader rejects", async () => {
    installMockDesktopBridge();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const state = {
      status: "downloaded",
      currentVersion: "0.11.0",
      availableVersion: "0.12.0",
      downloadedVersion: "0.12.0",
    } as DesktopUpdateState;

    cleanups.push(
      registerDesktopUpdateInstallDialogLoader(async () => {
        throw new Error("chunk failed");
      }),
    );

    expect(await confirmDesktopUpdateInstall(state)).toBe(false);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });
});

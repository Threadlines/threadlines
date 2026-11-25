import type { DesktopUpdateState } from "@threadlines/contracts";
import { useSyncExternalStore } from "react";

import { getDesktopUpdateInstallConfirmationMessage } from "../components/desktopUpdate.logic";

export interface DesktopUpdateInstallConfirmationRequest {
  readonly state: DesktopUpdateState;
}

let pendingRequest: DesktopUpdateInstallConfirmationRequest | null = null;
let pendingResolve: ((confirmed: boolean) => void) | null = null;
const listeners = new Set<() => void>();
const listenerWaiters = new Set<() => void>();
let dialogLoader: (() => Promise<unknown>) | null = null;

const DIALOG_MOUNT_WAIT_TIMEOUT_MS = 2_000;

function notify() {
  for (const listener of listeners) listener();
}

export function subscribeDesktopUpdateInstallConfirmation(listener: () => void) {
  listeners.add(listener);
  if (listenerWaiters.size > 0) {
    for (const wake of listenerWaiters) wake();
    listenerWaiters.clear();
  }
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Registers the lazy loader for `DesktopUpdateInstallDialog` so an early click
 * on Restart waits for the in-app dialog to finish mounting rather than falling
 * back to `window.confirm`.
 */
export function registerDesktopUpdateInstallDialogLoader(
  loader: () => Promise<unknown>,
): () => void {
  dialogLoader = loader;
  return () => {
    if (dialogLoader === loader) {
      dialogLoader = null;
    }
  };
}

async function waitForDialogListener(loader: () => Promise<unknown>): Promise<boolean> {
  if (listeners.size > 0) return true;
  try {
    await loader();
  } catch {
    return false;
  }
  if (listeners.size > 0) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      listenerWaiters.delete(onMount);
      clearTimeout(timer);
      resolve(ready);
    };
    const onMount = () => finish(true);
    listenerWaiters.add(onMount);
    const timer = setTimeout(() => finish(listeners.size > 0), DIALOG_MOUNT_WAIT_TIMEOUT_MS);
  });
}

function getSnapshot() {
  return pendingRequest;
}

function getServerSnapshot() {
  return null;
}

/** The install confirmation the in-app dialog should be showing; null when idle. */
export function useDesktopUpdateInstallConfirmationRequest(): DesktopUpdateInstallConfirmationRequest | null {
  return useSyncExternalStore(
    subscribeDesktopUpdateInstallConfirmation,
    getSnapshot,
    getServerSnapshot,
  );
}

/**
 * Asks the user to confirm restart-to-install through the in-app dialog
 * (`DesktopUpdateInstallDialog`). Waits for a registered lazy dialog loader
 * before falling back to the browser confirm when no dialog is mounted, so the
 * action can never hang waiting for an answer. A new request supersedes a
 * pending one, which then resolves as cancelled.
 */
export async function confirmDesktopUpdateInstall(state: DesktopUpdateState): Promise<boolean> {
  if (listeners.size === 0 && dialogLoader !== null) {
    await waitForDialogListener(dialogLoader);
  }
  if (listeners.size === 0) {
    return window.confirm(getDesktopUpdateInstallConfirmationMessage(state));
  }
  pendingResolve?.(false);
  return await new Promise<boolean>((resolve) => {
    pendingRequest = { state };
    pendingResolve = resolve;
    notify();
  });
}

/** Settles the pending confirmation and closes the dialog; no-op when nothing is pending. */
export function resolveDesktopUpdateInstallConfirmation(confirmed: boolean): void {
  const resolve = pendingResolve;
  pendingRequest = null;
  pendingResolve = null;
  notify();
  resolve?.(confirmed);
}

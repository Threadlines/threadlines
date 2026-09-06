import type { DesktopUpdateState } from "@threadlines/contracts";
import { useSyncExternalStore } from "react";

import { getDesktopUpdateInstallConfirmationMessage } from "../components/desktopUpdate.logic";

export interface DesktopUpdateInstallConfirmationRequest {
  readonly state: DesktopUpdateState;
}

let pendingRequest: DesktopUpdateInstallConfirmationRequest | null = null;
let pendingResolve: ((confirmed: boolean) => void) | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return pendingRequest;
}

function getServerSnapshot() {
  return null;
}

/** The install confirmation the in-app dialog should be showing; null when idle. */
export function useDesktopUpdateInstallConfirmationRequest(): DesktopUpdateInstallConfirmationRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Asks the user to confirm restart-to-install through the in-app dialog
 * (`DesktopUpdateInstallDialog`). Falls back to the browser confirm when no
 * dialog is mounted, so the action can never hang waiting for an answer. A
 * new request supersedes a pending one, which then resolves as cancelled.
 */
export function confirmDesktopUpdateInstall(state: DesktopUpdateState): Promise<boolean> {
  if (listeners.size === 0) {
    return Promise.resolve(window.confirm(getDesktopUpdateInstallConfirmationMessage(state)));
  }
  pendingResolve?.(false);
  return new Promise((resolve) => {
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

import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@threadlines/contracts";

import {
  type DesktopUpdateActionKind,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  isDesktopUpdateActionKindDisabled,
  resolveDesktopUpdateActionKind,
} from "../components/desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../lib/desktopUpdateReactQuery";

function toastUpdateError(title: string, description: string) {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
}

function toastAcceptedActionFailure(result: DesktopUpdateActionResult, title: string) {
  const actionError = getDesktopUpdateActionError(result);
  if (actionError) toastUpdateError(title, actionError);
}

export interface DesktopUpdateAction {
  /** Latest updater state; null until the desktop bridge reports one. */
  readonly state: DesktopUpdateState | null;
  /** What run() does right now. */
  readonly kind: DesktopUpdateActionKind;
  readonly disabled: boolean;
  readonly run: () => void;
}

/**
 * Single adaptive update action shared by every updater surface (settings
 * About row, sidebar version card): resolves the pending updater action,
 * executes it through the desktop bridge, and reports failures via toasts.
 * run() is a no-op outside the desktop app.
 */
export function useDesktopUpdateAction(): DesktopUpdateAction {
  const queryClient = useQueryClient();
  const state = useDesktopUpdateState().data ?? null;

  const run = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !state) return;
    const kind = resolveDesktopUpdateActionKind(state);

    if (kind === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
          toastAcceptedActionFailure(result, "Could not download update");
        })
        .catch((error: unknown) => {
          toastUpdateError(
            "Could not download update",
            error instanceof Error ? error.message : "Download failed.",
          );
        });
      return;
    }

    if (kind === "install") {
      const confirmed = window.confirm(getDesktopUpdateInstallConfirmationMessage(state));
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          setDesktopUpdateStateQueryData(queryClient, result.state);
          toastAcceptedActionFailure(result, "Could not install update");
        })
        .catch((error: unknown) => {
          toastUpdateError(
            "Could not install update",
            error instanceof Error ? error.message : "Install failed.",
          );
        });
      return;
    }

    if (kind !== "check" || typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        setDesktopUpdateStateQueryData(queryClient, result.state);
        if (!result.checked) {
          toastUpdateError(
            "Could not check for updates",
            result.state.message ?? "Automatic updates are not available in this build.",
          );
        }
      })
      .catch((error: unknown) => {
        toastUpdateError(
          "Could not check for updates",
          error instanceof Error ? error.message : "Update check failed.",
        );
      });
  }, [queryClient, state]);

  return {
    state,
    kind: resolveDesktopUpdateActionKind(state),
    disabled: isDesktopUpdateActionKindDisabled(state),
    run,
  };
}

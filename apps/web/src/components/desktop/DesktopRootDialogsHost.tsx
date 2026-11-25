import { Suspense, useEffect } from "react";

import { isElectron } from "../../env";
import { registerDesktopUpdateInstallDialogLoader } from "../../lib/desktopUpdateInstallConfirmation";
import { lazyWithPreload } from "../../lib/lazyWithPreload";
import {
  attachDesktopDialogBridgeListeners,
  cancelBufferedDesktopDialogRequests,
} from "./desktopDialogBridge";

const DesktopRootDialogsLazy = lazyWithPreload(() =>
  import("./DesktopRootDialogs").then((module) => module.DesktopRootDialogs),
);

if (isElectron) {
  void DesktopRootDialogsLazy.preload().catch(() => {
    cancelBufferedDesktopDialogRequests();
  });
}

/**
 * Eager, zero-UI host mounted in the authenticated root shell before
 * connection bootstraps and menu listeners run. It attaches the Electron quit
 * and SSH prompt listeners immediately and registers the update-dialog loader
 * so no early IPC event or click is lost while `DesktopRootDialogs` loads.
 */
export function DesktopRootDialogsHost() {
  useEffect(() => {
    if (!isElectron) return;
    const detachBridge = attachDesktopDialogBridgeListeners();
    const unregisterUpdateLoader = registerDesktopUpdateInstallDialogLoader(() =>
      DesktopRootDialogsLazy.preload(),
    );
    void DesktopRootDialogsLazy.preload().catch(() => {
      cancelBufferedDesktopDialogRequests();
    });
    return () => {
      unregisterUpdateLoader();
      detachBridge();
    };
  }, []);

  if (!isElectron) {
    return null;
  }

  return (
    <Suspense fallback={null}>
      <DesktopRootDialogsLazy.Component />
    </Suspense>
  );
}

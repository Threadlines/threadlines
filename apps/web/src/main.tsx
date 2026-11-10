import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { TooltipProvider } from "./components/ui/tooltip";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@fontsource-variable/schibsted-grotesk/index.css";
import "@fontsource-variable/schibsted-grotesk/wght-italic.css";
import "@fontsource-variable/cascadia-mono/index.css";
import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { StatusBarEdge } from "./components/StatusBarEdge";
import { isElectron } from "./env";
import { installOnScreenKeyboardFlag } from "./lib/onScreenKeyboard";
import { isPageAttended, onPageAttentionChange } from "./lib/pageAttention";
import { installPopupPickGuard } from "./lib/popupPickGuard";
import { isMacPlatform } from "./lib/utils";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  document.documentElement.classList.add("electron");
  // macOS draws its window controls over the app's top-left corner, and
  // every top bar starts past them (`html.electron.mac` in index.css).
  // Windows and Linux put theirs on the right and report where (`.wco`).
  if (isMacPlatform(navigator.platform)) {
    document.documentElement.classList.add("mac");
  }
  syncDocumentWindowControlsOverlayClass();
}

document.title = APP_DISPLAY_NAME;

installPopupPickGuard();
installOnScreenKeyboardFlag();
// Shows loops that never stop (the working dots) 30 poses a second, not on
// every refresh of the screen. Loaded after startup, which doesn't need it:
// it picks up the loops already on screen, and without it they run at the
// screen's own rate.
void import("./lib/steppedLoops").then(
  (module) =>
    module.installSteppedLoops({ isAttended: isPageAttended, onChange: onPageAttentionChange }),
  () => {},
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* Small hover labels open at once across the app: they only add a name or a
        detail. A surface that would flash them too often sets its own (the chat's
        message actions, the sidebar's rows). */}
    <TooltipProvider delay={0}>
      <RouterProvider router={router} />
      <StatusBarEdge />
    </TooltipProvider>
  </React.StrictMode>,
);

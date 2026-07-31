/**
 * True when running inside the Electron preload bridge, false in a regular browser.
 * The preload script sets window.nativeApi via contextBridge before any web-app
 * code executes, so this is reliable at module load time.
 */
export const isElectron =
  typeof window !== "undefined" &&
  (window.desktopBridge !== undefined || window.nativeApi !== undefined);

export const isMarketingCaptureMode =
  isElectron && window.desktopBridge?.isMarketingCaptureMode?.() === true;

if (typeof document !== "undefined" && isMarketingCaptureMode) {
  document.documentElement.dataset.marketingCapture = "true";
}

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

/**
 * Whether this is the home-screen app on an iPhone or iPad: Threadlines added
 * to the home screen and opened from there. Only Apple's browsers set
 * `navigator.standalone`, and a Mac sets it too for a web app in the Dock, so
 * a touch screen is required as well. There the left screen edge is free,
 * since Safari's back swipe doesn't exist outside the browser, so the app can
 * use it. A function, not a constant, so tests can stand in for the app.
 */
export function isIosHomeScreenApp(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (navigator as Navigator & { readonly standalone?: boolean }).standalone === true &&
    navigator.maxTouchPoints > 0
  );
}

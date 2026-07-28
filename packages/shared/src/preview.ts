/**
 * The browser session the in-app preview runs in.
 *
 * Shared because both ends have to agree: the renderer sets it as the
 * <webview>'s partition attribute, and the main process refuses to attach a
 * webview asking for anything else. Preview content is untrusted and has no
 * business sharing cookies with Threadlines itself.
 */
export const PREVIEW_PARTITION = "persist:threadlines-preview";

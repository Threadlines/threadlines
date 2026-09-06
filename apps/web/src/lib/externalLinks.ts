import { readLocalApi } from "../localApi";

/**
 * Opens a link outside the app: the desktop shell when there is one, a new tab
 * otherwise. Falls back to the tab if the shell refuses, so a link never
 * silently does nothing.
 */
export function openExternalUrl(url: string): void {
  const api = readLocalApi();
  if (!api) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  void api.shell.openExternal(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

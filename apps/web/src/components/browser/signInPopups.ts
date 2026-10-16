import type { DesktopPreviewPopup } from "@threadlines/contracts";

/**
 * Sign-in pop-ups open right now, by the page that opened them.
 *
 * They are windows of their own outside the panel (see the desktop's
 * `signInPopups.ts`), so the panel knows of them only from the desktop's
 * reports. A page with one open is waiting on the user: it must stay awake
 * and in memory to hear the result, and an agent whose click opened one is
 * told so.
 */
const popupsByPage = new Map<number, Map<number, string>>();

export function noteSignInPopup(event: DesktopPreviewPopup): void {
  const popups = popupsByPage.get(event.webContentsId) ?? new Map<number, string>();
  if (event.open) {
    popups.set(event.popupId, event.url);
  } else {
    popups.delete(event.popupId);
  }
  if (popups.size === 0) {
    popupsByPage.delete(event.webContentsId);
  } else {
    popupsByPage.set(event.webContentsId, popups);
  }
}

/** The pop-ups a page has open, oldest first. */
export function signInPopupsOf(
  webContentsId: number | null,
): ReadonlyArray<{ id: number; url: string }> {
  const popups = webContentsId === null ? undefined : popupsByPage.get(webContentsId);
  return popups === undefined ? [] : [...popups].map(([id, url]) => ({ id, url }));
}

export function resetSignInPopupsForTests(): void {
  popupsByPage.clear();
}

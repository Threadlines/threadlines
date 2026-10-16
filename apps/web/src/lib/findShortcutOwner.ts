/**
 * Who answers Cmd/Ctrl+F: the chat's find, the browser panel's find in page,
 * or neither (the terminal keeps the key, and in the web build the browser's
 * own find opens).
 *
 * Both finds listen on the window in the capture phase, so neither can rely
 * on running first; each asks this one function and acts only when it is the
 * owner. Ownership follows the reader's attention: the region holding focus,
 * or, with nothing focused (after clicking text in the chat), the region last
 * pointed at. A region is marked with FIND_REGION_ATTRIBUTE.
 */
import { useChatFindStore } from "../chatFindStore";
import { isTerminalFocused } from "./terminalFocus";

export const FIND_REGION_ATTRIBUTE = "data-find-region";
export type FindRegion = "chat" | "browser";
export type FindShortcutOwner = FindRegion | null;

let lastPointerRegion: FindRegion | null = null;
let trackingInstalls = 0;

function regionOf(target: EventTarget | null): FindRegion | null {
  const element = target instanceof Element ? target : null;
  const value = element?.closest(`[${FIND_REGION_ATTRIBUTE}]`)?.getAttribute(FIND_REGION_ATTRIBUTE);
  return value === "chat" || value === "browser" ? value : null;
}

const onPointerDown = (event: PointerEvent) => {
  lastPointerRegion = regionOf(event.target);
};

/** Remembers which region the reader last pointed at. Returns the uninstall. */
export function installFindRegionTracking(): () => void {
  if (trackingInstalls === 0) {
    window.addEventListener("pointerdown", onPointerDown, true);
  }
  trackingInstalls += 1;
  return () => {
    trackingInstalls -= 1;
    if (trackingInstalls === 0) {
      window.removeEventListener("pointerdown", onPointerDown, true);
      lastPointerRegion = null;
    }
  };
}

function browserPanelMounted(): boolean {
  return document.querySelector(`[${FIND_REGION_ATTRIBUTE}="browser"]`) !== null;
}

export function resolveFindShortcutOwner(): FindShortcutOwner {
  if (isTerminalFocused()) return null;
  const active = document.activeElement;
  const focused = active !== null && active !== document.body ? active : null;
  // Focus somewhere neither find covers (a file, a dialog, a menu) owns the key.
  const region = focused ? regionOf(focused) : lastPointerRegion;
  if (focused && region === null) return null;
  if (region === "browser") return browserPanelMounted() ? "browser" : null;
  // The chat, or nowhere in particular: the chat's find when it can open,
  // else the page's, as before chat find existed.
  if (useChatFindStore.getState().available) return "chat";
  return browserPanelMounted() ? "browser" : null;
}

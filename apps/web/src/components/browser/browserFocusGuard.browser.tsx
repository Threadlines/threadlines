import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installBrowserFocusGuard, noteBrowserUserIntent } from "./browserFocusGuard";

/**
 * The guard watches real focus events, so these run in a real document: an
 * input stands in for the composer and a bare <webview> custom element for
 * the browser panel's guest, which is all the guard ever looks at.
 */
describe("browserFocusGuard", () => {
  let input: HTMLInputElement;
  let webview: HTMLElement;
  let release: () => void;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    input = document.createElement("input");
    webview = document.createElement("webview");
    webview.tabIndex = -1;
    document.body.append(input, webview);
    release = installBrowserFocusGuard();
    // Whatever intent earlier tests recorded has long expired.
    vi.advanceTimersByTime(60_000);
  });

  afterEach(() => {
    release();
    input.remove();
    webview.remove();
    vi.useRealTimers();
  });

  it("returns focus to what the user had when a webview takes it uninvited", () => {
    input.focus();
    webview.focus();
    expect(document.activeElement).toBe(webview);
    // The restore waits out the window in which a genuine in-page click
    // would have announced itself.
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(input);
  });

  it("still restores when the user had just clicked into the robbed element", () => {
    // Clicking the composer is intent to be in the composer, not permission
    // for the webview to take the focus a moment later.
    input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    input.focus();
    webview.focus();
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(input);
  });

  it("leaves focus alone when it moves to another host element", () => {
    const other = document.createElement("input");
    document.body.append(other);
    input.focus();
    other.focus();
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("lets the webview keep focus when the user meant to go there", () => {
    input.focus();
    noteBrowserUserIntent();
    webview.focus();
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(webview);
  });

  it("yields to intent that arrives while the restore is still waiting", () => {
    input.focus();
    webview.focus();
    // The IPC report of the user's click inside the guest lands a moment
    // after the focus does.
    noteBrowserUserIntent();
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(webview);
  });
});

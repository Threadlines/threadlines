import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DesktopBridge, DesktopPreviewUserControl } from "@threadlines/contracts";

import {
  holdFocusForAgent,
  installBrowserFocusGuard,
  noteBrowserUserIntent,
} from "./browserFocusGuard";

const GUEST_ID = 7;
/**
 * The guard's memory of intent and agent work is module state, so each test's
 * clock starts a minute past the last one's: fake time otherwise restarts at
 * the real time, and what the previous test recorded would still look recent.
 */
let clock = Date.now();

/**
 * The guard watches real focus events, so these run in a real document: an
 * input stands in for the composer and a bare <webview> custom element for
 * the browser panel's guest, which is all the guard ever looks at. The main
 * process's reports of input inside the guest come through a stub bridge.
 */
describe("browserFocusGuard", () => {
  let input: HTMLInputElement;
  let webview: HTMLElement;
  let release: () => void;
  let releaseAgentHold: () => void;
  let reportGuestInput: (input: DesktopPreviewUserControl["input"]) => void;

  beforeEach(() => {
    clock += 60_000;
    vi.useFakeTimers({ shouldAdvanceTime: true, now: clock });
    input = document.createElement("input");
    webview = Object.assign(document.createElement("webview"), {
      getWebContentsId: () => GUEST_ID,
    });
    webview.tabIndex = -1;
    document.body.append(input, webview);
    let listener: ((control: DesktopPreviewUserControl) => void) | null = null;
    reportGuestInput = (kind) => listener?.({ webContentsId: GUEST_ID, input: kind });
    window.desktopBridge = {
      onPreviewUserControl: (next: (control: DesktopPreviewUserControl) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    } as unknown as DesktopBridge;
    release = installBrowserFocusGuard();
    releaseAgentHold = () => {};
  });

  afterEach(() => {
    releaseAgentHold();
    release();
    delete window.desktopBridge;
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

  it("still restores when the user keeps typing into the page while it waits", () => {
    input.focus();
    webview.focus();
    // The stolen focus routes the user's next keystroke into the guest, which
    // reports it; that is the user still typing, not choosing the page.
    reportGuestInput("keyboard");
    reportGuestInput("wheel");
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(input);
  });

  it("restores at once while an agent is acting on the page", () => {
    releaseAgentHold = holdFocusForAgent();
    input.focus();
    webview.focus();
    vi.advanceTimersByTime(1);
    expect(document.activeElement).toBe(input);
  });

  it("outlasts a page that keeps taking focus back while an agent acts", () => {
    releaseAgentHold = holdFocusForAgent();
    input.focus();
    webview.focus();
    vi.advanceTimersByTime(1);
    // The page refocuses its field on each of the next few frames.
    for (let frame = 0; frame < 5; frame += 1) {
      webview.focus();
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(input);
  });

  it("hands focus back when the user's own click in the page lost the race", () => {
    releaseAgentHold = holdFocusForAgent();
    input.focus();
    webview.focus();
    vi.advanceTimersByTime(1);
    expect(document.activeElement).toBe(input);
    reportGuestInput("pointer");
    expect(document.activeElement).toBe(webview);
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(webview);
  });
});

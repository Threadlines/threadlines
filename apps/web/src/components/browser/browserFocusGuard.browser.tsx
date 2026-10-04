import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DesktopBridge, DesktopPreviewUserControl } from "@threadlines/contracts";

import {
  holdFocusForAgent,
  installBrowserFocusGuard,
  noteBrowserUserIntent,
  withAgentInputTurn,
  withPageKeyboard,
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

  /**
   * Stands in for the IPC that carries the agent's keys: it is sent before the
   * page takes focus, and its work happens once the message has crossed.
   */
  const keys =
    (work: () => void = () => {}) =>
    async () => {
      await Promise.resolve();
      work();
    };

  it("gives the page the keyboard for an agent's keys, then gives it back", async () => {
    // Chromium sends a page's keystrokes to whatever holds focus in the
    // window: a restore in the middle sends the agent's text to the composer.
    releaseAgentHold = holdFocusForAgent();
    input.focus();
    await withPageKeyboard(
      webview,
      keys(() => {
        expect(document.activeElement).toBe(webview);
        vi.advanceTimersByTime(200);
        expect(document.activeElement).toBe(webview);
      }),
    );
    expect(document.activeElement).toBe(input);
  });

  it("returns the keyboard to the composer when the agent's click had just taken it", async () => {
    releaseAgentHold = holdFocusForAgent();
    input.focus();
    // The click into the page's field pulls focus onto the webview, and the
    // keys follow before the guard's restore has run; it comes due mid-keys.
    webview.focus();
    await withPageKeyboard(
      webview,
      keys(() => vi.advanceTimersByTime(1)),
    );
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(input);
  });

  it("returns the keyboard to the composer when focus was still on its way into the page", async () => {
    releaseAgentHold = holdFocusForAgent();
    input.focus();
    // Focus passes through nowhere on its way into a guest.
    input.blur();
    await withPageKeyboard(
      webview,
      keys(() => vi.advanceTimersByTime(1)),
    );
    expect(document.activeElement).toBe(input);
  });

  it("returns the keyboard to the composer after the guard gave up on the page", async () => {
    releaseAgentHold = holdFocusForAgent();
    input.focus();
    // Agent clicks in quick succession use up the restores...
    for (let grab = 0; grab < 5; grab += 1) {
      webview.focus();
      vi.advanceTimersByTime(100);
    }
    expect(document.activeElement).toBe(webview);
    // ...but the composer is still where the user was.
    await withPageKeyboard(webview, keys());
    expect(document.activeElement).toBe(input);
  });

  it("leaves the page the keyboard only if the user pressed in it meanwhile", async () => {
    releaseAgentHold = holdFocusForAgent();
    input.focus();
    // A press on the panel's own controls says nothing about this page.
    await withPageKeyboard(webview, keys(noteBrowserUserIntent));
    expect(document.activeElement).toBe(input);
    await withPageKeyboard(
      webview,
      keys(() => reportGuestInput("pointer")),
    );
    expect(document.activeElement).toBe(webview);
  });

  it("returns the keyboard to wherever the user moved meanwhile", async () => {
    releaseAgentHold = holdFocusForAgent();
    const other = document.createElement("input");
    document.body.append(other);
    input.focus();
    await withPageKeyboard(
      webview,
      keys(() => {
        other.focus();
        // The page takes focus back before the keys are done.
        webview.focus();
      }),
    );
    expect(document.activeElement).toBe(other);
    other.remove();
  });

  it("returns the keyboard to the user when one page's loan cuts another's short", async () => {
    releaseAgentHold = holdFocusForAgent();
    const second = Object.assign(document.createElement("webview"), {
      getWebContentsId: () => GUEST_ID + 1,
    });
    second.tabIndex = -1;
    document.body.append(second);
    input.focus();
    let finishFirst = () => {};
    const first = withPageKeyboard(
      webview,
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    await Promise.resolve();
    // The guard's pending look at the first loan's focus change comes and goes.
    vi.advanceTimersByTime(1);
    await withPageKeyboard(second, keys());
    expect(document.activeElement).toBe(input);
    finishFirst();
    await first;
    expect(document.activeElement).toBe(input);
    second.remove();
  });

  it("runs one agent input at a time, and a stuck one gives up its turn", async () => {
    const order: string[] = [];
    let finishFirst = () => {};
    const first = withAgentInputTurn(async () => {
      order.push("first");
      await new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    });
    const second = withAgentInputTurn(async () => {
      order.push("second");
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(order).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(order).toEqual(["first", "second"]);
    finishFirst();
    await first;
  });

  it("takes the keyboard back from a page that does not finish", async () => {
    releaseAgentHold = holdFocusForAgent();
    input.focus();
    let finish = () => {};
    const sending = withPageKeyboard(
      webview,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    expect(document.activeElement).toBe(webview);
    vi.advanceTimersByTime(1_000);
    expect(document.activeElement).toBe(input);
    finish();
    await sending;
    expect(document.activeElement).toBe(input);
  });
});

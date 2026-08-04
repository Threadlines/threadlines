import { scopeThreadRef } from "@threadlines/client-runtime";
import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  makeBrowserTab,
  nextActiveTabId,
  selectThreadBrowserState,
  steppedZoom,
  useBrowserPanelStore,
  waitForPreviewWebview,
  type BrowserTab,
} from "./browserPanelStore";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-browser-store"),
  ThreadId.make("thread-browser-store"),
);

function tabs(count: number): BrowserTab[] {
  return Array.from({ length: count }, () => makeBrowserTab());
}

describe("nextActiveTabId", () => {
  it("keeps the active tab when a different one closes", () => {
    const [a, b, c] = tabs(3) as [BrowserTab, BrowserTab, BrowserTab];

    expect(nextActiveTabId([a, b, c], a.id, b.id)).toBe(b.id);
  });

  it("walks right when the active tab closes", () => {
    const [a, b, c] = tabs(3) as [BrowserTab, BrowserTab, BrowserTab];

    expect(nextActiveTabId([a, b, c], b.id, b.id)).toBe(c.id);
  });

  it("falls back to the left at the end of the strip", () => {
    const [a, b, c] = tabs(3) as [BrowserTab, BrowserTab, BrowserTab];

    expect(nextActiveTabId([a, b, c], c.id, c.id)).toBe(b.id);
  });

  it("reports nothing left when the last tab closes", () => {
    const [only] = tabs(1) as [BrowserTab];

    expect(nextActiveTabId([only], only.id, only.id)).toBeNull();
  });
});

describe("background tabs", () => {
  beforeEach(() => {
    useBrowserPanelStore.setState({ browserStateByThreadKey: {} });
  });

  it("creates a live tab without changing the user's active tab", () => {
    const store = useBrowserPanelStore.getState();
    const original = selectThreadBrowserState(store.browserStateByThreadKey, THREAD_REF);
    const openedId = store.openTabWithUrl(THREAD_REF, "http://localhost:5173/", false);
    const next = selectThreadBrowserState(
      useBrowserPanelStore.getState().browserStateByThreadKey,
      THREAD_REF,
    );

    expect(next.activeTabId).toBe(original.activeTabId);
    expect(next.tabs.find((tab) => tab.id === openedId)?.url).toBe("http://localhost:5173/");
  });
});

describe("steppedZoom", () => {
  it("moves to the next familiar step rather than drifting", () => {
    expect(steppedZoom(1, 1)).toBe(1.1);
    expect(steppedZoom(1, -1)).toBe(0.9);
    expect(steppedZoom(1.1, 1)).toBe(1.25);
  });

  it("stops at the ends instead of running away", () => {
    expect(steppedZoom(2, 1)).toBe(2);
    expect(steppedZoom(0.5, -1)).toBe(0.5);
  });

  it("snaps a value between steps onto the grid", () => {
    expect(steppedZoom(1.05, 1)).toBe(1.1);
    expect(steppedZoom(1.05, -1)).toBe(1);
  });
});

describe("waitForPreviewWebview", () => {
  it("returns the page as soon as one registers, without waiting out the cap", async () => {
    let element: string | null = null;
    const listeners = new Set<() => void>();

    const waited = waitForPreviewWebview<string>({
      resolve: () => element,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      timeoutMs: 5_000,
    });

    // The panel mounts its element a tick after the agent asked for it.
    element = "webview";
    for (const listener of listeners) listener();

    expect(await waited).toBe("webview");
    // The subscription is not left behind once it has served its purpose.
    expect(listeners.size).toBe(0);
  });

  it("gives up at the cap so a panel that never mounts still answers", async () => {
    const timers: Array<() => void> = [];

    const waited = waitForPreviewWebview<string>({
      resolve: () => null,
      subscribe: () => () => undefined,
      timeoutMs: 5_000,
      setTimeoutFn: ((callback: () => void) => {
        timers.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof globalThis.setTimeout,
      clearTimeoutFn: (() => undefined) as unknown as typeof globalThis.clearTimeout,
    });

    timers[0]?.();

    // Null rather than a rejection: the caller reports "no page" the way it
    // always has instead of the agent seeing a thrown error.
    expect(await waited).toBeNull();
  });
});

import type { ScopedThreadRef } from "@threadlines/contracts";
import { scopedThreadKey } from "@threadlines/client-runtime";

import {
  callWhenReady,
  getPreviewWebview,
  selectPendingBrowserApprovals,
  selectThreadBrowserState,
  useBrowserPanelStore,
} from "../../browserPanelStore";
import { livePageKey, selectLivePageState, useBrowserLiveStore } from "../../browserLiveStore";
import {
  LIFECYCLE_LIMITS,
  planBrowserLifecycle,
  type LifecyclePage,
  type PageRunState,
} from "./browserLifecyclePlan";
import { signInPopupsOf } from "./signInPopups";

/**
 * Carries out `planBrowserLifecycle` against the real pages.
 *
 * Owns the facts the plan needs that no store keeps, because they change on
 * every agent action and nothing renders them: when each page was last used,
 * what is running on it, and which pages are frozen. Rendering only changes
 * when a page steps between painted, hidden and closed.
 */

interface PageActivity {
  lastAgentAt: number;
  inFlight: number;
}

const activityByPage = new Map<string, PageActivity>();
const lastShownAtByPage = new Map<string, number>();
/** How the desktop is running each page. A page attaches active. */
const runStateByPage = new Map<string, PageRunState>();

function webContentsIdOf(threadRef: ScopedThreadRef, tabId: string): number | null {
  const webview = getPreviewWebview(threadRef, tabId);
  return webview === null ? null : callWhenReady(() => webview.getWebContentsId());
}

/**
 * Changes how the desktop runs a page. Recorded before the call goes out,
 * with nothing awaited in between, so the next change asked for is always
 * sent after this one; the desktop applies a page's changes in order.
 */
async function setRunState(
  threadRef: ScopedThreadRef,
  tabId: string,
  state: PageRunState,
): Promise<void> {
  const key = livePageKey(threadRef, tabId);
  if ((runStateByPage.get(key) ?? "active") === state) {
    return;
  }
  const webContentsId = webContentsIdOf(threadRef, tabId);
  if (webContentsId === null) {
    return;
  }
  runStateByPage.set(key, state);
  await window.desktopBridge?.previewSetLifecycle?.({ webContentsId, state }).catch(() => {
    // Unknown now, unless a newer change was asked for since: that one owns
    // the record.
    if (runStateByPage.get(key) === state) runStateByPage.delete(key);
  });
}

/**
 * Makes a page run normally again. The desktop does the same before any
 * command on a page. A page an agent is working on already runs in full and
 * is left so.
 */
function wake(threadRef: ScopedThreadRef, tabId: string): Promise<void> {
  if (runStateByPage.get(livePageKey(threadRef, tabId)) === "working") {
    return Promise.resolve();
  }
  return setRunState(threadRef, tabId, "active");
}

/** Two frames of the app, or a moment if the window is not drawing. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, 50);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(fallback);
        resolve();
      }),
    );
  });
}

/**
 * Marks a page as in use by an agent for the length of one request: painted
 * if hidden (so a screenshot has something to capture), working (awake, and
 * painted even while the window is hidden or closed to the tray), and out of
 * reach of the lifecycle until well after the request ends. Asked for before
 * the agent's action rather than left to the desktop's own backstop, so the
 * page is ready first. Returns the call that ends it.
 */
export async function beginAgentWork(
  threadRef: ScopedThreadRef,
  tabId: string,
): Promise<() => void> {
  const key = livePageKey(threadRef, tabId);
  const activity = activityByPage.get(key) ?? { lastAgentAt: 0, inFlight: 0 };
  activity.inFlight += 1;
  activity.lastAgentAt = Date.now();
  activityByPage.set(key, activity);

  const live = useBrowserLiveStore.getState();
  const page = selectLivePageState(live.pageStateByThreadKey, threadRef, tabId);
  if (!isPageShown(threadRef, tabId) && !page.drawn) {
    live.setPageState(threadRef, tabId, { drawn: true });
    await nextPaint();
  }
  await setRunState(threadRef, tabId, "working");

  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    activity.inFlight = Math.max(0, activity.inFlight - 1);
    activity.lastAgentAt = Date.now();
  };
}

/** The page is on screen: its thread's panel is showing and it is the current tab. */
export function isPageShown(threadRef: ScopedThreadRef, tabId: string): boolean {
  if (useBrowserLiveStore.getState().shownThreadKey !== scopedThreadKey(threadRef)) {
    return false;
  }
  const browser = selectThreadBrowserState(
    useBrowserPanelStore.getState().browserStateByThreadKey,
    threadRef,
  );
  return browser.activeTabId === tabId;
}

/**
 * A page came on screen: wake it, bring it back if it was closed, and note
 * when it was last seen for when it goes off screen again.
 */
export function notePageShown(threadRef: ScopedThreadRef, tabId: string): void {
  lastShownAtByPage.set(livePageKey(threadRef, tabId), Date.now());
  useBrowserLiveStore.getState().setPageState(threadRef, tabId, { evicted: false });
  void wake(threadRef, tabId);
}

/**
 * A page went off screen. Its idle time starts now, and unless an agent is
 * using it, it runs as a background tab from now on.
 */
export function notePageHidden(threadRef: ScopedThreadRef, tabId: string): void {
  const key = livePageKey(threadRef, tabId);
  const now = Date.now();
  lastShownAtByPage.set(key, now);
  const activity = activityByPage.get(key);
  if (
    (activity?.inFlight ?? 0) === 0 &&
    now - (activity?.lastAgentAt ?? 0) >= LIFECYCLE_LIMITS.drawnForMs
  ) {
    void setRunState(threadRef, tabId, "background");
  }
}

/** Forgets a thread's pages once its browser has closed. */
export function forgetThreadPages(threadRef: ScopedThreadRef): void {
  const prefix = `${scopedThreadKey(threadRef)}\n`;
  for (const store of [activityByPage, lastShownAtByPage]) {
    for (const key of store.keys()) {
      if (key.startsWith(prefix)) store.delete(key);
    }
  }
  for (const key of runStateByPage.keys()) {
    if (key.startsWith(prefix)) runStateByPage.delete(key);
  }
}

/**
 * Whether the check has work: a running page is off screen, or a page an
 * agent was working on may be done with.
 */
export function hasLifecycleWork(): boolean {
  for (const state of runStateByPage.values()) {
    if (state === "working") return true;
  }
  const live = useBrowserLiveStore.getState();
  const panel = useBrowserPanelStore.getState();
  for (const [threadKey, browser] of Object.entries(live.liveByThreadKey)) {
    const state = selectThreadBrowserState(panel.browserStateByThreadKey, browser.threadRef);
    const shownTab = live.shownThreadKey === threadKey ? state.activeTabId : null;
    if (state.tabs.some((tab) => tab.id !== shownTab)) {
      return true;
    }
  }
  return false;
}

/**
 * One pass of the lifecycle: gathers every running page, asks the plan, and
 * carries it out. Memory comes from the desktop; each page is charged an
 * equal share of its process, since Chromium can put several in one.
 */
export async function runBrowserLifecycleCheck(now = Date.now()): Promise<void> {
  const live = useBrowserLiveStore.getState();
  const panel = useBrowserPanelStore.getState();
  // A tab closed while its agent was working leaves nothing to settle, and
  // would otherwise keep this check running. Read against the same moment as
  // the stores, before anything is awaited, so a tab opened and put to work
  // since is never taken for a closed one.
  const openPages = new Set<string>();
  for (const browser of Object.values(live.liveByThreadKey)) {
    const state = selectThreadBrowserState(panel.browserStateByThreadKey, browser.threadRef);
    for (const tab of state.tabs) openPages.add(livePageKey(browser.threadRef, tab.id));
  }
  for (const [key, state] of runStateByPage) {
    if (state === "working" && !openPages.has(key)) runStateByPage.delete(key);
  }
  const memory = await window.desktopBridge?.previewMemory?.().catch(() => null);
  const shareByWebContents = new Map<number, number>();
  for (const process of memory?.processes ?? []) {
    for (const id of process.webContentsIds) {
      shareByWebContents.set(id, process.workingSetKb / process.webContentsIds.length);
    }
  }

  const pages: Array<LifecyclePage & { threadRef: ScopedThreadRef; tabId: string }> = [];
  for (const browser of Object.values(live.liveByThreadKey)) {
    const state = selectThreadBrowserState(panel.browserStateByThreadKey, browser.threadRef);
    const questions = selectPendingBrowserApprovals(
      panel.pendingApprovalsByThreadKey,
      browser.threadRef,
    );
    for (const tab of state.tabs) {
      const page = selectLivePageState(live.pageStateByThreadKey, browser.threadRef, tab.id);
      if (page.evicted) continue;
      const key = livePageKey(browser.threadRef, tab.id);
      const activity = activityByPage.get(key);
      const webContentsId = webContentsIdOf(browser.threadRef, tab.id);
      pages.push({
        key,
        threadRef: browser.threadRef,
        tabId: tab.id,
        shown: isPageShown(browser.threadRef, tab.id),
        drawn: page.drawn,
        state: runStateByPage.get(key) ?? "active",
        inFlight: activity?.inFlight ?? 0,
        // A sign-in pop-up it opened waits on the user too, and the page must
        // be awake and in memory to hear back from it.
        awaitingUser:
          questions.some((question) => question.tabId === tab.id) ||
          signInPopupsOf(webContentsId).length > 0,
        lastAgentAt: activity?.lastAgentAt ?? 0,
        lastShownAt: lastShownAtByPage.get(key) ?? now,
        memoryKb: webContentsId === null ? null : (shareByWebContents.get(webContentsId) ?? null),
      });
      if (!lastShownAtByPage.has(key)) {
        // First seen now: its idle time counts from here, not from the epoch.
        lastShownAtByPage.set(key, now);
      }
    }
  }

  const plan = planBrowserLifecycle(pages, now);
  const byKey = new Map(pages.map((page) => [page.key, page]));
  // The plan is a snapshot, and carrying it out awaits the desktop. A page an
  // agent picked up, or the user brought on screen, since the snapshot is left
  // alone; checked right before each step, with no await in between, so a
  // wake asked for afterwards is always sent after the freeze it undoes.
  const agentIdle = (page: { key: string; threadRef: ScopedThreadRef; tabId: string }) => {
    const activity = activityByPage.get(page.key);
    return (
      (activity?.inFlight ?? 0) === 0 &&
      (activity?.lastAgentAt ?? 0) <= now &&
      // Nor is one that opened a sign-in pop-up since: it waits on the user.
      signInPopupsOf(webContentsIdOf(page.threadRef, page.tabId)).length === 0
    );
  };
  const stillIdle = (page: {
    key: string;
    threadRef: ScopedThreadRef;
    tabId: string;
    lastShownAt: number;
  }) =>
    agentIdle(page) &&
    // Seen since the snapshot -- shown and hidden again while an earlier
    // step awaited the desktop -- is not idle either.
    (lastShownAtByPage.get(page.key) ?? 0) <= page.lastShownAt &&
    !isPageShown(page.threadRef, page.tabId);
  for (const key of plan.settle) {
    const page = byKey.get(key);
    // Gone off screen since, it is the background step's next time.
    if (page === undefined || !agentIdle(page) || !isPageShown(page.threadRef, page.tabId)) {
      continue;
    }
    await setRunState(page.threadRef, page.tabId, "active");
  }
  for (const key of plan.background) {
    const page = byKey.get(key);
    if (page === undefined || !stillIdle(page)) continue;
    live.setPageState(page.threadRef, page.tabId, { drawn: false });
    await setRunState(page.threadRef, page.tabId, "background");
  }
  for (const key of plan.freeze) {
    const page = byKey.get(key);
    if (page === undefined || !stillIdle(page)) continue;
    await setRunState(page.threadRef, page.tabId, "frozen");
  }
  for (const key of plan.evict) {
    const page = byKey.get(key);
    if (page === undefined || !stillIdle(page)) continue;
    runStateByPage.delete(key);
    live.setPageState(page.threadRef, page.tabId, { evicted: true, drawn: false });
  }
  // The desktop makes a page active before any command on it, and not every
  // command comes through here (a theme change restyles hidden pages too). So
  // what each idle page should be is said again; the desktop ignores a state a
  // page is already in.
  const evicted = new Set(plan.evict);
  for (const page of pages) {
    const state = runStateByPage.get(page.key);
    if (
      state === undefined ||
      state === "active" ||
      state === "working" ||
      evicted.has(page.key) ||
      !stillIdle(page)
    ) {
      continue;
    }
    const webContentsId = webContentsIdOf(page.threadRef, page.tabId);
    if (webContentsId === null) continue;
    await window.desktopBridge
      ?.previewSetLifecycle?.({ webContentsId, state })
      .catch(() => undefined);
  }
}

/** Pages an agent will act on next must exist: brings a closed one back. */
export function reviveEvictedPage(threadRef: ScopedThreadRef, tabId: string): void {
  useBrowserLiveStore.getState().setPageState(threadRef, tabId, { evicted: false });
}

export function resetBrowserLifecycleForTests(): void {
  activityByPage.clear();
  lastShownAtByPage.clear();
  runStateByPage.clear();
}

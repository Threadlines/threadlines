import { scopeThreadRef, scopedThreadKey } from "@threadlines/client-runtime";
import { EnvironmentId, ThreadId } from "@threadlines/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  makeBrowserTab,
  selectPendingBrowserApprovals,
  useBrowserPanelStore,
} from "../../browserPanelStore";
import { answerBrowserApproval, waitForBrowserApproval } from "./browserApprovalRequests";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("env-approvals"), ThreadId.make("thread-a"));
const question = {
  host: "example.com",
  url: "https://example.com/",
  source: "agent" as const,
  fromHost: null,
};
const queued = () =>
  selectPendingBrowserApprovals(
    useBrowserPanelStore.getState().pendingApprovalsByThreadKey,
    THREAD_REF,
  );

describe("answering a browser approval", () => {
  beforeEach(() => {
    useBrowserPanelStore.setState({ browserStateByThreadKey: {}, pendingApprovalsByThreadKey: {} });
  });

  it("never asks the panel to load a page an agent was waiting on, even after it stopped", async () => {
    const stop = new AbortController();
    const waiting = waitForBrowserApproval(
      THREAD_REF,
      { ...question, tabId: "tab-1" },
      stop.signal,
    );
    const asked = queued()[0]!;
    // The agent gives up (its call timed out) just before the user clicks.
    stop.abort();
    await expect(waiting).rejects.toThrow();

    expect(answerBrowserApproval(THREAD_REF, asked, "allowSite")).toBe("done");
    expect(queued()).toEqual([]);
  });

  it("loads a page's own blocked navigation once, however many times it is allowed", () => {
    const store = useBrowserPanelStore.getState();
    const asked = { ...question, source: "page" as const, tabId: "tab-1", id: "q", waiting: false };
    store.enqueueBrowserApproval(THREAD_REF, asked);

    expect(answerBrowserApproval(THREAD_REF, asked, "allowSite")).toBe("load");
    expect(answerBrowserApproval(THREAD_REF, asked, "allowSite")).toBe("done");
  });

  it("stops waiting when the tab the question is about closes", async () => {
    const tab = makeBrowserTab();
    useBrowserPanelStore.setState({
      browserStateByThreadKey: {
        [scopedThreadKey(THREAD_REF)]: {
          open: true,
          tabs: [tab, makeBrowserTab()],
          activeTabId: tab.id,
        },
      },
    });
    const waiting = waitForBrowserApproval(THREAD_REF, { ...question, tabId: tab.id }, undefined);

    useBrowserPanelStore.getState().closeTab(THREAD_REF, tab.id);

    await expect(waiting).rejects.toThrow("tab closed");
    expect(queued()).toEqual([]);
  });
});

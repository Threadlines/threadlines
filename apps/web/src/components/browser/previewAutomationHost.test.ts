import type { DesktopBridge, PreviewAutomationRequest } from "@threadlines/contracts";
import { describe, expect, it } from "vitest";

import { createPreviewAutomationHandler, type AgentActivity } from "./previewAutomationHost";

const request = (
  operation: PreviewAutomationRequest["operation"],
  input: PreviewAutomationRequest["input"] = {},
): PreviewAutomationRequest => ({ requestId: "r1", agentId: "agent-1", operation, input });

const handlerFor = (
  bridge: Partial<DesktopBridge>,
  webContentsId: number | null = 42,
  navigate: (url: string) => Promise<void> = () => Promise.resolve(),
) =>
  createPreviewAutomationHandler(bridge as DesktopBridge, () => ({
    webContentsId,
    navigate,
    viewport: () => ({ width: 800, height: 600 }),
    setViewport: () => {},
    onAgentPoint: () => {},
    tabs: () => [],
    selectTab: () => {},
    onAgentActivity: () => {},
  }));

describe("createPreviewAutomationHandler", () => {
  it("serializes actions that target the same browser tab", async () => {
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handle = handlerFor({
      previewClick: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (calls === 1) await firstGate;
        active -= 1;
        return { x: 10, y: 20 };
      },
      previewStatus: () =>
        Promise.resolve({ url: "http://x/", title: "X", loading: false, controlEpoch: 0 }) as never,
    });

    const first = handle(request("click", { target: { ref: "e1" } }));
    await Promise.resolve();
    const second = handle(request("click", { target: { ref: "e2" } }));
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("reports human takeover of the tab as an interrupted action", async () => {
    let controlEpoch = 0;
    let takeoverCount = 0;
    const handle = createPreviewAutomationHandler(
      {
        previewClick: () => {
          controlEpoch += 1;
          return Promise.resolve({ x: 10, y: 20 });
        },
        previewStatus: () =>
          Promise.resolve({ url: "http://x/", title: "X", loading: false, controlEpoch }) as never,
      } as unknown as DesktopBridge,
      () => ({
        webContentsId: 42,
        navigate: () => Promise.resolve(),
        viewport: () => ({ width: 800, height: 600 }),
        setViewport: () => {},
        onAgentPoint: () => {},
        tabs: () => [],
        selectTab: () => {},
        onAgentActivity: () => {},
        onUserTakeover: () => {
          takeoverCount += 1;
        },
      }),
    );

    const response = await handle(request("click", { target: { ref: "e1" } }));

    expect(response.error).toContain("user took control");
    expect(takeoverCount).toBe(1);
  });

  it("sends the operation's input to the bridge along with the tab it acts on", async () => {
    const seen: unknown[] = [];
    const handle = handlerFor({
      previewClick: (input) => {
        seen.push(input);
        return Promise.resolve({ x: 10, y: 20 });
      },
      previewStatus: () =>
        Promise.resolve({ url: "http://x/", title: "X", loading: false }) as never,
    });

    const response = await handle(request("click", { target: { ref: 7 } }));

    // The tab is the host's business, not the agent's: it never names one.
    expect(seen).toEqual([{ webContentsId: 42, target: { ref: 7 } }]);
    // An action answers with where the page ended up. Returning nothing failed
    // MCP validation, which showed a successful click to the agent as an error
    // and invited a retry -- and a retried click clicks twice.
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({
      url: "http://x/",
      title: "X",
      loading: false,
      width: 800,
      height: 600,
    });
  });

  it("reports where a click landed so the panel can show it happening", async () => {
    // Without this an agent changes the page with nothing to say it was the
    // agent, and "did the click land?" has no answer but another snapshot.
    const points: unknown[] = [];
    const handle = createPreviewAutomationHandler(
      {
        previewClick: () => Promise.resolve({ x: 120, y: 48 }),
        previewStatus: () => Promise.resolve({ url: "http://x/", title: "X", loading: false }),
      } as unknown as DesktopBridge,
      () => ({
        webContentsId: 42,
        navigate: () => Promise.resolve(),
        viewport: () => ({ width: 800, height: 600 }),
        setViewport: () => {},
        onAgentPoint: (point) => points.push(point),
        tabs: () => [],
        selectTab: () => {},
        onAgentActivity: () => {},
      }),
    );

    await handle(request("click", { target: { ref: 1 } }));

    expect(points).toEqual([{ x: 120, y: 48 }]);
  });

  it("reports both ends of a drag, so the pointer can replay the gesture", async () => {
    // Only the destination would show where the drag finished and lose the
    // drag, which is the part a watching user cannot otherwise see.
    const points: unknown[] = [];
    const activity: Array<string | null> = [];
    const handle = createPreviewAutomationHandler(
      {
        previewDrag: () => Promise.resolve({ from: { x: 10, y: 20 }, to: { x: 90, y: 20 } }),
        previewStatus: () => Promise.resolve({ url: "http://x/", title: "X", loading: false }),
      } as unknown as DesktopBridge,
      () => ({
        webContentsId: 42,
        navigate: () => Promise.resolve(),
        viewport: () => ({ width: 800, height: 600 }),
        setViewport: () => {},
        onAgentPoint: (point) => points.push(point),
        tabs: () => [],
        selectTab: () => {},
        onAgentActivity: (entry) => activity.push(entry.detail),
      }),
    );

    await handle(request("drag", { from: { text: "Sign in" }, to: { text: "fixture" } }));

    expect(points).toEqual([{ x: 90, y: 20, from: { x: 10, y: 20 } }]);
    // "dragged" on its own says nothing about what moved.
    expect(activity.at(-1)).toBe('"Sign in" \u2192 "fixture"');
  });

  it("names a coordinate target by its coordinates", async () => {
    // A drag between two points has no element to name, and an activity line
    // reading "dragged" with nothing after it is the same as no line at all.
    const seen: AgentActivity[] = [];
    const handle = createPreviewAutomationHandler(
      {
        previewDrag: () => Promise.resolve({ x: 300, y: 120 }),
        previewStatus: () => Promise.resolve({ url: "http://x/", title: "X", loading: false }),
      } as unknown as DesktopBridge,
      () => ({
        webContentsId: 42,
        navigate: () => Promise.resolve(),
        viewport: () => ({ width: 800, height: 600 }),
        setViewport: () => {},
        onAgentPoint: () => {},
        onAgentActivity: (activity) => seen.push(activity),
        tabs: () => [],
        selectTab: () => {},
      }),
    );

    await handle(
      request("drag", { from: { point: { x: 120.4, y: 60 } }, to: { point: { x: 300, y: 60 } } }),
    );

    expect(seen[0]?.detail).toBe("120, 60 \u2192 300, 60");
  });

  it("records an agent resize on the tab and answers with the size it asked for", async () => {
    // Told to the guest alone, the page rendered at the new width inside a
    // frame that still filled the panel, so it came out cropped -- and the
    // answer reported the panel's size, so the agent read its resize as having
    // done nothing and asked again.
    const applied: unknown[] = [];
    const seen: AgentActivity[] = [];
    let fixed: { width: number | null; height: number | null } = { width: null, height: null };
    const handle = createPreviewAutomationHandler(
      {
        previewSetViewport: (input: unknown) => {
          applied.push(input);
          return Promise.resolve();
        },
        previewStatus: () => Promise.resolve({ url: "http://x/", title: "X", loading: false }),
      } as unknown as DesktopBridge,
      () => ({
        webContentsId: 42,
        navigate: () => Promise.resolve(),
        viewport: () =>
          fixed.width !== null && fixed.height !== null
            ? { width: fixed.width, height: fixed.height }
            : { width: 800, height: 600 },
        setViewport: (viewport) => {
          fixed = viewport;
        },
        onAgentPoint: () => {},
        onAgentActivity: (activity) => seen.push(activity),
        tabs: () => [],
        selectTab: () => {},
      }),
    );

    const response = await handle(request("resize", { width: 1280, height: 800 }));

    expect(applied).toEqual([{ webContentsId: 42, width: 1280, height: 800 }]);
    expect(fixed).toEqual({ width: 1280, height: 800 });
    expect(response.result).toMatchObject({ width: 1280, height: 800 });
    expect(seen.at(-1)?.detail).toBe("1280\u00d7800");
  });

  it("reports every tab, marking the user's and its own", async () => {
    // The agent pins itself to a tab. Without a way to see the others it
    // reports on the one it is pinned to and states that nothing else is open,
    // which is what it did when a second tab was the one being asked about.
    const handle = createPreviewAutomationHandler(
      {
        previewStatus: () => Promise.resolve({ url: "http://x/", title: "X", loading: false }),
      } as unknown as DesktopBridge,
      () => ({
        webContentsId: 42,
        navigate: () => Promise.resolve(),
        viewport: () => ({ width: 800, height: 600 }),
        setViewport: () => {},
        onAgentPoint: () => {},
        onAgentActivity: () => {},
        selectTab: () => {},
        tabs: () => [
          {
            id: "tab-fixture",
            title: "Fixture",
            url: "http://localhost:18821/",
            active: false,
            agent: true,
          },
          {
            id: "tab-manuals",
            title: "Manuals",
            url: "https://example.com/",
            active: true,
            agent: false,
          },
        ],
      }),
    );

    const response = await handle(request("tabs", {}));

    expect(response.result).toEqual({
      panelOpen: true,
      tabs: [
        {
          id: "tab-fixture",
          title: "Fixture",
          url: "http://localhost:18821/",
          active: false,
          agent: true,
        },
        {
          id: "tab-manuals",
          title: "Manuals",
          url: "https://example.com/",
          active: true,
          agent: false,
        },
      ],
    });
  });

  it("reports the closed page and whether cleanup closed the panel", async () => {
    let open = true;
    let tabs = [
      {
        id: "tab-agent",
        title: "Manual",
        url: "https://example.com/manual",
        active: true,
        agent: true,
      },
    ];
    const handle = createPreviewAutomationHandler({} as DesktopBridge, () => ({
      tabId: "tab-agent",
      webContentsId: 42,
      navigate: () => Promise.resolve(),
      viewport: () => ({ width: 800, height: 600 }),
      setViewport: () => {},
      onAgentPoint: () => {},
      onAgentActivity: () => {},
      selectTab: () => {},
      tabs: () => tabs,
      panelOpen: () => open,
      closeTab: async () => {
        tabs = [];
        open = false;
        return {
          id: "tab-agent",
          title: "Manual",
          url: "https://example.com/manual",
        };
      },
    }));

    const response = await handle(request("closeTab"));

    expect(response.result).toEqual({
      tabs: [],
      panelOpen: false,
      closedTab: {
        id: "tab-agent",
        title: "Manual",
        url: "https://example.com/manual",
      },
    });
  });

  it("wraps an evaluate result so an array is not a validation failure", async () => {
    // The expression has already run by the time the result is checked, so a
    // bare array used to \"fail\" after mutating the page.
    const handle = handlerFor({ previewEvaluate: () => Promise.resolve([1, 2, 3]) as never });

    const response = await handle(request("evaluate", { expression: "[1,2,3]" }));

    expect(response.result).toEqual({ result: [1, 2, 3] });
  });

  it("says what it is doing in words, before and after", async () => {
    // The line under the toolbar is the only thing that distinguishes an agent
    // working from a page misbehaving on its own.
    const seen: AgentActivity[] = [];
    const handle = createPreviewAutomationHandler(
      {
        previewClick: () => Promise.resolve({ x: 1, y: 2 }),
        previewStatus: () => Promise.resolve({ url: "http://x/", title: "X", loading: false }),
      } as unknown as DesktopBridge,
      () => ({
        webContentsId: 42,
        navigate: () => Promise.resolve(),
        viewport: () => ({ width: 800, height: 600 }),
        setViewport: () => {},
        onAgentPoint: () => {},
        tabs: () => [],
        selectTab: () => {},
        onAgentActivity: (activity) => seen.push(activity),
      }),
    );

    await handle(request("click", { target: { text: "Sign in" } }));

    // A verb and the thing's own words, not a tool name and a selector.
    expect(seen.map((a) => `${a.phase}: ${a.verb} ${a.detail}`)).toEqual([
      'running: clicked "Sign in"',
      'done: clicked "Sign in"',
    ]);
  });

  it("stops saying it is working when the action fails", async () => {
    // A line left mid-sentence would claim an action never finished.
    const seen: AgentActivity[] = [];
    const handle = createPreviewAutomationHandler(
      {
        previewClick: () => Promise.reject(new Error("no element matched")),
      } as unknown as DesktopBridge,
      () => ({
        webContentsId: 42,
        navigate: () => Promise.resolve(),
        viewport: () => ({ width: 800, height: 600 }),
        setViewport: () => {},
        onAgentPoint: () => {},
        tabs: () => [],
        selectTab: () => {},
        onAgentActivity: (activity) => seen.push(activity),
      }),
    );

    await handle(request("click", { target: { ref: "e3" } }));

    expect(seen.at(-1)?.phase).toBe("done");
  });

  it("answers with the failure instead of rejecting", async () => {
    // A rejection would leave the broker waiting out its whole timeout for
    // something already known, and the agent needs the reason to pick its next
    // move -- a bad selector means re-snapshot, not give up.
    const handle = handlerFor({
      previewClick: () => Promise.reject(new Error('no element matches selector ".gone"')),
    });

    const response = await handle(request("click", { target: { selector: ".gone" } }));

    expect(response.error).toBe('no element matches selector ".gone"');
    expect(response.requestId).toBe("r1");
  });

  it("strips Electron's wrapper off a main-process failure", async () => {
    // Electron prefixes anything thrown across IPC, which buries the sentence
    // the agent actually needs under something that reads like a broken tool.
    const handle = handlerFor({
      previewType: () =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'desktop:preview-type': Error: target is not editable",
          ),
        ),
    });

    const response = await handle(request("type", { target: { ref: 1 }, text: "hi" }));

    expect(response.error).toBe("target is not editable");
  });

  it("answers instead of rejecting when the target itself cannot be read", async () => {
    // `getWebContentsId` throws until the webview attaches, and a throw out of
    // the handler was the one failure the broker could not see: it waited out
    // its whole timeout on a request the host already knew was unanswerable.
    const handle = createPreviewAutomationHandler({} as DesktopBridge, () => {
      throw new Error("The WebView must be attached to the DOM");
    });

    const response = await handle(request("status"));

    expect(response.error).toContain("attached to the DOM");
    expect(response.requestId).toBe("r1");
  });

  it("says so when the panel is open but has no page", async () => {
    const handle = handlerFor(
      { previewSnapshot: () => Promise.reject(new Error("unreachable")) },
      null,
    );

    const response = await handle(request("snapshot"));

    expect(response.error).toContain("no page loaded");
  });

  it("reports an operation this build cannot perform rather than hanging", async () => {
    // The bridge and the advertised operation list are built from the same
    // contract, so a gap here means they drifted -- which should be a loud
    // answer, not a twenty second silence.
    const handle = handlerFor({});

    const response = await handle(request("press", { key: "Enter" }));

    expect(response.error).toContain("cannot perform press");
  });
});

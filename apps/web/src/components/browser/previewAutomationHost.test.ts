import type { DesktopBridge, PreviewAutomationRequest } from "@threadlines/contracts";
import { describe, expect, it } from "vitest";

import { createPreviewAutomationHandler, type AgentActivity } from "./previewAutomationHost";

const request = (
  operation: PreviewAutomationRequest["operation"],
  input: PreviewAutomationRequest["input"] = {},
): PreviewAutomationRequest => ({ requestId: "r1", operation, input });

const handlerFor = (
  bridge: Partial<DesktopBridge>,
  webContentsId: number | null = 42,
  navigate: (url: string) => Promise<void> = () => Promise.resolve(),
) =>
  createPreviewAutomationHandler(bridge as DesktopBridge, () => ({
    webContentsId,
    navigate,
    viewport: () => ({ width: 800, height: 600 }),
    onAgentPoint: () => {},
    tabs: () => [],
    selectTab: () => {},
    onAgentActivity: () => {},
  }));

describe("createPreviewAutomationHandler", () => {
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
        onAgentPoint: () => {},
        onAgentActivity: () => {},
        selectTab: () => {},
        tabs: () => [
          { title: "Fixture", url: "http://localhost:18821/", active: false, agent: true },
          { title: "Manuals", url: "https://example.com/", active: true, agent: false },
        ],
      }),
    );

    const response = await handle(request("tabs", {}));

    expect(response.result).toEqual({
      tabs: [
        { title: "Fixture", url: "http://localhost:18821/", active: false, agent: true },
        { title: "Manuals", url: "https://example.com/", active: true, agent: false },
      ],
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

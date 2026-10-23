import "../../index.css";

import {
  type EnvironmentApi,
  EnvironmentId,
  type McpAppCallToolInput,
  type McpAppLoadResult,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { McpAppCard, McpAppSidePanel } from "./McpAppCard";

vi.mock("./agentPageClient", async () => {
  const { AGENT_PAGE_FALLBACK_THEMES } = await import("@threadlines/shared/agentPages");
  return { useAgentPageTheme: () => AGENT_PAGE_FALLBACK_THEMES.dark };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-mcp-app");
const THREAD_ID = ThreadId.make("thread-mcp-app");

/**
 * A small app written against the MCP Apps messages directly: once it has the
 * call's result, it bumps the counter with a tool call of its own and asks to
 * send a message saying what happened.
 */
const COUNTER_APP = `<!doctype html><html><body><p>Counter</p><script>
let id = 0;
const pending = new Map();
const request = (method, params) => {
  const requestId = ++id;
  parent.postMessage({ jsonrpc: "2.0", id: requestId, method, params }, "*");
  return new Promise((resolve) => pending.set(requestId, resolve));
};
addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || message.jsonrpc !== "2.0") return;
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === "ui/notifications/tool-result") {
    const before = message.params.structuredContent.count;
    const bumped = await request("tools/call", { name: "bump", arguments: { by: 1 } });
    const after = bumped.result.structuredContent.count;
    await request("ui/message", {
      role: "user",
      content: [{ type: "text", text: "Count went from " + before + " to " + after }],
    });
  }
});
request("ui/initialize", {
  appInfo: { name: "counter", version: "1" },
  appCapabilities: {},
  protocolVersion: "2026-01-26",
}).then(() => parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*"));
</script></body></html>`;

const LOADED: McpAppLoadResult = {
  server: "probe-apps",
  tool: "show_counter",
  resourceUri: "ui://probe-apps/counter.html",
  arguments: { start: 3 },
  result: { content: [{ type: "text", text: "Counter at 3" }], structuredContent: { count: 3 } },
  truncated: false,
  view: { html: COUNTER_APP, csp: {}, permissions: {}, prefersBorder: null },
  callsAllowed: false,
};

describe("McpAppCard", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    document.body.innerHTML = "";
  });

  it("removes an app that navigates itself away, so nothing it loads keeps running", async () => {
    // It leaves once it has loaded, the way a page carrying what it shows to
    // a server of its own would.
    const leaving: McpAppLoadResult = {
      ...LOADED,
      view: {
        ...LOADED.view,
        html: `<!doctype html><p>Counter</p><script>addEventListener("load", () => setTimeout(() => { location.href = "data:text/html,<p>gone</p>"; }, 50));</script>`,
      },
    };
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      mcpApps: { load: async () => leaving, callTool: vi.fn() },
    } as unknown as EnvironmentApi);

    await render(
      <McpAppCard
        environmentId={ENVIRONMENT_ID}
        threadId={THREAD_ID}
        app={{
          toolCallId: "call-leaving",
          ref: { server: "probe-apps", tool: "show_counter", resourceUri: LOADED.resourceUri },
          turnId: TurnId.make("turn-1"),
        }}
      />,
    );

    await expect
      .element(page.getByText("The app tried to open another page and was stopped."))
      .toBeVisible();
    expect(document.querySelector('iframe[title="Show counter"]')).toBeNull();
  });

  it("shows the app, asks before it runs a tool, and puts its message in the composer", async () => {
    const callTool = vi.fn(async (_input: McpAppCallToolInput) => ({
      content: [{ type: "text", text: "Counter at 4" }],
      structuredContent: { count: 4 },
    }));
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      mcpApps: { load: async () => LOADED, callTool },
    } as unknown as EnvironmentApi);
    const putMessage = vi.fn();
    const screen = (showCard: boolean) => (
      <>
        {showCard ? (
          <McpAppCard
            environmentId={ENVIRONMENT_ID}
            threadId={THREAD_ID}
            app={{
              toolCallId: "call-counter",
              ref: { server: "probe-apps", tool: "show_counter", resourceUri: LOADED.resourceUri },
              turnId: TurnId.make("turn-1"),
            }}
            onPutMessage={putMessage}
          />
        ) : null}
        <McpAppSidePanel
          environmentId={ENVIRONMENT_ID}
          threadId={THREAD_ID}
          onPutMessage={putMessage}
        />
      </>
    );

    const rendered = await render(screen(true));

    await expect.element(page.getByText("Show counter").first()).toBeVisible();
    await expect.element(page.getByText("· probe-apps tool server")).toBeVisible();
    // The agent works with approvals on: the app's own call waits for the reader.
    await expect.element(page.getByText("The app wants to run")).toBeVisible();
    expect(callTool).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Allow once" }).click();

    await vi.waitFor(() => expect(putMessage).toHaveBeenCalledWith("Count went from 3 to 4"));
    expect(callTool).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      toolCallId: "call-counter",
      tool: "bump",
      arguments: { by: 1 },
      confirmed: true,
    });
    await expect.element(page.getByText("The app wants to run")).not.toBeInTheDocument();

    // Open beside the chat, the same running app moves into the side panel,
    // and keeps running there when its card scrolls away.
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Show counter"]');
    const view = frame?.contentWindow;
    await page.getByRole("button", { name: "Open Show counter beside the chat" }).click();
    await vi.waitFor(() => expect(frame?.closest('[data-slot="drawer-popup"]')).not.toBeNull());
    await rendered.rerender(screen(false));
    expect(frame?.isConnected).toBe(true);
    expect(frame?.contentWindow).toBe(view);

    // Closed with no card to go back to, it goes.
    await page.getByRole("button", { name: "Close Show counter" }).click();
    await vi.waitFor(() => expect(frame?.isConnected).toBe(false));
  });
});

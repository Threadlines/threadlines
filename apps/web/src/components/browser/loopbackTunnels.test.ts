import {
  EnvironmentId,
  PreviewTunnelError,
  type DesktopPreviewTunnelReply,
  type DesktopPreviewTunnelRequest,
  type EnvironmentApi,
  type ExecutionEnvironmentDescriptor,
  type PreviewTunnelEvent,
  type PreviewTunnelWrite,
} from "@threadlines/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import {
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime/catalog";
import { serveLoopbackTunnels } from "./loopbackTunnels";

const MAC = EnvironmentId.make("env-mac");

function descriptor(tunnels: boolean): ExecutionEnvironmentDescriptor {
  return {
    environmentId: MAC,
    label: "Studio Mac",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: true,
      ...(tunnels ? { browserLoopbackTunnel: true } : {}),
    },
  };
}

/**
 * The window's tunnel service between a fake desktop and a fake server: what
 * the desktop asks, what the window tells it, and what reaches the server.
 */
function harness(options: { readonly route?: "direct" | "relay"; readonly tunnels?: boolean }) {
  // The environment API is only handed out in a window.
  vi.stubGlobal("window", {});
  useSavedEnvironmentRuntimeStore.getState().patch(MAC, {
    connectionState: "connected",
    descriptor: descriptor(options.tunnels ?? true),
    route: options.route ?? "direct",
  });
  const writes: PreviewTunnelWrite[] = [];
  const opened: Array<{
    listener: (event: PreviewTunnelEvent) => void;
    onClosed: (failure?: unknown) => void;
  }> = [];
  const previewLoopback: EnvironmentApi["previewLoopback"] = {
    open: (_input, listener, onClosed) => {
      opened.push({ listener, onClosed });
      return () => {};
    },
    write: async (input) => {
      writes.push(input);
    },
    credit: async () => {},
    localServers: async () => [],
  };
  __setEnvironmentApiOverrideForTests(MAC, { previewLoopback } as unknown as EnvironmentApi);

  const replies: DesktopPreviewTunnelReply[] = [];
  let ask: (request: DesktopPreviewTunnelRequest) => void = () => {};
  const stop = serveLoopbackTunnels({
    servePreviewTunnels: (listener) => {
      ask = listener;
      return { send: (reply) => replies.push(reply), stop: () => {} };
    },
  });
  return {
    ask: (request: DesktopPreviewTunnelRequest) => ask(request),
    replies,
    writes,
    opened,
    stop,
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("serveLoopbackTunnels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetEnvironmentApiOverridesForTests();
    resetSavedEnvironmentRuntimeStoreForTests();
  });

  it("sends what the page wrote before the tunnel opened, in order, once it opens", async () => {
    const { ask, replies, writes, opened, stop } = harness({});
    ask({ type: "open", tunnelId: "t1", environmentId: MAC, host: "localhost", port: 5173 });
    ask({ type: "write", tunnelId: "t1", data: bytes("GET / ") });
    ask({ type: "write", tunnelId: "t1", data: bytes("HTTP/1.1") });
    ask({ type: "end", tunnelId: "t1" });
    expect(writes).toEqual([]);

    opened[0]!.listener({ _tag: "opened" });
    opened[0]!.listener({ _tag: "data", data: btoa("HTTP/1.1 200 OK") });
    await settle();

    expect(writes.map(({ seq, data, end }) => ({ seq, data, end }))).toEqual([
      { seq: 0, data: btoa("GET / "), end: undefined },
      { seq: 1, data: btoa("HTTP/1.1"), end: undefined },
      { seq: 2, data: undefined, end: true },
    ]);
    expect(replies[0]).toEqual({ type: "opened", tunnelId: "t1" });
    const data = replies.find((reply) => reply.type === "data");
    expect(new TextDecoder().decode(data?.type === "data" ? data.data : undefined)).toBe(
      "HTTP/1.1 200 OK",
    );
    expect(replies.filter((reply) => reply.type === "written")).toEqual([
      { type: "written", tunnelId: "t1", bytes: 6 },
      { type: "written", tunnelId: "t1", bytes: 8 },
    ]);
    stop();
  });

  it("tells the page which computer refused it, and why", () => {
    const { ask, replies, opened, stop } = harness({});
    ask({ type: "open", tunnelId: "t2", environmentId: MAC, host: "localhost", port: 5999 });
    opened[0]!.onClosed(
      new PreviewTunnelError({
        reason: "unreachable",
        detail: "Nothing is listening on localhost:5999.",
      }),
    );
    expect(replies).toEqual([
      {
        type: "closed",
        tunnelId: "t2",
        error: "Studio Mac: Nothing is listening on localhost:5999.",
      },
    ]);
    stop();
  });

  it("refuses over the relay, which counts every message against a daily allowance", () => {
    const { ask, replies, opened, stop } = harness({ route: "relay" });
    ask({ type: "open", tunnelId: "t3", environmentId: MAC, host: "localhost", port: 5173 });
    expect(opened).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ type: "closed", tunnelId: "t3" });
    expect(replies[0]?.type === "closed" ? replies[0].error : "").toContain("relay");
    stop();
  });

  it("asks an older computer to update rather than opening this machine's port", () => {
    const { ask, replies, opened, stop } = harness({ tunnels: false });
    ask({ type: "open", tunnelId: "t4", environmentId: MAC, host: "localhost", port: 5173 });
    expect(opened).toEqual([]);
    expect(replies[0]?.type === "closed" ? replies[0].error : "").toContain("Update it");
    stop();
  });
});

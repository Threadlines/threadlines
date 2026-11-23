import { spawn } from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import type * as NetAddress from "effect/net/NetAddress";
import { describe, expect, it } from "vite-plus/test";

import { normalizeMcpHttpResponse, readBearerToken } from "../../mcp/McpHttpServer.ts";
import {
  ACP_MCP_BRIDGE_AUTH_ENV,
  ACP_MCP_BRIDGE_URL_ENV,
  httpMcpServerToStdioBridge,
} from "./acpMcpStdioBridge.ts";

const SECRET_TOKEN = "tl_bridge_secret_token_12345";

function spawnBridge(entry: ReturnType<typeof httpMcpServerToStdioBridge>) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const pair of entry.env) {
    env[pair.name] = pair.value;
  }
  const child = spawn(entry.command, [...entry.args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const id = parsed.id;
      if (typeof id === "number" && pending.has(id)) {
        const resolve = pending.get(id)!;
        pending.delete(id);
        resolve(parsed);
      }
    }
  });
  const request = (id: number, method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} (id=${id})`));
      }, 10_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`,
      );
    });
  const notify = (method: string, params?: unknown) => {
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })}\n`,
    );
  };
  const close = () =>
    new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.stdin.end();
    });
  return { child, request, notify, close };
}

describe("acpMcpStdioBridge", () => {
  it("puts the URL and Bearer token in env, never in args, and adds ELECTRON_RUN_AS_NODE in Electron", () => {
    const bridged = httpMcpServerToStdioBridge(
      {
        type: "http",
        name: "threadlines_room",
        url: "http://127.0.0.1:4321/mcp/room",
        headers: [{ name: "Authorization", value: `Bearer ${SECRET_TOKEN}` }],
      },
      { nodePath: "/opt/node", isElectron: true },
    );
    expect(bridged.name).toBe("threadlines_room");
    expect(bridged.command).toBe("/opt/node");
    expect(bridged.args.join(" ")).not.toContain(SECRET_TOKEN);
    expect(bridged.args.join(" ")).not.toContain("127.0.0.1");
    expect(bridged.env).toEqual([
      { name: ACP_MCP_BRIDGE_URL_ENV, value: "http://127.0.0.1:4321/mcp/room" },
      { name: ACP_MCP_BRIDGE_AUTH_ENV, value: `Bearer ${SECRET_TOKEN}` },
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
    ]);
  });

  it("bridges stdio JSON-RPC to a real Effect McpServer HTTP endpoint and aborts in-flight calls on EOF", async () => {
    let waitStarted = false;
    let waitInterrupted = false;
    const EchoTool = Tool.make("echo", {
      description: "Echoes text",
      parameters: Schema.Struct({ text: Schema.String }),
      success: Schema.String,
    });
    const WaitTool = Tool.make("wait_forever", {
      description: "Waits until interrupted",
      success: Schema.String,
    });
    const TestToolkit = Toolkit.make(EchoTool, WaitTool);
    const handlers = TestToolkit.toLayer({
      echo: ({ text }) => Effect.succeed(`echo:${text}`),
      wait_forever: () =>
        Effect.sync(() => {
          waitStarted = true;
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              waitInterrupted = true;
            }),
          ),
        ),
    });

    const authMiddleware = HttpRouter.middleware()(
      Effect.succeed(
        (handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>) =>
          Effect.gen(function* () {
            const req = yield* HttpServerRequest.HttpServerRequest;
            if (readBearerToken(req) !== SECRET_TOKEN) {
              return HttpServerResponse.empty({ status: 401 });
            }
            return normalizeMcpHttpResponse(yield* handler);
          }),
      ),
    ).layer;

    const routes = McpServer.toolkit(TestToolkit).pipe(
      Layer.provide(handlers),
      Layer.provideMerge(
        McpServer.layerHttp({
          name: "bridge-test",
          version: "1",
          path: "/mcp/room",
          protocols: [McpProtocol.v2025_06_18],
        }).pipe(Layer.provide(authMiddleware)),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.fresh(routes).pipe(HttpRouter.serve, Layer.build);
          const server = yield* HttpServer.HttpServer;
          const port = (server.address as NetAddress.InetAddress).port;
          const bridged = httpMcpServerToStdioBridge({
            type: "http",
            name: "threadlines_room",
            url: `http://127.0.0.1:${port}/mcp/room`,
            headers: [{ name: "Authorization", value: `Bearer ${SECRET_TOKEN}` }],
          });

          yield* Effect.promise(async () => {
            const proc = spawnBridge(bridged);
            try {
              // 1. Unsupported protocol probe (like agy's server/discover) returns JSON-RPC error cleanly.
              const discover = await proc.request(1, "server/discover", {});
              expect(discover.error).toBeDefined();

              // 2. Full MCP handshake + tools/list + tools/call.
              const init = await proc.request(2, "initialize", {
                protocolVersion: "2025-11-25",
                capabilities: {},
                clientInfo: { name: "test-agent", version: "1.0.0" },
              });
              expect((init.result as { protocolVersion?: string }).protocolVersion).toBe(
                "2025-06-18",
              );

              proc.notify("notifications/initialized", {});

              const listed = await proc.request(3, "tools/list", {});
              const toolNames = (listed.result as { tools: Array<{ name: string }> }).tools
                .map((tool) => tool.name)
                .toSorted();
              expect(toolNames).toEqual(["echo", "wait_forever"]);

              // 3. Concurrency: start a blocking call and run a fast call alongside it.
              proc.child.stdin.write(
                `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "wait_forever", arguments: {} } })}\n`,
              );
              for (let waited = 0; waited < 5_000 && !waitStarted; waited += 20) {
                await new Promise((r) => setTimeout(r, 20));
              }
              expect(waitStarted).toBe(true);

              const echoed = await proc.request(5, "tools/call", {
                name: "echo",
                arguments: { text: "hello" },
              });
              expect(JSON.stringify(echoed.result)).toContain("echo:hello");

              // 4. Closing stdin aborts the in-flight wait_forever call and exits cleanly.
              const exitCode = await proc.close();
              expect(exitCode).toBe(0);
              for (let waited = 0; waited < 5_000 && !waitInterrupted; waited += 20) {
                await new Promise((r) => setTimeout(r, 20));
              }
              expect(waitInterrupted).toBe(true);
            } finally {
              if (proc.child.exitCode === null) proc.child.kill();
            }
          });
        }),
      ).pipe(Effect.provide(NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0 }))),
    );
  });
});

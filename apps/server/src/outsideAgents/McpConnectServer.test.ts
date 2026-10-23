import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { OutsideAgentConnectionId, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as NodeHttp from "node:http";
import { describe, expect, it } from "vite-plus/test";

import { mcpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBootstrap } from "../orchestration/Services/ThreadBootstrap.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as McpConnectServer from "./McpConnectServer.ts";
import { OutsideAgentConnections } from "./OutsideAgentConnections.ts";
import { OutsideAgentRequests } from "./OutsideAgentRequests.ts";

const SEE = OutsideAgentConnectionId.make("connection-see");
const START = OutsideAgentConnectionId.make("connection-start");

/**
 * Two live connections: `tlc1.see` may see threads, `tlc1.start` may start
 * them. A token is good only for the resource it was issued for.
 */
const connections = Layer.succeed(OutsideAgentConnections, {
  authenticate: ({ token, resource }) =>
    Effect.succeed(
      !resource.startsWith("http://127.0.0.1:")
        ? null
        : token === "tlc1.see"
          ? { connectionId: SEE, name: "Gemini CLI" }
          : token === "tlc1.start"
            ? { connectionId: START, name: "Claude Code" }
            : null,
    ),
  grant: (connectionId) =>
    Effect.succeed({
      connectionId,
      name: connectionId === SEE ? "Gemini CLI" : "Claude Code",
      access: connectionId === SEE ? ("see" as const) : ("start" as const),
      maxRuntimeMode: "approval-required" as const,
      projectIds: null,
    }),
});

const unused = () => Effect.die("not used by this test");

/** What the tools read; nothing here starts or sends. */
const stubs = Layer.mergeAll(
  connections,
  Layer.succeed(OrchestrationEngineService, {
    dispatch: unused,
    getCommandReceipt: unused,
    subscribeDomainEvents: Effect.succeed(Stream.empty),
  } as never),
  Layer.succeed(ProjectionSnapshotQuery, {
    getShellSnapshot: () =>
      Effect.succeed({ snapshotSequence: 0, projects: [], threads: [], updatedAt: "" }),
    getThreadShellById: () => Effect.succeed(Option.none()),
  } as never),
  Layer.succeed(ThreadBootstrap, { runTurnStart: unused, startChild: unused } as never),
  Layer.succeed(ProviderRegistry, { getProviders: Effect.succeed([]) } as never),
  Layer.succeed(GitVcsDriver, {} as never),
  Layer.succeed(OutsideAgentRequests, {} as never),
  ServerSettingsService.layerTest(),
);

/** A request with every header as given (fetch won't send a Host of our choosing). */
const request = (
  port: number,
  headers: Record<string, string>,
  body: unknown,
): Promise<{
  readonly status: number;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}> =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const outgoing = NodeHttp.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp/connect",
        method: "POST",
        headers: {
          host: `127.0.0.1:${port}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(payload),
          ...headers,
        },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(payload);
  });

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

/** Opens a session with `token` and runs one more request in it. */
const inSession = async (port: number, token: string, body: unknown) => {
  const auth = { authorization: `Bearer ${token}` };
  const opened = await request(port, auth, initialize);
  const session = String(opened.headers["mcp-session-id"] ?? "");
  const inside = { ...auth, "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" };
  await request(port, inside, { jsonrpc: "2.0", method: "notifications/initialized" });
  const response = await request(port, inside, body);
  return JSON.parse(response.body) as { readonly result: Record<string, unknown> };
};

const withServer = <A>(test: (port: number) => Promise<A>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* McpConnectServer.layer.pipe(Layer.provide(stubs), HttpRouter.serve, Layer.build);
        const server = yield* HttpServer.HttpServer;
        const port = (server.address as HttpServer.TcpAddress).port;
        return yield* Effect.promise(() => test(port));
      }),
    ).pipe(Effect.provide(NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0 }))),
  );

describe("/mcp/connect", () => {
  it("refuses every credential but an outside agent's token, pointing at the sign-in", async () => {
    const results = await withServer(async (port) => {
      // An agent session's own token (the room and browser tools take it).
      const registry = await Effect.runPromise(
        mcpSessionRegistry.credentialFor({
          sessionKey: ThreadId.make("thread-1"),
          browser: true,
          room: true,
        }),
      );
      const refused = {
        none: await request(port, {}, initialize),
        cookie: await request(port, { cookie: "threadlines_session=owner" }, initialize),
        ownerBearer: await request(
          port,
          { authorization: "Bearer owner-session-token" },
          initialize,
        ),
        registry: await request(port, { authorization: `Bearer ${registry.token}` }, initialize),
      };
      await Effect.runPromise(
        mcpSessionRegistry.revoke(ThreadId.make("thread-1"), registry.generation),
      );
      return { port, refused };
    });
    for (const response of Object.values(results.refused)) {
      expect(response.status).toBe(401);
      expect(response.headers["www-authenticate"]).toBe(
        `Bearer resource_metadata="http://127.0.0.1:${results.port}/.well-known/oauth-protected-resource/mcp/connect"`,
      );
    }
  });

  it("answers only on this computer, under a loopback Host, with no proxy between", async () => {
    const statuses = await withServer(async (port) => {
      const auth = { authorization: "Bearer tlc1.start" };
      return {
        rebound: (await request(port, { ...auth, host: `evil.example:${port}` }, initialize))
          .status,
        otherPort: (await request(port, { ...auth, host: "127.0.0.1:9" }, initialize)).status,
        proxied: (await request(port, { ...auth, "x-forwarded-for": "10.0.0.8" }, initialize))
          .status,
        // A token issued for 127.0.0.1 isn't good for localhost.
        otherName: (await request(port, { ...auth, host: `localhost:${port}` }, initialize)).status,
        // A web page can't call it, token or not.
        browser: (await request(port, { ...auth, origin: "https://evil.example" }, initialize))
          .status,
        good: (await request(port, auth, initialize)).status,
      };
    });
    expect(statuses).toEqual({
      rebound: 421,
      otherPort: 421,
      proxied: 421,
      otherName: 401,
      browser: 403,
      good: 200,
    });
  });

  it("lists what the live grant allows, and refuses a start from a See connection anyway", async () => {
    const result = await withServer(async (port) => ({
      see: await inSession(port, "tlc1.see", { jsonrpc: "2.0", id: 2, method: "tools/list" }),
      start: await inSession(port, "tlc1.start", { jsonrpc: "2.0", id: 2, method: "tools/list" }),
      call: await inSession(port, "tlc1.see", {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "thread_start", arguments: { project: "app", prompt: "Go" } },
      }),
    }));
    const names = (listed: { readonly result: Record<string, unknown> }) =>
      (listed.result.tools as Array<{ readonly name: string }>).map((tool) => tool.name).toSorted();
    expect(names(result.see)).toEqual([
      "agents",
      "projects",
      "thread_read",
      "thread_wait",
      "threads_list",
    ]);
    expect(names(result.start)).toEqual([
      "agents",
      "projects",
      "thread_read",
      "thread_send",
      "thread_start",
      "thread_stop",
      "thread_wait",
      "threads_list",
    ]);
    expect(result.call.result.isError).toBe(false);
    expect(result.call.result.structuredContent).toMatchObject({ outcome: "not_allowed" });
  });
});

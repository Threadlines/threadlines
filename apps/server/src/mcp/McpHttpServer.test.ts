import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { SideTurnId, ThreadId, ThreadParticipantId } from "@threadlines/contracts";
import { participantSessionKey, sideSessionKey } from "@threadlines/shared/threadParticipants";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import * as NodeHttp from "node:http";
import { describe, expect, it } from "vitest";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PreviewAutomationBroker from "../preview/PreviewAutomationBroker.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import { normalizeMcpHttpResponse } from "./McpHttpServer.ts";
import * as McpRoomServer from "./McpRoomServer.ts";
import { makeMcpSessionRegistry, mcpSessionRegistry } from "./McpSessionRegistry.ts";
import { ROOM_TOOL_NAMES } from "./roomToolAccess.ts";

/**
 * The whole browser feature hung on this.
 *
 * A JSON-RPC notification has no reply, and the transport answered 200 with
 * `content-type: application/json` and nothing in the body. Codex believed the
 * content type, tried to parse an empty document, failed with "EOF while
 * parsing a value", and gave up on the handshake -- registering the server with
 * zero tools. Every browser tool was then missing, and the model told the user
 * the in-app browser was unavailable, which was true and impossible to act on.
 */
describe("normalizeMcpHttpResponse", () => {
  it("turns an empty 200 into 202, because there is nothing to parse", () => {
    const normalized = normalizeMcpHttpResponse(HttpServerResponse.empty({ status: 200 }));

    expect(normalized.status).toBe(202);
  });

  it("leaves a response that actually has a body alone", () => {
    // tools/list is the one that matters: turning that into a 202 would break
    // the handshake in the opposite direction.
    const normalized = normalizeMcpHttpResponse(
      HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    );

    expect(normalized.status).toBe(200);
  });

  it("leaves other statuses alone even when they are empty", () => {
    // A 401 carries meaning in its status; promoting it to 202 would say the
    // opposite of what happened.
    for (const status of [204, 401, 404, 500]) {
      expect(normalizeMcpHttpResponse(HttpServerResponse.empty({ status })).status).toBe(status);
    }
  });
});

const THREAD = ThreadId.make("0f8f5a52-4d0e-4c1b-9d56-1e7c1f9b7a01");
const AGENT = ThreadParticipantId.make("6f1c9a3e-2b7d-4a55-8e0f-9c3d2b1a0e44");
const SIDE_TURN = SideTurnId.make("b2c4d6e8-1a3b-4c5d-8e9f-0a1b2c3d4e5f");

describe("McpSessionRegistry", () => {
  it("gives simultaneous provider runtimes separate agent identities", async () => {
    const registry = makeMcpSessionRegistry();
    const request = { sessionKey: THREAD, browser: true, room: false };
    const first = await Effect.runPromise(registry.credentialFor(request));
    const second = await Effect.runPromise(registry.credentialFor(request));

    expect(second.token).not.toBe(first.token);
    const firstScope = await Effect.runPromise(registry.resolve(first.token));
    const secondScope = await Effect.runPromise(registry.resolve(second.token));
    expect(firstScope?.threadId).toBe(THREAD);
    expect(secondScope?.threadId).toBe(THREAD);
    expect(secondScope?.agentId).not.toBe(firstScope?.agentId);
  });

  it("never lets the late stop of a replaced runtime revoke its successor", async () => {
    const registry = makeMcpSessionRegistry();
    const key = participantSessionKey(THREAD, AGENT);
    const old = await Effect.runPromise(
      registry.credentialFor({ sessionKey: key, browser: true, room: true }),
    );
    const replacement = await Effect.runPromise(
      registry.credentialFor({ sessionKey: key, browser: true, room: true }),
    );

    await Effect.runPromise(registry.revoke(key, old.generation));

    expect(await Effect.runPromise(registry.resolve(old.token))).toBeNull();
    const scope = await Effect.runPromise(registry.resolve(replacement.token));
    expect(scope?.threadId).toBe(THREAD);
    expect(scope?.participantId).toBe(AGENT);

    await Effect.runPromise(registry.revoke(key, replacement.generation));
    expect(await Effect.runPromise(registry.resolve(replacement.token))).toBeNull();
  });

  it("scopes a side runtime to its side turn, never the browser, and its kind's room tools", async () => {
    const registry = makeMcpSessionRegistry();
    const key = sideSessionKey(THREAD, SIDE_TURN, AGENT);
    const scopeOf = async (sideKind: "ask" | "review") => {
      const credential = await Effect.runPromise(
        // Asking for the browser changes nothing: a side runtime never gets it.
        registry.credentialFor({ sessionKey: key, browser: true, room: true, sideKind }),
      );
      return Effect.runPromise(registry.resolve(credential.token));
    };

    const answerer = await scopeOf("ask");
    expect(answerer?.threadId).toBe(THREAD);
    expect(answerer?.participantId).toBe(AGENT);
    expect(answerer?.side).toEqual({ sideTurnId: SIDE_TURN, kind: "ask" });
    expect(answerer?.browser).toBe(false);
    expect([...(answerer?.roomTools ?? [])].toSorted()).toEqual(["room_diff", "room_history"]);

    const reviewer = await scopeOf("review");
    expect(reviewer?.browser).toBe(false);
    expect([...(reviewer?.roomTools ?? [])]).toEqual(["room_diff"]);
  });
});

// ---------------------------------------------------------------------------
// The two endpoints, served for real.
// ---------------------------------------------------------------------------

const unused = () => Effect.die("not used by this test");

/** A room with one added agent, as the projection would return it. */
const ROOM_THREAD = {
  id: THREAD,
  modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
  participants: [
    {
      id: AGENT,
      handle: "Opus 5.5",
      modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      joinedAt: "2026-09-27T10:00:00.000Z",
      leftAt: null,
    },
  ],
  session: null,
  sideTurn: null,
  messages: [],
};

/** The room server's dependencies: only the thread read is reached here. */
const RoomServerStubs = Layer.mergeAll(
  Layer.succeed(OrchestrationEngineService, {
    readEvents: () => Effect.die("not used by this test") as never,
    dispatch: unused,
    getCommandReceipt: unused,
    streamDomainEvents: Effect.die("not used by this test") as never,
    subscribeDomainEvents: unused(),
  } as never),
  Layer.succeed(ProjectionSnapshotQuery, {
    getThreadDetailById: () => Effect.succeed(Option.some(ROOM_THREAD)),
  } as never),
  Layer.succeed(ProviderInstanceRegistry, {
    getInstance: () => Effect.succeed(undefined),
  } as never),
  Layer.succeed(GitVcsDriver, {} as never),
  PreviewAutomationBroker.layer,
);

/** Serve `routes` on a loopback port for the rest of the enclosing scope. */
const serve = <A, E>(routes: Layer.Layer<A, E, HttpRouter.HttpRouter>) =>
  Effect.gen(function* () {
    yield* routes.pipe(HttpRouter.serve, Layer.build);
    const server = yield* HttpServer.HttpServer;
    return `http://127.0.0.1:${(server.address as HttpServer.TcpAddress).port}`;
  });

const onLoopback = Effect.provide(NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0 }));

const post = (url: string, token: string, body: unknown, session?: string, signal?: AbortSignal) =>
  fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session !== undefined
        ? { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }
        : {}),
    },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });

/** Initialize an MCP session; its id, or the refusal's status. */
const openSession = async (url: string, token: string) => {
  const response = await post(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    },
  });
  if (response.status !== 200) {
    return { status: response.status } as const;
  }
  const session = response.headers.get("mcp-session-id") ?? "";
  await post(url, token, { jsonrpc: "2.0", method: "notifications/initialized" }, session);
  return { status: 200, session } as const;
};

const listTools = async (url: string, token: string) => {
  const opened = await openSession(url, token);
  if (!("session" in opened)) {
    return opened;
  }
  const response = await post(
    url,
    token,
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    opened.session,
  );
  const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
  return { status: 200, tools: body.result.tools.map((tool) => tool.name).toSorted() } as const;
};

/** Poll until `done` holds, for at most five seconds. */
const waitFor = async (done: () => boolean) => {
  for (let waited = 0; waited < 5_000 && !done(); waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Call one tool in a fresh session; its result. */
const callTool = async (url: string, token: string, name: string) => {
  const opened = await openSession(url, token);
  if (!("session" in opened)) throw new Error(`refused: ${opened.status}`);
  const response = await post(
    url,
    token,
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name, arguments: {} } },
    opened.session,
  );
  const body = (await response.json()) as {
    result: { isError: boolean; structuredContent: Record<string, unknown> };
  };
  return body.result;
};

describe("MCP endpoints", () => {
  it("lists only its own tools on each endpoint, and keeps side runtimes off the browser", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = yield* serve(
            Layer.mergeAll(McpHttpServer.layer, McpRoomServer.layer).pipe(
              Layer.provide(RoomServerStubs),
            ),
          );
          const main = yield* mcpSessionRegistry.credentialFor({
            sessionKey: THREAD,
            browser: true,
            room: true,
          });
          const reviewer = yield* mcpSessionRegistry.credentialFor({
            sessionKey: sideSessionKey(THREAD, SIDE_TURN, AGENT),
            browser: false,
            room: true,
            sideKind: "review",
          });
          const browserOnly = yield* mcpSessionRegistry.credentialFor({
            sessionKey: participantSessionKey(THREAD, AGENT),
            browser: true,
            room: false,
          });

          const result = yield* Effect.promise(async () => ({
            browser: await listTools(`${base}/mcp`, main.token),
            room: await listTools(`${base}/mcp/room`, main.token),
            reviewerOnBrowser: await openSession(`${base}/mcp`, reviewer.token),
            // The screenshot is registered by hand, outside the toolkit; the
            // refusal comes before any tool is looked at.
            reviewerScreenshot: (
              await post(`${base}/mcp`, reviewer.token, {
                jsonrpc: "2.0",
                id: 3,
                method: "tools/call",
                params: { name: "browser_screenshot", arguments: {} },
              })
            ).status,
            reviewerOnRoom: await openSession(`${base}/mcp/room`, reviewer.token),
            browserOnlyOnRoom: await openSession(`${base}/mcp/room`, browserOnly.token),
            // Handlers learn who called from the credential, not the model.
            agents: await callTool(`${base}/mcp/room`, main.token, "room_agents"),
            reviewerAgents: await callTool(`${base}/mcp/room`, reviewer.token, "room_agents"),
          }));

          expect(result.browser.status).toBe(200);
          const browserTools = "tools" in result.browser ? result.browser.tools : [];
          expect(browserTools).toContain("browser_screenshot");
          expect(browserTools.every((name) => name.startsWith("browser_"))).toBe(true);
          expect("tools" in result.room ? result.room.tools : []).toEqual(
            [...ROOM_TOOL_NAMES].toSorted(),
          );
          expect(result.reviewerOnBrowser.status).toBe(401);
          expect(result.reviewerScreenshot).toBe(401);
          expect(result.reviewerOnRoom.status).toBe(200);
          expect(result.browserOnlyOnRoom.status).toBe(401);
          expect(result.agents.isError).toBe(false);
          expect(
            (result.agents.structuredContent.agents as Array<{ key: string; you: boolean }>).map(
              (agent) => [agent.key, agent.you],
            ),
          ).toEqual([
            ["primary", true],
            [AGENT, false],
          ]);
          expect(result.reviewerAgents.isError).toBe(false);
          expect(result.reviewerAgents.structuredContent.outcome).toBe("refused");

          yield* mcpSessionRegistry.revoke(THREAD, main.generation);
          yield* mcpSessionRegistry.revoke(
            sideSessionKey(THREAD, SIDE_TURN, AGENT),
            reviewer.generation,
          );
          yield* mcpSessionRegistry.revoke(
            participantSessionKey(THREAD, AGENT),
            browserOnly.generation,
          );
        }),
      ).pipe(onLoopback),
    );
  });

  /**
   * Room asks wait minutes for an answer inside a tool call, and a request is
   * stopped only when its last waiter leaves. That needs the HTTP server to
   * interrupt a tool handler whose client went away.
   */
  it("interrupts a tool handler when its client drops the call", async () => {
    let interrupted = false;
    let started = false;
    const WaitTool = Tool.make("wait", { success: Schema.String });
    const WaitToolkit = Toolkit.make(WaitTool);
    const handlers = WaitToolkit.toLayer({
      wait: () =>
        Effect.sync(() => {
          started = true;
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        ),
    });
    const routes = McpServer.toolkit(WaitToolkit).pipe(
      Layer.provide(handlers),
      Layer.provideMerge(
        McpServer.layerHttp({
          name: "wait",
          version: "1",
          path: "/wait",
          protocols: [McpProtocol.v2025_06_18],
        }),
      ),
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const base = yield* serve(Layer.fresh(routes));
          yield* Effect.promise(async () => {
            const opened = await openSession(`${base}/wait`, "unused");
            if (!("session" in opened)) throw new Error("no session");
            const abort = new AbortController();
            const call = post(
              `${base}/wait`,
              "unused",
              {
                jsonrpc: "2.0",
                id: 9,
                method: "tools/call",
                params: { name: "wait", arguments: {} },
              },
              opened.session,
              abort.signal,
            ).catch(() => undefined);
            await waitFor(() => started);
            abort.abort();
            await call;
            await waitFor(() => interrupted);
          });
        }),
      ).pipe(onLoopback),
    );

    expect(started).toBe(true);
    expect(interrupted).toBe(true);
  });
});

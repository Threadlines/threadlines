import {
  RELAY_ASSISTANT_FRAME_MAX_BYTES,
  type RelayAssistantRequestFrame,
} from "@threadlines/contracts/relayAssistants";
import { describe, expect, it } from "vite-plus/test";

import { makeTestSql } from "../testSql.ts";
import { OFFLINE_TEXT } from "./answers.ts";
import {
  AssistantDoor,
  type AssistantDoorRequest,
  type AssistantDoorSocket,
  type AssistantDoorState,
  parseHostFrame,
} from "./door.ts";
import { AssistantHostCore } from "./hostAssistants.ts";

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const ORIGIN = "https://connect.test";

function makeDoor(options: { readonly timeoutMs?: number; readonly maxInFlight?: number } = {}) {
  const core = new AssistantHostCore(makeTestSql());
  let next = 0;
  const door = new AssistantDoor(core, {
    ...options,
    newId: () => `request-${(next += 1)}`,
  });
  return { core, door };
}

/** A computer's socket that keeps every frame the relay sends it. */
function fakeSocket(socketId = "socket-1") {
  const sent: RelayAssistantRequestFrame[] = [];
  let open = true;
  const socket: AssistantDoorSocket = {
    socketId,
    send(text) {
      if (!open) throw new Error("closed");
      sent.push(JSON.parse(text) as RelayAssistantRequestFrame);
    },
  };
  return { socket, sent, close: () => (open = false) };
}

function state(overrides: Partial<AssistantDoorState> = {}): AssistantDoorState {
  return {
    now: T0,
    origin: ORIGIN,
    resource: `${ORIGIN}/mcp`,
    dailyRequests: 20_000,
    socket: null,
    relayBusy: false,
    uncommittedRequests: 0,
    onForwarded: () => undefined,
    ...overrides,
  };
}

function mcpRequest(body: unknown, connectionId = "conn-1"): AssistantDoorRequest {
  return {
    route: "mcp",
    connectionId,
    credential: "tlaa1.secret-credential",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

const toolCall = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "thread_list" } };

describe("the assistants door while the computer is offline", () => {
  it("answers a tool call with a tool error the model reads, and nothing about the computer", async () => {
    const { door } = makeDoor();
    const answer = await door.request(mcpRequest(toolCall), state());
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: OFFLINE_TEXT }], isError: true },
    });
    expect(OFFLINE_TEXT).toBe(
      "Your Threadlines computer is offline (asleep, or Threadlines is closed). Try again later.",
    );
  });

  it("answers other methods, batches and junk with 503, and /token with temporarily_unavailable", async () => {
    const { door } = makeDoor();
    const list = await door.request(
      mcpRequest({ jsonrpc: "2.0", id: "a", method: "tools/list" }),
      state(),
    );
    expect(list.status).toBe(503);
    expect(JSON.parse(list.body)).toEqual({
      jsonrpc: "2.0",
      id: "a",
      error: { code: -32000, message: OFFLINE_TEXT },
    });
    for (const body of [JSON.stringify([toolCall]), "not json"]) {
      const answer = await door.request(mcpRequest(body), state());
      expect(answer.status).toBe(503);
      expect(JSON.parse(answer.body).id).toBeNull();
    }

    const token = await door.request(
      { route: "token", connectionId: "conn-1", credential: "tlar1.x", headers: {}, body: "" },
      state(),
    );
    expect(token.status).toBe(503);
    expect(token.headers["retry-after"]).toBe("60");
    expect(JSON.parse(token.body)).toEqual({ error: "temporarily_unavailable" });
  });

  it("refuses a removed connection with 401 even while the computer is offline", async () => {
    const { core, door } = makeDoor();
    core.revoke(["conn-1"], T0);
    const answer = await door.request(mcpRequest(toolCall), state());
    expect(answer.status).toBe(401);
    expect(answer.headers["www-authenticate"]).toBe(
      `Bearer error="invalid_token", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    const token = await door.request(
      { route: "token", connectionId: "conn-1", credential: "tlar1.x", headers: {}, body: "" },
      state(),
    );
    expect(token.status).toBe(400);
    expect(JSON.parse(token.body)).toEqual({ error: "invalid_grant" });
    // Another connection of the same computer still gets the generic offline answer.
    expect((await door.request(mcpRequest(toolCall, "conn-2"), state())).status).toBe(200);
  });
});

describe("the assistants door with the computer there", () => {
  it("matches each answer to its request by id, whatever order they come back in", async () => {
    const { door } = makeDoor();
    const { socket, sent } = fakeSocket();
    let forwarded = 0;
    const online = state({ socket, onForwarded: () => (forwarded += 1) });
    const first = door.request(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" }), online);
    const second = door.request(mcpRequest(toolCall), online);
    expect(sent.map((frame) => frame.id)).toEqual(["request-1", "request-2"]);
    expect(sent[1]).toMatchObject({
      type: "request",
      route: "mcp",
      credential: "tlaa1.secret-credential",
      resource: `${ORIGIN}/mcp`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(toolCall),
    });
    expect(forwarded).toBe(2);

    door.resolve("socket-1", {
      type: "response",
      id: "request-2",
      status: 200,
      headers: { "Content-Type": "application/json", "Set-Cookie": "x=1", "mcp-session-id": "s" },
      body: '{"second":true}',
    });
    door.resolve("socket-1", {
      type: "response",
      id: "request-1",
      status: 202,
      headers: {},
      body: "",
    });
    const [one, two] = await Promise.all([first, second]);
    expect(one.status).toBe(202);
    expect(two).toEqual({
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "s" },
      body: '{"second":true}',
    });
    expect(door.inFlight()).toBe(0);
  });

  it("fails requests in flight with 502 when their socket goes, and ignores another socket's answers", async () => {
    const { door } = makeDoor();
    const { socket } = fakeSocket("old");
    const pending = door.request(mcpRequest(toolCall), state({ socket }));
    // A newer socket can't answer for the one the request went out on.
    expect(
      door.resolve("new", {
        type: "response",
        id: "request-1",
        status: 200,
        headers: {},
        body: "",
      }),
    ).toBe(false);
    door.dropSocket("old");
    const answer = await pending;
    expect(answer.status).toBe(502);
    expect(JSON.parse(answer.body)).toMatchObject({ jsonrpc: "2.0", id: 7 });
  });

  it("times out a computer that never answers with 504, and a late answer finds nothing", async () => {
    const { door } = makeDoor({ timeoutMs: 20 });
    const { socket } = fakeSocket();
    const answer = await door.request(mcpRequest(toolCall), state({ socket }));
    expect(answer.status).toBe(504);
    expect(JSON.parse(answer.body).error.message).toContain("didn't answer in time");
    expect(
      door.resolve("socket-1", {
        type: "response",
        id: "request-1",
        status: 200,
        headers: {},
        body: "",
      }),
    ).toBe(false);
  });

  it("holds the daily allowance and the in-flight cap", async () => {
    const { core, door } = makeDoor({ maxInFlight: 1 });
    const { socket } = fakeSocket();
    core.commitRequests(T0, 9);
    const over = await door.request(
      mcpRequest(toolCall),
      state({ socket, dailyRequests: 10, uncommittedRequests: 1 }),
    );
    expect(over.status).toBe(429);
    expect(Number(over.headers["retry-after"])).toBe(12 * 60 * 60);
    // Refreshes count against the same allowance.
    const overToken = await door.request(
      { route: "token", connectionId: "conn-1", credential: "tlar1.x", headers: {}, body: "" },
      state({ socket, dailyRequests: 10, uncommittedRequests: 1 }),
    );
    expect(overToken.status).toBe(503);
    expect(JSON.parse(overToken.body)).toMatchObject({ error: "temporarily_unavailable" });

    const first = door.request(mcpRequest(toolCall), state({ socket }));
    const busy = await door.request(mcpRequest(toolCall), state({ socket }));
    expect(busy.status).toBe(503);
    door.dropSocket("socket-1");
    await first;
  });
});

describe("assistant socket frames from the computer", () => {
  it("takes the contract's frames as JSON text, at most 768 KiB", () => {
    expect(
      parseHostFrame(
        JSON.stringify({
          type: "signin.decision",
          signInId: "3.abc",
          decision: "allow",
          authorizationCode: "tlac1.x",
        }),
      ),
    ).toMatchObject({ ok: true, frame: { decision: "allow" } });
    expect(parseHostFrame(new ArrayBuffer(4))).toEqual({ ok: false, reason: "binary" });
    expect(
      parseHostFrame(
        JSON.stringify({ type: "signin.decision", signInId: "3.abc", decision: "allow" }),
      ),
    ).toEqual({ ok: false, reason: "invalid" });
    const huge = JSON.stringify({
      type: "response",
      id: "r",
      status: 200,
      headers: {},
      body: "x".repeat(RELAY_ASSISTANT_FRAME_MAX_BYTES),
    });
    expect(parseHostFrame(huge)).toEqual({ ok: false, reason: "too-large" });
  });
});

import { ThreadId } from "@threadlines/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { afterAll, assert, beforeAll, describe, it } from "vite-plus/test";

import { mcpSessionRegistry } from "../../src/mcp/McpSessionRegistry.ts";
import { calls, everyCall, firstBefore, never, TOOL_USE_CASES } from "./cases.ts";
import { makeGatedCodexSpawner } from "./codexGate.ts";
import { EVAL_SERVER_SETTINGS } from "./runCase.ts";
import { startEvalToolServer, type EvalToolServer } from "./toolServer.ts";

/** Speaks MCP over HTTP to the room endpoint as an agent's runtime would. */
async function mcpSession(port: number, token: string | null) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
  };
  let id = 0;
  const post = async (method: string, params: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp/room`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const session = response.headers.get("mcp-session-id");
    if (session !== null) headers["mcp-session-id"] = session;
    headers["mcp-protocol-version"] = "2025-06-18";
    return {
      status: response.status,
      body: (response.ok ? await response.json() : null) as {
        readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> };
      } | null,
    };
  };
  return { post };
}

describe("eval tool server", () => {
  let server: EvalToolServer;
  beforeAll(async () => {
    server = await startEvalToolServer({
      runtimeMode: "full-access",
      serverSettings: EVAL_SERVER_SETTINGS,
    });
  });
  afterAll(() => server.close());

  it("lists an ordinary runtime's tools, as production does, and logs what is called", async () => {
    const credential = await Effect.runPromise(
      mcpSessionRegistry.credentialFor({
        sessionKey: ThreadId.make("thread-eval-tool-server"),
        browser: true,
        room: true,
        pages: false,
        commands: false,
        scheduledRun: false,
        guideOnly: false,
      }),
    );
    const session = await mcpSession(server.port, credential.token);
    await session.post("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    const listed = await session.post("tools/list", {});
    const names = (listed.body?.result.tools ?? []).map((tool) => tool.name);
    assert.include(names, "thread_start");
    assert.include(names, "schedule_create");
    assert.notInclude(names, "scheduled_run_finish", "only a scheduled run's runtime gets it");

    const called = await session.post("tools/call", {
      name: "thread_start",
      arguments: { threads: [{ title: "Docs", prompt: "Write docs." }] },
    });
    assert.equal(called.status, 200);
    assert.deepEqual(server.calls.at(-1), {
      tool: "thread_start",
      input: { threads: [{ title: "Docs", prompt: "Write docs." }] },
    });
  });

  it("refuses a caller without a credential", async () => {
    const session = await mcpSession(server.port, null);
    const answer = await session.post("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    assert.equal(answer.status, 401);
  });
});

describe("tool-use checks", () => {
  const run = (tools: ReadonlyArray<string>) => ({
    calls: tools.map((tool) => ({ tool, input: { threads: [{}, {}] } })),
    native: [],
    reply: "",
  });

  it("grade the calls a run made", () => {
    assert.isNull(calls("thread_start", { min: 1, max: 1 })(run(["thread_start"])));
    assert.isNotNull(
      calls("thread_start", { min: 1, max: 1 })(run(["thread_start", "thread_start"])),
    );
    assert.isNotNull(never("thread_send")(run(["thread_send"])));
    assert.isNotNull(
      firstBefore("app_guide", "settings_change")(run(["settings_change", "app_guide"])),
    );
    assert.isNull(
      everyCall(
        "thread_start",
        (input) => (input.threads as Array<unknown>).length === 2,
        "x",
      )(run(["thread_start"])),
    );
  });

  it("grade what the reply tells the user about a thread's access", () => {
    const accessCheck = TOOL_USE_CASES.find((entry) => entry.name === "access-ceiling")!.checks[0]!;
    const said = (reply: string) => accessCheck({ calls: [], native: [], reply });
    assert.isNotNull(said("I've started a new thread called Tidy with full access."));
    assert.isNull(said("I started the thread, but it didn't get full access. It runs supervised."));
    assert.isNull(said("I'll check how to start a thread with full access."));
  });

  it("every case has a unique name", () => {
    const names = TOOL_USE_CASES.map((entry) => entry.name);
    assert.equal(new Set(names).size, names.length);
  });
});

describe("Codex session check", () => {
  /** A fake `codex app-server` that answers the session check with `account`. */
  function fakeCodex(account: { type: string }, sent: Array<string>) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    return ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const answer = (message: unknown) =>
          Queue.offerUnsafe(output, encoder.encode(`${JSON.stringify(message)}\n`));
        const results: Record<string, unknown> = {
          "account/read": { account },
          "modelProvider/list": { defaultProviderId: "openai" },
          "mcpServerStatus/list": { data: [] },
        };
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.sync(() => Queue.endUnsafe(output)),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach((chunk: Uint8Array) =>
            Effect.sync(() => {
              for (const line of decoder.decode(chunk).split("\n").filter(Boolean)) {
                const message = JSON.parse(line) as { id?: unknown; method?: string };
                sent.push(message.method ?? "reply");
                if (message.method !== undefined && message.method in results) {
                  answer({ id: message.id, result: results[message.method] });
                } else if (message.method === "thread/start") {
                  answer({ id: message.id, result: { thread: {}, modelProvider: "openai" } });
                }
              }
            }),
          ),
          stdout: Stream.fromQueue(output),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
  }

  const session = (account: { type: string }) =>
    Effect.gen(function* () {
      const sent: Array<string> = [];
      let blocked: string | null = null;
      const spawner = makeGatedCodexSpawner(fakeCodex(account, sent), (reason) => {
        blocked = reason;
      });
      const handle = yield* spawner.spawn(ChildProcess.make("codex", ["app-server"]));
      const write = (message: unknown) =>
        Stream.run(
          Stream.make(new TextEncoder().encode(`${JSON.stringify(message)}\n`)),
          handle.stdin,
        );
      yield* Effect.forkScoped(Stream.runDrain(handle.stdout));
      yield* write({ id: 1, method: "initialize", params: {} });
      yield* write({ method: "initialized" });
      yield* write({ id: 2, method: "thread/start", params: {} });
      const turn = yield* Effect.exit(
        write({ id: 3, method: "turn/start", params: {} }).pipe(Effect.timeout("2 seconds")),
      );
      return { sent, blocked: blocked as string | null, turnSent: turn._tag === "Success" };
    }).pipe(Effect.scoped);

  it("holds the first turn until the session is on a ChatGPT sign-in", async () => {
    const ok = await Effect.runPromise(session({ type: "chatgpt" }));
    assert.isNull(ok.blocked);
    assert.isTrue(ok.turnSent);
    assert.include(ok.sent, "turn/start");

    const apiKey = await Effect.runPromise(session({ type: "apiKey" }));
    assert.match(apiKey.blocked ?? "", /isn't signed in with ChatGPT/);
    assert.isFalse(apiKey.turnSent);
    assert.notInclude(apiKey.sent, "turn/start");
  });
});

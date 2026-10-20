import {
  type McpAppToolResult,
  type OrchestrationThreadShell,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@threadlines/contracts";
import type { McpResourceContent, McpToolUi } from "@threadlines/shared/mcpApps";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { McpAppCallRepositoryLive } from "../persistence/Layers/McpAppCalls.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../provider/Errors.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { fitMcpAppCall, McpApps, layer as McpAppsLayer } from "./McpApps.ts";

const THREAD_ID = ThreadId.make("thread-mcp-apps");
const INSTANCE = ProviderInstanceId.make("claude");
const VIEW_HTML = "<!doctype html><p>Counter</p>";

/** What the agent's session does, as a test sets it. */
interface FakeSession {
  running: boolean;
  providerThreadId: string;
  runtimeMode: RuntimeMode;
  tools: Map<string, McpToolUi | null>;
  reads: Array<{ server: string; uri: string }>;
  calls: Array<{ tool: string; arguments: Readonly<Record<string, unknown>> }>;
}

const session: FakeSession = {
  running: true,
  providerThreadId: "native-1",
  runtimeMode: "full-access",
  tools: new Map(),
  reads: [],
  calls: [],
};

const adapter = {
  readMcpResource: (_key: ThreadId, input: { server: string; uri: string }) =>
    Effect.sync((): ReadonlyArray<McpResourceContent> => {
      session.reads.push(input);
      return [
        {
          uri: input.uri,
          mimeType: "text/html;profile=mcp-app",
          text: VIEW_HTML,
          _meta: { ui: { csp: { connectDomains: ["https://api.example.com", "*"] } } },
        },
      ];
    }),
  callMcpTool: (
    _key: ThreadId,
    input: { tool: string; arguments: Readonly<Record<string, unknown>> },
  ) =>
    Effect.sync((): McpAppToolResult => {
      session.calls.push(input);
      return { content: [{ type: "text", text: "ok" }], structuredContent: { count: 4 } };
    }),
  readMcpToolUi: (_key: ThreadId, input: { tool: string }) =>
    Effect.succeed(session.tools.has(input.tool) ? session.tools.get(input.tool) : undefined),
} as unknown as ProviderAdapterShape<ProviderAdapterError>;

const testLayer = McpAppsLayer.pipe(
  Layer.provideMerge(McpAppCallRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    Layer.mock(ProviderService)({
      agentSession: (input) =>
        Effect.succeed(
          session.running && input.sessionKey === THREAD_ID
            ? { adapter, sessionKey: input.sessionKey, providerThreadId: session.providerThreadId }
            : null,
        ),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () =>
        Effect.succeed(
          Option.some({
            runtimeMode: session.runtimeMode,
            interactionMode: "default",
          } as OrchestrationThreadShell),
        ),
    }),
  ),
);

const recordCall = (toolCallId: string) =>
  Effect.gen(function* () {
    const apps = yield* McpApps;
    yield* apps.recordCall({
      threadId: THREAD_ID,
      toolCallId,
      participantId: null,
      providerInstanceId: INSTANCE,
      call: {
        server: "probe-apps",
        tool: "show_counter",
        resourceUri: "ui://probe-apps/counter.html",
        arguments: { start: 3 },
        result: {
          content: [{ type: "text", text: "Counter at 3" }],
          structuredContent: { count: 3 },
        },
      },
      fromSideAnswer: false,
      createdAt: "2026-10-20T16:00:00.000Z",
    });
  });

it.layer(testLayer)("McpApps", (it) => {
  it.effect("reads a card's view once, through the agent that made the call", () =>
    Effect.gen(function* () {
      const apps = yield* McpApps;
      session.reads.length = 0;
      yield* recordCall("call-view");
      const first = yield* apps.load({ threadId: THREAD_ID, toolCallId: "call-view" });
      assert.deepStrictEqual(first.arguments, { start: 3 });
      assert.strictEqual(first.view.html, VIEW_HTML);
      // A host the view declared reaches its policy; a bare "*" does not.
      assert.deepStrictEqual(first.view.csp, { connectDomains: ["https://api.example.com"] });
      assert.strictEqual(first.callsAllowed, true);

      // Once the session is gone, the kept view still shows.
      session.running = false;
      const again = yield* apps.load({ threadId: THREAD_ID, toolCallId: "call-view" });
      assert.strictEqual(again.view.html, VIEW_HTML);
      assert.strictEqual(session.reads.length, 1);
      session.running = true;
    }),
  );

  it.effect(
    "runs only tools apps may call, and asks the user unless the agent has full access",
    () =>
      Effect.gen(function* () {
        const apps = yield* McpApps;
        yield* recordCall("call-tools");
        session.calls.length = 0;
        session.tools = new Map<string, McpToolUi | null>([
          ["bump", { resourceUri: null, visibility: ["app"] }],
          ["delete_all", { resourceUri: null, visibility: ["model"] }],
        ]);
        const call = (tool: string, confirmed: boolean) =>
          apps.callTool({ threadId: THREAD_ID, toolCallId: "call-tools", tool, confirmed }).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          );

        // Full access, the same session, a tool for apps: it runs.
        const result = yield* apps.callTool({
          threadId: THREAD_ID,
          toolCallId: "call-tools",
          tool: "bump",
          confirmed: false,
        });
        assert.deepStrictEqual(result.structuredContent, { count: 4 });
        // A tool only the model may call never runs, confirmed or not.
        assert.strictEqual(yield* call("delete_all", true), "not-allowed");
        // A tool whose metadata can't be read is the user's call.
        assert.strictEqual(yield* call("unknown_tool", false), "needs-confirmation");

        session.runtimeMode = "approval-required";
        assert.strictEqual(yield* call("bump", false), "needs-confirmation");
        yield* apps.callTool({
          threadId: THREAD_ID,
          toolCallId: "call-tools",
          tool: "bump",
          confirmed: true,
        });
        session.runtimeMode = "full-access";

        // The same agent in a new session: the user says so first.
        session.providerThreadId = "native-2";
        assert.strictEqual(yield* call("bump", false), "needs-confirmation");
        session.providerThreadId = "native-1";
        // A call recorded while its session could not be found is never known
        // to be this session's.
        session.running = false;
        yield* recordCall("call-unknown-session");
        session.running = true;
        assert.strictEqual(
          yield* apps
            .callTool({
              threadId: THREAD_ID,
              toolCallId: "call-unknown-session",
              tool: "bump",
              confirmed: false,
            })
            .pipe(
              Effect.flip,
              Effect.map((error) => error.reason),
            ),
          "needs-confirmation",
        );

        session.running = false;
        assert.strictEqual(yield* call("bump", true), "session-ended");
        session.running = true;
        assert.deepStrictEqual(
          session.calls.map((entry) => entry.tool),
          ["bump", "bump"],
        );
      }),
  );
});

it("cuts a call too large to keep, input first", () => {
  const big = "x".repeat(600 * 1024);
  const fitted = fitMcpAppCall({
    server: "s",
    tool: "t",
    resourceUri: "ui://s/v",
    arguments: { big },
    result: { content: [{ type: "text", text: "small" }], structuredContent: { count: 1 } },
  });
  assert.strictEqual(fitted.truncated, true);
  assert.strictEqual(fitted.call.arguments, undefined);
  assert.deepStrictEqual(fitted.call.result?.structuredContent, { count: 1 });
});

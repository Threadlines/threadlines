import { ProviderDriverKind, ThreadId } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import { makeAcpNativeLoggers, redactAcpLogCredentials } from "./AcpNativeLogging.ts";

describe("redactAcpLogCredentials", () => {
  it("keeps the browser MCP header but not its token, decoded or raw", () => {
    const sessionNew = {
      cwd: "/repo",
      mcpServers: [
        {
          type: "http",
          name: "threadlines_browser",
          url: "http://127.0.0.1:3773/mcp",
          headers: [{ name: "Authorization", value: "Bearer tl_abc.DEF-123" }],
        },
      ],
    };

    expect(redactAcpLogCredentials(sessionNew)).toEqual({
      ...sessionNew,
      mcpServers: [
        {
          ...sessionNew.mcpServers[0],
          headers: [{ name: "Authorization", value: "Bearer [redacted]" }],
        },
      ],
    });
    // The raw protocol line is logged before it is decoded.
    expect(redactAcpLogCredentials(JSON.stringify(sessionNew))).not.toContain("tl_abc");
  });

  it("redacts stdio-bridge MCP authorization env values, decoded or raw", () => {
    const sessionNew = {
      cwd: "/repo",
      mcpServers: [
        {
          name: "threadlines_room",
          command: "/usr/bin/node",
          args: ["-e", "..."],
          env: [
            { name: "THREADLINES_MCP_URL", value: "http://127.0.0.1:3773/mcp/room" },
            { name: "THREADLINES_MCP_AUTHORIZATION", value: "Bearer tl_secret_xyz" },
          ],
        },
      ],
    };

    const redacted = redactAcpLogCredentials(sessionNew) as typeof sessionNew;
    expect(redacted.mcpServers[0]?.env).toEqual([
      { name: "THREADLINES_MCP_URL", value: "http://127.0.0.1:3773/mcp/room" },
      { name: "THREADLINES_MCP_AUTHORIZATION", value: "[redacted]" },
    ]);
    expect(redactAcpLogCredentials(JSON.stringify(sessionNew))).not.toContain("tl_secret_xyz");
  });

  it("preserves references when nothing requires redaction and still redacts bearer tokens in binary-shaped fields", () => {
    const cleanPrompt = {
      sessionId: "s-1",
      prompt: [
        { type: "text", text: "describe this image" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" },
      ],
    };
    expect(redactAcpLogCredentials(cleanPrompt)).toBe(cleanPrompt);

    const leaked = {
      sessionId: "s-1",
      prompt: [{ type: "image", mimeType: "image/png", data: "Bearer tl_secret_in_data" }],
    };
    expect(redactAcpLogCredentials(leaked)).toEqual({
      sessionId: "s-1",
      prompt: [{ type: "image", mimeType: "image/png", data: "Bearer [redacted]" }],
    });
  });
});

describe("makeAcpNativeLoggers", () => {
  it("drops both raw and Effect-RPC decoded stream chunks when stream fragments are disabled", async () => {
    const written: Array<{ readonly event: { readonly payload: unknown } }> = [];
    const logger: EventNdjsonLogger = {
      filePath: "/tmp/test.log",
      keepsStreamFragments: false,
      write: (event) =>
        Effect.sync(() => {
          written.push(event as { readonly event: { readonly payload: unknown } });
        }),
      close: () => Effect.void,
    };
    const { protocolLogging } = makeAcpNativeLoggers({
      nativeEventLogger: logger,
      provider: ProviderDriverKind.make("antigravity"),
      threadId: ThreadId.make("thread-1"),
    });
    expect(protocolLogging).toBeDefined();

    // Raw JSON-RPC stream chunk split across two pipe reads
    const rawFragment = `${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      },
    })}\n`;
    const splitAt = Math.floor(rawFragment.length / 2);
    await Effect.runPromise(
      protocolLogging!.logger!({
        direction: "incoming",
        stage: "raw",
        payload: rawFragment.slice(0, splitAt),
      }),
    );
    await Effect.runPromise(
      protocolLogging!.logger!({
        direction: "incoming",
        stage: "raw",
        payload: rawFragment.slice(splitAt),
      }),
    );

    // Effect RPC decoded RequestEncoded stream chunk
    await Effect.runPromise(
      protocolLogging!.logger!({
        direction: "incoming",
        stage: "decoded",
        payload: [
          {
            _tag: "Request",
            id: "",
            tag: "session/update",
            payload: {
              sessionId: "s-1",
              update: {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: "thinking" },
              },
            },
            headers: [],
          },
        ],
      }),
    );

    expect(written).toHaveLength(0);

    // Mixed decoded batch strips stream fragments and retains non-fragment updates
    await Effect.runPromise(
      protocolLogging!.logger!({
        direction: "incoming",
        stage: "decoded",
        payload: [
          {
            _tag: "Request",
            id: "",
            tag: "session/update",
            payload: {
              sessionId: "s-1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "drop me" },
              },
            },
            headers: [],
          },
          {
            _tag: "Request",
            id: "",
            tag: "session/update",
            payload: {
              sessionId: "s-1",
              update: { sessionUpdate: "tool_call", toolCallId: "t-1", title: "Run" },
            },
            headers: [],
          },
        ],
      }),
    );
    expect(written).toHaveLength(1);
    const logged = written[0]?.event.payload as {
      readonly payload: ReadonlyArray<{
        readonly payload?: { readonly update?: { readonly sessionUpdate?: string } };
      }>;
    };
    expect(logged.payload).toHaveLength(1);
    expect(logged.payload[0]?.payload?.update?.sessionUpdate).toBe("tool_call");

    // Mixed raw read drops the fragment line and preserves the non-fragment line
    const rawToolLine = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s-1",
        update: { sessionUpdate: "tool_call", toolCallId: "t-2", title: "Read" },
      },
    });
    await Effect.runPromise(
      protocolLogging!.logger!({
        direction: "incoming",
        stage: "raw",
        payload: `${rawFragment}${rawToolLine}\n`,
      }),
    );
    expect(written).toHaveLength(2);
    const loggedRaw = written[1]?.event.payload as { readonly payload: string };
    expect(loggedRaw.payload).toBe(`${rawToolLine}\n`);
  });

  it("returns no loggers when nativeEventLogger is absent", () => {
    expect(
      makeAcpNativeLoggers({
        nativeEventLogger: undefined,
        provider: ProviderDriverKind.make("antigravity"),
        threadId: ThreadId.make("thread-1"),
      }),
    ).toEqual({});
  });
});

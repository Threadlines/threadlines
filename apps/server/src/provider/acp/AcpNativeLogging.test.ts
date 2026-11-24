import { describe, expect, it } from "vite-plus/test";

import { redactAcpLogCredentials } from "./AcpNativeLogging.ts";

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
});

import { describe, expect, it } from "vitest";

import { providerMcpLoginCommand } from "./mcpAuthStatus";

describe("providerMcpLoginCommand", () => {
  it("builds Codex MCP login commands with scopes", () => {
    expect(providerMcpLoginCommand("codex", "supabase", ["read", "write"])).toBe(
      "codex mcp login supabase --scopes read,write",
    );
  });

  it("builds Claude MCP login commands without Codex scopes", () => {
    expect(providerMcpLoginCommand("claudeAgent", "supabase", ["read", "write"])).toBe(
      "claude mcp login supabase",
    );
  });

  it("quotes server names that need shell escaping", () => {
    expect(providerMcpLoginCommand("claudeAgent", "my server")).toBe(
      'claude mcp login "my server"',
    );
  });
});

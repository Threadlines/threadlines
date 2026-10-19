import { describe, expect, it } from "vite-plus/test";

import { identifyPiTool, piToolData, piToolDetail } from "./PiToolItems.ts";

describe("PiToolItems", () => {
  it("names Pi's tools and Threadlines' own tool servers the way the chat words them", () => {
    expect(identifyPiTool("bash").itemType).toBe("command_execution");
    expect(identifyPiTool("powershell").itemType).toBe("command_execution");
    expect(identifyPiTool("write").itemType).toBe("file_change");
    expect(identifyPiTool("mcp__threadlines_browser__browser_click")).toEqual({
      kind: "mcp",
      itemType: "mcp_tool_call",
      title: "MCP tool call",
      mcp: { server: "threadlines_browser", tool: "browser_click" },
    });
    expect(piToolDetail(identifyPiTool("grep"), { pattern: "TODO", path: "src" })).toBe(
      "TODO in src",
    );
  });

  it("takes an edit's counts from Pi's patch, and a shell call's exit code from its result", () => {
    const edit = piToolData({
      name: "edit",
      identity: identifyPiTool("edit"),
      directory: "/repo",
      args: { path: "/repo/e.txt", edits: [] },
      // Recorded from Pi 1.3.0.
      result: {
        details: {
          patch:
            "--- e.txt\n+++ e.txt\n@@ -1,3 +1,4 @@\n line one\n-line two\n+line 2\n+line 2b\n line three\n",
        },
      },
      final: true,
    });
    expect(edit.changes).toEqual([
      {
        path: "e.txt",
        kind: "update",
        diff: expect.stringContaining("@@"),
        additions: 2,
        deletions: 1,
      },
    ]);
    const shell = piToolData({
      name: "bash",
      identity: identifyPiTool("bash"),
      directory: "/repo",
      args: { command: "echo hi" },
      result: { structuredContent: { output: "hi\n", exit_code: 0 } },
      final: true,
    });
    expect(shell.item).toEqual({ command: "echo hi", exitCode: 0 });
  });

  it("counts a write's lines only for a new file", () => {
    const write = (existedBefore: boolean) =>
      piToolData({
        name: "write",
        identity: identifyPiTool("write"),
        directory: "/repo",
        args: { path: "notes.txt", content: "one\ntwo\n" },
        result: { content: [{ type: "text", text: "Successfully wrote" }] },
        final: true,
        existedBefore,
      }).changes;
    expect(write(false)).toEqual([{ path: "notes.txt", kind: "add", additions: 2, deletions: 0 }]);
    // Pi doesn't say what an overwrite replaced.
    expect(write(true)).toEqual([{ path: "notes.txt", kind: "update" }]);
  });
});

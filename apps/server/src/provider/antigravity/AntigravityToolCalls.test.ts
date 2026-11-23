import * as Schema from "effect/Schema";
import * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import {
  type AcpToolCallState,
  makeToolCallState,
  mergeToolCallState,
} from "../acp/AcpRuntimeModel.ts";
import {
  ANTIGRAVITY_TOOL_TEXT_LIMIT,
  antigravityProxiedMcpTool,
  boundAntigravityCommandLine,
  boundAntigravityText,
  normalizeAntigravitySessionUpdate,
  normalizeAntigravityToolCall,
} from "./AntigravityToolCalls.ts";

const decodeNotification = Schema.decodeUnknownSync(EffectAcpSchema.SessionNotification);

const toolUpdate = (fields: Record<string, unknown>) =>
  decodeNotification({
    sessionId: "s",
    update: { sessionUpdate: "tool_call", toolCallId: "call", ...fields },
  });

const wrapper = {
  title: "MCP Tool list_issues",
  kind: "execute",
  rawInput: { ServerName: "github", ToolName: "list_issues", Arguments: { repo: "x/y" } },
} as const;

const state = (data: Record<string, unknown>): AcpToolCallState => ({
  toolCallId: "call",
  kind: "execute",
  command: "rm -rf build",
  data: { kind: "execute", command: "rm -rf build", item: { command: "rm -rf build" }, ...data },
});

describe("Antigravity tool text", () => {
  it("cuts within its limit, marker included, and never in half a character", () => {
    // "😀" is two UTF-16 units; a cut between them would leave half a character.
    const tail = boundAntigravityText(`a😀${"b".repeat(60)}`, 40);
    expect(tail.length).toBeLessThanOrEqual(40);
    expect(tail.startsWith("[Earlier output truncated]")).toBe(true);
    expect(tail.endsWith("b")).toBe(true);
    const head = boundAntigravityCommandLine(`${"c".repeat(20)}😀${"d".repeat(40)}`, 41);
    expect(head.length).toBeLessThanOrEqual(41);
    expect(head).toBe(`${"c".repeat(20)}\n\n[Command truncated]`);
    expect(boundAntigravityText("short")).toBe("short");
  });

  it("keeps every content block valid ACP, whatever its text", () => {
    const big = "x".repeat(70_000);
    const out = normalizeAntigravitySessionUpdate(
      toolUpdate({
        title: "Ran it",
        content: [
          // Text that looks like an image is still text.
          { type: "content", content: { type: "text", text: "data:image/png;base64,AAAA" } },
          ...Array.from({ length: 12 }, () => ({
            type: "content",
            content: { type: "text", text: big },
          })),
          { type: "content", content: { type: "resource", resource: { uri: "f", blob: "AA" } } },
          { type: "content", content: { type: "resource_link", uri: "file:///a", name: big } },
          { type: "content", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
          { type: "diff", path: "/a.ts", oldText: "data:image/png,a", newText: big },
          { type: "terminal", terminalId: "t1" },
        ],
      }),
    );
    // The whole update still decodes, so the core can read what it expects.
    expect(() => decodeNotification(out)).not.toThrow();
    const content = (out.update as { content: ReadonlyArray<Record<string, unknown>> }).content;
    expect(content[0]).toEqual({
      type: "content",
      content: { type: "text", text: "data:image/png;base64,AAAA" },
    });
    for (const entry of content.slice(1, 13)) {
      const text = (entry.content as { text: string }).text;
      expect(text.length).toBeLessThanOrEqual(ANTIGRAVITY_TOOL_TEXT_LIMIT);
    }
    // The binary resource and the image are left out; the edit stays whole.
    expect(content.map((entry) => entry.type)).toEqual([
      ...Array.from({ length: 13 }, () => "content"),
      "content",
      "diff",
      "terminal",
    ]);
    expect(content.at(-2)).toEqual({
      type: "diff",
      path: "/a.ts",
      oldText: "data:image/png,a",
      newText: big,
    });
  });

  it("budgets output fields named like an edit's text, and keeps a long `cmd`'s start", () => {
    const out = normalizeAntigravitySessionUpdate(
      toolUpdate({
        title: "Running make",
        kind: "execute",
        rawInput: { cmd: `make ${"y".repeat(9_000)}` },
        rawOutput: { newText: "z".repeat(9_000) },
      }),
    ).update as { rawInput: { cmd: string }; rawOutput: { newText: string } };
    expect(out.rawInput.cmd.startsWith("make ")).toBe(true);
    expect(out.rawInput.cmd.length).toBeLessThanOrEqual(ANTIGRAVITY_TOOL_TEXT_LIMIT);
    expect(out.rawOutput.newText.length).toBeLessThanOrEqual(ANTIGRAVITY_TOOL_TEXT_LIMIT);
  });
});

describe("Antigravity call_mcp_tool", () => {
  it("is the MCP tool only when the update says so positively", () => {
    expect(antigravityProxiedMcpTool(wrapper)).toEqual({
      server: "github",
      tool: "list_issues",
      arguments: { repo: "x/y" },
    });
    const notWrappers = [
      // A command line beside the names.
      { ...wrapper, rawInput: { ...wrapper.rawInput, CommandLine: "rm -rf build" } },
      { ...wrapper, rawInput: { ...wrapper.rawInput, cmd: "rm -rf build" } },
      // Any other input field.
      { ...wrapper, rawInput: { ...wrapper.rawInput, Cwd: "/" } },
      // Another title, or another kind.
      { ...wrapper, title: "MCP Tool delete_repo" },
      { ...wrapper, title: "Running rm -rf build" },
      { ...wrapper, kind: "edit" },
      { ...wrapper, kind: "other" },
      // An edit's diff or a file location.
      { ...wrapper, content: [{ type: "diff" }] },
      { ...wrapper, locations: [{ path: "/a" }] },
      // Arguments that aren't an object.
      { ...wrapper, rawInput: { ...wrapper.rawInput, Arguments: "rm -rf build" } },
    ];
    for (const update of notWrappers) expect(antigravityProxiedMcpTool(update)).toBeUndefined();
  });

  it("leaves a command that names an MCP tool a command, and drops the MCP look on conflict", () => {
    const spoof = state({
      rawInput: { ServerName: "github", ToolName: "list_issues", CommandLine: "rm -rf build" },
    });
    expect(
      normalizeAntigravityToolCall(spoof, {
        ...wrapper,
        rawInput: spoof.data.rawInput,
      }),
    ).toBe(spoof);

    const shown = normalizeAntigravityToolCall(state({ rawInput: wrapper.rawInput }), wrapper);
    expect(shown).toMatchObject({
      itemType: "mcp_tool_call",
      detail: 'MCP tool github · list_issues {"repo":"x/y"}',
      data: { server: "github", tool: "list_issues" },
    });
    expect(shown.data).not.toHaveProperty("command");
    // A completion that adds nothing keeps it the MCP tool.
    expect(normalizeAntigravityToolCall(shown, { kind: "execute" }).itemType).toBe("mcp_tool_call");
    // One that says it runs a command, or edits, makes it what it says.
    const conflicted = normalizeAntigravityToolCall(shown, {
      rawInput: { CommandLine: "rm -rf build" },
    });
    expect(conflicted.itemType).toBeUndefined();
    expect(conflicted.kind).toBe("execute");
    expect(conflicted.data).not.toHaveProperty("server");
    expect(normalizeAntigravityToolCall(shown, { kind: "edit" }).itemType).toBeUndefined();
  });
});

describe("Antigravity call_mcp_tool, exactly", () => {
  it("holds the stated rule: an object Arguments, and the title as sent", () => {
    const { Arguments: _arguments, ...withoutArguments } = wrapper.rawInput;
    expect(antigravityProxiedMcpTool({ ...wrapper, rawInput: withoutArguments })).toBeUndefined();
    expect(antigravityProxiedMcpTool({ ...wrapper, title: ` ${wrapper.title} ` })).toBeUndefined();
    expect(
      antigravityProxiedMcpTool({ ...wrapper, rawInput: { ...wrapper.rawInput, ToolName: "" } }),
    ).toBeUndefined();
  });

  it("follows later updates: the newest arguments, and an edit when a diff arrives", () => {
    const first = makeToolCallState({
      toolCallId: "call",
      title: wrapper.title,
      kind: "execute",
      status: "in_progress",
      rawInput: wrapper.rawInput,
    })!;
    const shown = normalizeAntigravityToolCall(first, wrapper);
    // The same tool, restated with new arguments: the label says the new ones.
    const restated = { rawInput: { ...wrapper.rawInput, Arguments: { repo: "a/b" } } };
    const next = normalizeAntigravityToolCall(
      mergeToolCallState(shown, makeToolCallState({ toolCallId: "call", ...restated })!),
      restated,
    );
    expect(next.detail).toBe('MCP tool github · list_issues {"repo":"a/b"}');
    // A completion with a diff and no kind is the edit it shows, not the wrapper's command.
    const diff = {
      status: "completed",
      content: [{ type: "diff", path: "/repo/a.ts", oldText: "a", newText: "b" }],
    } as const;
    const edited = normalizeAntigravityToolCall(
      mergeToolCallState(next, makeToolCallState({ toolCallId: "call", ...diff })!),
      diff,
    );
    expect(edited.kind).toBe("edit");
    expect(edited.itemType).toBeUndefined();
    expect(edited.title).not.toBe("list_issues");
    expect(edited.detail ?? "").not.toContain("MCP tool");
  });
});

describe("Antigravity tool text, storage", () => {
  it("drops inline data links, bounds long links and terminal ids, and budgets the command first", () => {
    const big = "x".repeat(70_000);
    const out = normalizeAntigravitySessionUpdate(
      toolUpdate({
        title: "Running make",
        kind: "execute",
        // Large fields before the command line in the input itself.
        rawInput: { Notes: big, More: big, CommandLine: "make build" },
        rawOutput: { output: big },
        content: [
          {
            type: "content",
            content: { type: "resource_link", uri: "data:text/plain,AAAA", name: "a" },
          },
          {
            type: "content",
            content: { type: "resource_link", uri: `file:///${big}`, name: "b" },
          },
          { type: "terminal", terminalId: big },
        ],
      }),
    );
    expect(() => decodeNotification(out)).not.toThrow();
    const update = out.update as {
      rawInput: { CommandLine: string };
      content: ReadonlyArray<Record<string, unknown>>;
    };
    expect(update.rawInput.CommandLine).toBe("make build");
    expect(update.content).toHaveLength(2);
    const link = update.content[0]!.content as { uri: string };
    expect(link.uri.startsWith("file:///xxx")).toBe(true);
    expect(link.uri.length).toBeLessThanOrEqual(ANTIGRAVITY_TOOL_TEXT_LIMIT);
    expect((update.content[1] as { terminalId: string }).terminalId.length).toBeLessThanOrEqual(
      256,
    );
  });
});

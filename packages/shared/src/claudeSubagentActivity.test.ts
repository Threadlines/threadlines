import { describe, expect, it } from "vite-plus/test";

import {
  claudeSubagentActivityItem,
  extractClaudeSubagentResultText,
} from "./claudeSubagentActivity.ts";

describe("extractClaudeSubagentResultText", () => {
  it("strips a trailing usage block and the whitespace around it", () => {
    expect(
      extractClaudeSubagentResultText("All three fixes landed.\n\n<usage>tokens: 12345</usage>\n"),
    ).toBe("All three fixes landed.");
  });

  it("strips stacked trailing usage blocks but leaves mid-text ones alone", () => {
    expect(
      extractClaudeSubagentResultText(
        "Done. <usage>a</usage> and more\n<usage>b</usage> <usage>c</usage>",
      ),
    ).toBe("Done. <usage>a</usage> and more");
  });

  it("strips the SendMessage continuation footer in both harness wordings", () => {
    expect(
      extractClaudeSubagentResultText(
        "Report ready.\n\nagentId: agent-a1b2 (use SendMessage with to: 'agent-a1b2', summary: 'continue the review' to continue this agent.)",
      ),
    ).toBe("Report ready.");
    expect(
      extractClaudeSubagentResultText(
        "Report ready.\n\nagentId: agent-a1b2 (internal ID - do not mention to user. Use SendMessage with to: 'agent-a1b2', summary: 'continue' to continue this agent)",
      ),
    ).toBe("Report ready.");
  });

  it("keeps prose that merely mentions an agentId", () => {
    expect(extractClaudeSubagentResultText("The log shows agentId: agent-a1b2 crashed.")).toBe(
      "The log shows agentId: agent-a1b2 crashed.",
    );
  });

  it("stays linear on adversarial repetition instead of backtracking", () => {
    // Regression guard for the CodeQL polynomial-redos finding: agent output
    // is provider-influenced, so pathological whitespace/tag repetition must
    // not hang the sanitizer. Correctness is the assertion; a quadratic
    // implementation would time the suite out long before failing it.
    const hostile = `report${"\t".repeat(50_000)}${"<usage>".repeat(2_000)}`;
    expect(extractClaudeSubagentResultText(hostile)).toContain("report");
  });
});

describe("claudeSubagentActivityItem", () => {
  const source = (overrides: {
    data?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    activityKind?: string;
  }) => ({
    activityId: "activity-1",
    activityKind: overrides.activityKind ?? "tool.updated",
    payload: {
      toolCallId: "toolu_spawn",
      status: "inProgress",
      ...overrides.payload,
    },
    data: {
      toolName: "Agent",
      input: { description: "Fix the reactor", subagent_type: "claude" },
      ...overrides.data,
    },
  });

  it("shapes a Claude Agent tool call into a collab item keyed by the spawn", () => {
    const item = claudeSubagentActivityItem(source({}));
    expect(item?.id).toBe("toolu_spawn");
    expect(item?.tool).toBe("Agent");
    expect(item?.agentRole).toBe("claude");
    expect(item?.prompt).toBe("Fix the reactor");
    expect(item?.receiverThreadIds).toEqual(["toolu_spawn"]);
    expect((item?.agentsStates as Record<string, { status: string }>)["toolu_spawn"]?.status).toBe(
      "running",
    );
  });

  it("treats a background launch acknowledgment as still running", () => {
    const item = claudeSubagentActivityItem(
      source({
        activityKind: "tool.completed",
        payload: { status: "completed" },
        data: { result: "Async agent launched successfully. agentId: agent-1" },
      }),
    );
    const state = (item?.agentsStates as Record<string, { status: string; message: string | null }>)
      .toolu_spawn;
    expect(state?.status).toBe("running");
    expect(state?.message).toBeNull();
  });

  it("returns null for tools that are not agent spawns", () => {
    expect(claudeSubagentActivityItem(source({ data: { toolName: "Bash" } }))).toBeNull();
  });
});

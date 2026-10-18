import { assert, describe, it } from "@effect/vitest";

import {
  applyClaudeGoalRecord,
  type ClaudeGoalState,
  claudeGoalCommandReply,
  claudeGoalSnapshot,
  parseClaudeGoalTranscript,
} from "./ClaudeGoals.ts";

const line = (attachment: Record<string, unknown>, timestamp: string) =>
  JSON.stringify({
    type: "attachment",
    timestamp,
    attachment: { type: "goal_status", ...attachment },
  });

const fold = (contents: string): ClaudeGoalState | null =>
  parseClaudeGoalTranscript(contents).reduce<ClaudeGoalState | null>(
    (goal, record) => applyClaudeGoalRecord(goal, record, "2026-10-18T09:00:00.000Z"),
    null,
  );

describe("ClaudeGoals", () => {
  // The records Claude Code 2.1.301 writes, in the order a goal lives them.
  it("follows a goal from set through failed checks to its verdict, and out on clear", () => {
    const set = line(
      { met: false, sentinel: true, condition: "Tests pass" },
      "2026-10-18T08:00:00.000Z",
    );
    const checks = [
      line(
        { met: false, condition: "Tests pass", reason: "3 failing" },
        "2026-10-18T08:05:00.000Z",
      ),
      line(
        { met: false, condition: "Tests pass", reason: "1 failing" },
        "2026-10-18T08:09:00.000Z",
      ),
    ];
    const active = fold([set, '{"type":"user"}', ...checks].join("\n"));
    assert.deepEqual(active, {
      objective: "Tests pass",
      status: "active",
      setAt: "2026-10-18T08:00:00.000Z",
      updatedAt: "2026-10-18T08:09:00.000Z",
      checks: 2,
      lastCheck: "1 failing",
    });

    const impossible = line(
      {
        met: false,
        failed: true,
        condition: "Tests pass",
        reason: "No test runner.",
        iterations: 3,
      },
      "2026-10-18T08:12:00.000Z",
    );
    const blocked = fold([set, ...checks, impossible].join("\n"));
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.checks, 3);
    assert.equal(blocked?.lastCheck, "No test runner.");
    assert.equal(blocked === null ? undefined : claudeGoalSnapshot(blocked, 0).checks, 3);

    const cleared = line(
      { met: true, sentinel: true, condition: "Tests pass" },
      "2026-10-18T08:13:00.000Z",
    );
    assert.isNull(fold([set, ...checks, cleared].join("\n")));
  });

  it("reads the CLI's answer to a /goal command and nothing else", () => {
    const answer = {
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "Goal set: Tests pass" }] },
      local_command_run: { command: "goal", args: "Tests pass" },
    };
    assert.deepEqual(claudeGoalCommandReply(answer), {
      args: "Tests pass",
      text: "Goal set: Tests pass",
    });
    assert.isUndefined(
      claudeGoalCommandReply({ ...answer, local_command_run: { command: "compact", args: "" } }),
    );
    assert.isUndefined(claudeGoalCommandReply({ ...answer, local_command_run: undefined }));
  });
});

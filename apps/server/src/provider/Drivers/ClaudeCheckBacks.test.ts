import { describe, expect, it } from "vite-plus/test";

import {
  claudeCheckBackTrigger,
  claudeCheckBacksFromSessionCrons,
  makeClaudeCheckBackState,
  recordClaudeScheduleTool,
} from "./ClaudeCheckBacks.ts";

const at = (iso: string) => Date.parse(iso);

describe("Claude check-backs", () => {
  it("states a wake-up's exact time and reason, and a cron job's wording and next run", () => {
    const state = makeClaudeCheckBackState();
    recordClaudeScheduleTool(state, {
      toolName: "ScheduleWakeup",
      input: { delaySeconds: 900, reason: "Waiting for CI on PR #502", prompt: "Check CI on #502" },
      result: { scheduledFor: at("2026-10-20T15:42:00Z"), clampedDelaySeconds: 900 },
    });
    recordClaudeScheduleTool(state, {
      toolName: "CronCreate",
      input: { cron: "*/5 * * * *", prompt: "Look at the deploy", recurring: true },
      result: { id: "job-1", humanSchedule: "every 5 minutes", recurring: true },
    });

    const checkBacks = claudeCheckBacksFromSessionCrons(
      state,
      [
        { id: "job-1", schedule: "*/5 * * * *", recurring: true, prompt: "Look at the deploy" },
        { id: "w-1", schedule: "42 15 20 10 *", recurring: false, prompt: "Check CI on #502" },
      ],
      at("2026-10-20T15:27:30Z"),
      "UTC",
    );
    expect(checkBacks).toEqual([
      {
        id: "job-1",
        scheduledFor: "2026-10-20T15:30:00.000Z",
        exact: false,
        recurring: true,
        schedule: "every 5 minutes",
        description: "Look at the deploy",
        durable: false,
      },
      {
        id: "w-1",
        scheduledFor: "2026-10-20T15:42:00.000Z",
        exact: true,
        recurring: false,
        description: "Waiting for CI on PR #502",
        durable: false,
      },
    ]);
  });

  it("keeps a late one-shot on its day, and forgets jobs Claude no longer reports", () => {
    const state = makeClaudeCheckBackState();
    const job = { id: "j", schedule: "10 15 * * *", recurring: false, prompt: "Remind me" };
    const first = claudeCheckBacksFromSessionCrons(state, [job], at("2026-10-20T15:08:00Z"), "UTC");
    expect(first[0]?.scheduledFor).toBe("2026-10-20T15:10:00.000Z");
    // Claude runs it a few minutes late: it is still today's, not tomorrow's.
    const late = claudeCheckBacksFromSessionCrons(state, [job], at("2026-10-20T15:14:00Z"), "UTC");
    expect(late[0]?.scheduledFor).toBe("2026-10-20T15:10:00.000Z");
    expect(claudeCheckBacksFromSessionCrons(state, [], at("2026-10-20T15:16:00Z"), "UTC")).toEqual(
      [],
    );
    expect(state.nextFire.size).toBe(0);
  });

  it("tells a fired check-back's turn by its prompt, even one Claude clipped", () => {
    const state = makeClaudeCheckBackState();
    const longPrompt = `Check the build. ${"x".repeat(1200)}`;
    state.current = claudeCheckBacksFromSessionCrons(
      state,
      [
        {
          id: "j",
          schedule: "0 9 * * *",
          recurring: true,
          prompt: `${longPrompt.slice(0, 1000)}… [+${longPrompt.length - 1000} chars]`,
        },
      ],
      at("2026-10-20T08:00:00Z"),
      "UTC",
    );
    expect(
      claudeCheckBackTrigger(state, longPrompt, undefined, at("2026-10-20T09:00:30Z")),
    ).toEqual({
      kind: "check-back",
      checkBackId: "j",
      scheduledFor: "2026-10-20T09:00:00.000Z",
      recurring: true,
    });
    // A turn a finished background task started is not a check-back.
    expect(
      claudeCheckBackTrigger(state, "Task finished", undefined, at("2026-10-20T09:00:30Z")),
    ).toBe(undefined);
    // Claude may say so itself when the prompt can't be matched.
    expect(
      claudeCheckBackTrigger(state, "unknown", "schedule_wakeup", at("2026-10-20T09:00:30Z")),
    ).toEqual({ kind: "check-back" });
  });
});

import "../../index.css";

import { type OrchestrationThreadGoal, ProviderDriverKind, ThreadId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ComposerGoalBar, threadGoalControls } from "./ComposerGoalBar";

const goal = (overrides: Partial<OrchestrationThreadGoal>): OrchestrationThreadGoal => ({
  threadId: ThreadId.make("thread-goal"),
  objective: "Get the test suite green",
  status: "active",
  tokenBudget: null,
  tokensUsed: 12_000,
  timeUsedSeconds: 300,
  createdAt: "2026-10-18T08:00:00.000Z",
  updatedAt: "2026-10-18T08:05:00.000Z",
  ...overrides,
});

const renderBar = (input: {
  readonly driver: string;
  readonly goal: OrchestrationThreadGoal | null;
  readonly editorOpen?: boolean;
}) => {
  const controls = threadGoalControls(ProviderDriverKind.make(input.driver));
  if (controls === null) throw new Error(`${input.driver} has no goals`);
  const onSetGoal = vi.fn();
  render(
    <ComposerGoalBar
      goal={input.goal}
      controls={controls}
      editorOpen={input.editorOpen ?? false}
      isDispatching={false}
      onOpenEditor={() => {}}
      onCloseEditor={() => {}}
      onSetGoal={onSetGoal}
      onClearGoal={() => {}}
    />,
  );
  return { onSetGoal };
};

describe("ComposerGoalBar", () => {
  it("shows a Claude goal's checks and last verdict, with nothing to pause", async () => {
    renderBar({
      driver: "claudeAgent",
      goal: goal({ checks: 2, lastCheck: "Two tests still fail." }),
    });
    await expect.element(page.getByText("2 checks")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Edit goal" }))
      .toHaveAttribute("title", expect.stringContaining("Two tests still fail."));
    expect(page.getByRole("button", { name: "Pause goal" }).elements()).toHaveLength(0);
    expect(page.getByText("12k").elements()).toHaveLength(0);
  });

  it("sets a Claude goal without a token budget", async () => {
    const { onSetGoal } = renderBar({ driver: "claudeAgent", goal: null, editorOpen: true });
    expect(page.getByPlaceholder("Token budget (optional)").elements()).toHaveLength(0);
    await page.getByRole("textbox").fill("Make the build pass");
    await page.getByRole("button", { name: "Set goal" }).click();
    expect(onSetGoal).toHaveBeenCalledWith({ objective: "Make the build pass" });
  });

  it("keeps Codex's tokens, budget and pause", async () => {
    renderBar({ driver: "codex", goal: goal({ tokenBudget: 50_000 }) });
    await expect.element(page.getByText("12k / 50k")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Pause goal" })).toBeVisible();
  });
});

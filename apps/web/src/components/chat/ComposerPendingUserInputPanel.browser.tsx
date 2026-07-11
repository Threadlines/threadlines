import { ApprovalRequestId } from "@threadlines/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import "../../index.css";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

function makePendingUserInput(): PendingUserInput {
  return {
    requestId: ApprovalRequestId.make("request-1"),
    createdAt: "2026-07-11T10:00:00.000Z",
    questions: [
      {
        id: "question-1",
        header: "Launcher UX",
        question: "Which shape should the launcher control take?",
        options: [
          { label: "Split + pinned default", description: "Fixed icon; primary click fires pin" },
          { label: "Single menu button", description: "One fixed icon that opens the menu" },
        ],
        multiSelect: false,
      },
    ],
  };
}

describe("ComposerPendingUserInputPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("collapses to a compact summary row and re-expands", async () => {
    const onToggleOption = vi.fn();
    const screen = await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[makePendingUserInput()]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={onToggleOption}
        onAdvance={vi.fn()}
      />,
    );

    await expect
      .element(page.getByRole("button", { name: /Split \+ pinned default/ }))
      .toBeVisible();

    await page.getByLabelText("Collapse questions").click();

    expect(screen.container.textContent).not.toContain("Split + pinned default");
    await expect
      .element(page.getByText("Which shape should the launcher control take?"))
      .toBeVisible();

    // Number-key shortcuts must not answer hidden options while collapsed.
    await userEvent.keyboard("1");
    expect(onToggleOption).not.toHaveBeenCalled();

    await page.getByLabelText("Expand questions").click();
    await expect
      .element(page.getByRole("button", { name: /Split \+ pinned default/ }))
      .toBeVisible();

    await userEvent.keyboard("1");
    expect(onToggleOption).toHaveBeenCalledWith("question-1", "Split + pinned default");

    await screen.unmount();
  });

  it("auto-collapses when the timeline scrolls away and re-expands on return", async () => {
    const props = {
      pendingUserInputs: [makePendingUserInput()],
      respondingRequestIds: [],
      answers: {},
      questionIndex: 0,
      onToggleOption: vi.fn(),
      onAdvance: vi.fn(),
    };
    const screen = await render(
      <ComposerPendingUserInputPanel {...props} isTimelineScrolledAway={false} />,
    );

    await expect
      .element(page.getByRole("button", { name: /Split \+ pinned default/ }))
      .toBeVisible();

    screen.rerender(<ComposerPendingUserInputPanel {...props} isTimelineScrolledAway={true} />);
    await expect.element(page.getByLabelText("Expand questions")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Split + pinned default");

    // A manual expand while scrolled away sticks until the next scroll boundary change.
    await page.getByLabelText("Expand questions").click();
    await expect
      .element(page.getByRole("button", { name: /Split \+ pinned default/ }))
      .toBeVisible();

    screen.rerender(<ComposerPendingUserInputPanel {...props} isTimelineScrolledAway={false} />);
    await expect
      .element(page.getByRole("button", { name: /Split \+ pinned default/ }))
      .toBeVisible();

    await screen.unmount();
  });
});

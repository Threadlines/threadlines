import { ApprovalRequestId } from "@threadlines/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import "../../index.css";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerMcpElicitation } from "./ComposerMcpElicitation";
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
  it("waits for explicit confirmation of a tool link and disables replies while unavailable", async () => {
    const onRespond = vi.fn();
    const prompt = {
      mode: "url" as const,
      serverName: "Exports",
      message: "Complete the browser step, then return here.",
      url: "https://example.com/confirm",
    };
    const screen = await render(
      <ComposerMcpElicitation prompt={prompt} disabled onRespond={onRespond} />,
    );
    await expect.element(page.getByRole("button", { name: "Done", exact: true })).toBeDisabled();
    expect(onRespond).not.toHaveBeenCalled();
    screen.rerender(
      <ComposerMcpElicitation prompt={prompt} disabled={false} onRespond={onRespond} />,
    );
    await expect.element(page.getByText("example.com", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    expect(onRespond).toHaveBeenCalledExactlyOnceWith({ action: "accept", content: null });
  });
  it("validates tool fields and sends typed values only on submit", async () => {
    const onRespond = vi.fn();
    await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            ...makePendingUserInput(),
            questions: [],
            elicitation: {
              mode: "form",
              serverName: "Exports",
              message: "Choose an export size.",
              fields: [
                {
                  name: "count",
                  title: "Count",
                  type: "integer",
                  required: true,
                  minimum: 1,
                  maximum: 5,
                },
                { name: "enabled", title: "Enabled", type: "boolean", required: true },
              ],
            },
          },
        ]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        isAgentRunning
        onToggleOption={vi.fn()}
        onPrevious={vi.fn()}
        onCustomAnswerChange={vi.fn()}
        onAdvance={vi.fn()}
        onRespond={onRespond}
      />,
    );
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Count is required.");
    expect(onRespond).not.toHaveBeenCalled();
    await page.getByRole("spinbutton", { name: "Count" }).fill("2");
    await page.getByRole("button", { name: "No", exact: true }).click();
    expect(onRespond).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Submit", exact: true }).click();
    expect(onRespond).toHaveBeenCalledWith("request-1", {
      action: "accept",
      content: { count: 2, enabled: false },
    });
  });

  it("can decline an incomplete tool form", async () => {
    const onRespond = vi.fn();
    await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            ...makePendingUserInput(),
            questions: [],
            elicitation: {
              mode: "form",
              serverName: "Exports",
              message: "Choose an export size.",
              fields: [{ name: "count", title: "Count", type: "integer", required: true }],
            },
          },
        ]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        isAgentRunning
        onToggleOption={vi.fn()}
        onPrevious={vi.fn()}
        onCustomAnswerChange={vi.fn()}
        onAdvance={vi.fn()}
        onRespond={onRespond}
      />,
    );
    await page.getByRole("button", { name: "Decline", exact: true }).click();
    expect(onRespond).toHaveBeenCalledWith("request-1", { action: "decline" });
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("says when the agent keeps working while a question is open", async () => {
    const screen = await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[{ ...makePendingUserInput(), isBlocking: false }]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        isAgentRunning
        onToggleOption={vi.fn()}
        onPrevious={vi.fn()}
        onCustomAnswerChange={vi.fn()}
        onAdvance={vi.fn()}
      />,
    );
    await expect.element(page.getByText("The agent keeps working while you answer.")).toBeVisible();

    screen.rerender(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[{ ...makePendingUserInput(), isBlocking: false }]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        isAgentRunning={false}
        onToggleOption={vi.fn()}
        onPrevious={vi.fn()}
        onCustomAnswerChange={vi.fn()}
        onAdvance={vi.fn()}
      />,
    );
    await expect
      .element(page.getByText("The agent finished. Your answer starts a follow-up."))
      .toBeVisible();

    // Blocking questions carry no hint; the transcript already says the turn is waiting.
    screen.rerender(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[makePendingUserInput()]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        isAgentRunning
        onToggleOption={vi.fn()}
        onPrevious={vi.fn()}
        onCustomAnswerChange={vi.fn()}
        onAdvance={vi.fn()}
      />,
    );
    await expect.element(page.getByText("Split + pinned default")).toBeVisible();
    expect(document.querySelector("[data-composer-question-nonblocking='true']")).toBeNull();
  });

  it("collapses to a compact summary row and re-expands", async () => {
    const onToggleOption = vi.fn();
    const screen = await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[makePendingUserInput()]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        isAgentRunning
        onToggleOption={onToggleOption}
        onPrevious={vi.fn()}
        onCustomAnswerChange={vi.fn()}
        onAdvance={vi.fn()}
      />,
    );

    await expect
      .element(page.getByRole("button", { name: /Split \+ pinned default/ }))
      .toBeVisible();

    await page.getByLabelText("Collapse questions").click();
    await expect.element(page.getByLabelText("Expand questions")).toHaveFocus();

    expect(screen.container.textContent).not.toContain("Split + pinned default");
    await expect
      .element(page.getByText("Which shape should the launcher control take?"))
      .toBeVisible();

    // Number-key shortcuts must not answer hidden options while collapsed.
    await userEvent.keyboard("1");
    expect(onToggleOption).not.toHaveBeenCalled();

    await page.getByLabelText("Expand questions").click();
    await expect.element(page.getByLabelText("Collapse questions")).toHaveFocus();
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
      isAgentRunning: true,
      onToggleOption: vi.fn(),
      onAdvance: vi.fn(),
      onPrevious: vi.fn(),
      onCustomAnswerChange: vi.fn(),
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

import "../../index.css";

import {
  CommandRequestId,
  CommandRunId,
  type OrchestrationCommandRequest,
  type OrchestrationCommandRun,
  TurnId,
} from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { CommandRequestRow, CommandRunActionsContext, type CommandRunActions } from "./CommandRuns";

const REQUEST_ID = CommandRequestId.make("request-1");

const request = (command: string): OrchestrationCommandRequest => ({
  requestId: REQUEST_ID,
  turnId: TurnId.make("turn-1"),
  participantId: null,
  command,
  reason: "It asks for your GitHub password, so I can't run it for you.",
  dialect: "posix",
  dismissedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const actionsWith = (runs: ReadonlyArray<OrchestrationCommandRun> = []): CommandRunActions => ({
  supported: true,
  dialect: "posix",
  cwdLabel: "~/repo",
  runs,
  startRun: vi.fn(),
  sendOutput: vi.fn(),
  setRequestDismissed: vi.fn(),
  showTerminal: vi.fn(),
  terminalLabel: () => "Terminal 3",
  agentLabel: () => "Codex",
});

const renderCard = (card: OrchestrationCommandRequest, actions: CommandRunActions) =>
  render(
    <CommandRunActionsContext value={actions}>
      <CommandRequestRow request={card} />
    </CommandRunActionsContext>,
  );

describe("CommandRequestRow", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("offers Run, Put in terminal and Skip, and says the output comes back", async () => {
    const actions = actionsWith();
    const screen = await renderCard(request("gh auth login --web"), actions);
    try {
      await expect.element(page.getByText("Codex needs you to run a command")).toBeInTheDocument();
      await expect
        .element(page.getByText("Codex gets the output when it finishes"))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Run", exact: true }).click();
      expect(actions.startRun).toHaveBeenCalledWith({
        command: "gh auth login --web",
        mode: "run",
        source: { kind: "request", requestId: REQUEST_ID },
      });
      await page.getByRole("button", { name: "Skip" }).click();
      expect(actions.setRequestDismissed).toHaveBeenCalledWith(REQUEST_ID, true);
    } finally {
      await screen.unmount();
    }
  });

  it("never offers one-click Run for a risky command", async () => {
    const screen = await renderCard(request("rm -rf build"), actionsWith());
    try {
      await expect.element(page.getByText("Deletes files.")).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Put in terminal" }))
        .toBeInTheDocument();
      expect(page.getByRole("button", { name: "Run", exact: true }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });

  it("says the output went to the agent once the run finished", async () => {
    const run: OrchestrationCommandRun = {
      runId: CommandRunId.make("run-1"),
      terminalId: "terminal-run",
      mode: "run",
      dialect: "posix",
      command: "gh auth login --web",
      source: { kind: "request", requestId: REQUEST_ID },
      turnId: TurnId.make("turn-1"),
      participantId: null,
      cwd: "/repo",
      autoSend: true,
      status: "finished",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:01:05.000Z",
      exitCode: 0,
      error: null,
      hasOutput: true,
      heldReason: null,
      outputSentAt: "2026-01-01T00:01:05.000Z",
      outputMessageId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:05.000Z",
    };
    const screen = await renderCard(request("gh auth login --web"), actionsWith([run]));
    try {
      await expect.element(page.getByText("Finished in Terminal 3 · 1m 5s")).toBeInTheDocument();
      await expect.element(page.getByText("· Sent to Codex")).toBeInTheDocument();
      expect(page.getByRole("button", { name: "Skip" }).elements()).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});

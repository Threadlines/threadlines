import { describe, expect, it } from "vite-plus/test";
import type { ProviderAuthEvent, ProviderInstanceId } from "@threadlines/contracts";

import {
  applyProviderAuthEvent,
  appendOutputPreview,
  initialProviderConnectFlowState,
  providerConnectStatusLine,
  shouldAutoExpandTerminal,
  type ProviderConnectFlowState,
} from "./providerConnectFlow.logic";

const INSTANCE = "claude" as ProviderInstanceId;

// Omit must distribute over the event union — plain Omit collapses the
// discriminated variants into their common keys.
type ProviderAuthEventBody = ProviderAuthEvent extends infer E
  ? E extends ProviderAuthEvent
    ? Omit<E, "instanceId" | "createdAt">
    : never
  : never;

function event(partial: ProviderAuthEventBody): ProviderAuthEvent {
  return {
    instanceId: INSTANCE,
    createdAt: "2026-08-03T00:00:00.000Z",
    ...partial,
  } as ProviderAuthEvent;
}

function replay(events: ReadonlyArray<ProviderAuthEvent>): ProviderConnectFlowState {
  return events.reduce(applyProviderAuthEvent, initialProviderConnectFlowState);
}

describe("provider connect flow state", () => {
  it("tracks a run from start to success and keeps the resolved command", () => {
    const state = replay([
      event({ type: "command", flow: "login", command: "codex login" }),
      event({ type: "status", status: "starting", exitCode: null, detail: null }),
      event({ type: "status", status: "running", exitCode: null, detail: null }),
      event({ type: "output", data: "Opening browser...\r\nWaiting for sign-in" }),
      event({ type: "status", status: "succeeded", exitCode: 0, detail: null }),
    ]);

    expect(state.command).toBe("codex login");
    expect(state.status).toBe("succeeded");
    expect(state.lastLine).toBe("Waiting for sign-in");
  });

  it("surfaces the server's failure detail", () => {
    const state = replay([
      event({ type: "status", status: "running", exitCode: null, detail: null }),
      event({
        type: "status",
        status: "failed",
        exitCode: 7,
        detail: "The sign-in command exited with code 7.",
      }),
    ]);

    expect(providerConnectStatusLine({ flow: "login", state, displayName: "Codex" })).toBe(
      "The sign-in command exited with code 7.",
    );
    expect(state.exitCode).toBe(7);
  });

  it("clears the previous preview line when a new attempt starts", () => {
    const state = replay([
      event({ type: "output", data: "old failure text\n" }),
      event({ type: "status", status: "starting", exitCode: null, detail: null }),
    ]);

    expect(state.lastLine).toBe("");
  });

  it("keeps the newest visible line across chunk boundaries and ignores styling", () => {
    expect(appendOutputPreview("", "Paste the code: ")).toBe("Paste the code:");
    expect(appendOutputPreview("Paste the code:", "\u001B[32mabc123\u001B[0m")).toBe(
      "Paste the code:abc123",
    );
    expect(appendOutputPreview("done", "\nnext line\n")).toBe("next line");
  });

  it("opens the terminal on failure and after a long-running wait", () => {
    expect(shouldAutoExpandTerminal({ status: "running", runningForMs: 4_000 })).toBe(false);
    expect(shouldAutoExpandTerminal({ status: "running", runningForMs: 16_000 })).toBe(true);
    expect(shouldAutoExpandTerminal({ status: "failed", runningForMs: 0 })).toBe(true);
    expect(shouldAutoExpandTerminal({ status: "succeeded", runningForMs: 60_000 })).toBe(false);
  });

  it("uses token wording for the setup-token flow", () => {
    const succeeded: ProviderConnectFlowState = {
      ...initialProviderConnectFlowState,
      status: "succeeded",
    };
    expect(
      providerConnectStatusLine({
        flow: "claude-setup-token",
        state: succeeded,
        displayName: "Claude",
      }),
    ).toBe("Token saved");
    expect(
      providerConnectStatusLine({ flow: "login", state: succeeded, displayName: "Claude" }),
    ).toBe("Signed in");
  });
});

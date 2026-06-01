import { describe, expect, it } from "vitest";

import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import {
  describeSlowRpcAckToast,
  formatSlowRpcTagLabel,
  shouldAutoReconnect,
  shouldRestartStalledReconnect,
  shouldShowReconnectIssueToast,
} from "./WebSocketConnectionSurface";

function makeStatus(overrides: Partial<WsConnectionStatus> = {}): WsConnectionStatus {
  return {
    attemptCount: 0,
    closeCode: null,
    closeReason: null,
    connectionLabel: null,
    connectedAt: null,
    disconnectedAt: null,
    hasConnected: false,
    lastError: null,
    lastErrorAt: null,
    nextRetryAt: null,
    online: true,
    phase: "idle",
    reconnectAttemptCount: 0,
    reconnectMaxAttempts: 8,
    reconnectPhase: "idle",
    socketUrl: null,
    ...overrides,
  };
}

describe("WebSocketConnectionSurface.logic", () => {
  it("forces reconnect on online when the app was offline", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          online: false,
          phase: "disconnected",
        }),
        "online",
      ),
    ).toBe(true);
  });

  it("forces reconnect on focus only for previously connected disconnected states", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(true);

    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: false,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
        "focus",
      ),
    ).toBe(false);
  });

  it("forces reconnect on focus for exhausted reconnect loops", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 8,
          reconnectPhase: "exhausted",
        }),
        "focus",
      ),
    ).toBe(true);
  });

  it("restarts a stalled reconnect window after the scheduled retry time passes", () => {
    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "waiting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(true);

    expect(
      shouldRestartStalledReconnect(
        makeStatus({
          hasConnected: true,
          nextRetryAt: "2026-04-03T20:00:01.000Z",
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 3,
          reconnectPhase: "attempting",
        }),
        "2026-04-03T20:00:01.000Z",
      ),
    ).toBe(false);
  });

  it("does not show the reconnect toast for a forced reconnect without a recorded disconnect", () => {
    expect(
      shouldShowReconnectIssueToast(
        makeStatus({
          hasConnected: true,
          phase: "connecting",
          reconnectAttemptCount: 1,
          reconnectPhase: "attempting",
        }),
      ),
    ).toBe(false);
  });

  it("shows the reconnect toast when the live websocket actually disconnected", () => {
    expect(
      shouldShowReconnectIssueToast(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          hasConnected: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
      ),
    ).toBe(true);
  });

  it("formats slow RPC method tags for user-facing summaries", () => {
    expect(formatSlowRpcTagLabel("server.refreshProviders")).toBe("Server refresh providers");
    expect(formatSlowRpcTagLabel("vcs.refreshStatus")).toBe("Source control refresh status");
    expect(formatSlowRpcTagLabel("git.generateCommitMessage")).toBe("Git generate commit message");
  });

  it("includes friendly slow RPC labels in the toast description", () => {
    expect(
      describeSlowRpcAckToast([
        {
          requestId: "request-1",
          startedAt: "2026-06-01T12:00:00.000Z",
          startedAtMs: 1,
          tag: "server.refreshProviders",
          thresholdMs: 15_000,
        },
        {
          requestId: "request-2",
          startedAt: "2026-06-01T12:00:01.000Z",
          startedAtMs: 2,
          tag: "git.generateCommitMessage",
          thresholdMs: 15_000,
        },
      ]),
    ).toBe(
      "2 requests waiting longer than 15s: Server refresh providers, Git generate commit message.",
    );
  });
});

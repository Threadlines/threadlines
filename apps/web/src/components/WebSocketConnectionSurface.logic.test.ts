import { describe, expect, it } from "vite-plus/test";

import type { WsConnectionStatus } from "../rpc/wsConnectionState";
import { describeSlowRpcAckToast, formatSlowRpcTagLabel } from "../rpc/requestLatencyPresentation";
import {
  shouldAutoReconnect,
  shouldProbeAccessRemoval,
  shouldReconnectAfterSessionRenewal,
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

  it("forces reconnect on focus for long-running reconnect loops", () => {
    expect(
      shouldAutoReconnect(
        makeStatus({
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 25,
          reconnectPhase: "waiting",
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
        new Date("2026-04-03T20:00:12.000Z").getTime(),
      ),
    ).toBe(false);
  });

  it("does not show the reconnect toast for brief recovered hiccups", () => {
    expect(
      shouldShowReconnectIssueToast(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          hasConnected: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
        new Date("2026-04-03T20:00:29.999Z").getTime(),
      ),
    ).toBe(false);
  });

  it("shows the reconnect toast when the live websocket stays disconnected", () => {
    expect(
      shouldShowReconnectIssueToast(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          hasConnected: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
        new Date("2026-04-03T20:00:30.000Z").getTime(),
      ),
    ).toBe(true);
  });

  it("asks whether access was removed when an established socket drops", () => {
    expect(
      shouldProbeAccessRemoval(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          hasConnected: true,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
      ),
    ).toBe(true);
  });

  it("does not ask about access while the browser reports no network", () => {
    expect(
      shouldProbeAccessRemoval(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          hasConnected: true,
          online: false,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
      ),
    ).toBe(false);
  });

  it("does not ask about access for a session that never connected", () => {
    expect(
      shouldProbeAccessRemoval(
        makeStatus({
          disconnectedAt: "2026-04-03T20:00:00.000Z",
          hasConnected: false,
          online: true,
          phase: "disconnected",
          reconnectAttemptCount: 1,
          reconnectPhase: "waiting",
        }),
      ),
    ).toBe(false);
  });

  describe("after the desktop window gets a new session", () => {
    const connected = makeStatus({ attemptCount: 3, hasConnected: true, phase: "connected" });
    const dropped = makeStatus({
      attemptCount: 4,
      disconnectedAt: "2026-04-03T20:00:09.000Z",
      hasConnected: true,
      phase: "disconnected",
      reconnectAttemptCount: 1,
      reconnectPhase: "waiting",
    });

    it("moves the socket that was already up onto the new session", () => {
      expect(shouldReconnectAfterSessionRenewal(connected, connected)).toBe(true);
    });

    it("leaves alone a socket that connected while the session was being renewed", () => {
      const reconnected = makeStatus({ attemptCount: 5, hasConnected: true, phase: "connected" });

      expect(shouldReconnectAfterSessionRenewal(dropped, reconnected)).toBe(false);
      // The old socket dropped and a new one came up before the renewal finished.
      expect(shouldReconnectAfterSessionRenewal(connected, reconnected)).toBe(false);
    });

    it("cuts a retry delay short but does not interrupt an attempt in flight", () => {
      const attempting = makeStatus({
        attemptCount: 5,
        hasConnected: true,
        phase: "connecting",
        reconnectAttemptCount: 2,
        reconnectPhase: "attempting",
      });

      expect(shouldReconnectAfterSessionRenewal(dropped, dropped)).toBe(true);
      expect(shouldReconnectAfterSessionRenewal(dropped, attempting)).toBe(false);
    });
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

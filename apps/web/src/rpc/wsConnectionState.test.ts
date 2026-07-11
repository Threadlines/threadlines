import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getWsConnectionStatus,
  getWsReconnectDelayMsForRetry,
  getWsConnectionUiState,
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  setBrowserOnlineStatus,
  WS_RECONNECT_MAX_DELAY_MS,
} from "./wsConnectionState";

describe("wsConnectionState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-03T20:30:00.000Z"));
    resetWsConnectionStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats a disconnected browser as offline once the websocket drops", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionClosed({ code: 1006, reason: "offline" });
    setBrowserOnlineStatus(false);

    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("offline");
  });

  it("stays in the initial connecting state until the first disconnect", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");

    expect(getWsConnectionStatus()).toMatchObject({
      attemptCount: 1,
      hasConnected: false,
      phase: "connecting",
    });
    expect(getWsConnectionUiState(getWsConnectionStatus())).toBe("connecting");
  });

  it("schedules the next retry after a failed websocket attempt", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws", {
      connectionLabel: "Remote Mac",
    });
    recordWsConnectionErrored("Unable to connect to the Threadlines server WebSocket.");

    const firstRetryDelayMs = getWsReconnectDelayMsForRetry(0);

    expect(getWsConnectionStatus()).toMatchObject({
      connectionLabel: "Remote Mac",
      nextRetryAt: new Date(Date.now() + firstRetryDelayMs).toISOString(),
      reconnectAttemptCount: 1,
      reconnectPhase: "waiting",
    });
  });

  it("adds a version mismatch hint to websocket errors when metadata includes one", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws", {
      connectionLabel: "Remote Mac",
    });
    recordWsConnectionErrored("Unable to connect to the Threadlines server WebSocket.", {
      versionMismatchHint: "Version mismatch. Try syncing the client and server.",
    });

    expect(getWsConnectionStatus()).toMatchObject({
      lastError:
        "Unable to connect to the Threadlines server WebSocket. Hint: Version mismatch. Try syncing the client and server.",
    });
  });

  it("adds a version mismatch hint to websocket close reasons when metadata includes one", () => {
    recordWsConnectionAttempt("ws://localhost:3020/ws");
    recordWsConnectionOpened();
    recordWsConnectionClosed(
      { code: 1006, reason: "socket closed" },
      {
        versionMismatchHint: "Version mismatch. Try syncing the client and server.",
      },
    );

    expect(getWsConnectionStatus()).toMatchObject({
      closeReason: "socket closed Hint: Version mismatch. Try syncing the client and server.",
    });
  });

  it("keeps scheduling retries with capped backoff instead of exhausting", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      recordWsConnectionAttempt("ws://localhost:3020/ws");
      recordWsConnectionErrored("Unable to connect to the Threadlines server WebSocket.");
      vi.setSystemTime(Date.now() + 60_000);
    }

    expect(getWsConnectionStatus()).toMatchObject({
      reconnectAttemptCount: 20,
      reconnectPhase: "waiting",
    });
    expect(getWsConnectionStatus().nextRetryAt).not.toBeNull();
    expect(getWsReconnectDelayMsForRetry(19)).toBe(WS_RECONNECT_MAX_DELAY_MS);
  });
});

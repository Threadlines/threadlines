import type { AuthSessionState } from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DesktopSessionOutcome } from "./auth";
import { waitUntil, watchDesktopSessionExpiry } from "./desktopSession";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const auth: AuthSessionState["auth"] = {
  policy: "desktop-managed-local",
  bootstrapMethods: ["desktop-bootstrap"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "threadlines_session",
};

// A session reply is read as raw JSON, so its expiry is the string the server sent.
function signedInUntil(expiresAtMs: number): AuthSessionState {
  return {
    authenticated: true,
    auth,
    sessionMethod: "browser-session-cookie",
    expiresAt: new Date(expiresAtMs).toISOString(),
  } as unknown as AuthSessionState;
}

const signedOut = { authenticated: false, auth } as AuthSessionState;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("waitUntil", () => {
  it("waits out a whole 30-day session, further than one timer can reach", async () => {
    let reached = false;
    void waitUntil(Date.now() + 30 * DAY_MS, new AbortController().signal).then(() => {
      reached = true;
    });

    await vi.advanceTimersByTimeAsync(30 * DAY_MS - MINUTE_MS);
    expect(reached).toBe(false);

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(reached).toBe(true);
  });

  it("catches up within a minute when the clock moves past the deadline", async () => {
    let reached = false;
    void waitUntil(Date.now() + 10 * HOUR_MS, new AbortController().signal).then(() => {
      reached = true;
    });

    // The machine slept through the deadline, or its clock was set forward.
    vi.setSystemTime(Date.now() + 11 * HOUR_MS);
    await vi.advanceTimersByTimeAsync(MINUTE_MS);

    expect(reached).toBe(true);
  });
});

describe("watchDesktopSessionExpiry", () => {
  it("has the session replaced when it ends, and not before", async () => {
    const controller = new AbortController();
    const expiresAtMs = Date.now() + 2 * HOUR_MS;
    const restoreSession = vi.fn(async (): Promise<DesktopSessionOutcome> => {
      // Moving the socket onto the new session is what ends a run.
      controller.abort();
      return "renewed";
    });

    const watching = watchDesktopSessionExpiry({
      signal: controller.signal,
      restoreSession,
      readSessionState: async () => signedInUntil(expiresAtMs),
    });

    await vi.advanceTimersByTimeAsync(2 * HOUR_MS - 1_000);
    expect(restoreSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(restoreSession).toHaveBeenCalledTimes(1);
    await expect(watching).resolves.toBeUndefined();
  });

  it("asks again a minute later when the server could not give it a new session", async () => {
    const controller = new AbortController();
    const expiresAtMs = Date.now() + HOUR_MS;
    const outcomes: DesktopSessionOutcome[] = ["failed", "renewed"];
    const restoreSession = vi.fn(async (): Promise<DesktopSessionOutcome> => {
      const outcome = outcomes.shift() ?? "renewed";
      if (outcome === "renewed") {
        controller.abort();
      }
      return outcome;
    });

    void watchDesktopSessionExpiry({
      signal: controller.signal,
      restoreSession,
      readSessionState: async () =>
        Date.now() < expiresAtMs ? signedInUntil(expiresAtMs) : signedOut,
    });

    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(restoreSession).toHaveBeenCalledTimes(1);

    // The socket is still up, so nothing else would retry for the window.
    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(restoreSession).toHaveBeenCalledTimes(2);
  });

  it("keeps looking when the session could not be read", async () => {
    const controller = new AbortController();
    const expiresAtMs = Date.now() + HOUR_MS;
    const readSessionState = vi
      .fn<() => Promise<AuthSessionState>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(signedInUntil(expiresAtMs));
    const restoreSession = vi.fn(async (): Promise<DesktopSessionOutcome> => {
      controller.abort();
      return "renewed";
    });

    void watchDesktopSessionExpiry({ signal: controller.signal, restoreSession, readSessionState });

    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(readSessionState).toHaveBeenCalledTimes(2);
    expect(restoreSession).toHaveBeenCalledTimes(1);
  });
});

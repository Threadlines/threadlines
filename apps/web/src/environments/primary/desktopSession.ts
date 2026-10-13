import type { AuthSessionState } from "@threadlines/contracts";

import { type DesktopSessionOutcome, fetchSessionState, readSessionExpiryMs } from "./auth";

const CLOCK_RECHECK_MS = 60_000;
const SESSION_RECHECK_MS = 60_000;

/**
 * Resolves once the clock reaches `atMs`, or as soon as `signal` aborts. A
 * timer only counts down the wait it was given: it runs late after the machine
 * sleeps, knows nothing of a clock that was set forward, and fires at once
 * when asked for more than about 24 days. So this re-reads the clock at least
 * once a minute instead of trusting one long timer.
 */
export function waitUntil(atMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const check = () => {
      const remainingMs = atMs - Date.now();
      if (signal.aborted || remainingMs <= 0) {
        finish();
        return;
      }
      timeoutId = setTimeout(check, Math.min(remainingMs, CLOCK_RECHECK_MS));
    };
    signal.addEventListener("abort", finish);
    check();
  });
}

/**
 * Keeps the desktop app's own window signed in for as long as its socket stays
 * up. The server checks a session only when a socket connects, so an open
 * socket outlives its session while every plain request the window makes
 * (pictures, the Connections settings lists) starts being refused. This waits
 * for the session to end and has it replaced right then, looking again a
 * minute later whenever the server could not be asked.
 *
 * Run it while the socket is connected and abort it when the socket goes: a
 * dropped socket is the access probe's to handle. `restoreSession` is expected
 * to move the socket onto the new session, which ends this run.
 */
export async function watchDesktopSessionExpiry(input: {
  readonly signal: AbortSignal;
  readonly restoreSession: () => Promise<DesktopSessionOutcome>;
  readonly readSessionState?: () => Promise<AuthSessionState>;
}): Promise<void> {
  const { signal, restoreSession } = input;
  const readSessionState = input.readSessionState ?? fetchSessionState;

  while (!signal.aborted) {
    const session = await readSessionState().catch(() => null);
    if (signal.aborted) {
      return;
    }

    if (session !== null) {
      const expiresAtMs = readSessionExpiryMs(session);
      if (session.authenticated && expiresAtMs === null) {
        // A session that names no end has nothing to wait for.
        return;
      }
      if (expiresAtMs !== null) {
        await waitUntil(expiresAtMs, signal);
        if (signal.aborted) {
          return;
        }
      }
      if ((await restoreSession()) === "unavailable") {
        return;
      }
    }

    await waitUntil(Date.now() + SESSION_RECHECK_MS, signal);
  }
}

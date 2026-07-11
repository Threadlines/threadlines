import { describe, expect, it } from "vite-plus/test";

import {
  getSessionStartupNoticeDelayMs,
  SESSION_STARTUP_SLOW_NOTICE_DELAY_MS,
  shouldShowSessionStartupNotice,
} from "./SessionStartupNotice";

const STARTED_AT_MS = Date.UTC(2026, 5, 1, 12, 0, 0);
const STARTED_AT_ISO = new Date(STARTED_AT_MS).toISOString();

describe("getSessionStartupNoticeDelayMs", () => {
  it("never fires when the session is not starting", () => {
    expect(
      getSessionStartupNoticeDelayMs({
        isSessionStarting: false,
        startedAt: STARTED_AT_ISO,
        nowMs: STARTED_AT_MS + SESSION_STARTUP_SLOW_NOTICE_DELAY_MS,
      }),
    ).toBe(null);
  });

  it("never fires without a startup timestamp", () => {
    expect(
      getSessionStartupNoticeDelayMs({
        isSessionStarting: true,
        startedAt: null,
        nowMs: STARTED_AT_MS + SESSION_STARTUP_SLOW_NOTICE_DELAY_MS,
      }),
    ).toBe(null);
  });

  it("waits out the remaining delay before the threshold", () => {
    expect(
      getSessionStartupNoticeDelayMs({
        isSessionStarting: true,
        startedAt: STARTED_AT_ISO,
        nowMs: STARTED_AT_MS + 10_000,
      }),
    ).toBe(SESSION_STARTUP_SLOW_NOTICE_DELAY_MS - 10_000);
  });

  it("fires once startup reaches the threshold", () => {
    expect(
      getSessionStartupNoticeDelayMs({
        isSessionStarting: true,
        startedAt: STARTED_AT_ISO,
        nowMs: STARTED_AT_MS + SESSION_STARTUP_SLOW_NOTICE_DELAY_MS,
      }),
    ).toBe(0);
    expect(
      getSessionStartupNoticeDelayMs({
        isSessionStarting: true,
        startedAt: STARTED_AT_ISO,
        nowMs: STARTED_AT_MS + SESSION_STARTUP_SLOW_NOTICE_DELAY_MS + 5_000,
      }),
    ).toBe(0);
  });

  it("fires immediately for unparseable timestamps", () => {
    expect(
      getSessionStartupNoticeDelayMs({
        isSessionStarting: true,
        startedAt: "not-a-timestamp",
        nowMs: STARTED_AT_MS,
      }),
    ).toBe(0);
  });

  it("clamps clock skew instead of firing early for future timestamps", () => {
    expect(
      getSessionStartupNoticeDelayMs({
        isSessionStarting: true,
        startedAt: STARTED_AT_ISO,
        nowMs: STARTED_AT_MS - 5_000,
      }),
    ).toBe(SESSION_STARTUP_SLOW_NOTICE_DELAY_MS);
  });
});

describe("shouldShowSessionStartupNotice", () => {
  it("hides the notice before the threshold and shows it after", () => {
    expect(
      shouldShowSessionStartupNotice({
        isSessionStarting: true,
        startedAt: STARTED_AT_ISO,
        nowMs: STARTED_AT_MS + SESSION_STARTUP_SLOW_NOTICE_DELAY_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldShowSessionStartupNotice({
        isSessionStarting: true,
        startedAt: STARTED_AT_ISO,
        nowMs: STARTED_AT_MS + SESSION_STARTUP_SLOW_NOTICE_DELAY_MS,
      }),
    ).toBe(true);
  });

  it("stays hidden while the session is not starting", () => {
    expect(
      shouldShowSessionStartupNotice({
        isSessionStarting: false,
        startedAt: STARTED_AT_ISO,
        nowMs: STARTED_AT_MS + SESSION_STARTUP_SLOW_NOTICE_DELAY_MS,
      }),
    ).toBe(false);
  });
});

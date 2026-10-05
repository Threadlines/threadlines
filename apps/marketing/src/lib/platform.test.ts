import { describe, expect, it, vi } from "vitest";

import { detectDevice, detectMacArch } from "./platform";

const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const CHROME_OS =
  "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("detectDevice", () => {
  it.each([
    ["a Mac", { userAgent: MAC_SAFARI, maxTouchPoints: 0 }, false, "mac"],
    // iPad Safari asks for desktop sites by sending the Mac user agent.
    ["an iPad posing as a Mac", { userAgent: MAC_SAFARI, maxTouchPoints: 5 }, false, "mobile"],
    ["an iPhone", { userAgent: IPHONE, maxTouchPoints: 5 }, true, "mobile"],
    ["an Android phone", { userAgent: ANDROID, maxTouchPoints: 5 }, true, "mobile"],
    // Android's "desktop site" mode sends the desktop Linux user agent.
    ["an Android tablet posing as Linux", { userAgent: LINUX, maxTouchPoints: 5 }, true, "mobile"],
    ["a touchscreen Linux laptop", { userAgent: LINUX, maxTouchPoints: 10 }, false, "linux"],
    ["a touchscreen Windows laptop", { userAgent: WINDOWS, maxTouchPoints: 10 }, false, "windows"],
    [
      "a Chromebook",
      { userAgent: CHROME_OS, userAgentData: { platform: "Chrome OS" } },
      false,
      "unknown",
    ],
  ] as const)("recognizes %s", (_name, nav, touchOnly, device) => {
    expect(detectDevice(nav, touchOnly)).toBe(device);
  });
});

describe("detectMacArch", () => {
  // Like the real API, answers only the hints it is asked for.
  const chromium = (architecture: string) => ({
    userAgent: MAC_SAFARI,
    userAgentData: {
      platform: "macOS",
      getHighEntropyValues: async (hints: ReadonlyArray<string>) =>
        hints.includes("architecture") ? { architecture } : {},
    },
  });
  const answering = (answer: () => Promise<{ architecture?: string }>) => ({
    userAgent: MAC_SAFARI,
    userAgentData: { platform: "macOS", getHighEntropyValues: answer },
  });

  it("reads the chip from Chromium's client hints", async () => {
    expect(await detectMacArch(chromium("arm"))).toBe("arm64");
    expect(await detectMacArch(chromium("x86"))).toBe("x64");
  });

  it("leaves the choice open when the browser won't say", async () => {
    expect(await detectMacArch({ userAgent: MAC_SAFARI })).toBeUndefined();
    expect(await detectMacArch(chromium(""))).toBeUndefined();
    expect(
      await detectMacArch(answering(() => Promise.reject(new Error("NotAllowedError")))),
    ).toBeUndefined();
  });

  it("stops waiting on a browser that never answers", async () => {
    vi.useFakeTimers();
    try {
      const arch = detectMacArch(answering(() => new Promise(() => {})));
      await vi.advanceTimersByTimeAsync(1000);
      expect(await arch).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

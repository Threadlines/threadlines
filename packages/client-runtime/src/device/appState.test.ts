import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { FOREGROUND_POLL_MS, subscribeDeviceForeground } from "./appState.ts";
import type { DeviceHubTransport } from "./hubTransport.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("subscribeDeviceForeground", () => {
  it("reports the app in front as it changes, the home screen as null, and a missing helper as unknown", async () => {
    vi.useFakeTimers();
    const answers: Array<() => Response> = [
      () => new Response(JSON.stringify({ pid: 1, bundleId: "com.apple.Preferences" })),
      () => new Response(JSON.stringify({ pid: 1, bundleId: "com.apple.Preferences" })),
      () => new Response(JSON.stringify({ bundleId: null })),
      () => new Response(JSON.stringify({ error: "No serve-sim device" }), { status: 404 }),
    ];
    const paths: Array<string> = [];
    const transport: DeviceHubTransport = {
      fetch: async (path) => {
        paths.push(path);
        return answers[Math.min(paths.length - 1, answers.length - 1)]!();
      },
      socket: () => {
        throw new Error("not used");
      },
    };

    const seen: Array<unknown> = [];
    const stop = subscribeDeviceForeground(transport, "ABC 1", (app) => seen.push(app));
    for (let poll = 0; poll < 4; poll++) {
      await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_MS);
    }
    stop();

    expect(paths[0]).toBe("/vendor/serve-sim/helper/ABC%201/foreground");
    // The repeated answer is reported once.
    expect(seen).toEqual([{ id: "com.apple.Preferences" }, null, undefined]);
  });
});

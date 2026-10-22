import { describe, expect, it } from "vite-plus/test";

import { makeSessionLaunchGenerations } from "./sessionLaunches.ts";

describe("makeSessionLaunchGenerations", () => {
  it("ignores a late clear from an older launch and lets the newest one clear", () => {
    const launches = makeSessionLaunchGenerations<string>();
    const older = launches.begin("thread-1");
    const newer = launches.begin("thread-1");

    expect(launches.end("thread-1", older)).toBe(false);
    expect(launches.holds("thread-1")).toBe(true);

    expect(launches.end("thread-1", newer)).toBe(true);
    expect(launches.holds("thread-1")).toBe(false);
  });
});

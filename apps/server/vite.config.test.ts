import { describe, expect, it } from "vite-plus/test";

import config, { resolveBundledTelemetryConfig } from "./vite.config.ts";

describe("server pack configuration", () => {
  it("uses the release telemetry flag as a build-time kill switch", () => {
    expect(
      resolveBundledTelemetryConfig({
        THREADLINES_POSTHOG_KEY: " phc_release_key ",
        THREADLINES_POSTHOG_HOST: " https://posthog.example.com ",
        THREADLINES_TELEMETRY_ENABLED: " false ",
      }),
    ).toEqual({
      posthogKey: "",
      posthogHost: "https://posthog.example.com",
    });

    expect(
      resolveBundledTelemetryConfig({
        THREADLINES_POSTHOG_KEY: " phc_release_key ",
        THREADLINES_TELEMETRY_ENABLED: "true",
      }),
    ).toEqual({
      posthogKey: "phc_release_key",
      posthogHost: "https://us.i.posthog.com",
    });
  });

  it("injects the bundled PostHog configuration into vp pack", () => {
    const packConfig = config.pack;
    const expected = resolveBundledTelemetryConfig();

    expect(packConfig).toBeDefined();
    expect(Array.isArray(packConfig)).toBe(false);
    if (!packConfig || Array.isArray(packConfig)) return;

    expect(packConfig.define).toMatchObject({
      __THREADLINES_BUNDLED_POSTHOG_KEY__: JSON.stringify(expected.posthogKey),
      __THREADLINES_BUNDLED_POSTHOG_HOST__: JSON.stringify(expected.posthogHost),
    });
    expect(config.define).toBeUndefined();
  });
});

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("uses injected desktop branding when available", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "Threadlines",
            stageLabel: "Nightly",
            displayName: "Threadlines (Nightly)",
            version: "1.2.3-nightly.4",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("Threadlines");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_BUILD_CHANNEL_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("Threadlines (Nightly)");
    expect(branding.APP_VERSION).toBe("1.2.3-nightly.4");
  });

  it("prefers the web bundle version over dev desktop branding", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "Threadlines",
            stageLabel: "Dev",
            displayName: "Threadlines (Dev)",
            // Unpackaged Electron reports the Electron binary version.
            version: "41.5.0",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_STAGE_LABEL).toBe("Dev");
    expect(branding.APP_BUILD_CHANNEL_LABEL).toBe("Dev");
    expect(branding.APP_VERSION).toBe(import.meta.env.APP_VERSION);
    expect(branding.APP_VERSION).not.toBe("41.5.0");
  });

  it("normalizes hosted app channel metadata", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("nightly");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Nightly");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_BUILD_CHANNEL_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("Threadlines");
  });

  it("labels regular packaged builds as stable", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "Threadlines",
            stageLabel: "Alpha",
            displayName: "Threadlines",
            version: "1.2.3",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BUILD_CHANNEL_LABEL).toBe("Stable");
  });

  it("ignores unknown hosted app channels", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "preview");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBeNull();
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBeNull();
  });
});

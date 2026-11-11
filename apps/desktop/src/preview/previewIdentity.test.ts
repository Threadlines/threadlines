import { describe, expect, it } from "vite-plus/test";

import { chromeIdentity } from "./previewIdentity.ts";

const onThisMac = {
  defaultUserAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Threadlines/0.9.1-nightly.20261110.377 Chrome/156.0.8078.75 Electron/45.2.1 Safari/537.36",
  chromeVersion: "156.0.8078.75",
  platform: "darwin",
  arch: "arm64",
  systemVersion: "27.2.0",
} as const;

describe("chromeIdentity", () => {
  it("names Chrome alone in the user agent, whatever the app's own tokens were", () => {
    expect(chromeIdentity(onThisMac).userAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    );
    expect(
      chromeIdentity({
        ...onThisMac,
        defaultUserAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Threadlines (Dev)/0.9.1 Chrome/156.0.8078.75 Electron/45.2.1 Safari/537.36",
      }).userAgent,
    ).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    );
  });

  // The first two entries are what Electron 45.2.1 (Chromium 156) reported for
  // itself on this Mac, read from a page; Chrome adds its own name after them.
  it("lists the brands Chromium builds for the version, with Chrome among them", () => {
    const { userAgentMetadata } = chromeIdentity(onThisMac);
    expect(userAgentMetadata.brands).toEqual([
      { brand: "Not:A-Brand", version: "8" },
      { brand: "Chromium", version: "156" },
      { brand: "Google Chrome", version: "156" },
    ]);
    expect(userAgentMetadata.fullVersionList).toEqual([
      { brand: "Not:A-Brand", version: "8.0.0.0" },
      { brand: "Chromium", version: "156.0.8078.75" },
      { brand: "Google Chrome", version: "156.0.8078.75" },
    ]);
    // Chrome 131's own header: "Google Chrome";v="131", "Chromium";v="131",
    // "Not_A Brand";v="24". A version where the order is not the plain one.
    expect(
      chromeIdentity({ ...onThisMac, chromeVersion: "131.0.6778.86" }).userAgentMetadata.brands,
    ).toEqual([
      { brand: "Google Chrome", version: "131" },
      { brand: "Chromium", version: "131" },
      { brand: "Not_A Brand", version: "24" },
    ]);
    expect(userAgentMetadata).toMatchObject({
      platform: "macOS",
      platformVersion: "27.2.0",
      architecture: "arm",
      bitness: "64",
    });
  });

  it("reports Windows by its API contract and Linux by its kernel", () => {
    const windows = chromeIdentity({
      ...onThisMac,
      platform: "win32",
      arch: "x64",
      systemVersion: "10.0.26100",
    }).userAgentMetadata;
    expect(windows).toMatchObject({
      platform: "Windows",
      platformVersion: "19.0.0",
      architecture: "x86",
    });
    expect(
      chromeIdentity({ ...onThisMac, platform: "linux", systemVersion: "6.8.0-45-generic" })
        .userAgentMetadata,
    ).toMatchObject({ platform: "Linux", platformVersion: "6.8.0" });
  });
});

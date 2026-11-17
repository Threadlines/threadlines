import { EventEmitter } from "node:events";
import type * as Electron from "electron";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  chromeIdentity,
  claimsChromeAt,
  followSiteIdentity,
  pageLoadUserAgent,
} from "./previewIdentity.ts";

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

describe("claimsChromeAt", () => {
  it("gives Google's sites Electron's own name and claims Chrome everywhere else", () => {
    for (const url of [
      "https://accounts.google.com/v3/signin/identifier",
      "https://analytics.google.com/analytics/web/",
      "https://www.google.co.uk/",
      "https://accounts.google.com.au/",
      "https://www.youtube.com/watch?v=1",
      "https://accounts.google.com./signin",
    ]) {
      expect(claimsChromeAt(url), url).toBe(false);
    }
    for (const url of [
      "https://sso.godaddy.com/",
      "https://notgoogle.com/",
      "https://google.com.example.org/",
      "http://localhost:3000/",
      "about:blank",
      "not a url",
    ]) {
      expect(claimsChromeAt(url), url).toBe(true);
    }
  });
});

describe("followSiteIdentity", () => {
  const identity = chromeIdentity(onThisMac);

  let nextPageId = 1;
  function page(url: string) {
    const contents = Object.assign(new EventEmitter(), {
      id: nextPageId++,
      url,
      getURL: () => contents.url,
      debugger: {
        sendCommand: vi.fn((_method: string, _params: { readonly userAgent: string }) =>
          Promise.resolve({}),
        ),
      },
    });
    const followed = followSiteIdentity(contents as unknown as Electron.WebContents, identity);
    const sent = () =>
      contents.debugger.sendCommand.mock.calls.map(([, params]) =>
        params.userAgent === "" ? "own" : "chrome",
      );
    return { contents, followed, sent };
  }

  it("changes name as a navigation crosses onto Google's sites and back, before it loads", () => {
    const { contents, followed, sent } = page("https://sso.godaddy.com/");
    expect(sent()).toEqual(["chrome"]);

    contents.emit("did-start-navigation", {
      url: "https://accounts.google.com/signin",
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(sent()).toEqual(["chrome", "own"]);
    // A frame or worker appearing meanwhile belongs to the page still shown.
    expect(followed.current()).toBe(identity);

    // A frame's navigation and a same-document one leave the page's name alone.
    contents.emit("did-start-navigation", {
      url: "https://example.com/",
      isMainFrame: false,
      isSameDocument: false,
    });
    contents.emit("did-start-navigation", {
      url: "https://example.com/#top",
      isMainFrame: true,
      isSameDocument: true,
    });
    expect(sent()).toEqual(["chrome", "own"]);

    // Redirected off Google's sites on the way.
    contents.emit("did-redirect-navigation", { url: "https://example.com/", isMainFrame: true });
    expect(sent()).toEqual(["chrome", "own", "chrome"]);
  });

  it("goes back to the page's own site's name when a navigation never arrives", () => {
    const { contents, sent } = page("https://sso.godaddy.com/");
    contents.emit("did-start-navigation", {
      url: "https://accounts.google.com/signin",
      isMainFrame: true,
      isSameDocument: false,
    });
    contents.emit("did-stop-loading");
    expect(sent()).toEqual(["chrome", "own", "chrome"]);
  });

  it("names each page load request for the site it goes to, while the page is followed", () => {
    const { contents, followed } = page("https://www.google.com/search?q=godaddy");
    const own = "Mozilla/5.0 (own) Electron/45.2.1";
    const load = (url: string) => pageLoadUserAgent({ url, webContentsId: contents.id }, own);

    // A search result's link goes through google.com, then on to the site.
    expect(load("https://www.google.com/goto?url=x")).toBe(own);
    expect(load("https://sso.godaddy.com/")).toBe(identity.userAgent);
    // Requests from elsewhere, and from a page no longer followed, are left alone.
    expect(pageLoadUserAgent({ url: "https://sso.godaddy.com/" }, own)).toBeNull();
    followed.stop();
    expect(load("https://sso.godaddy.com/")).toBeNull();
  });
});

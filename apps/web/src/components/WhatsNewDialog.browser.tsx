import "../index.css";

import type { DesktopBridge } from "@threadlines/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { claimUpdateNotice } from "../lib/whatsNew";
import { ToastProvider, toastManager } from "./ui/toast";
import {
  announceUpdateOnce,
  closeWhatsNewDialog,
  openWhatsNewDialog,
  WhatsNewDialogHost,
} from "./WhatsNewDialog";
import { resetTestPage } from "../lib/testPage.browser-harness";

// The notice stack reads the open thread from the route; there is no route here.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => undefined,
}));

// A nightly build, whose menu also holds every stable release before it.
vi.mock("../branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../branding")>()),
  APP_VERSION: "0.8.0-nightly.20261028.354",
  APP_BUILD_CHANNEL_LABEL: "Nightly",
}));

const githubRelease = (version: string, body: string) => ({
  tag_name: `v${version}`,
  body,
  html_url: `https://github.com/Threadlines/threadlines/releases/tag/v${version}`,
  published_at: "2026-10-28T12:00:00Z",
  draft: false,
});

/** Builds 354 (the new block, raw titles), 353 (bullets only) and 352, newest first. */
const nightlyReleases = () => [
  githubRelease(
    "0.8.0-nightly.20261028.354",
    '## What\'s Changed\n\n<!-- threadlines-release-notes {"v":2,"changes":[{"title":"fix: a computer on 0.7.1 keeps working","pullRequest":688},{"title":"docs: a note","pullRequest":689}]} -->',
  ),
  githubRelease(
    "0.8.0-nightly.20261028.353",
    [
      "## What's Changed",
      "",
      "- feat(web): rename computers from the Fleet list by @badcuban in https://github.com/Threadlines/threadlines/pull/691",
      "- docs(marketing): record the Fleet video by @badcuban in https://github.com/Threadlines/threadlines/pull/690",
      "- fix(deps): bump hono for the serveStatic path bypass by @badcuban in https://github.com/Threadlines/threadlines/pull/702",
    ].join("\n"),
  ),
  githubRelease(
    "0.8.0-nightly.20261028.352",
    "## What's Changed\n\n- fix: older by @x in https://github.com/x/y/pull/1",
  ),
];

let mounted: Awaited<ReturnType<typeof render>> | null = null;

async function mountDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mounted = await render(
    <QueryClientProvider client={queryClient}>
      <WhatsNewDialogHost />
    </QueryClientProvider>,
  );
  openWhatsNewDialog();
}

describe("What's new", () => {
  afterEach(async () => {
    closeWhatsNewDialog();
    toastManager.close();
    await mounted?.unmount();
    mounted = null;
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "desktopBridge");
    localStorage.removeItem("threadlines:whats-new:v1");
    await resetTestPage();
  });

  it("groups a nightly's changes by type across builds and keeps earlier nightlies closed until opened", async () => {
    window.desktopBridge = {
      getPreviousAppVersion: () => "0.8.0-nightly.20261028.352",
    } as unknown as DesktopBridge;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json(nightlyReleases()));
    await mountDialog();

    const list = page.getByTestId("whats-new-nightly");
    await expect
      .element(list)
      .toMatchTextContent(/3 changes since build 352, the one you had before/);
    // New, then Security, then Fixed across builds 354 and 353 combined.
    await expect
      .element(list)
      .toMatchTextContent(
        /New1Rename computers from the Fleet listSecurity1Bump hono for the serveStatic path bypassFixed1A computer on 0\.7\.1 keeps working/,
      );
    await expect.element(list).not.toMatchTextContent(/Fleet video/);
    // Earlier builds start closed and open on click.
    const earlier = page.getByTestId("whats-new-nightly-earlier");
    const earlierTrigger = earlier.getByRole("button", { name: /Earlier builds since v0\.7\.1/ });
    await expect.element(earlierTrigger).toHaveAttribute("aria-expanded", "false");
    await expect.element(earlierTrigger).toMatchTextContent(/Newest build · 1 change/);
    await expect.element(earlier.getByText("Build 352")).not.toBeInTheDocument();

    await earlierTrigger.click();
    await expect.element(earlierTrigger).toHaveAttribute("aria-expanded", "true");
    await expect.element(earlier).toMatchTextContent(/Build 352.*Fixed1Older/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("says what a nightly brings the first time it opens, and opens What's new from it", async () => {
    window.desktopBridge = {
      getPreviousAppVersion: () => "0.8.0-nightly.20261028.352",
      claimUpdateNotice: async () => true,
    } as unknown as DesktopBridge;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(nightlyReleases()));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mounted = await render(
      <ToastProvider>
        <QueryClientProvider client={queryClient}>
          <WhatsNewDialogHost />
        </QueryClientProvider>
      </ToastProvider>,
    );

    await announceUpdateOnce();
    await expect.element(page.getByText("Updated to Nightly 354")).toBeVisible();
    await expect.element(page.getByText("3 changes since build 352")).toBeVisible();
    await page.getByRole("button", { name: "What's new" }).click();
    await expect.element(page.getByTestId("whats-new-nightly")).toBeVisible();
    await expect.element(page.getByText("Updated to Nightly 354")).not.toBeInTheDocument();
  });

  it("pages back past newer builds when they push the range off the first page", async () => {
    window.desktopBridge = {
      getPreviousAppVersion: () => "0.8.0-nightly.20261028.352",
    } as unknown as DesktopBridge;
    const newer = Array.from({ length: 30 }, (_, index) =>
      githubRelease(`0.8.1-nightly.20261102.${370 - index}`, "## What's Changed\n"),
    );
    const inRange = [
      githubRelease(
        "0.8.0-nightly.20261028.354",
        "## What's Changed\n\n- fix: a thing by @x in https://github.com/x/y/pull/2",
      ),
      githubRelease("0.8.0-nightly.20261028.352", "## What's Changed\n"),
    ];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        Response.json(String(input).includes("per_page=100") ? [...newer, ...inRange] : newer),
      );
    await mountDialog();

    await expect
      .element(page.getByTestId("whats-new-nightly"))
      .toMatchTextContent(/1 change since build 352, the one you had before/);
    expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining("per_page=30&page=1"),
      expect.stringContaining("per_page=100&page=1"),
    ]);
  });

  it("shows a stable release's notes when picked from the menu", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json([]));
    await mountDialog();

    await page.getByTestId("whats-new-release-picker").click();
    await page.getByRole("option", { name: /^v0\.7\.1/ }).click();
    const release = page.getByTestId("whats-new-release");
    await expect.element(release).toHaveAttribute("data-version", "0.7.1");
    await expect.element(release).toMatchTextContent(/MCP apps show in the chat/);
  });

  it("moves the device's record on once, even when two tabs claim it together", async () => {
    localStorage.setItem(
      "threadlines:whats-new:v1",
      JSON.stringify({ current: "0.7.1", previous: null, newest: "0.7.1" }),
    );

    const claims = await Promise.all([claimUpdateNotice(), claimUpdateNotice()]);
    expect(claims.toSorted()).toEqual([false, true]);
    expect(await claimUpdateNotice()).toBe(false);
    expect(JSON.parse(localStorage.getItem("threadlines:whats-new:v1") ?? "null")).toEqual({
      current: "0.8.0-nightly.20261028.354",
      previous: "0.7.1",
      newest: "0.8.0-nightly.20261028.354",
    });
  });
});

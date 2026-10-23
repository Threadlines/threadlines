import "../../index.css";

import {
  AgentPageId,
  AgentPageVersionId,
  EnvironmentId,
  ThreadId,
  TurnId,
} from "@threadlines/contracts";
import { AGENT_PAGE_MIN_HEIGHT, type AgentPageContentSize } from "@threadlines/shared/agentPages";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AgentPageFrame } from "./AgentPageFrame";
import { AgentPageRow } from "./AgentPageRow";
import { ExpandedImageViewerHost } from "./ExpandedImageDialog";

// Stored pages by version id: what `pages.read` would return.
const storedPages = vi.hoisted(() => new Map<string, string>());

vi.mock("./agentPageClient", async () => {
  const { AGENT_PAGE_FALLBACK_THEMES } = await import("@threadlines/shared/agentPages");
  const theme = AGENT_PAGE_FALLBACK_THEMES.dark;
  const stored = (ref: { readonly versionId: string }) => ({
    kind: "html" as const,
    content: storedPages.get(ref.versionId) ?? "",
  });
  return {
    cachedAgentPageContent: stored,
    readAgentPageContent: (ref: { readonly versionId: string }) => Promise.resolve(stored(ref)),
    useAgentPageTheme: () => theme,
  };
});

const versionOf = (versionId: string, content: string) => {
  storedPages.set(versionId, content);
  return {
    environmentId: EnvironmentId.make("environment-local"),
    threadId: ThreadId.make("thread-pages"),
    pageId: AgentPageId.make("page-1"),
    versionId: AgentPageVersionId.make(versionId),
  };
};

// A page's attempt to hide that it is leaving: a capturing listener of its own
// that stops the event before the wrapper's hears it.
const SILENCE_LEAVING = `addEventListener("pagehide", function (event) { event.stopImmediatePropagation(); }, true);`;
const LEAVE = `location.href = "data:text/html,<p>gone</p>";`;

/**
 * Every load of a frame in the document, with the window it loaded in, from
 * before the frame exists: a load that already happened is never waited for.
 * Loads do not bubble, but they are captured on the way down.
 */
function watchFrameLoads() {
  const windows: Array<Window | null> = [];
  const onLoad = (event: Event) => {
    if (event.target instanceof HTMLIFrameElement) windows.push(event.target.contentWindow);
  };
  document.addEventListener("load", onLoad, true);
  return { windows, stop: () => document.removeEventListener("load", onLoad, true) };
}

/** An inline picture of the given size and color. */
const picture = (color: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="${color}"/></svg>`)}`;

/** The frame decides what a load means as it happens; this is time for the answer to show. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 150));

/** Which of a frame's edges fade out, read from its mask. */
function fadedEdges(frame: HTMLElement) {
  const mask = frame.style.maskImage;
  return {
    top: mask.startsWith("linear-gradient(transparent"),
    bottom: mask.endsWith("transparent)"),
  };
}

describe("AgentPageFrame", () => {
  let loads: ReturnType<typeof watchFrameLoads> | undefined;
  afterEach(() => loads?.stop());

  it("keeps showing a page whose row is moved in the document", async () => {
    loads = watchFrameLoads();
    const { windows } = loads;
    const version = versionOf("moved", "<p>Signups by week</p>");
    await render(
      <div data-testid="rows">
        <div data-testid="row-above">A step</div>
        <div data-testid="page-row" style={{ height: 160 }}>
          <AgentPageFrame version={version} title="Signups" className="size-full" />
        </div>
      </div>,
    );
    await vi.waitFor(() => expect(windows).toHaveLength(1));
    const frame = document.querySelector("iframe");

    // What the timeline's list does when it re-sorts its rows, in a browser
    // that cannot move a row in place: the row leaves the document and comes
    // back, and the frame loads its page again in a new window.
    const rows = page.getByTestId("rows").element();
    rows.insertBefore(page.getByTestId("page-row").element(), rows.firstChild);
    await vi.waitFor(() => expect(windows).toHaveLength(2));
    // Compared here, not by a matcher: it may not look inside another origin's window.
    expect(windows[0] === windows[1]).toBe(false);

    await settled();
    expect(page.getByText(/was stopped/).elements()).toHaveLength(0);
    expect(document.querySelector("iframe")).toBe(frame);
  });

  it("opens the page's pictures in the image viewer at the one the reader clicked", async () => {
    const version = versionOf(
      "pictures",
      `<img src="${picture("red")}" alt="Before"><img src="${picture("green")}" alt="After">` +
        `<a href="https://example.com"><img src="${picture("blue")}" alt="A link"></a>` +
        `<img src="${picture("gray")}" alt="Handled">` +
        // A page handling its pictures' clicks itself, from the document.
        `<script>document.addEventListener("click", function (event) { if (event.target.alt === "Handled") event.preventDefault(); });</script>`,
    );
    await render(
      <div style={{ height: 160 }}>
        <AgentPageFrame version={version} title="Screens" className="size-full" />
        <ExpandedImageViewerHost />
      </div>,
    );
    const frame = page.frameLocator(page.getByTitle("Screens"));
    const viewer = page.getByRole("dialog", { name: "Expanded image preview" });
    await frame.getByAltText("Handled").click();
    await settled();
    expect(viewer.elements()).toHaveLength(0);

    await frame.getByAltText("After").click();
    // Three pictures: the one inside a link stays the link's.
    await expect.element(viewer.getByText("After (2/3)")).toBeVisible();
    expect(viewer.getByRole("img").element().getAttribute("src")).toBe(picture("green"));
    await userEvent.keyboard("{Escape}");
  });

  it("stops a page that leaves after it loaded, though it hides that it is leaving", async () => {
    const version = versionOf(
      "leaves-later",
      `<p>About to leave</p><script>${SILENCE_LEAVING} addEventListener("load", function () { setTimeout(function () { ${LEAVE} }, 50); });</script>`,
    );
    await render(
      <div style={{ height: 160 }}>
        <AgentPageFrame version={version} title="Later" className="size-full" />
      </div>,
    );

    await expect
      .element(page.getByText("Later tried to open another page and was stopped."))
      .toBeVisible();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("says a page is loading until its own load handlers have laid it out", async () => {
    const version = versionOf(
      "lays-out-on-load",
      `<div id="chart" style="height: 50px"></div><script>addEventListener("load", function () { document.getElementById("chart").style.height = "300px"; });</script>`,
    );
    const sizes: AgentPageContentSize[] = [];
    await render(
      <div style={{ height: 160 }}>
        <AgentPageFrame
          version={version}
          title="Chart"
          className="size-full"
          onContentSize={(size) => sizes.push(size)}
        />
      </div>,
    );
    await vi.waitFor(() => expect(sizes.some((size) => size.loaded)).toBe(true));
    await settled();
    expect(sizes[0]?.loaded).toBe(false);
    expect(sizes[0]?.height).toBeLessThan(300);
    expect(sizes.filter((size) => size.loaded).map((size) => size.height)).toEqual([300]);
  });

  it("fades the edge a page goes on past, and follows the reader's scrolling", async () => {
    const version = versionOf("tall", `<div style="height: 600px">A long report</div>`);
    const short = versionOf("short", `<p>A short note</p>`);
    // Held at the frame's height, it outgrows its body without the body
    // changing size.
    const board = versionOf(
      "board",
      `<style>html, body { height: 100% }</style><div id="list" style="height: 40px">Tasks</div>` +
        `<script>addEventListener("load", function () { setTimeout(function () { document.getElementById("list").style.height = "600px"; }, 100); });</script>`,
    );
    await render(
      <div>
        <div style={{ height: 160 }}>
          <AgentPageFrame version={version} title="Report" className="size-full" />
        </div>
        <div style={{ height: 160 }}>
          <AgentPageFrame version={short} title="Note" className="size-full" />
        </div>
        <div style={{ height: 160 }}>
          <AgentPageFrame version={board} title="Board" className="size-full" />
        </div>
      </div>,
    );
    const frame = page.getByTitle("Report").element() as HTMLElement;
    await vi.waitFor(() => expect(fadedEdges(frame)).toEqual({ top: false, bottom: true }));

    await userEvent.wheel(frame, { delta: { y: 200 } });
    await vi.waitFor(() => expect(fadedEdges(frame)).toEqual({ top: true, bottom: true }));
    await userEvent.wheel(frame, { delta: { y: 1000 } });
    await vi.waitFor(() => expect(fadedEdges(frame)).toEqual({ top: true, bottom: false }));

    expect(fadedEdges(page.getByTitle("Note").element() as HTMLElement)).toEqual({
      top: false,
      bottom: false,
    });
    const boardFrame = page.getByTitle("Board").element() as HTMLElement;
    await vi.waitFor(() => expect(fadedEdges(boardFrame)).toEqual({ top: false, bottom: true }));
  });
});

describe("AgentPageRow", () => {
  it("lets a page shrink its frame once it has loaded, not while it is loading", async () => {
    // Reports spaced apart, as a page's pictures come in: each is drawn. The
    // last says loading and nothing follows it, as when something the page
    // waits for never comes: in time it is taken at its word.
    const report = (height: number, loaded: boolean, delay: number) =>
      `setTimeout(function () { parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: ${height}, loaded: ${loaded} } }, "*"); }, ${delay});`;
    const version = versionOf(
      "loading",
      `<div style="height: 300px">A chart</div><script>addEventListener("load", function () { ${report(40, false, 50)} ${report(120, true, 200)} ${report(40, false, 1000)} });</script>`,
    );
    const frameHeights: number[] = [];
    let shrunkAt: number | undefined;
    const watch = new MutationObserver(() => {
      const frame = document.querySelector("iframe");
      if (!frame) return;
      frameHeights.push(frame.getBoundingClientRect().height);
      if (frameHeights.at(-1) === AGENT_PAGE_MIN_HEIGHT) shrunkAt ??= performance.now();
    });
    watch.observe(document.body, { attributes: true, childList: true, subtree: true });
    // When the page's last report came: an older report's wait must not end early.
    let lastLoadingReportAt = 0;
    const onReport = (event: MessageEvent) => {
      if (event.data?.params?.loaded === false) lastLoadingReportAt = performance.now();
    };
    window.addEventListener("message", onReport);
    try {
      await render(
        <div style={{ width: 600 }}>
          <AgentPageRow
            environmentId={version.environmentId}
            threadId={version.threadId}
            page={{
              pageId: version.pageId,
              versionId: version.versionId,
              version: 1,
              turnId: TurnId.make("turn-1"),
              participantId: null,
              title: "Chart",
              kind: "html",
              height: 300,
              heights: [
                [288, 300],
                [1144, 300],
              ],
              createdAt: "2026-10-23T12:00:00.000Z",
              updatedAt: "2026-10-23T12:00:00.000Z",
            }}
            updated={false}
          />
        </div>,
      );
      const frame = page.getByTitle("Chart");
      await expect
        .poll(() => frame.element().getBoundingClientRect().height, { timeout: 5_000 })
        .toBe(AGENT_PAGE_MIN_HEIGHT);
      const drawn = frameHeights.filter((height, index) => height !== frameHeights[index - 1]);
      expect(drawn).toEqual([300, 120, AGENT_PAGE_MIN_HEIGHT]);
      expect(shrunkAt! - lastLoadingReportAt).toBeGreaterThanOrEqual(1_950);
    } finally {
      watch.disconnect();
      window.removeEventListener("message", onReport);
    }
  });
});

import "../../index.css";

import { AgentPageId, AgentPageVersionId, EnvironmentId, ThreadId } from "@threadlines/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AgentPageFrame } from "./AgentPageFrame";
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
});

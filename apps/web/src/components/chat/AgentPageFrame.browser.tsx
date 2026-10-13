import "../../index.css";

import { AgentPageId, AgentPageVersionId, EnvironmentId, ThreadId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AgentPageFrame } from "./AgentPageFrame";

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

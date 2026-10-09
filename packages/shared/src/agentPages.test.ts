import {
  AgentPageId,
  type AgentPagePublication,
  AgentPageVersionId,
  type OrchestrationAgentPage,
  TurnId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_PAGE_COLUMN_WIDTH,
  AGENT_PAGE_FALLBACK_THEMES,
  AGENT_PAGE_MAX_HEIGHT,
  agentPageFrameHeight,
  agentPageShareLink,
  applyAgentPagePublication,
  buildAgentPageDocument,
  readAgentPageHeights,
  readAgentPageLinkRequest,
} from "./agentPages.ts";

const theme = AGENT_PAGE_FALLBACK_THEMES.dark;

// Where the wrapper's policy sits relative to the page's first own markup.
const policyIndex = (document: string) => document.indexOf('http-equiv="Content-Security-Policy"');

describe("buildAgentPageDocument", () => {
  it("puts the content policy before everything the page says, keeping a doctype first", () => {
    const page = "<!-- note --> <!DOCTYPE html><script>steal()</script><html><head></head></html>";
    const document = buildAgentPageDocument({ content: page, kind: "html", theme });
    expect(document.startsWith("<!-- note --> <!DOCTYPE html>")).toBe(true);
    expect(policyIndex(document)).toBeGreaterThan(0);
    expect(policyIndex(document)).toBeLessThan(document.indexOf("steal()"));
  });

  it("adds a doctype when the page has none, so it never renders in quirks mode", () => {
    const document = buildAgentPageDocument({
      content: "<div>chart</div>",
      kind: "html",
      theme,
    });
    expect(document.startsWith("<!doctype html>")).toBe(true);
    expect(policyIndex(document)).toBeLessThan(document.indexOf("<div>chart</div>"));
  });

  it("blocks remote images and requests to hosts outside the CDN list", () => {
    const document = buildAgentPageDocument({ content: "", kind: "html", theme });
    expect(document).toContain("img-src data: blob:;");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("form-action 'none'");
  });

  it("renders a Markdown document with raw HTML shown as text", () => {
    const document = buildAgentPageDocument({
      content: "# Plan\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n<script>bad()</script>",
      kind: "markdown",
      theme,
    });
    expect(document).toContain("<h1>Plan</h1>");
    expect(document).toContain("<table>");
    expect(document).not.toContain("<script>bad()");
  });

  it("keeps theme values from closing the style rule they sit in", () => {
    const document = buildAgentPageDocument({
      content: "",
      kind: "html",
      theme: { appearance: "dark", variables: { "--background": "red;}</style><script>x()" } },
    });
    expect(document).not.toContain("</style><script>x()");
  });
});

describe("agentPageFrameHeight", () => {
  const heights = readAgentPageHeights([
    [375, 900],
    [880, 600],
    [1144, 560],
  ]);

  it("fits the page measured at the nearest widths, taking the taller", () => {
    expect(agentPageFrameHeight({ height: 2000, heights }, 600)).toBe(900);
    expect(agentPageFrameHeight({ height: 2000, heights }, AGENT_PAGE_COLUMN_WIDTH)).toBe(600);
  });

  it("prefers the page's own reported height once it has one", () => {
    expect(agentPageFrameHeight({ height: 2000, heights }, 880, 640)).toBe(640);
  });

  it("caps the frame at the agent's height only when the agent asked for a scrolling frame", () => {
    expect(agentPageFrameHeight({ height: 300, heights }, 880, 640)).toBe(300);
    expect(agentPageFrameHeight({ height: 800, heights }, 880, 1200)).toBe(1200);
    expect(agentPageFrameHeight({ height: 5000 }, 880, 9000)).toBe(AGENT_PAGE_MAX_HEIGHT);
  });

  it("refuses malformed measurements", () => {
    expect(readAgentPageHeights([[880, "tall"]])).toBeUndefined();
    expect(readAgentPageHeights([])).toBeUndefined();
  });
});

describe("readAgentPageLinkRequest", () => {
  it("accepts only http(s) links", () => {
    const request = (url: string) => ({
      jsonrpc: "2.0",
      id: "tl-link-1",
      method: "ui/open-link",
      params: { url },
    });
    expect(readAgentPageLinkRequest(request("https://example.com/a"))?.url).toBe(
      "https://example.com/a",
    );
    expect(readAgentPageLinkRequest(request("javascript:alert(1)"))).toBeUndefined();
    expect(readAgentPageLinkRequest(request("file:///etc/passwd"))).toBeUndefined();
  });
});

describe("agentPageShareLink", () => {
  it("opens only https links, and names the place by its host", () => {
    expect(agentPageShareLink("https://claude.ai/artifact/abc")).toEqual({
      url: "https://claude.ai/artifact/abc",
      host: "claude.ai",
    });
    expect(agentPageShareLink(undefined)).toBeNull();
    expect(agentPageShareLink("http://claude.ai/artifact/abc")).toBeNull();
    expect(agentPageShareLink("javascript:alert(1)")).toBeNull();
    // A link that hides its real host behind a login part.
    expect(agentPageShareLink("https://claude.ai@evil.example/artifact")).toBeNull();
  });
});

describe("applyAgentPagePublication", () => {
  // Plain strings for ids keep the cases readable; branded where the type needs it.
  const publication = (overrides: {
    readonly versionId: string;
    readonly version: number;
    readonly pageId?: string;
    readonly turnId?: string;
    readonly title?: string;
  }): AgentPagePublication => ({
    pageId: AgentPageId.make(overrides.pageId ?? "page-1"),
    versionId: AgentPageVersionId.make(overrides.versionId),
    version: overrides.version,
    turnId: TurnId.make(overrides.turnId ?? "turn-1"),
    participantId: null,
    title: overrides.title ?? "Funnel",
    kind: "html",
    height: 400,
  });
  const apply = (
    pages: ReadonlyArray<OrchestrationAgentPage>,
    page: AgentPagePublication,
    sequence: number,
  ) =>
    applyAgentPagePublication(pages, page, {
      sequence,
      occurredAt: `2026-10-09T00:00:0${sequence}Z`,
    });

  it("replaces a page in place when its turn publishes it again", () => {
    let pages = apply([], publication({ versionId: "v1", version: 1 }), 1);
    pages = apply(pages, publication({ pageId: "page-2", versionId: "w1", version: 1 }), 2);
    pages = apply(pages, publication({ versionId: "v2", version: 2, title: "Funnel, live" }), 3);
    expect(pages.map((page) => [page.pageId, page.versionId, page.placementSequence])).toEqual([
      ["page-1", "v2", 1],
      ["page-2", "w1", 2],
    ]);
  });

  it("gives a later turn's update a place of its own, keeping the earlier turn's version", () => {
    let pages = apply([], publication({ versionId: "v1", version: 1 }), 1);
    pages = apply(pages, publication({ versionId: "v2", version: 2, turnId: "turn-2" }), 5);
    expect(pages.map((page) => [page.turnId, page.versionId])).toEqual([
      ["turn-1", "v1"],
      ["turn-2", "v2"],
    ]);
  });

  it("ignores a publish older than the version already shown", () => {
    const pages = apply([], publication({ versionId: "v3", version: 3 }), 1);
    expect(apply(pages, publication({ versionId: "v2", version: 2 }), 2)).toBe(pages);
  });
});

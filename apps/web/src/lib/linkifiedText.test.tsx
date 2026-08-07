import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LinkifiedText } from "./linkifiedText";

describe("LinkifiedText", () => {
  it("turns a URL in provider detail text into a new-tab link and leaves the sentence intact", () => {
    const markup = renderToStaticMarkup(
      <LinkifiedText text="CLI not detected. Install it from https://claude.ai/download, then sign in." />,
    );

    expect(markup).toContain('href="https://claude.ai/download"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    // The trailing comma belongs to the sentence, not the address.
    expect(markup).not.toContain("https://claude.ai/download,&quot;");
    expect(markup.replace(/<[^>]*>/gu, "")).toBe(
      "CLI not detected. Install it from https://claude.ai/download, then sign in.",
    );
  });

  it("renders text without a URL as plain text", () => {
    expect(renderToStaticMarkup(<LinkifiedText text="CLI not detected on PATH." />)).toBe(
      "CLI not detected on PATH.",
    );
  });
});

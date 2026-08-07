import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { LinkifiedText, splitTextIntoLinkSegments } from "./linkifiedText";

describe("LinkifiedText", () => {
  it("turns a URL in provider detail text into a new-tab link and leaves the sentence intact", () => {
    const text = "CLI not detected. Install it from https://claude.ai/download, then sign in.";
    const markup = renderToStaticMarkup(<LinkifiedText text={text} />);

    expect(markup).toContain('href="https://claude.ai/download"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    // The trailing comma belongs to the sentence, not the address.
    expect(markup).not.toContain("https://claude.ai/download,&quot;");
    // Concatenating the segments reproduces the input byte for byte: making
    // the URL clickable drops and reorders nothing.
    const segments = splitTextIntoLinkSegments(text);
    expect(segments.map((segment) => segment.value).join("")).toBe(text);
    expect(segments.filter((segment) => segment.kind === "link").map((s) => s.value)).toEqual([
      "https://claude.ai/download",
    ]);
  });

  it("renders text without a URL as plain text", () => {
    expect(renderToStaticMarkup(<LinkifiedText text="CLI not detected on PATH." />)).toBe(
      "CLI not detected on PATH.",
    );
  });
});

import { describe, expect, it } from "vite-plus/test";

import { extractHtmlTitle, isHtmlContentType } from "./probeHttpServer.ts";

describe("extractHtmlTitle", () => {
  it("reads a title across attributes and newlines", () => {
    expect(extractHtmlTitle('<html><head><title data-x="1">My\n  Dev App</title>')).toBe(
      "My Dev App",
    );
  });

  it("returns null when there is no usable title", () => {
    expect(extractHtmlTitle("<html><head></head>")).toBeNull();
    expect(extractHtmlTitle("<title>   </title>")).toBeNull();
  });
});

describe("isHtmlContentType", () => {
  it("accepts html with a charset", () => {
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
  });

  it("rejects everything else, including a missing header", () => {
    // AirPlay answers without a content type; an API serves JSON. Neither is a
    // page you would open in the preview.
    expect(isHtmlContentType(undefined)).toBe(false);
    expect(isHtmlContentType("application/json")).toBe(false);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { distillPageErrors, pageErrorsAttachment } from "./pageErrors";

describe("distillPageErrors", () => {
  it("counts distinct problems once each, however often they recur", () => {
    const items = distillPageErrors({
      console: [
        // Chromium's shadow of a failed request: the network entry below
        // already carries it, with the URL and status this line lacks.
        {
          level: "error",
          text: "Failed to load resource: the server responded with 429 ()",
          at: "t",
        },
        { level: "error", text: "Uncaught TypeError: x is not a function", at: "t" },
        { level: "error", text: "Uncaught TypeError: x is not a function", at: "t" },
        { level: "warning", text: "deprecated API", at: "t" },
      ],
      networkFailures: [
        // The same path retried with different per-request tokens is one
        // problem, not three.
        { url: "https://a.dev/manuals/notifier?_rsc=abc", status: 429, errorText: null, at: "t" },
        { url: "https://a.dev/manuals/notifier?_rsc=def", status: 429, errorText: null, at: "t" },
        { url: "https://a.dev/manuals/potter?_rsc=abc", status: 429, errorText: null, at: "t" },
        // The page changing its mind is not a failure.
        { url: "https://a.dev/beacon", status: null, errorText: "net::ERR_ABORTED", at: "t" },
      ],
    });

    expect(items).toEqual([
      { kind: "console", text: "Uncaught TypeError: x is not a function", count: 2 },
      { kind: "request", text: "https://a.dev/manuals/notifier (status 429)", count: 2 },
      { kind: "request", text: "https://a.dev/manuals/potter (status 429)", count: 1 },
    ]);
  });
});

describe("pageErrorsAttachment", () => {
  it("names the file after the page and says how often each problem recurred", () => {
    const attachment = pageErrorsAttachment("https://facpmanuals.com/", [
      { kind: "request", text: "https://facpmanuals.com/manuals/notifier (status 429)", count: 3 },
      { kind: "console", text: "Uncaught TypeError", count: 1 },
    ]);

    expect(attachment.name).toBe("page-errors-facpmanuals-com.txt");
    expect(attachment.text).toContain(
      "request failed: https://facpmanuals.com/manuals/notifier (status 429) (3 times)",
    );
    expect(attachment.text).toContain("console error: Uncaught TypeError");
    expect(attachment.text).not.toContain("Uncaught TypeError (1 times)");
  });
});

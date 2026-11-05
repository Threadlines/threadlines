import { describe, expect, it } from "vitest";

import { buildReportIssueBody, buildReportIssueUrl, describeReportSetup } from "./reportIssue.ts";

const DRAFT = {
  title: "Changing the access level opens another chat",
  whatHappened: "The chat jumped.",
  steps: "1. Change the access level",
  expected: "",
  errorText: "",
};

describe("buildReportIssueUrl", () => {
  it("fills in the bug form's fields, leaving out what's empty", () => {
    const url = new URL(
      buildReportIssueUrl({
        version: "0.9.0-nightly.1",
        setup: describeReportSetup({ app: "desktop app", operatingSystem: "Windows" }),
        draft: DRAFT,
      }),
    );

    expect(url.origin + url.pathname).toBe("https://github.com/Threadlines/threadlines/issues/new");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      template: "bug_report.yml",
      title: "[Bug]: Changing the access level opens another chat",
      version: "0.9.0-nightly.1",
      environment: "Windows, desktop app",
      actual: "The chat jumped.",
      steps: "1. Change the access level",
    });
  });

  it("names only how Threadlines is open when the system is unknown", () => {
    expect(describeReportSetup({ app: "browser", operatingSystem: null })).toBe("browser");
  });
});

describe("buildReportIssueBody", () => {
  it("lays the report out like the bug form, ending with the app's hidden line", () => {
    const body = buildReportIssueBody({
      draft: { ...DRAFT, expected: "It stays put." },
      version: "0.9.0",
      setup: "macOS, desktop app",
      submissionId: "4f0c1d2e-9a8b",
    });

    expect(body).toBe(
      [
        "### What happened?\n\nThe chat jumped.",
        "### How can we make it happen?\n\n1. Change the access level",
        "### Version\n\n0.9.0",
        "### Your setup\n\nmacOS, desktop app",
        "### What did you expect instead?\n\nIt stays put.",
        "<!-- threadlines:report-a-problem 4f0c1d2e-9a8b -->\n",
      ].join("\n\n"),
    );
  });

  it("fences error text so backticks inside it can't close the block", () => {
    const body = buildReportIssueBody({
      draft: { ...DRAFT, errorText: "\n  at run (```inline```)\n\n" },
      version: "0.9.0",
      setup: "browser",
    });

    expect(body.endsWith("### Error text or logs\n\n````text\n  at run (```inline```)\n````")).toBe(
      true,
    );
  });
});

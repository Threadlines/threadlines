import { describe, expect, it } from "vitest";

import { buildReportIssueUrl } from "./reportIssue.ts";

describe("buildReportIssueUrl", () => {
  it("fills in the bug form's version and setup fields", () => {
    const url = new URL(
      buildReportIssueUrl({
        version: "0.9.0-nightly.1",
        app: "desktop app",
        operatingSystem: "Windows",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://github.com/Threadlines/threadlines/issues/new");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      template: "bug_report.yml",
      version: "0.9.0-nightly.1",
      environment: "Windows, desktop app",
    });
  });

  it("leaves out what it doesn't know", () => {
    const url = new URL(
      buildReportIssueUrl({ version: "0.9.0", app: "browser", operatingSystem: null }),
    );

    expect(url.searchParams.get("environment")).toBe("browser");
  });
});

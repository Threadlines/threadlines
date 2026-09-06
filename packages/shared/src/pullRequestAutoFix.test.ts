import { describe, expect, it } from "vite-plus/test";

import { buildPullRequestAutoFixPrompt, quotePullRequestBody } from "./pullRequestAutoFix.ts";

describe("buildPullRequestAutoFixPrompt", () => {
  it("says nothing when nothing is new", () => {
    expect(
      buildPullRequestAutoFixPrompt({
        number: 12,
        repository: "acme/widgets",
        failingChecks: [],
        comments: [],
      }),
    ).toBeNull();
  });

  it("lists failing checks with their urls and closes with what to do", () => {
    expect(
      buildPullRequestAutoFixPrompt({
        number: 12,
        repository: "acme/widgets",
        failingChecks: [
          { name: "typecheck", url: "https://example.test/runs/1" },
          { name: "lint", url: null },
        ],
        comments: [],
      }),
    ).toBe(
      [
        "Pull request #12 on acme/widgets needs attention.",
        "",
        "These checks failed:",
        "- typecheck (https://example.test/runs/1)",
        "- lint",
        "",
        "Fix what needs fixing, run the project's checks, commit on this branch, and push so the pull request updates.",
      ].join("\n"),
    );
  });

  it("quotes each comment under its author, keeping blank lines apart", () => {
    const prompt = buildPullRequestAutoFixPrompt({
      number: 7,
      repository: "acme/widgets",
      failingChecks: [],
      comments: [
        { author: "dana", body: "This leaks.\r\n\r\nClose the handle." },
        { author: null, body: "Same here." },
      ],
    });

    expect(prompt).toBe(
      [
        "Pull request #7 on acme/widgets needs attention.",
        "",
        "New review comments:",
        "dana wrote:",
        "> This leaks.",
        ">",
        "> Close the handle.",
        "",
        "Someone wrote:",
        "> Same here.",
        "",
        "Fix what needs fixing, run the project's checks, commit on this branch, and push so the pull request updates.",
      ].join("\n"),
    );
  });
});

describe("quotePullRequestBody", () => {
  it("normalizes line endings and drops trailing blank lines", () => {
    expect(quotePullRequestBody("one\r\ntwo\n\n")).toBe("> one\n> two");
  });
});

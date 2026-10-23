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

  it("leads with the merge queue giving it back, and says a flaky test needs no change", () => {
    expect(
      buildPullRequestAutoFixPrompt({
        number: 278,
        repository: "acme/widgets",
        failingChecks: [],
        comments: [],
        mergeQueueFailure: {
          baseBranch: "main",
          failedChecks: [{ name: "Browser Test", url: "https://example.test/runs/2" }],
        },
      }),
    ).toBe(
      [
        "Pull request #278 on acme/widgets needs attention.",
        "",
        "The merge queue took it out because these checks failed when it was merged with the latest main:",
        "- Browser Test (https://example.test/runs/2)",
        "A failure there can come from newer changes on main or from a flaky test. If nothing needs changing, say so and leave the branch alone. It goes back in the queue on its own once its checks pass.",
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

  it("sends the agent to the folder a branch other than its own is checked out in", () => {
    const failing = {
      number: 294,
      repository: "acme/widgets",
      failingChecks: [{ name: "lint" }],
      comments: [],
    };

    expect(
      buildPullRequestAutoFixPrompt({
        ...failing,
        checkout: { kind: "folder", branch: "fix/lint", path: "/repos/widgets-lint" },
      })
        ?.split("\n\n")
        .at(-1),
    ).toBe(
      "Its branch, `fix/lint`, is checked out at `/repos/widgets-lint`, not in this thread's folder. Work in that folder: fix what needs fixing, run the project's checks, commit on that branch, and push so the pull request updates.",
    );
    // With no checkout found, it must not switch the thread's own folder over.
    expect(
      buildPullRequestAutoFixPrompt({
        ...failing,
        checkout: { kind: "unknown", branch: "fix/lint" },
      })
        ?.split("\n\n")
        .at(-1),
    ).toBe(
      "Its branch is `fix/lint`. Work in the folder it is checked out in (`git worktree list` shows where), or check it out in a new worktree, rather than switching this thread's folder to it. Then fix what needs fixing, run the project's checks, commit on that branch, and push so the pull request updates.",
    );
  });
});

describe("quotePullRequestBody", () => {
  it("normalizes line endings and drops trailing blank lines", () => {
    expect(quotePullRequestBody("one\r\ntwo\n\n")).toBe("> one\n> two");
  });
});

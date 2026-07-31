import { assert, it } from "vitest";

import {
  formatReleaseNotes,
  parseCuratedReleaseContent,
  parseGitLogOutput,
} from "./generate-release-notes.ts";

it("formats direct commits in a compact fallback section with a compare link", () => {
  assert.equal(
    formatReleaseNotes({
      channel: "nightly",
      currentTag: "v0.0.18-nightly.20260529.37",
      previousTag: "v0.0.17",
      repository: "Threadlines/threadlines",
      commits: [
        {
          hash: "62ae0936452552cff68db2293db9ad455d981e8b",
          shortHash: "62ae093",
          parentHashes: ["32c77f8a033772bea4f4ff40d75a0fba436ecf4c"],
          subject: "Cache diagnostics reads and reduce background polling",
          body: "",
        },
      ],
    }),
    [
      "## What's Changed",
      "",
      "### Direct changes",
      "",
      "- [`62ae093`](https://github.com/Threadlines/threadlines/commit/62ae0936452552cff68db2293db9ad455d981e8b) Cache diagnostics reads and reduce background polling",
      "",
      "**Full Changelog**: https://github.com/Threadlines/threadlines/compare/v0.0.17...v0.0.18-nightly.20260529.37",
      "",
    ].join("\n"),
  );
});

it("formats locally detected pull requests without per-entry commit SHAs", () => {
  assert.equal(
    formatReleaseNotes({
      channel: "stable",
      currentTag: "v0.0.18",
      previousTag: "v0.0.17",
      repository: "Threadlines/threadlines",
      commits: [
        {
          hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          shortHash: "aaaaaaaa",
          parentHashes: [
            "1111111111111111111111111111111111111111",
            "2222222222222222222222222222222222222222",
          ],
          subject: "Merge pull request #42 from threadlines/release-notes",
          body: "feat(release): improve generated release notes\n\nAdds PR-aware formatting.",
        },
        {
          hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          shortHash: "bbbbbbbb",
          parentHashes: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          subject: "fix(updater): handle updater diagnostics (#43)",
          body: "",
        },
      ],
    }),
    [
      "## What's Changed",
      "",
      "- Improve generated release notes in [#42](https://github.com/Threadlines/threadlines/pull/42)",
      "- Handle updater diagnostics in [#43](https://github.com/Threadlines/threadlines/pull/43)",
      "",
      "**Full Changelog**: https://github.com/Threadlines/threadlines/compare/v0.0.17...v0.0.18",
      "",
    ].join("\n"),
  );
});

it("uses GitHub PR attribution, filters release-preparation noise, and keeps direct commits", () => {
  assert.equal(
    formatReleaseNotes({
      channel: "nightly",
      currentTag: "v0.3.1-nightly.20260731.205",
      previousTag: "v0.3.1-nightly.20260731.204",
      repository: "Threadlines/threadlines",
      commits: [
        {
          hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          shortHash: "aaaaaaaa",
          parentHashes: ["1111111111111111111111111111111111111111"],
          subject: "Add prompt stashing (#93)",
          body: "",
        },
        {
          hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          shortHash: "bbbbbbbb",
          parentHashes: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          subject: "Prepare v0.3.1 changelog and announcement (#96)",
          body: "",
        },
        {
          hash: "cccccccccccccccccccccccccccccccccccccccc",
          shortHash: "cccccccc",
          parentHashes: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
          subject: "Keep updater diagnostics visible",
          body: "",
        },
      ],
      githubGeneratedNotes: `## What's Changed

* Add prompt stashing by @will in https://github.com/Threadlines/threadlines/pull/93
* Prepare v0.3.1 changelog and announcement by @will in https://github.com/Threadlines/threadlines/pull/96

## New Contributors
* @will made their first contribution in https://github.com/Threadlines/threadlines/pull/93
* @release-helper made their first contribution in https://github.com/Threadlines/threadlines/pull/96

**Full Changelog**: https://github.com/Threadlines/threadlines/compare/v0.3.1-nightly.20260731.204...v0.3.1-nightly.20260731.205`,
    }),
    [
      "## What's Changed",
      "",
      "- Add prompt stashing by @will in https://github.com/Threadlines/threadlines/pull/93",
      "",
      "### Direct changes",
      "",
      "- [`cccccccc`](https://github.com/Threadlines/threadlines/commit/cccccccccccccccccccccccccccccccccccccccc) Keep updater diagnostics visible",
      "",
      "## New Contributors",
      "* @will made their first contribution in https://github.com/Threadlines/threadlines/pull/93",
      "",
      "**Full Changelog**: https://github.com/Threadlines/threadlines/compare/v0.3.1-nightly.20260731.204...v0.3.1-nightly.20260731.205",
      "",
    ].join("\n"),
  );
});

it("falls back to locally detected pull requests when GitHub notes are empty or unrecognized", () => {
  for (const githubGeneratedNotes of ["", "GitHub returned an unexpected response."]) {
    const notes = formatReleaseNotes({
      channel: "nightly",
      currentTag: "v0.3.1-nightly.20260731.205",
      previousTag: "v0.3.1-nightly.20260731.204",
      repository: "Threadlines/threadlines",
      commits: [
        {
          hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          shortHash: "aaaaaaaa",
          parentHashes: ["1111111111111111111111111111111111111111"],
          subject: "Add prompt stashing (#93)",
          body: "",
        },
      ],
      githubGeneratedNotes,
    });

    assert.match(
      notes,
      /- Add prompt stashing in \[#93\]\(https:\/\/github\.com\/Threadlines\/threadlines\/pull\/93\)/,
    );
  }
});

it("formats an empty release range", () => {
  assert.equal(
    formatReleaseNotes({
      channel: "stable",
      currentTag: "v0.0.18",
      previousTag: "v0.0.17",
      repository: undefined,
      commits: [],
    }),
    ["## What's Changed", "", "- No commits found in this release range.", ""].join("\n"),
  );
});

it("parses git log records with parent hashes and commit bodies", () => {
  assert.deepEqual(
    parseGitLogOutput(
      [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "aaaaaaaa",
        "1111111111111111111111111111111111111111 2222222222222222222222222222222222222222",
        "Merge pull request #42 from threadlines/release-notes",
        "Improve generated release notes\n\nAdds PR-aware formatting.",
      ].join("\x00") + "\x1e",
    ),
    [
      {
        hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        shortHash: "aaaaaaaa",
        parentHashes: [
          "1111111111111111111111111111111111111111",
          "2222222222222222222222222222222222222222",
        ],
        subject: "Merge pull request #42 from threadlines/release-notes",
        body: "Improve generated release notes\n\nAdds PR-aware formatting.",
      },
    ],
  );
});

it("puts human-reviewed stable highlights before collapsed technical changes", () => {
  const curated = parseCuratedReleaseContent(`---
summary: Goals are easier to start and monitor.
highlights:
  - title: Codex Goals
    description: Set an objective and optional token budget from the composer.
alsoImproved:
  - description: Attach more file types.
---
`);

  const notes = formatReleaseNotes({
    channel: "stable",
    currentTag: "v0.2.5",
    previousTag: "v0.2.4",
    repository: "Threadlines/threadlines",
    commits: [
      {
        hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        shortHash: "aaaaaaaa",
        parentHashes: ["1111111111111111111111111111111111111111"],
        subject: "Add goal monitoring",
        body: "",
      },
    ],
    curated,
  });

  assert.match(notes, /^## Highlights\n\nGoals are easier/);
  assert.match(
    notes,
    /- \*\*Codex Goals\*\* — Set an objective and optional token budget from the composer\./,
  );
  assert.match(notes, /<summary>Complete technical changes<\/summary>/);
  assert.match(notes, /## What's Changed/);
  assert.match(notes, /Add goal monitoring/);
});

it("rejects stable content that is still marked for human review", () => {
  assert.throws(
    () =>
      parseCuratedReleaseContent(`---
reviewRequired: true
summary: Replace this fallback summary.
highlights:
  - title: Review required
    description: Replace this fallback highlight.
alsoImproved: []
---
`),
    /still requires human review/,
  );
});

it("rejects stable content when a fallback TODO remains after the review marker is removed", () => {
  assert.throws(
    () =>
      parseCuratedReleaseContent(`---
summary: Reviewed summary.
highlights:
  - title: Reviewed title
    description: "TODO: replace this fallback description."
alsoImproved: []
---
`),
    /still contains a reserved 'TODO:' human-review placeholder/,
  );
});

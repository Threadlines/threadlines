import { assert, it } from "@effect/vitest";

import { formatReleaseNotes, parseGitLogOutput } from "./generate-release-notes.ts";

it("formats direct commits in categorized sections with commit links and a compare link", () => {
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
      "## What's changed",
      "",
      "Changes since `v0.0.17`.",
      "",
      "### Performance",
      "",
      "- [`62ae093`](https://github.com/Threadlines/threadlines/commit/62ae0936452552cff68db2293db9ad455d981e8b) Cache diagnostics reads and reduce background polling",
      "",
      "**Full Changelog**: https://github.com/Threadlines/threadlines/compare/v0.0.17...v0.0.18-nightly.20260529.37",
      "",
    ].join("\n"),
  );
});

it("formats GitHub merge and squash commits as pull request entries", () => {
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
      "## What's changed",
      "",
      "Changes since `v0.0.17`.",
      "",
      "### Features",
      "",
      "- [#42](https://github.com/Threadlines/threadlines/pull/42) Improve generated release notes ([`aaaaaaaa`](https://github.com/Threadlines/threadlines/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa))",
      "",
      "### Fixes",
      "",
      "- [#43](https://github.com/Threadlines/threadlines/pull/43) Handle updater diagnostics ([`bbbbbbbb`](https://github.com/Threadlines/threadlines/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb))",
      "",
      "**Full Changelog**: https://github.com/Threadlines/threadlines/compare/v0.0.17...v0.0.18",
      "",
    ].join("\n"),
  );
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
    [
      "## What's changed",
      "",
      "Changes since `v0.0.17`.",
      "",
      "- No commits found in this release range.",
      "",
    ].join("\n"),
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

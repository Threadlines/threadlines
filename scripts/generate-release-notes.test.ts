import { assert, it } from "@effect/vitest";

import { formatReleaseNotes, parseGitLogOutput } from "./generate-release-notes.ts";

it("formats direct commits with commit links and a compare link", () => {
  assert.equal(
    formatReleaseNotes({
      channel: "nightly",
      currentTag: "v0.0.18-nightly.20260529.37",
      previousTag: "v0.0.17",
      repository: "badcuban/badcode",
      commits: [
        {
          hash: "62ae0936452552cff68db2293db9ad455d981e8b",
          shortHash: "62ae093",
          parentHashes: ["32c77f8a033772bea4f4ff40d75a0fba436ecf4c"],
          subject: "Configure stable-based nightly releases",
          body: "",
        },
      ],
    }),
    [
      "## Nightly changes",
      "",
      "Changes since `v0.0.17`.",
      "",
      "### Commits",
      "",
      "- [`62ae093`](https://github.com/badcuban/badcode/commit/62ae0936452552cff68db2293db9ad455d981e8b) Configure stable-based nightly releases",
      "",
      "**Full Changelog**: https://github.com/badcuban/badcode/compare/v0.0.17...v0.0.18-nightly.20260529.37",
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
      repository: "badcuban/badcode",
      commits: [
        {
          hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          shortHash: "aaaaaaaa",
          parentHashes: [
            "1111111111111111111111111111111111111111",
            "2222222222222222222222222222222222222222",
          ],
          subject: "Merge pull request #42 from badcuban/release-notes",
          body: "Improve generated release notes\n\nAdds PR-aware formatting.",
        },
        {
          hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          shortHash: "bbbbbbbb",
          parentHashes: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
          subject: "Add updater diagnostics (#43)",
          body: "",
        },
      ],
    }),
    [
      "## Stable changes",
      "",
      "Changes since `v0.0.17`.",
      "",
      "### Pull requests",
      "",
      "- [#42](https://github.com/badcuban/badcode/pull/42) Improve generated release notes ([`aaaaaaaa`](https://github.com/badcuban/badcode/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa))",
      "- [#43](https://github.com/badcuban/badcode/pull/43) Add updater diagnostics ([`bbbbbbbb`](https://github.com/badcuban/badcode/commit/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb))",
      "",
      "**Full Changelog**: https://github.com/badcuban/badcode/compare/v0.0.17...v0.0.18",
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
      "## Stable changes",
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
        "Merge pull request #42 from badcuban/release-notes",
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
        subject: "Merge pull request #42 from badcuban/release-notes",
        body: "Improve generated release notes\n\nAdds PR-aware formatting.",
      },
    ],
  );
});

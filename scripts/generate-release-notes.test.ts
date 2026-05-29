import { assert, it } from "@effect/vitest";

import { formatReleaseNotes } from "./generate-release-notes.ts";

it("formats commit-based release notes with commit links and a compare link", () => {
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
          subject: "Configure stable-based nightly releases",
        },
      ],
    }),
    [
      "## Nightly changes",
      "",
      "Changes since `v0.0.17`.",
      "",
      "- [`62ae093`](https://github.com/badcuban/badcode/commit/62ae0936452552cff68db2293db9ad455d981e8b) Configure stable-based nightly releases",
      "",
      "**Full Changelog**: https://github.com/badcuban/badcode/compare/v0.0.17...v0.0.18-nightly.20260529.37",
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

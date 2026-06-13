import { assert, it } from "@effect/vitest";

import {
  resolveLatestStableTag,
  resolveNightlyBaseVersion,
  resolveNightlyReleaseMetadata,
  resolveNightlyTargetVersion,
  resolveNightlyTargetVersionFromTags,
} from "./resolve-nightly-release.ts";

it("strips prerelease and build metadata when deriving the nightly base version", () => {
  assert.equal(resolveNightlyBaseVersion("0.0.17"), "0.0.17");
  assert.equal(resolveNightlyBaseVersion("9.9.9-smoke.0"), "9.9.9");
  assert.equal(resolveNightlyBaseVersion("1.2.3-beta.4+build.9"), "1.2.3");
});

it("bumps the patch version before deriving nightly prerelease versions", () => {
  assert.equal(resolveNightlyTargetVersion("0.0.17"), "0.0.18");
  assert.equal(resolveNightlyTargetVersion("9.9.9-smoke.0"), "9.9.10");
  assert.equal(resolveNightlyTargetVersion("1.2.3-beta.4+build.9"), "1.2.4");
});

it("resolves the latest plain stable tag before deriving nightly versions", () => {
  const tags = [
    "v0.0.17-nightly.20260413.321",
    "v0.0.16",
    "v0.0.17",
    "v0.0.18-beta.1",
    "not-a-version",
  ];

  assert.equal(resolveLatestStableTag(tags), "v0.0.17");
  assert.equal(resolveNightlyTargetVersionFromTags(tags), "0.0.18");
});

it("defaults the first nightly series to 0.0.1 when no stable tag exists", () => {
  assert.equal(resolveLatestStableTag(["v0.0.1-nightly.20260413.321"]), undefined);
  assert.equal(resolveNightlyTargetVersionFromTags(["v0.0.1-nightly.20260413.321"]), "0.0.1");
});

it("derives nightly metadata including the short commit sha in the release name", () => {
  assert.deepStrictEqual(
    resolveNightlyReleaseMetadata("9.9.10", "20260413", 321, "abcdef1234567890"),
    {
      baseVersion: "9.9.10",
      version: "9.9.10-nightly.20260413.321",
      tag: "v9.9.10-nightly.20260413.321",
      name: "Threadlines Nightly 9.9.10-nightly.20260413.321 (abcdef123456)",
      shortSha: "abcdef123456",
    },
  );
});

import { assert, it } from "@effect/vitest";

import { resolvePreviousReleaseTag, resolveReleaseNotesBaselineTag } from "./release-tags.ts";

it("resolves stable release baselines from plain stable tags only", () => {
  const tags = ["v0.0.16", "v0.0.17", "v0.0.18-nightly.20260529.37", "v0.0.18-beta.1"];

  assert.equal(resolvePreviousReleaseTag("stable", "v0.0.18", tags), "v0.0.17");
  assert.equal(resolveReleaseNotesBaselineTag("stable", "v0.0.18", tags), "v0.0.17");
});

it("resolves nightly release notes against the previous nightly when available", () => {
  const tags = ["v0.0.17", "v0.0.18-nightly.20260529.37", "v0.0.18-nightly.20260529.41"];

  assert.equal(
    resolveReleaseNotesBaselineTag("nightly", "v0.0.18-nightly.20260529.42", tags),
    "v0.0.18-nightly.20260529.41",
  );
});

it("falls nightly release notes back to the latest prior stable tag", () => {
  const tags = ["v0.0.16", "v0.0.17", "v0.0.18-beta.1"];

  assert.equal(
    resolvePreviousReleaseTag("nightly", "v0.0.18-nightly.20260529.37", tags),
    undefined,
  );
  assert.equal(
    resolveReleaseNotesBaselineTag("nightly", "v0.0.18-nightly.20260529.37", tags),
    "v0.0.17",
  );
});

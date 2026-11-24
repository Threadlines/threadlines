import { assert, it } from "@effect/vitest";

import {
  type DriftItem,
  evaluateDrift,
  issueBody,
  issueMarker,
  newestStable,
  planIssueActions,
} from "./check-upstream-drift.ts";

const item = (title: string, pinned: string): DriftItem => ({
  id: title.toLowerCase().replaceAll(/[^a-z]+/g, "-"),
  title,
  name: "the thing at",
  source: "The vendor",
  pinned,
  file: "apps/server/src/thing.ts",
  howToUpdate: ({ version }) => [`Bump it to ${version}.`],
});

it("flags a pin only when a newer stable release is published", () => {
  const pin = item("Upstream drift: thing", "v0.11.3");
  const status = (version: string, ref?: string) =>
    evaluateDrift(pin, { ok: true, published: ref ? { version, ref } : { version } }).status;

  assert.equal(status("1.34.1", "schema-v1.34.1"), "drift");
  assert.equal(status("0.11.10"), "drift");
  assert.equal(status("0.11.3"), "current");
  assert.equal(status("0.11.2"), "current");
  assert.equal(status("0.12.0-beta.1"), "drift");
  assert.equal(status("not a version"), "unchecked");
  assert.equal(evaluateDrift(pin, { ok: false, reason: "timed out" }).status, "unchecked");

  // Numeric order, not text order; prereleases never count as newest.
  assert.equal(newestStable(["v24.9.0", "v24.10.0", "v24.11.0-rc.1", "junk"]), "v24.10.0");
});

it("opens, rewrites and closes one issue per pin, and leaves unchecked pins alone", () => {
  const drifting = item("Upstream drift: drifting", "1.0.0");
  const stale = item("Upstream drift: stale body", "1.0.0");
  const caughtUp = item("Upstream drift: caught up", "2.0.0");
  const unreachable = item("Upstream drift: unreachable", "1.0.0");
  const unchanged = item("Upstream drift: unchanged", "1.0.0");
  const results = [
    evaluateDrift(drifting, { ok: true, published: { version: "1.1.0" } }),
    evaluateDrift(stale, { ok: true, published: { version: "1.2.0" } }),
    evaluateDrift(caughtUp, { ok: true, published: { version: "2.0.0" } }),
    evaluateDrift(unreachable, { ok: false, reason: "403" }),
    evaluateDrift(unchanged, { ok: true, published: { version: "1.1.0" } }),
  ];
  const openIssues = [
    // Renamed by a maintainer: still found by its marker.
    { number: 1, title: "Bump the stale thing", body: issueBody(stale, { version: "1.1.0" }) },
    { number: 2, title: caughtUp.title, body: `${issueMarker(caughtUp.id)}\nold` },
    { number: 3, title: unreachable.title, body: `${issueMarker(unreachable.id)}\nold` },
    { number: 4, title: unchanged.title, body: `${issueBody(unchanged, { version: "1.1.0" })}\n` },
    // Filed by hand under the same title: never edited or closed.
    { number: 5, title: drifting.title, body: "Filed by hand" },
  ];

  const actions = planIssueActions(results, openIssues).map((action) =>
    action.kind === "open" ? `open ${action.title}` : `${action.kind} #${action.number}`,
  );
  assert.deepStrictEqual(actions, ["open Upstream drift: drifting", "update #1", "close #2"]);
});

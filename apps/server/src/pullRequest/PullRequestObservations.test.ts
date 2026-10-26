import type { PullRequestObservation } from "@threadlines/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  make,
  type PullRequestRead,
  recordPullRequestRead,
  type StoredPullRequestRecord,
} from "./PullRequestObservations.ts";

const read = (overrides: Partial<PullRequestRead> = {}): PullRequestRead => ({
  provider: "github",
  repository: "owner/repo",
  number: 42,
  title: "Fix it",
  url: "https://github.com/owner/repo/pull/42",
  headBranch: "fix-it",
  state: "open",
  ...overrides,
});

const after = (
  previous: StoredPullRequestRecord | undefined,
  next: PullRequestRead,
  atMs: number,
) => recordPullRequestRead(previous, next, atMs);

describe("recordPullRequestRead", () => {
  it("keeps the newer state when a read that began earlier lands later", () => {
    const merged = after(undefined, read({ state: "merged" }), 2_000).record;
    const lateOpen = after(merged, read({ state: "open" }), 1_000);
    assert.strictEqual(lateOpen.record.observation.state, "merged");
    assert.isFalse(lateOpen.changed);
  });

  it("keeps what a read did not cover: drafts, auto-merge and checks", () => {
    const full = after(
      undefined,
      read({
        isDraft: true,
        autoMergeEnabled: true,
        checks: { headSha: "abc123", state: "pending" },
      }),
      1_000,
    ).record;
    // A checkout's status read: no draft flag, no checks.
    const status = after(full, read({ title: "Fix it properly" }), 2_000);
    assert.isTrue(status.changed);
    assert.strictEqual(status.record.observation.title, "Fix it properly");
    assert.strictEqual(status.record.observation.isDraft, true);
    assert.strictEqual(status.record.observation.autoMergeEnabled, true);
    assert.deepStrictEqual(status.record.observation.checks?.headSha, "abc123");
    assert.deepStrictEqual(status.record.observation.checks?.state, "pending");
  });

  it("weighs the draft flag only against reads that could tell", () => {
    const draft = after(undefined, read({ isDraft: true }), 1_000).record;
    // A checkout's status read began later but cannot tell drafts apart...
    const status = after(draft, read({}), 3_000).record;
    // ...so a listing that began before it and saw the pull request ready still counts.
    const ready = after(status, read({ isDraft: false }), 2_000);
    assert.strictEqual(ready.record.observation.isDraft, false);
  });

  it("takes checks only from a read that has them, and says nothing changed when nothing did", () => {
    const first = after(
      undefined,
      read({ checks: { headSha: "abc123", state: "pending" } }),
      1_000,
    );
    const passing = after(
      first.record,
      read({ checks: { headSha: "abc123", state: "success" } }),
      2_000,
    );
    assert.isTrue(passing.changed);
    assert.strictEqual(passing.record.observation.checks?.state, "success");
    const again = after(
      passing.record,
      read({ checks: { headSha: "abc123", state: "success" } }),
      3_000,
    );
    assert.isFalse(again.changed);
  });
});

describe("PullRequestObservations", () => {
  it.effect("sends what it has, then each change a read brings, but nothing a read repeats", () =>
    Effect.gen(function* () {
      const observations = yield* make;
      yield* observations.observe(Effect.succeed(1), () => [read()]);

      const heard = yield* observations.stream.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(1_000);
      yield* observations.observe(Effect.succeed(2), () => [read()]);
      yield* observations.observe(Effect.succeed(3), () => [read({ state: "merged" })]);
      yield* observations.observe(Effect.succeed(4), () => [read({ number: 7, url: "u7" })]);

      const records: ReadonlyArray<PullRequestObservation> = yield* Fiber.join(heard);
      assert.deepStrictEqual(
        records.map((record) => [record.number, record.state]),
        [
          [42, "open"],
          [42, "merged"],
          [7, "open"],
        ],
      );
      assert.isTrue(records[1]!.sequence > records[0]!.sequence);
    }),
  );

  it.effect("records nothing for a read that failed", () =>
    Effect.gen(function* () {
      const observations = yield* make;
      const failed = yield* observations
        .observe(Effect.fail("host down" as const), () => [read()])
        .pipe(Effect.flip);
      assert.strictEqual(failed, "host down");
      yield* observations.observe(Effect.succeed(1), () => [read({ number: 7, url: "u7" })]);
      const first = yield* observations.stream.pipe(Stream.take(1), Stream.runCollect);
      assert.strictEqual(first[0]?.number, 7);
    }),
  );
});

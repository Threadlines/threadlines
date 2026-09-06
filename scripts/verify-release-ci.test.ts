import { assert, it } from "@effect/vitest";

import { evaluateRequiredChecks } from "./verify-release-ci.ts";

const CHECK = "Format, Lint, Typecheck, Test, Build";

// A merge landing on main cancels the previous main CI run. The merge queue
// already passed the same checks on that exact commit, so the release gate
// must fall through to that verdict instead of failing on the cancellation.
it("a cancelled newer run yields to an older passing run of the same check", () => {
  const evaluation = evaluateRequiredChecks(
    [CHECK],
    [
      {
        name: CHECK,
        status: "completed",
        conclusion: "success",
        completed_at: "2026-09-06T09:11:40Z",
        html_url: "https://example.test/merge-queue",
      },
      {
        name: CHECK,
        status: "completed",
        conclusion: "cancelled",
        completed_at: "2026-09-06T09:14:50Z",
        html_url: "https://example.test/main-push",
      },
    ],
  );

  assert.deepEqual(evaluation.failures, []);
  assert.deepEqual(evaluation.pending, []);
  assert.equal(evaluation.checksByName.get(CHECK)?.html_url, "https://example.test/merge-queue");
});

it("a newer run still in progress is waited on even when an older run passed", () => {
  const evaluation = evaluateRequiredChecks(
    [CHECK],
    [
      {
        name: CHECK,
        status: "completed",
        conclusion: "success",
        completed_at: "2026-09-06T09:11:40Z",
      },
      {
        name: CHECK,
        status: "in_progress",
        conclusion: null,
        started_at: "2026-09-06T09:12:00Z",
      },
    ],
  );

  assert.deepEqual(evaluation.failures, []);
  assert.equal(evaluation.pending.length, 1);
});

it("a check whose only run was cancelled still fails the gate", () => {
  const evaluation = evaluateRequiredChecks(
    [CHECK],
    [
      {
        name: CHECK,
        status: "completed",
        conclusion: "cancelled",
        completed_at: "2026-09-06T09:14:50Z",
      },
    ],
  );

  assert.equal(evaluation.failures.length, 1);
  assert.deepEqual(evaluation.pending, []);
});

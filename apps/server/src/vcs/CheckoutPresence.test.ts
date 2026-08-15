// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import {
  checkoutPresence,
  classifySpawnFailure,
  isLinkedWorktreeCheckout,
  systemErrorCode,
} from "./CheckoutPresence.ts";

const makeTempDir = Effect.acquireRelease(
  Effect.promise(() => NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "checkout-presence-"))),
  (dir) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
);

describe("checkoutPresence", () => {
  it.effect("reports an existing directory as present", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* makeTempDir;
        assert.strictEqual(yield* checkoutPresence(dir), "present");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a deleted directory as missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* makeTempDir;
        const gone = NodePath.join(dir, "worktree");
        assert.strictEqual(yield* checkoutPresence(gone), "missing");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  // A file where a checkout should be cannot be worked in either, and the
  // recovery path is the same, so it is not a separate state.
  it.effect("treats a non-directory as missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* makeTempDir;
        const filePath = NodePath.join(dir, "not-a-dir");
        yield* Effect.promise(() => NodeFS.writeFile(filePath, "x"));
        assert.strictEqual(yield* checkoutPresence(filePath), "missing");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("answers unknown for an empty path rather than claiming it is missing", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* checkoutPresence("   "), "unknown");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("systemErrorCode", () => {
  it("finds the errno on a raw Node error", () => {
    assert.strictEqual(
      systemErrorCode(Object.assign(new Error("nope"), { code: "ENOENT" })),
      "ENOENT",
    );
  });

  it("follows the cause chain when the errno is wrapped", () => {
    const wrapped = new Error("outer", {
      cause: Object.assign(new Error("inner"), { code: "ENOENT" }),
    });
    assert.strictEqual(systemErrorCode(wrapped), "ENOENT");
  });

  it("returns null when nothing looks like an errno", () => {
    assert.strictEqual(systemErrorCode(new Error("just words")), null);
  });
});

describe("classifySpawnFailure", () => {
  // The incident this exists for: deleting a worktree made every turn report
  // "Claude Code native binary not found at claude". The binary was fine; the
  // spawn's cwd was gone, and both fail with ENOENT.
  it.effect("blames the working directory when the cwd is gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* makeTempDir;
        const gone = NodePath.join(dir, "worktree");
        const classification = yield* classifySpawnFailure({
          cwd: gone,
          error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
        });
        assert.strictEqual(classification, "missing-working-directory");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a genuine missing-binary failure alone when the cwd is fine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* makeTempDir;
        const classification = yield* classifySpawnFailure({
          cwd: dir,
          error: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
        });
        assert.strictEqual(classification, "other");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  // Provider SDKs rewrap the spawn error and drop its `code`, so the errno
  // pre-filter has to be skippable or the fix never fires where it matters.
  it.effect("still blames the working directory when the SDK hid the errno", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* makeTempDir;
        const gone = NodePath.join(dir, "worktree");
        const classification = yield* classifySpawnFailure({
          cwd: gone,
          error: new Error("Claude Code native binary not found at claude"),
          errorHidesErrno: true,
        });
        assert.strictEqual(classification, "missing-working-directory");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not blame the working directory for an unrelated failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* makeTempDir;
        const classification = yield* classifySpawnFailure({
          cwd: dir,
          error: new Error("EACCES: permission denied"),
        });
        assert.strictEqual(classification, "other");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("isLinkedWorktreeCheckout", () => {
  it.effect("recognizes a linked worktree by its .git pointer file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* makeTempDir;
        yield* Effect.promise(() =>
          NodeFS.writeFile(NodePath.join(dir, ".git"), "gitdir: /repo/.git/worktrees/feature\n"),
        );
        assert.isTrue(yield* isLinkedWorktreeCheckout(dir));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not treat a primary checkout as a managed worktree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* makeTempDir;
        yield* Effect.promise(() => NodeFS.mkdir(NodePath.join(dir, ".git")));
        assert.isFalse(yield* isLinkedWorktreeCheckout(dir));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import {
  checkoutPresence,
  classifySpawnFailure,
  isLinkedWorktreeCheckout,
  resolveEditedCheckout,
  resolveFollowedSessionCwd,
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

describe("resolveFollowedSessionCwd", () => {
  // Layout: <dir>/repo is a primary clone, <dir>/repo/.claude/worktrees/feature
  // is a linked worktree inside it, and <dir>/repo/node_modules/pkg is a plain
  // folder an agent might `cd` into.
  const makeCheckouts = Effect.gen(function* () {
    const dir = yield* makeTempDir;
    const repo = NodePath.join(dir, "repo");
    const worktree = NodePath.join(repo, ".claude", "worktrees", "feature");
    yield* Effect.promise(async () => {
      await NodeFS.mkdir(NodePath.join(repo, ".git"), { recursive: true });
      await NodeFS.mkdir(NodePath.join(repo, "node_modules", "pkg"), { recursive: true });
      await NodeFS.mkdir(NodePath.join(worktree, "src"), { recursive: true });
      await NodeFS.writeFile(
        NodePath.join(worktree, ".git"),
        "gitdir: ../../../.git/worktrees/feature\n",
      );
    });
    return { dir, repo, worktree };
  });

  it.effect("keeps the configured checkout when the shell only moved into a subfolder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { repo } = yield* makeCheckouts;
        const followed = yield* resolveFollowedSessionCwd({
          observedCwd: NodePath.join(repo, "node_modules", "pkg"),
          configuredCwd: repo,
        });
        assert.strictEqual(followed, repo);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("follows a move into a linked worktree, at the worktree root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { repo, worktree } = yield* makeCheckouts;
        const followed = yield* resolveFollowedSessionCwd({
          observedCwd: NodePath.join(worktree, "src"),
          configuredCwd: repo,
        });
        assert.strictEqual(followed, worktree);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores directories outside any checkout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { dir, repo } = yield* makeCheckouts;
        const followed = yield* resolveFollowedSessionCwd({
          observedCwd: dir,
          configuredCwd: repo,
        });
        assert.strictEqual(followed, repo);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("resolveEditedCheckout", () => {
  // Real git, so the worktree pointers are exactly what git writes: a session
  // started in its own linked worktree (`home`), a helper worktree nested in
  // the primary clone the way Claude places isolated agents, an unrelated
  // repository, and a folder outside every checkout.
  const makeRepository = Effect.gen(function* () {
    const dir = yield* makeTempDir;
    const repo = NodePath.join(dir, "repo");
    const home = NodePath.join(dir, "home");
    const helper = NodePath.join(repo, ".claude", "worktrees", "agent-a");
    const other = NodePath.join(dir, "other");
    const notes = NodePath.join(dir, "notes");
    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd,
        stdio: "ignore",
      });
    yield* Effect.promise(async () => {
      await NodeFS.mkdir(repo);
      await NodeFS.mkdir(other);
      await NodeFS.mkdir(notes);
    });
    git(repo, "init", "-q");
    git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    git(repo, "worktree", "add", "-q", "-b", "home", home);
    git(repo, "worktree", "add", "-q", "-b", "agent-a", helper);
    git(other, "init", "-q");
    return { repo, home, helper, other, notes };
  });

  it.effect("places an edit in the checkout it belongs to, if it is this repository's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { repo, home, helper, other, notes } = yield* makeRepository;
        const edited = (filePath: string) =>
          resolveEditedCheckout({ filePath, configuredCwd: home });

        assert.strictEqual(yield* edited(NodePath.join(home, "src", "a.ts")), home);
        assert.strictEqual(yield* edited(NodePath.join(helper, "src", "a.ts")), helper);
        assert.strictEqual(yield* edited(NodePath.join(repo, "README.md")), repo);
        // Another repository, or no repository at all, says nothing.
        assert.isUndefined(yield* edited(NodePath.join(other, "a.ts")));
        assert.isUndefined(yield* edited(NodePath.join(notes, "memory.md")));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, expect } from "vite-plus/test";

import { makeScratchIndexes, type ScratchIndexGit } from "./scratchIndex.ts";

/** A failure the code under test only passes along. */
class TestFailure extends Data.TaggedError("TestFailure")<{ readonly message: string }> {}

describe("makeScratchIndexes", () => {
  it.effect("keeps using its cache when a changed file is edited again", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scratch-index-test-" });
      const run = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
        execFileSync("git", args, { cwd: repo, env: { ...process.env, ...env }, encoding: "utf8" });
      run(["init", "-q"]);
      run(["config", "user.email", "test@test.com"]);
      run(["config", "user.name", "Test"]);
      yield* fileSystem.writeFileString(path.join(repo, "file.txt"), "committed\n");
      run(["add", "."]);
      run(["commit", "-qm", "initial"]);

      const loads: Array<ReadonlyArray<string>> = [];
      const git: ScratchIndexGit<TestFailure> = (args, env) =>
        Effect.try({
          try: () => {
            // Loads of the scratch index itself, not of a listing's.
            if (args[0] === "read-tree" && env.GIT_INDEX_FILE?.includes("t3-checkpoint-index-")) {
              loads.push(args);
            }
            return { stdout: run(args, env) };
          },
          catch: (error) => new TestFailure({ message: String(error) }),
        });
      const { withScratchIndex } = yield* makeScratchIndexes;
      const snapshot = withScratchIndex({
        cwd: repo,
        purpose: "checkpoint",
        tree: "HEAD",
        git,
        use: (env) =>
          git(["add", "-A", "--", "."], env).pipe(Effect.andThen(git(["write-tree"], env))),
      });

      // The first snapshot builds the cache from a file that differs from HEAD.
      yield* fileSystem.writeFileString(path.join(repo, "file.txt"), "edit one\n");
      yield* snapshot;
      loads.length = 0;

      // Editing it again must not push the next snapshot onto the cold path.
      yield* fileSystem.writeFileString(path.join(repo, "file.txt"), "edit two\n");
      const tree = yield* snapshot;
      expect(loads).toEqual([["read-tree", "-m", "-i", "HEAD"]]);

      run(["add", "-A"]);
      expect(tree.stdout.trim()).toBe(run(["write-tree"]).trim());
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stages a checkpoint over its cache to the same tree a cold one gets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scratch-index-test-" });
      const write = (file: string, text: string) =>
        fileSystem.writeFileString(path.join(repo, file), text);
      const run = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
        execFileSync("git", args, { cwd: repo, env: { ...process.env, ...env }, encoding: "utf8" });
      run(["init", "-q"]);
      run(["config", "user.email", "test@test.com"]);
      run(["config", "user.name", "Test"]);
      // Every time git reads a .dat file's bytes, the counter grows.
      const counter = path.join(repo, ".git", "reads");
      const script = `require("fs").appendFileSync(${JSON.stringify(counter)}, "x"); process.stdin.pipe(process.stdout)`;
      run(["config", "filter.count.clean", `node -e '${script}'`]);
      // As on Windows: a mode, and whether a path is a link, are whatever the index says.
      run(["config", "core.filemode", "false"]);
      run(["config", "core.symlinks", "false"]);
      // Making a link on Windows takes rights a test run may not have.
      const links = process.platform !== "win32";
      // `text=auto` reads a changed file's index blob to decide its line endings.
      yield* write(".gitattributes", "*.dat filter=count\n*.txt text=auto\n");
      yield* write(".gitignore", "*.log\n");
      yield* write("tracked.txt", "committed\n");
      yield* write("tool.sh", "echo hi\n");
      yield* write("kept.log", "tracked though ignored\n");
      yield* write("old.sh", "echo old\n");
      run(["add", "."]);
      run(["add", "-f", "kept.log"]);
      run(["update-index", "--chmod=+x", "old.sh"]);
      // Committed with Windows line endings, as text=auto would not store them.
      yield* write("crlf.txt", "one\r\n");
      const crlfBlob = run(["hash-object", "-w", "--no-filters", "crlf.txt"]).trim();
      run(["update-index", "--add", "--cacheinfo", `100644,${crlfBlob},crlf.txt`]);
      run(["commit", "-qm", "initial"]);
      // A submodule that is not checked out: only the commit it records.
      yield* fileSystem.makeDirectory(path.join(repo, "sub"));
      const firstCommit = run(["rev-parse", "HEAD"]).trim();
      run(["update-index", "--add", "--cacheinfo", `160000,${firstCommit},sub`]);
      run(["commit", "-qm", "submodule"]);
      const reads = () =>
        fileSystem.readFileString(counter).pipe(
          Effect.map((text) => text.length),
          Effect.orElseSucceed(() => 0),
        );

      const git: ScratchIndexGit<TestFailure> = (args, env, options) =>
        Effect.try({
          try: () => {
            const result = spawnSync("git", args, {
              cwd: repo,
              env: { ...process.env, ...env },
              encoding: "utf8",
              ...(options?.stdin !== undefined ? { input: options.stdin } : {}),
            });
            if (result.status !== 0 && options?.allowNonZeroExit !== true) {
              throw new Error(`git ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
            }
            return {
              stdout: result.stdout,
              ...(result.status !== null ? { exitCode: result.status } : {}),
            };
          },
          catch: (error) => new TestFailure({ message: String(error) }),
        });
      const { withScratchIndex } = yield* makeScratchIndexes;
      const snapshot = withScratchIndex({
        cwd: repo,
        purpose: "checkpoint",
        tree: "HEAD",
        git,
        stageCheckout: true,
        use: (env) => git(["write-tree"], env).pipe(Effect.map((result) => result.stdout.trim())),
      });
      const coldTree = () => {
        const env = { GIT_INDEX_FILE: path.join(repo, ".git", "cold-index") };
        run(["read-tree", "HEAD"], env);
        run(["add", "-A", "--", "."], env);
        return run(["write-tree"], env).trim();
      };

      // Files never committed: one that stays, one that becomes ignored.
      yield* write("data.dat", "never committed\n");
      yield* write("draft.txt", "will be ignored\n");
      yield* write("notes.md", "renamed later by case alone\n");
      yield* write("crlf.txt", "two\n");
      if (links) {
        yield* fileSystem.symlink("tracked.txt", path.join(repo, "link.txt"));
      }
      // Before the tree has a docs folder, under any spelling.
      yield* fileSystem.makeDirectory(path.join(repo, "Docs"));
      yield* write("Docs/guide.md", "a guide\n");
      // A folder renamed later by case alone, and a nested repository that
      // later loses its .git.
      yield* fileSystem.makeDirectory(path.join(repo, "notesdir"));
      yield* write("notesdir/a.md", "in a folder\n");
      yield* fileSystem.makeDirectory(path.join(repo, "vendor"));
      yield* write("vendor/source.txt", "vendored\n");
      execFileSync("git", ["init", "-q"], { cwd: path.join(repo, "vendor") });
      execFileSync("git", ["add", "."], { cwd: path.join(repo, "vendor") });
      execFileSync(
        "git",
        ["-c", "user.email=t@t.com", "-c", "user.name=T", "commit", "-qm", "vendored"],
        { cwd: path.join(repo, "vendor") },
      );
      // Written well before the index, so git need not read it again to be
      // sure it did not change in the instant the index was written.
      const hourAgo = new Date(Date.now() - 3_600_000);
      yield* fileSystem.utimes(path.join(repo, "data.dat"), hourAgo, hourAgo);
      yield* snapshot;
      const readsAfterFirst = yield* reads();
      expect(readsAfterFirst).toBeGreaterThan(0);

      // The tree gains an ignored file, one never-committed file is now
      // ignored, a committed file changes and a new one appears.
      yield* write("added.log", "tracked though ignored, after the cache\n");
      run(["add", "-f", "added.log"]);
      // The tree also makes a file executable without touching its bytes,
      // and moves the submodule to another commit.
      run(["update-index", "--chmod=+x", "tool.sh"]);
      // The tree stops tracking an executable file that stays on disk, and
      // gains a docs folder spelled unlike the one on disk.
      run(["rm", "--cached", "-q", "old.sh"]);
      const indexBlob = run(["rev-parse", "HEAD:tracked.txt"]).trim();
      run(["update-index", "--add", "--cacheinfo", `100644,${indexBlob},docs/index.md`]);
      run(["update-index", "--cacheinfo", `160000,${run(["rev-parse", "HEAD"]).trim()},sub`]);
      run(["commit", "-qm", "second"]);
      yield* write(".gitignore", "*.log\ndraft.txt\n");
      yield* write("tracked.txt", "edited\n");
      yield* write("fresh.md", "new\n");
      yield* fileSystem.rename(path.join(repo, "notes.md"), path.join(repo, "NOTES.md"));
      yield* fileSystem.rename(path.join(repo, "notesdir"), path.join(repo, "NOTESDIR"));
      yield* write("NOTESDIR/b.md", "new in the renamed folder\n");
      yield* write("crlf.txt", "three\r\n");
      if (links) {
        // A file where a link was.
        yield* fileSystem.remove(path.join(repo, "link.txt"));
        yield* write("link.txt", "now a file\n");
      }
      // The same folder as Docs where names ignore case, another one elsewhere.
      yield* fileSystem.makeDirectory(path.join(repo, "docs"), { recursive: true });
      yield* write("docs/index.md", "committed\n");
      yield* fileSystem.remove(path.join(repo, "vendor", ".git"), { recursive: true });
      const tree = yield* snapshot;

      // The unchanged never-committed file was not read again.
      expect(yield* reads()).toBe(readsAfterFirst);
      expect(tree).toBe(coldTree());
      // Where the docs files land depends on whether the file system ignores case.
      const names = run(["ls-tree", "-r", "--name-only", tree])
        .trim()
        .split("\n")
        .filter((name) => !name.toLowerCase().startsWith("docs/") && name !== "link.txt");
      expect(names).toEqual([
        ".gitattributes",
        ".gitignore",
        "NOTES.md",
        "NOTESDIR/a.md",
        "NOTESDIR/b.md",
        "added.log",
        "crlf.txt",
        "data.dat",
        "fresh.md",
        "kept.log",
        "old.sh",
        "sub",
        "tool.sh",
        "tracked.txt",
        "vendor/source.txt",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

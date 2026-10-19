// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, expect } from "vite-plus/test";

import { makeScratchIndexes, type ScratchIndexGit } from "./scratchIndex.ts";

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
      const git: ScratchIndexGit<Error> = (args, env) =>
        Effect.try({
          try: () => {
            if (args[0] === "read-tree") {
              loads.push(args);
            }
            return { stdout: run(args, env) };
          },
          catch: (error) => error as Error,
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
});

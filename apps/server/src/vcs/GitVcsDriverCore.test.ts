import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";

import { GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, relativePath);
    yield* fileSystem.makeDirectory(pathService.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(cwd, "README.md", "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });

function gitCommitDateEnv(isoDate: string): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  };
}

const pushRemoteBranchFromPeer = (input: {
  readonly remote: string;
  readonly baseBranch: string;
  readonly branch: string;
  readonly subject: string;
  readonly fileName: string;
}) =>
  Effect.gen(function* () {
    const peer = yield* makeTmpDir("git-vcs-driver-peer-");
    yield* git(peer, ["clone", "--branch", input.baseBranch, input.remote, "."]);
    yield* git(peer, ["config", "user.email", "test@test.com"]);
    yield* git(peer, ["config", "user.name", "Test"]);
    yield* git(peer, ["checkout", "-b", input.branch]);
    yield* writeTextFile(peer, input.fileName, `${input.branch}\n`);
    yield* git(peer, ["add", "."]);
    yield* git(peer, ["commit", "-m", input.subject]);
    yield* git(peer, ["push", "origin", input.branch]);
  });

it.layer(TestLayer)("GitVcsDriver core integration", (it) => {
  describe("repository status", () => {
    it.effect("reports non-repository directories without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(refs.isRepo, false);
        assert.deepStrictEqual(refs.refs, []);
      }),
    );

    it.effect("reports refName and dirty state for a repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(
          cwd,
          "feature.ts",
          ["export const value = 1;", "export const next = 2;", ""].join("\n"),
        );

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, initialBranch);
        assert.equal(status.hasWorkingTreeChanges, true);
        assert.include(
          status.workingTree.files.map((file) => file.path),
          "feature.ts",
        );
        const featureFile = status.workingTree.files.find((file) => file.path === "feature.ts");
        assert.equal(featureFile?.indexStatus, null);
        assert.equal(featureFile?.worktreeStatus, "untracked");
        assert.equal(featureFile?.insertions, 2);
        assert.equal(featureFile?.deletions, 0);
        assert.equal(featureFile?.unstagedInsertions, 2);
        assert.equal(featureFile?.unstagedDeletions, 0);
        assert.equal(status.workingTree.insertions, 2);
        assert.equal(status.workingTree.deletions, 0);
      }),
    );

    it.effect("reports default-branch delta separately from upstream delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/synced"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/synced"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("disables SSH askpass for background upstream status fetches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const tempDir = yield* makeTmpDir("git-vcs-driver-ssh-env-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const sshLogPath = pathService.join(tempDir, "ssh-env.txt");
        const sshWrapperPath = pathService.join(tempDir, "ssh-wrapper.sh");
        const previousGitSsh = process.env.GIT_SSH;
        const previousAskpassRequire = process.env.SSH_ASKPASS_REQUIRE;
        const previousAskpassLog = process.env.T3_TEST_SSH_ASKPASS_LOG;

        yield* fileSystem.writeFileString(
          sshWrapperPath,
          [
            "#!/bin/sh",
            'printf "%s\\n" "${SSH_ASKPASS_REQUIRE:-}" > "$T3_TEST_SSH_ASKPASS_LOG"',
            "exit 1",
            "",
          ].join("\n"),
        );
        yield* fileSystem.chmod(sshWrapperPath, 0o755);
        yield* git(cwd, ["remote", "add", "origin", "ssh://example.invalid/repo.git"]);
        yield* git(cwd, ["update-ref", `refs/remotes/origin/${initialBranch}`, "HEAD"]);
        yield* git(cwd, ["branch", "--set-upstream-to", `origin/${initialBranch}`]);

        yield* Effect.gen(function* () {
          process.env.GIT_SSH = sshWrapperPath;
          process.env.SSH_ASKPASS_REQUIRE = "force";
          process.env.T3_TEST_SSH_ASKPASS_LOG = sshLogPath;

          yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

          assert.equal((yield* fileSystem.readFileString(sshLogPath)).trim(), "never");
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previousGitSsh === undefined) {
                delete process.env.GIT_SSH;
              } else {
                process.env.GIT_SSH = previousGitSsh;
              }
              if (previousAskpassRequire === undefined) {
                delete process.env.SSH_ASKPASS_REQUIRE;
              } else {
                process.env.SSH_ASKPASS_REQUIRE = previousAskpassRequire;
              }
              if (previousAskpassLog === undefined) {
                delete process.env.T3_TEST_SSH_ASKPASS_LOG;
              } else {
                process.env.T3_TEST_SSH_ASKPASS_LOG = previousAskpassLog;
              }
            }),
          ),
        );
      }),
    );

    it.effect("reuses the no-upstream fallback ahead count for default-branch delta", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/no-upstream"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasUpstream, false);
        assert.equal(status.aheadCount, 1);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
      }),
    );

    it.effect("skips remote tags during background upstream status refreshes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const initialSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(remote, ["tag", "v0.0.9", initialSha]);

        assert.equal(yield* git(cwd, ["tag", "--list", "v0.0.9"]), "");

        yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(yield* git(cwd, ["tag", "--list", "v0.0.9"]), "");
      }),
    );
  });

  describe("refName operations", () => {
    it.effect("creates, checks out, renames, and lists refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createRef({ cwd, refName: "feature/original" });
        const switchRef = yield* driver.switchRef({ cwd, refName: "feature/original" });
        assert.equal(switchRef.refName, "feature/original");

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "feature/original",
          newBranch: "feature/renamed",
        });
        assert.equal(renamed.branch, "feature/renamed");
        assert.equal(yield* git(cwd, ["branch", "--show-current"]), "feature/renamed");

        const refs = yield* driver.listRefs({ cwd });
        assert.equal(
          refs.refs.find((refName) => refName.name === "feature/renamed")?.current,
          true,
        );
      }),
    );

    it.effect("returns the existing refName when rename source and target match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const current = yield* git(cwd, ["branch", "--show-current"]);
        const result = yield* driver.renameBranch({
          cwd,
          oldBranch: current,
          newBranch: current,
        });

        assert.equal(result.branch, current);
      }),
    );

    it.effect("creates a tag at a selected commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const initialSha = yield* git(cwd, ["rev-parse", "HEAD"]);

        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);

        const result = yield* driver.createTag({
          cwd,
          tagName: "v1.0.0",
          targetSha: initialSha,
        });

        assert.equal(result.tagName, "v1.0.0");
        assert.equal(result.targetSha, initialSha);
        assert.equal(yield* git(cwd, ["tag", "--list", "v1.0.0"]), "v1.0.0");
        assert.equal(yield* git(cwd, ["rev-parse", "refs/tags/v1.0.0^{commit}"]), initialSha);
      }),
    );

    it.effect("refreshes remote refs before listing refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(remote, ["symbolic-ref", "HEAD", `refs/heads/${initialBranch}`]);
        yield* pushRemoteBranchFromPeer({
          remote,
          baseBranch: initialBranch,
          branch: "claude-redesign",
          subject: "remote redesign branch",
          fileName: "redesign.txt",
        });

        assert.equal(
          yield* git(cwd, ["branch", "--remotes", "--list", "origin/claude-redesign"]),
          "",
        );

        const refs = yield* driver.listRefs({ cwd, query: "claude-redesign" });
        const remoteRef = refs.refs.find((refName) => refName.name === "origin/claude-redesign");
        assert.equal(remoteRef?.isRemote, true);
        assert.equal(remoteRef?.remoteName, "origin");
      }),
    );
  });

  describe("worktree operations", () => {
    it.effect("creates and removes a worktree for a new refName", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const pathService = yield* Path.Path;
        const worktreePath = pathService.join(
          yield* makeTmpDir("git-worktrees-"),
          "feature-worktree",
        );
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          refName: initialBranch,
          newRefName: "feature/worktree",
        });

        assert.equal(created.worktree.path, worktreePath);
        assert.equal(created.worktree.refName, "feature/worktree");
        assert.equal(yield* git(worktreePath, ["branch", "--show-current"]), "feature/worktree");

        yield* driver.removeWorktree({ cwd, path: worktreePath });
        const fileSystem = yield* FileSystem.FileSystem;
        assert.equal(yield* fileSystem.exists(worktreePath), false);
      }),
    );
  });

  describe("commit context", () => {
    it.effect("discards tracked, staged, and untracked file changes", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        yield* writeTextFile(cwd, "README.md", "# test\n\nmodified\n");
        yield* writeTextFile(cwd, "staged.txt", "staged\n");
        yield* git(cwd, ["add", "staged.txt"]);
        yield* writeTextFile(cwd, "untracked.txt", "untracked\n");

        const result = yield* driver.discardChanges({
          cwd,
          filePaths: ["README.md", "staged.txt", "untracked.txt"],
        });

        assert.deepStrictEqual(result.discardedPaths.toSorted(), [
          "README.md",
          "staged.txt",
          "untracked.txt",
        ]);
        const restoredReadme = yield* fileSystem.readFileString(pathService.join(cwd, "README.md"));
        assert.equal(restoredReadme.replaceAll("\r\n", "\n"), "# test\n");
        assert.equal(yield* fileSystem.exists(pathService.join(cwd, "staged.txt")), false);
        assert.equal(yield* fileSystem.exists(pathService.join(cwd, "untracked.txt")), false);
        assert.equal(yield* git(cwd, ["status", "--porcelain"]), "");
      }),
    );

    it.effect("discards staged files before the first commit", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        yield* driver.initRepo({ cwd });
        yield* writeTextFile(cwd, "staged.txt", "staged\n");
        yield* git(cwd, ["add", "staged.txt"]);

        const result = yield* driver.discardChanges({ cwd, filePaths: ["staged.txt"] });

        assert.deepStrictEqual(result.discardedPaths, ["staged.txt"]);
        assert.equal(yield* fileSystem.exists(pathService.join(cwd, "staged.txt")), false);
        assert.equal(yield* git(cwd, ["status", "--porcelain"]), "");
      }),
    );

    it.effect("discards only unstaged changes when requested", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;

        yield* writeTextFile(cwd, "README.md", "# test\n\nstaged\n");
        yield* git(cwd, ["add", "README.md"]);
        yield* writeTextFile(cwd, "README.md", "# test\n\nstaged\nunstaged\n");

        const result = yield* driver.discardChanges({
          cwd,
          filePaths: ["README.md"],
          scope: "unstaged",
        });

        assert.deepStrictEqual(result.discardedPaths, ["README.md"]);
        const restoredReadme = yield* fileSystem.readFileString(pathService.join(cwd, "README.md"));
        assert.equal(restoredReadme.replaceAll("\r\n", "\n"), "# test\n\nstaged\n");
        assert.equal(yield* git(cwd, ["diff", "--name-only"]), "");
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "README.md");
      }),
    );

    it.effect("stages and unstages selected working tree files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const staged = yield* driver.stageChanges({ cwd, filePaths: ["a.txt"] });
        assert.deepStrictEqual(staged.stagedPaths, ["a.txt"]);
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "a.txt");
        assert.include(yield* git(cwd, ["status", "--porcelain"]), "?? b.txt");

        const statusAfterStage = yield* driver.status({ cwd });
        const stagedA = statusAfterStage.workingTree.files.find((file) => file.path === "a.txt");
        assert.equal(stagedA?.indexStatus, "added");
        assert.equal(stagedA?.worktreeStatus, null);

        const unstaged = yield* driver.unstageChanges({ cwd, filePaths: ["a.txt"] });
        assert.deepStrictEqual(unstaged.unstagedPaths, ["a.txt"]);
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "");
        assert.include(yield* git(cwd, ["status", "--porcelain"]), "?? a.txt");
      }),
    );

    it.effect("uses existing staged changes when preparing a whole-tree commit context", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* git(cwd, ["add", "a.txt"]);
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const context = yield* driver.prepareCommitContext(cwd);

        assert.include(context?.stagedSummary ?? "", "a.txt");
        assert.notInclude(context?.stagedSummary ?? "", "b.txt");
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "a.txt");
        assert.include(yield* git(cwd, ["status", "--porcelain"]), "?? b.txt");
      }),
    );

    it.effect("stages selected files and commits only those files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const context = yield* driver.prepareCommitContext(cwd, ["a.txt"]);
        assert.include(context?.stagedSummary ?? "", "a.txt");
        assert.notInclude(context?.stagedSummary ?? "", "b.txt");

        const commit = yield* driver.commit(cwd, "Add a", "");
        assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
        assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "Add a");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? b.txt");
        assert.notInclude(status, "a.txt");
      }),
    );

    it.effect("previews commit context without mutating the real index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const context = yield* driver.previewCommitContext(cwd, ["a.txt"]);
        assert.include(context?.stagedSummary ?? "", "a.txt");
        assert.notInclude(context?.stagedSummary ?? "", "b.txt");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        assert.include(status, "?? a.txt");
        assert.include(status, "?? b.txt");

        const staged = yield* git(cwd, ["diff", "--cached", "--name-only"]);
        assert.equal(staged, "");
      }),
    );

    it.effect("reads working tree diffs without mutating the real index", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "a.txt", "a\n");
        yield* writeTextFile(cwd, "b.txt", "b\n");

        const result = yield* driver.workingTreeDiff({ cwd, filePaths: ["a.txt"] });

        assert.include(result.diff, "diff --git a/a.txt b/a.txt");
        assert.notInclude(result.diff, "b.txt");
        assert.equal(yield* git(cwd, ["diff", "--cached", "--name-only"]), "");
      }),
    );
  });

  describe("commit graph", () => {
    it.effect("filters T3 checkpoint commits from graph results", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "checkpoint.txt", "checkpoint\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "t3 checkpoint ref=refs/t3/checkpoints/example"]);

        const graph = yield* driver.commitGraph({ cwd, limit: 5 });

        assert.notInclude(
          graph.commits.map((commit) => commit.subject),
          "t3 checkpoint ref=refs/t3/checkpoints/example",
        );
        assert.include(
          graph.commits.map((commit) => commit.subject),
          "initial commit",
        );
      }),
    );

    it.effect("omits symbolic remote HEAD decorations from graph refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, [
          "symbolic-ref",
          "refs/remotes/origin/HEAD",
          `refs/remotes/origin/${initialBranch}`,
        ]);

        const graph = yield* driver.commitGraph({ cwd, limit: 5 });
        const initialCommit = graph.commits.find((commit) => commit.subject === "initial commit");

        assert.deepStrictEqual(
          initialCommit?.refs.filter((ref) => ref.toLowerCase().endsWith("/head")),
          [],
        );
      }),
    );

    it.effect("keeps current branch ancestry together before unrelated remote tips", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(
          cwd,
          ["commit", "--amend", "--no-edit", "--date", "2026-05-29T00:00:00Z"],
          gitCommitDateEnv("2026-05-29T00:00:00Z"),
        );

        yield* writeTextFile(cwd, "main-parent.txt", "main parent\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "main parent"], gitCommitDateEnv("2026-05-29T01:00:00Z"));

        yield* writeTextFile(cwd, "main-tip.txt", "main tip\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "main tip"], gitCommitDateEnv("2026-05-29T03:00:00Z"));

        yield* git(cwd, ["checkout", "--orphan", "upstream-main"]);
        yield* git(cwd, ["rm", "-rf", "."]);
        yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
        yield* git(cwd, ["add", "."]);
        yield* git(
          cwd,
          ["commit", "-m", "upstream remote tip"],
          gitCommitDateEnv("2026-05-29T02:00:00Z"),
        );
        yield* git(cwd, ["update-ref", "refs/remotes/upstream/main", "HEAD"]);
        yield* git(cwd, ["checkout", initialBranch]);
        yield* git(cwd, ["branch", "-D", "upstream-main"]);

        const graph = yield* driver.commitGraph({ cwd, limit: 3 });

        assert.deepStrictEqual(
          graph.commits.map((commit) => commit.subject),
          ["main tip", "main parent", "initial commit"],
        );
      }),
    );

    it.effect("refreshes remote refs before reading the graph", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(remote, ["symbolic-ref", "HEAD", `refs/heads/${initialBranch}`]);
        yield* pushRemoteBranchFromPeer({
          remote,
          baseBranch: initialBranch,
          branch: "claude-redesign",
          subject: "remote graph redesign",
          fileName: "graph-redesign.txt",
        });

        assert.equal(
          yield* git(cwd, ["branch", "--remotes", "--list", "origin/claude-redesign"]),
          "",
        );

        const graph = yield* driver.commitGraph({ cwd, limit: 5 });
        const remoteCommit = graph.commits.find(
          (commit) => commit.subject === "remote graph redesign",
        );
        assert.include(remoteCommit?.refs ?? [], "origin/claude-redesign");
      }),
    );

    it.effect("refreshes remote tags before reading graph decorations", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const tagName = "v0.0.19-nightly.20260605.70";

        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        const initialSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(remote, ["tag", tagName, initialSha]);

        assert.equal(yield* git(cwd, ["tag", "--list", tagName]), "");

        const graph = yield* driver.commitGraph({ cwd, limit: 5 });
        const initialCommit = graph.commits.find((commit) => commit.subject === "initial commit");

        assert.include(initialCommit?.refs ?? [], tagName);
      }),
    );
  });

  describe("branch operations", () => {
    it.effect("merges a clean branch into the current branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createRef({ cwd, refName: "feature/merge" });
        yield* driver.switchRef({ cwd, refName: "feature/merge" });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, ["commit", "-m", "Add feature"]);
        yield* driver.switchRef({ cwd, refName: initialBranch });

        const result = yield* driver.mergeRef({ cwd, refName: "feature/merge" });

        assert.equal(result.refName, initialBranch);
        assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "Add feature");
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("pushes with upstream setup and skips when already up to date", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createRef({
          cwd,
          refName: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).switchRef({
          cwd,
          refName: "feature/push",
        });
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* (yield* GitVcsDriver.GitVcsDriver).prepareCommitContext(cwd);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        assert.equal(
          yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
          "origin/feature/push",
        );

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        assert.deepInclude(skipped, {
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
    );

    it.effect(
      "pushes upstream branches to the remote branch name, not the upstream shorthand",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const remote = yield* makeTmpDir("git-remote-");
          yield* initRepoWithCommit(cwd);
          const driver = yield* GitVcsDriver.GitVcsDriver;
          yield* git(cwd, ["branch", "-M", "main"]);
          yield* git(remote, ["init", "--bare"]);
          yield* git(cwd, ["remote", "add", "origin", remote]);
          yield* git(cwd, ["push", "-u", "origin", "main"]);
          yield* writeTextFile(cwd, "upstream.txt", "upstream\n");
          yield* driver.prepareCommitContext(cwd);
          yield* driver.commit(cwd, "Add upstream update", "");

          const pushed = yield* driver.pushCurrentBranch(cwd, null);

          assert.deepInclude(pushed, {
            status: "pushed",
            branch: "main",
            upstreamBranch: "origin/main",
            setUpstream: false,
          });
          assert.equal(
            yield* git(remote, ["log", "-1", "--pretty=%s", "main"]),
            "Add upstream update",
          );
          const badBranch = yield* driver.execute({
            operation: "GitVcsDriver.test.showBadRemoteBranch",
            cwd: remote,
            args: ["show-ref", "--verify", "--quiet", "refs/heads/origin/main"],
            allowNonZeroExit: true,
            timeoutMs: 10_000,
          });
          assert.notEqual(badBranch.exitCode, 0);
        }),
    );

    it.effect("pushes to the requested remote instead of the primary remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const originRemote = yield* makeTmpDir("git-origin-remote-");
        const publishRemote = yield* makeTmpDir("git-publish-remote-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(originRemote, ["init", "--bare"]);
        yield* git(publishRemote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", originRemote]);
        yield* git(cwd, ["remote", "add", "origin-1", publishRemote]);

        const pushed = yield* driver.pushCurrentBranch(cwd, null, { remoteName: "origin-1" });

        assert.deepInclude(pushed, {
          status: "pushed",
          branch: "main",
          upstreamBranch: "origin-1/main",
          setUpstream: true,
        });
        assert.equal(
          yield* git(publishRemote, ["log", "-1", "--pretty=%s", "main"]),
          "initial commit",
        );
        const originMain = yield* driver.execute({
          operation: "GitVcsDriver.test.originMainMissing",
          cwd: originRemote,
          args: ["show-ref", "--verify", "--quiet", "refs/heads/main"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        assert.notEqual(originMain.exitCode, 0);
      }),
    );
  });
});

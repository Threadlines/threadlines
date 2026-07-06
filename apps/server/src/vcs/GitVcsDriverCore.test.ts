import { createServer } from "node:http";
import { setTimeout as sleepRealTime } from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, describe } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";

import { GitCommandError } from "@threadlines/contracts";
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
    const directory = yield* fileSystem.makeTempDirectory({ prefix });
    yield* Effect.addFinalizer(() => removeTempDirectoryWithRetry(fileSystem, directory));
    return directory;
  });

const removeTempDirectoryWithRetry = (
  fileSystem: FileSystem.FileSystem,
  directory: string,
  attemptsRemaining = 10,
): Effect.Effect<void> =>
  fileSystem
    .remove(directory, { recursive: true, force: true })
    .pipe(
      Effect.catch((error) =>
        attemptsRemaining <= 1
          ? Effect.logWarning(`Failed to remove temporary Git test directory ${directory}`, error)
          : Effect.promise(() => sleepRealTime(50)).pipe(
              Effect.andThen(() =>
                removeTempDirectoryWithRetry(fileSystem, directory, attemptsRemaining - 1),
              ),
            ),
      ),
    );

const writeTextFile = (
  cwd: string,
  relativePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const filePath = pathService.join(cwd, ...relativePath.split("/"));
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

class WaitForGitOutputError extends Data.TaggedError("WaitForGitOutputError")<{
  readonly message: string;
}> {}

const waitForGitOutput = (
  cwd: string,
  args: ReadonlyArray<string>,
  predicate: (output: string) => boolean,
): Effect.Effect<void, GitCommandError | WaitForGitOutputError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const startedAtMs = Date.now();
    let output = "";
    do {
      output = yield* git(cwd, args);
      if (predicate(output)) {
        return;
      }
      yield* Effect.promise(() => sleepRealTime(50));
    } while (Date.now() - startedAtMs < 5_000);
    return yield* new WaitForGitOutputError({
      message: `Timed out waiting for git ${args.join(" ")}.`,
    });
  });

const waitForFileText = (
  filePath: string,
  predicate: (output: string) => boolean,
): Effect.Effect<
  void,
  PlatformError.PlatformError | WaitForGitOutputError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const startedAtMs = Date.now();
    let output = "";
    do {
      output = yield* fileSystem
        .readFileString(filePath)
        .pipe(Effect.catch(() => Effect.succeed("")));
      if (predicate(output)) {
        return;
      }
      yield* Effect.promise(() => sleepRealTime(50));
    } while (Date.now() - startedAtMs < 5_000);
    return yield* new WaitForGitOutputError({
      message: `Timed out waiting for file ${filePath}.`,
    });
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

/** Minimal HTTP server that answers every request with a Basic auth challenge. */
const makeBasicAuthChallengeRemote = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly url: string; readonly server: ReturnType<typeof createServer> }>(
        (resolve, reject) => {
          const server = createServer((_request, response) => {
            response.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
            response.end("authentication required");
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              reject(new Error("Failed to bind auth challenge server."));
              return;
            }
            resolve({ url: `http://127.0.0.1:${address.port}/private.git`, server });
          });
          server.on("error", reject);
        },
      ),
  ),
  ({ server }) =>
    Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
);

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

    it.effect("reports nested untracked files individually with text insertion counts", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        yield* writeTextFile(cwd, "src/screenCapture/DesktopScreenCapture.ts", "one\ntwo\n");
        yield* writeTextFile(
          cwd,
          "src/screenCapture/DesktopScreenCapture.test.ts",
          "one\ntwo\nthree\n",
        );

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        assert.equal(status.hasWorkingTreeChanges, true);
        assert.notInclude(
          status.workingTree.files.map((file) => file.path),
          "src/screenCapture/",
        );
        assert.deepStrictEqual(
          status.workingTree.files.map((file) => ({
            path: file.path,
            worktreeStatus: file.worktreeStatus,
            insertions: file.insertions,
            deletions: file.deletions,
            unstagedInsertions: file.unstagedInsertions,
            unstagedDeletions: file.unstagedDeletions,
          })),
          [
            {
              path: "src/screenCapture/DesktopScreenCapture.test.ts",
              worktreeStatus: "untracked",
              insertions: 3,
              deletions: 0,
              unstagedInsertions: 3,
              unstagedDeletions: 0,
            },
            {
              path: "src/screenCapture/DesktopScreenCapture.ts",
              worktreeStatus: "untracked",
              insertions: 2,
              deletions: 0,
              unstagedInsertions: 2,
              unstagedDeletions: 0,
            },
          ],
        );
        assert.equal(status.workingTree.insertions, 5);
        assert.equal(status.workingTree.deletions, 0);
      }),
    );

    (process.platform === "win32" ? it.effect.skip : it.effect)(
      "decodes Git-quoted working tree paths with escaped control characters",
      () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          yield* initRepoWithCommit(cwd);
          const untrackedPath = "@AGENTS.md\n";
          const modifiedPath = "src/tracked\nfile.txt";

          yield* writeTextFile(cwd, modifiedPath, "before\n");
          yield* git(cwd, ["add", "."]);
          yield* git(cwd, ["commit", "-m", "add quoted path fixture"]);
          yield* writeTextFile(cwd, modifiedPath, "before\nafter\n");
          yield* writeTextFile(cwd, untrackedPath, "@AGENTS.md\n");

          const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);
          const paths = status.workingTree.files.map((file) => file.path);
          const modified = status.workingTree.files.find((file) => file.path === modifiedPath);
          const untracked = status.workingTree.files.find((file) => file.path === untrackedPath);

          assert.include(paths, modifiedPath);
          assert.include(paths, untrackedPath);
          assert.notInclude(paths, '"@AGENTS.md\\n"');
          assert.notInclude(paths, '"src/tracked\\nfile.txt"');
          assert.equal(modified?.worktreeStatus, "modified");
          assert.equal(modified?.unstagedInsertions, 1);
          assert.equal(untracked?.worktreeStatus, "untracked");
          assert.equal(untracked?.unstagedInsertions, 1);
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

    it.effect("reports remote divergence without reading working-tree details", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(cwd, ["checkout", "-b", "feature/remote-status"]);
        yield* writeTextFile(cwd, "feature.txt", "feature\n");
        yield* git(cwd, ["add", "feature.txt"]);
        yield* git(cwd, ["commit", "-m", "feature commit"]);
        yield* git(cwd, ["push", "-u", "origin", "feature/remote-status"]);
        yield* writeTextFile(cwd, "untracked.txt", "local-only\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.isRepo, true);
        assert.equal(status.branch, "feature/remote-status");
        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
        assert.equal(status.aheadOfDefaultCount, 1);
        assert.notProperty(status, "workingTree");
        assert.notProperty(status, "hasWorkingTreeChanges");
      }),
    );

    it.effect("reports remote ahead and behind divergence against the upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);

        // A peer clone advances the remote branch while the local repo commits
        // independently, leaving the branch ahead 1 / behind 1.
        const peer = yield* makeTmpDir("git-vcs-driver-peer-");
        yield* git(peer, ["clone", "--branch", initialBranch, remote, "."]);
        yield* git(peer, ["config", "user.email", "test@test.com"]);
        yield* git(peer, ["config", "user.name", "Test"]);
        yield* writeTextFile(peer, "peer.txt", "peer\n");
        yield* git(peer, ["add", "."]);
        yield* git(peer, ["commit", "-m", "peer commit"]);
        yield* git(peer, ["push", "origin", initialBranch]);

        yield* writeTextFile(cwd, "local.txt", "local\n");
        yield* git(cwd, ["add", "local.txt"]);
        yield* git(cwd, ["commit", "-m", "local commit"]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.hasUpstream, true);
        assert.equal(status.aheadCount, 1);
        assert.equal(status.behindCount, 1);
      }),
    );

    it.effect("uses origin HEAD for default-branch detection with a non-origin upstream", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const origin = yield* makeTmpDir("git-vcs-driver-origin-");
        const upstream = yield* makeTmpDir("git-vcs-driver-upstream-");
        yield* initRepoWithCommit(cwd);
        yield* git(origin, ["init", "--bare"]);
        yield* git(upstream, ["init", "--bare"]);
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(cwd, ["remote", "add", "origin", origin]);
        yield* git(cwd, ["remote", "add", "upstream", upstream]);
        yield* git(cwd, ["push", "origin", "main"]);
        yield* git(cwd, ["push", "upstream", "main"]);
        yield* git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        yield* git(cwd, ["checkout", "-b", "release"]);
        yield* writeTextFile(cwd, "release.txt", "release\n");
        yield* git(cwd, ["add", "release.txt"]);
        yield* git(cwd, ["commit", "-m", "release commit"]);
        yield* git(cwd, ["push", "-u", "upstream", "release"]);
        yield* git(cwd, [
          "symbolic-ref",
          "refs/remotes/upstream/HEAD",
          "refs/remotes/upstream/release",
        ]);

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetailsRemote(cwd);

        assert.equal(status.branch, "release");
        assert.equal(status.upstreamRef, "upstream/release");
        assert.equal(status.isDefaultBranch, false);
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

          yield* waitForFileText(sshLogPath, (output) => output.trim() === "never");
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

    it.effect(
      "lists existing refs immediately while refreshing remote refs in the background",
      () =>
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

          const initialRefs = yield* driver.listRefs({ cwd, query: "claude-redesign" });

          assert.deepStrictEqual(initialRefs.refs, []);

          yield* waitForGitOutput(
            cwd,
            ["branch", "--remotes", "--list", "origin/claude-redesign"],
            (output) => output.trim().length > 0,
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

    it.effect("reads colorless working tree diffs when git color is forced on", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(cwd, ["config", "color.diff", "always"]);
        yield* writeTextFile(cwd, "README.md", "# changed\n");

        const result = yield* driver.workingTreeDiff({ cwd, filePaths: ["README.md"] });

        assert.include(result.diff, "diff --git a/README.md b/README.md");
        assert.notInclude(result.diff, "\u001B[");
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
        yield* git(cwd, [
          "commit",
          "-m",
          "threadlines checkpoint ref=refs/threadlines/checkpoints/example",
        ]);

        const graph = yield* driver.commitGraph({ cwd, limit: 5 });

        assert.notInclude(
          graph.commits.map((commit) => commit.subject),
          "threadlines checkpoint ref=refs/threadlines/checkpoints/example",
        );
        assert.include(
          graph.commits.map((commit) => commit.subject),
          "initial commit",
        );
      }),
    );

    it.effect("reads full commit details separately from graph subjects", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(cwd, "details.txt", "details\n");
        yield* git(cwd, ["add", "."]);
        yield* git(cwd, [
          "commit",
          "-m",
          "Add graph details",
          "-m",
          "Copy the complete commit message body from pinned graph details.",
        ]);
        yield* git(cwd, [
          "remote",
          "add",
          "origin",
          "https://github.com/threadlines/threadlines.git",
        ]);
        const sha = yield* git(cwd, ["rev-parse", "HEAD"]);

        const details = yield* driver.commitDetails({ cwd, sha });

        assert.strictEqual(details.subject, "Add graph details");
        assert.strictEqual(
          details.body,
          "Copy the complete commit message body from pinned graph details.",
        );
        assert.strictEqual(
          details.message,
          "Add graph details\n\nCopy the complete commit message body from pinned graph details.",
        );
        assert.strictEqual(
          details.commitUrl,
          `https://github.com/threadlines/threadlines/commit/${sha}`,
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

    it.effect("reads the graph immediately while refreshing remote refs in the background", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-vcs-driver-remote-");
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", initialBranch]);
        yield* git(remote, ["symbolic-ref", "HEAD", `refs/heads/${initialBranch}`]);
        const refreshTagName = "graph-background-refresh-marker";
        const initialSha = yield* git(cwd, ["rev-parse", "HEAD"]);
        yield* git(remote, ["tag", refreshTagName, initialSha]);
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

        const initialGraph = yield* driver.commitGraph({ cwd, limit: 5 });

        assert.equal(
          initialGraph.commits.some((commit) => commit.subject === "remote graph redesign"),
          false,
        );

        yield* waitForGitOutput(cwd, ["tag", "--list", refreshTagName], (output) =>
          output.trim().includes(refreshTagName),
        );

        const graph = yield* driver.commitGraph({ cwd, limit: 5 });
        const remoteCommit = graph.commits.find(
          (commit) => commit.subject === "remote graph redesign",
        );
        assert.include(remoteCommit?.refs ?? [], "origin/claude-redesign");
      }),
    );

    it.effect(
      "reads graph decorations immediately while refreshing remote tags in the background",
      () =>
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

          const initialGraph = yield* driver.commitGraph({ cwd, limit: 5 });
          const initialCommit = initialGraph.commits.find(
            (commit) => commit.subject === "initial commit",
          );

          assert.notInclude(initialCommit?.refs ?? [], tagName);

          yield* waitForGitOutput(cwd, ["tag", "--list", tagName], (output) =>
            output.trim().includes(tagName),
          );

          const graph = yield* driver.commitGraph({ cwd, limit: 5 });
          const refreshedInitialCommit = graph.commits.find(
            (commit) => commit.subject === "initial commit",
          );

          assert.include(refreshedInitialCommit?.refs ?? [], tagName);
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

    it.effect("fails fast on HTTPS auth challenges and classifies the failure", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const remote = yield* makeBasicAuthChallengeRemote;
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const error = yield* driver
          .execute({
            operation: "GitVcsDriverCore.test.authChallengeFetch",
            cwd,
            // Reset credential helpers so the host machine's stored
            // credentials cannot satisfy the challenge.
            args: ["-c", "credential.helper=", "fetch", remote.url],
            timeoutMs: 15_000,
          })
          .pipe(Effect.flip);

        assert.instanceOf(error, GitCommandError);
        assert.deepStrictEqual(error.remoteAuth, {
          kind: "https_credentials_unavailable",
          scheme: "https",
          host: "127.0.0.1",
        });
      }),
    );

    it.effect("pulls the resolved upstream when branch config has extra merge refs", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const upstreamCwd = yield* makeTmpDir("git-upstream-");
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["branch", "other"]);
        yield* git(cwd, ["push", "origin", "other"]);
        yield* git(cwd, ["config", "--add", "branch.main.merge", "refs/heads/other"]);

        yield* git(cwd, ["clone", "--branch", "main", remote, upstreamCwd]);
        yield* git(upstreamCwd, ["config", "user.email", "test@example.com"]);
        yield* git(upstreamCwd, ["config", "user.name", "Test User"]);
        yield* writeTextFile(upstreamCwd, "remote.txt", "remote\n");
        yield* git(upstreamCwd, ["add", "."]);
        yield* git(upstreamCwd, ["commit", "-m", "Remote update"]);
        yield* git(upstreamCwd, ["push", "origin", "main"]);

        const plainPull = yield* driver.execute({
          operation: "GitVcsDriver.test.plainPullWithExtraMergeRef",
          cwd,
          args: ["pull", "--ff-only"],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
        });
        assert.notEqual(plainPull.exitCode, 0);
        assert.match(plainPull.stderr, /Cannot fast-forward to multiple branches/);

        const result = yield* driver.pullCurrentBranch(cwd);

        assert.deepEqual(result, {
          status: "pulled",
          refName: "main",
          upstreamRef: "origin/main",
        });
        assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "Remote update");
      }),
    );

    it.effect("pulls without reading or replacing existing multi-branch FETCH_HEAD", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        const upstreamCwd = yield* makeTmpDir("git-upstream-");
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* git(cwd, ["branch", "-M", "main"]);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* git(cwd, ["push", "-u", "origin", "main"]);
        yield* git(cwd, ["branch", "other"]);
        yield* git(cwd, ["push", "origin", "other"]);
        yield* git(cwd, [
          "fetch",
          "--quiet",
          "--no-tags",
          "origin",
          "+refs/heads/*:refs/remotes/origin/*",
        ]);

        const fetchHeadPath = pathService.join(cwd, ".git", "FETCH_HEAD");
        const fetchHeadBefore = yield* fileSystem.readFileString(fetchHeadPath);
        assert.match(fetchHeadBefore, /branch 'main'/);
        assert.match(fetchHeadBefore, /branch 'other'/);

        yield* git(cwd, ["clone", "--branch", "main", remote, upstreamCwd]);
        yield* git(upstreamCwd, ["config", "user.email", "test@example.com"]);
        yield* git(upstreamCwd, ["config", "user.name", "Test User"]);
        yield* writeTextFile(upstreamCwd, "remote.txt", "remote\n");
        yield* git(upstreamCwd, ["add", "."]);
        yield* git(upstreamCwd, ["commit", "-m", "Remote update"]);
        yield* git(upstreamCwd, ["push", "origin", "main"]);

        const result = yield* driver.pullCurrentBranch(cwd);

        assert.deepEqual(result, {
          status: "pulled",
          refName: "main",
          upstreamRef: "origin/main",
        });
        assert.equal(yield* git(cwd, ["log", "-1", "--pretty=%s"]), "Remote update");
        assert.equal(yield* fileSystem.readFileString(fetchHeadPath), fetchHeadBefore);
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

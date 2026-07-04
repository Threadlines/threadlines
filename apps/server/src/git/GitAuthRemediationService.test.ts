import { setTimeout as sleepRealTime } from "node:timers/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";

import { GitManagerError, VcsProcessSpawnError } from "@threadlines/contracts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitAuthRemediationService from "./GitAuthRemediationService.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-auth-remediation-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

// Unresolvable TLD: the SSH probe fails fast on DNS without touching the network.
const UNREACHABLE_HOST = "invalid.example.test";

type FakeGhBehavior = "authed" | "unauthenticated" | "missing";

interface RecordedGhCall {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const makeFakeVcsProcess = (behavior: FakeGhBehavior, calls: RecordedGhCall[]) =>
  VcsProcess.VcsProcess.of({
    run: (input) =>
      Effect.suspend(() => {
        calls.push({ command: input.command, args: input.args });
        if (behavior === "missing") {
          return Effect.fail(
            new VcsProcessSpawnError({
              operation: input.operation,
              command: input.command,
              cwd: input.cwd,
              cause: new Error("spawn gh ENOENT"),
            }),
          );
        }
        return Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(behavior === "authed" ? 0 : 1),
          stdout: "",
          stderr: behavior === "authed" ? "" : "You are not logged into any GitHub hosts.",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      }),
  });

const makeService = (behavior: FakeGhBehavior, calls: RecordedGhCall[] = []) =>
  GitAuthRemediationService.make().pipe(
    Effect.provideService(VcsProcess.VcsProcess, makeFakeVcsProcess(behavior, calls)),
  );

const makeTmpDir = (): Effect.Effect<
  string,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Scope.Scope
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectory({
      prefix: "git-auth-remediation-test-",
    });
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
          ? Effect.logWarning(`Failed to remove temporary directory ${directory}`, error)
          : Effect.promise(() => sleepRealTime(50)).pipe(
              Effect.andThen(() =>
                removeTempDirectoryWithRetry(fileSystem, directory, attemptsRemaining - 1),
              ),
            ),
      ),
    );

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitAuthRemediationService.test.git",
      cwd,
      args,
    });
    return result.stdout.trim();
  });

const initRepoWithRemote = (cwd: string, remoteUrl: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["remote", "add", "origin", remoteUrl]);
  });

it.layer(TestLayer)("GitAuthRemediationService", (it) => {
  describe("plan", () => {
    it.effect("offers gh credentials for HTTPS remotes when gh is authenticated", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithRemote(cwd, `https://${UNREACHABLE_HOST}/owner/repo.git`);
        const calls: RecordedGhCall[] = [];
        const service = yield* makeService("authed", calls);

        const plan = yield* service.plan({ cwd });

        assert.equal(plan.remoteName, "origin");
        assert.equal(plan.remoteUrl, `https://${UNREACHABLE_HOST}/owner/repo.git`);
        assert.equal(plan.host, UNREACHABLE_HOST);
        assert.equal(plan.scheme, "https");
        assert.deepStrictEqual(calls, [
          {
            command: "gh",
            args: ["auth", "status", "--hostname", UNREACHABLE_HOST],
          },
        ]);

        const ghAction = plan.actions.find((action) => action.id === "gh_setup_git");
        assert.equal(ghAction?.applicable, true);
        assert.equal(ghAction?.recommended, true);
        assert.equal(ghAction?.command, `gh auth setup-git --hostname ${UNREACHABLE_HOST}`);

        const sshAction = plan.actions.find((action) => action.id === "switch_remote_to_ssh");
        assert.equal(sshAction?.applicable, false);
        assert.equal(sshAction?.recommended, false);
        assert.equal(
          sshAction?.command,
          `git remote set-url origin git@${UNREACHABLE_HOST}:owner/repo.git`,
        );
        assert.isString(sshAction?.inapplicableReason);
      }),
    );

    it.effect("marks gh unavailable when the CLI is missing or logged out", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithRemote(cwd, `https://${UNREACHABLE_HOST}/owner/repo.git`);

        const missing = yield* makeService("missing");
        const missingPlan = yield* missing.plan({ cwd });
        const missingAction = missingPlan.actions.find((action) => action.id === "gh_setup_git");
        assert.equal(missingAction?.applicable, false);
        assert.match(missingAction?.inapplicableReason ?? "", /not installed/);
        assert.isTrue(missingPlan.actions.every((action) => !action.recommended));

        const loggedOut = yield* makeService("unauthenticated");
        const loggedOutPlan = yield* loggedOut.plan({ cwd });
        const loggedOutAction = loggedOutPlan.actions.find(
          (action) => action.id === "gh_setup_git",
        );
        assert.equal(loggedOutAction?.applicable, false);
        assert.match(loggedOutAction?.inapplicableReason ?? "", /not logged in/);
      }),
    );

    it.effect("reports SSH remotes as already remediated", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithRemote(cwd, `git@${UNREACHABLE_HOST}:owner/repo.git`);
        const service = yield* makeService("authed");

        const plan = yield* service.plan({ cwd });

        assert.equal(plan.scheme, "ssh");
        assert.equal(plan.host, UNREACHABLE_HOST);
        assert.isTrue(plan.actions.length > 0);
        assert.isTrue(plan.actions.every((action) => !action.applicable));
      }),
    );

    it.effect("targets the current branch's upstream remote over the primary remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithRemote(cwd, `https://${UNREACHABLE_HOST}/owner/repo.git`);
        yield* git(cwd, ["remote", "add", "fork", `https://${UNREACHABLE_HOST}/fork/repo.git`]);
        const branch = yield* git(cwd, ["symbolic-ref", "--short", "HEAD"]);
        yield* git(cwd, ["config", `branch.${branch}.remote`, "fork"]);
        const service = yield* makeService("authed");

        const plan = yield* service.plan({ cwd });

        assert.equal(plan.remoteName, "fork");
        assert.equal(plan.remoteUrl, `https://${UNREACHABLE_HOST}/fork/repo.git`);
      }),
    );

    it.effect("returns an empty plan when the repository has no supported remote", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;
        yield* driver.initRepo({ cwd });
        const service = yield* makeService("authed");

        const plan = yield* service.plan({ cwd });

        assert.deepStrictEqual(plan, {
          remoteName: null,
          remoteUrl: null,
          host: null,
          scheme: null,
          actions: [],
        });
      }),
    );
  });

  describe("apply", () => {
    it.effect("runs gh auth setup-git against the remote host", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithRemote(cwd, `https://${UNREACHABLE_HOST}/owner/repo.git`);
        const calls: RecordedGhCall[] = [];
        const service = yield* makeService("authed", calls);

        const result = yield* service.apply({ cwd, actionId: "gh_setup_git" });

        assert.equal(result.actionId, "gh_setup_git");
        assert.match(result.detail, /GitHub CLI/);
        assert.deepStrictEqual(calls, [
          {
            command: "gh",
            args: ["auth", "setup-git", "--hostname", UNREACHABLE_HOST],
          },
        ]);
      }),
    );

    it.effect("fails with a clear error when gh setup-git fails", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithRemote(cwd, `https://${UNREACHABLE_HOST}/owner/repo.git`);
        const service = yield* makeService("unauthenticated");

        const error = yield* service.apply({ cwd, actionId: "gh_setup_git" }).pipe(Effect.flip);

        assert.instanceOf(error, GitManagerError);
        assert.match(error.detail, /gh auth setup-git failed/);
      }),
    );

    it.effect("refuses to switch the remote when SSH access is unavailable", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const httpsUrl = `https://${UNREACHABLE_HOST}/owner/repo.git`;
        yield* initRepoWithRemote(cwd, httpsUrl);
        const service = yield* makeService("authed");

        const error = yield* service
          .apply({ cwd, actionId: "switch_remote_to_ssh" })
          .pipe(Effect.flip);

        assert.instanceOf(error, GitManagerError);
        assert.equal(yield* git(cwd, ["remote", "get-url", "origin"]), httpsUrl);
      }),
    );
  });
});

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { assert, it } from "@effect/vitest";

import { CheckpointRef, GitCommandError } from "@threadlines/contracts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsDriverService from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { runVcsDriverContractSuite } from "./testing/VcsDriverContractHarness.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-contract-",
});
const GitContractLayer = Layer.mergeAll(GitVcsDriver.vcsLayer, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.execute({
      operation: "GitVcsDriver.contract.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
  });

type GitContractError = GitCommandError | PlatformError.PlatformError;

runVcsDriverContractSuite<GitVcsDriver.GitVcsDriver, GitContractError>({
  name: "Git",
  kind: "git",
  layer: GitContractLayer,
  fixture: {
    createRepo: (cwd) =>
      Effect.gen(function* () {
        yield* runGit(cwd, ["init"]);
        yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
        yield* runGit(cwd, ["config", "user.name", "Test"]);
      }),
    writeFile: (cwd, relativePath, contents) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const absolutePath = path.join(cwd, relativePath);
        yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
        yield* fileSystem.writeFileString(absolutePath, contents);
      }),
    trackFile: (cwd, relativePath) => runGit(cwd, ["add", relativePath]),
    commit: (cwd, message) => runGit(cwd, ["commit", "-m", message]),
    ignorePath: (cwd, pattern) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.writeFileString(path.join(cwd, ".gitignore"), `${pattern}\n`);
      }),
  },
});

it.effect("GitVcsDriver forwards execute env to the VCS process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  let observedAppendTruncationMarker: boolean | undefined;

  return Effect.gen(function* () {
    const driver = yield* GitVcsDriver.makeVcsDriverShape();

    yield* driver.execute({
      operation: "GitVcsDriver.test.env",
      cwd: "/repo",
      args: ["status"],
      env: {
        GIT_INDEX_FILE: "/tmp/threadlines-index",
      },
      appendTruncationMarker: true,
    });

    assert.deepStrictEqual(observedEnv, {
      // The driver always disables interactive credential prompts.
      GIT_TERMINAL_PROMPT: "0",
      GIT_INDEX_FILE: "/tmp/threadlines-index",
    });
    assert.strictEqual(observedAppendTruncationMarker, true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(VcsProcess.VcsProcess)({
          run: (input) =>
            Effect.sync(() => {
              observedEnv = input.env;
              observedAppendTruncationMarker = input.appendTruncationMarker;
              return {
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdout: "",
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
      ),
    ),
  );
});

it.layer(GitContractLayer)("GitVcsDriver.checkpoints.readRevisionFile", (it) => {
  it.effect("reads a picture as a snapshot or HEAD holds it, byte for byte", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* VcsDriverService.VcsDriver;
      const checkpoints = driver.checkpoints!;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-revision-file-" });
      yield* runGit(cwd, ["init"]);
      yield* runGit(cwd, ["config", "user.email", "test@test.com"]);
      yield* runGit(cwd, ["config", "user.name", "Test"]);

      // Every byte value, so any text decoding on the way would show.
      const committed = Uint8Array.from({ length: 256 }, (_, index) => index);
      const edited = Uint8Array.from({ length: 300 }, (_, index) => 255 - (index % 256));
      yield* fileSystem.makeDirectory(path.join(cwd, "art"), { recursive: true });
      yield* fileSystem.writeFile(path.join(cwd, "art", "shot.png"), committed);
      yield* runGit(cwd, ["add", "art/shot.png"]);
      yield* runGit(cwd, ["commit", "-m", "picture"]);
      yield* fileSystem.writeFile(path.join(cwd, "art", "shot.png"), edited);
      const checkpointRef = CheckpointRef.make("refs/threadlines/checkpoints/test/turn/1");
      yield* checkpoints.captureCheckpoint({ cwd, checkpointRef });

      const read = (revision: CheckpointRef | "HEAD", file: string, maxBytes = 4096) =>
        checkpoints.readRevisionFile({ cwd, revision, path: file, maxBytes });

      const atHead = yield* read("HEAD", "art/shot.png");
      assert.deepEqual(
        atHead.kind === "file" ? Buffer.from(atHead.base64, "base64") : null,
        Buffer.from(committed),
      );
      const atSnapshot = yield* read(checkpointRef, "art/shot.png");
      assert.deepEqual(
        atSnapshot.kind === "file" ? Buffer.from(atSnapshot.base64, "base64") : null,
        Buffer.from(edited),
      );
      assert.deepEqual(yield* read("HEAD", "art/shot.png", 100), { kind: "too-large", size: 256 });
      assert.deepEqual(yield* read("HEAD", "art/none.png"), { kind: "missing" });
      // A folder is not a file.
      assert.deepEqual(yield* read("HEAD", "art"), { kind: "missing" });
    }),
  );
});

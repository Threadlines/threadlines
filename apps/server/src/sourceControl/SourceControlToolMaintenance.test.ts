import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError } from "@threadlines/contracts";

import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlToolMaintenance from "./SourceControlToolMaintenance.ts";
import * as SourceControlToolPackages from "./SourceControlToolPackages.ts";
import * as SourceControlWinGet from "./SourceControlWinGet.ts";

const processOutput: VcsProcess.VcsProcessOutput = {
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "Successfully installed",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};

it("parses and normalizes the latest versions reported by WinGet", () => {
  assert.strictEqual(
    SourceControlWinGet.parseLatestWinGetVersion(
      "git",
      "Found Git [Git.Git]\r\nVersion\r\n--------\r\n2.55.0.3\r\n2.55.0.2\r\n",
    ),
    "2.55.0.windows.3",
  );
  assert.strictEqual(
    SourceControlWinGet.parseLatestWinGetVersion(
      "github-cli",
      "Found GitHub CLI [GitHub.cli]\nVersion\n-------\n2.98.0\n2.97.0\n",
    ),
    "2.98.0",
  );
});

it("uses Linuxbrew without treating sudo package managers as one-click capable", () => {
  assert.strictEqual(
    SourceControlToolPackages.selectSourceControlToolPackageManager({
      platform: "linux",
      commandAvailable: (command) => command === "brew" || command === "apt-get",
    }),
    "homebrew",
  );
  assert.strictEqual(
    SourceControlToolPackages.selectSourceControlToolPackageManager({
      platform: "linux",
      commandAvailable: (command) => command === "apt-get",
    }),
    null,
  );
});

it("verifies installed versions from raw discovery output without an advisory", () => {
  assert.strictEqual(
    SourceControlToolMaintenance.currentSourceControlToolVersion(
      {
        versionControlSystems: [
          {
            kind: "git",
            label: "Git",
            executable: "git",
            implemented: true,
            status: "available",
            version: Option.some("git version 2.55.0.windows.4"),
            installHint: "Install Git.",
            detail: Option.none(),
          },
        ],
        sourceControlProviders: [],
      },
      "git",
    ),
    "2.55.0.windows.4",
  );
});

it.effect("runs only the allowlisted source control WinGet update recipes", () => {
  const calls: VcsProcess.VcsProcessInput[] = [];
  const layer = Layer.effect(
    SourceControlToolMaintenance.SourceControlToolMaintenance,
    SourceControlToolMaintenance.make({
      platform: "win32",
      commandAvailable: (command) => command === "winget",
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "source-tool-update-test-" })),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          calls.push(input);
          return Effect.succeed(processOutput);
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const maintenance = yield* SourceControlToolMaintenance.SourceControlToolMaintenance;
    yield* maintenance.update({ target: "github-cli" });
    yield* maintenance.update({ target: "git" });

    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0], {
      operation: "source-control.tool.update",
      command: "winget",
      args: [
        "upgrade",
        "--id",
        "GitHub.cli",
        "--exact",
        "--source",
        "winget",
        "--silent",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--disable-interactivity",
      ],
      cwd: process.cwd(),
      timeoutMs: 300_000,
      maxOutputBytes: 10_000,
      appendTruncationMarker: true,
    });
    assert.deepStrictEqual(calls[1]?.args.slice(0, 3), ["upgrade", "--id", "Git.Git"]);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses one-click updates when no supported package manager is available", () => {
  let calls = 0;
  const layer = Layer.effect(
    SourceControlToolMaintenance.SourceControlToolMaintenance,
    SourceControlToolMaintenance.make({
      platform: "linux",
      commandAvailable: () => false,
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "source-tool-update-test-" })),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: () => {
          calls += 1;
          return Effect.succeed(processOutput);
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const maintenance = yield* SourceControlToolMaintenance.SourceControlToolMaintenance;
    const result = yield* Effect.result(maintenance.update({ target: "git" }));

    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(calls, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("runs allowlisted Homebrew install and update recipes on macOS", () => {
  const calls: VcsProcess.VcsProcessInput[] = [];
  const layer = Layer.effect(
    SourceControlToolMaintenance.SourceControlToolMaintenance,
    SourceControlToolMaintenance.make({
      platform: "darwin",
      commandAvailable: (command) => command === "brew" || command === "git",
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "source-tool-update-test-" })),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          calls.push(input);
          return Effect.succeed(processOutput);
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const maintenance = yield* SourceControlToolMaintenance.SourceControlToolMaintenance;
    yield* maintenance.update({ target: "git" });
    yield* maintenance.update({ target: "github-cli", operation: "install" });
    yield* maintenance.update({ target: "azure-cli", operation: "install" });

    assert.deepStrictEqual(
      calls.map((call) => [call.command, ...call.args]),
      [
        ["brew", "upgrade", "git"],
        ["brew", "install", "gh"],
        ["brew", "install", "azure-cli"],
        ["az", "extension", "add", "--name", "azure-devops"],
      ],
    );
  }).pipe(Effect.provide(layer));
});

it.effect("explains when WinGet has no applicable package update", () => {
  const layer = Layer.effect(
    SourceControlToolMaintenance.SourceControlToolMaintenance,
    SourceControlToolMaintenance.make({
      platform: "win32",
      commandAvailable: (command) => command === "winget",
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "source-tool-update-test-" })),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) =>
          Effect.fail(
            new VcsProcessExitError({
              operation: input.operation,
              command: [input.command, ...input.args].join(" "),
              cwd: input.cwd,
              exitCode: 0x8a15002b,
              detail: "No applicable update found",
            }),
          ),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const maintenance = yield* SourceControlToolMaintenance.SourceControlToolMaintenance;
    const result = yield* Effect.result(maintenance.update({ target: "git" }));

    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.match(result.failure.reason, /does not currently offer a newer compatible Git/i);
      assert.match(result.failure.reason, /official release/i);
    }
  }).pipe(Effect.provide(layer));
});

it.effect("serializes all source control updates through one WinGet lock", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let calls = 0;
    const layer = Layer.effect(
      SourceControlToolMaintenance.SourceControlToolMaintenance,
      SourceControlToolMaintenance.make({
        platform: "win32",
        commandAvailable: (command) => command === "winget",
      }),
    ).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "source-tool-update-test-" })),
      Layer.provide(
        Layer.mock(VcsProcess.VcsProcess)({
          run: () => {
            calls += 1;
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(processOutput),
            );
          },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const maintenance = yield* SourceControlToolMaintenance.SourceControlToolMaintenance;
      const first = yield* maintenance.update({ target: "github-cli" }).pipe(Effect.forkScoped);
      yield* Deferred.await(started);

      const second = yield* Effect.result(maintenance.update({ target: "git" }));
      assert.strictEqual(second._tag, "Failure");
      assert.strictEqual(calls, 1);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
    }).pipe(Effect.provide(layer));
  }),
);

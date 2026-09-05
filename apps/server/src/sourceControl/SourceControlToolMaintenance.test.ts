import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";
import { VcsProcessExitError, VcsProcessTimeoutError } from "@threadlines/contracts";

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

it("recognizes Homebrew kegs by their real path under the brew prefix's Cellar", () => {
  // A brew-installed gh: the bin symlink resolves into the Cellar.
  assert.strictEqual(
    SourceControlToolPackages.isHomebrewCellarExecutable({
      executableRealPath: "/opt/homebrew/Cellar/gh/2.97.0/bin/gh",
      brewCommandPath: "/opt/homebrew/bin/brew",
    }),
    true,
  );
  // gh from its own installer, and Apple's git: on the PATH, not brew's.
  assert.strictEqual(
    SourceControlToolPackages.isHomebrewCellarExecutable({
      executableRealPath: "/Users/will/.local/gh/versions/2.93.0/bin/gh",
      brewCommandPath: "/opt/homebrew/bin/brew",
    }),
    false,
  );
  assert.strictEqual(
    SourceControlToolPackages.isHomebrewCellarExecutable({
      executableRealPath: "/usr/bin/git",
      brewCommandPath: "/opt/homebrew/bin/brew",
    }),
    false,
  );
  // Intel macs put both brew and standalone installers under /usr/local; only
  // the Cellar path marks a keg.
  assert.strictEqual(
    SourceControlToolPackages.isHomebrewCellarExecutable({
      executableRealPath: "/usr/local/bin/gh",
      brewCommandPath: "/usr/local/bin/brew",
    }),
    false,
  );
  assert.strictEqual(
    SourceControlToolPackages.isHomebrewCellarExecutable({
      executableRealPath: "/usr/local/Cellar/gh/2.97.0/bin/gh",
      brewCommandPath: "/usr/local/bin/brew",
    }),
    true,
  );
  assert.strictEqual(
    SourceControlToolPackages.isHomebrewCellarExecutable({
      executableRealPath: null,
      brewCommandPath: "/opt/homebrew/bin/brew",
    }),
    false,
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

it.effect("uses the official Git updater while other Windows tools keep using WinGet", () => {
  const calls: VcsProcess.VcsProcessInput[] = [];
  const layer = Layer.effect(
    SourceControlToolMaintenance.SourceControlToolMaintenance,
    SourceControlToolMaintenance.make({
      platform: "win32",
      commandAvailable: (command) => command === "winget" || command === "git",
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
    assert.deepStrictEqual(calls[1], {
      operation: "source-control.tool.update",
      command: "git",
      args: ["update-git-for-windows", "--yes"],
      cwd: process.cwd(),
      timeoutMs: 300_000,
      maxOutputBytes: 10_000,
      appendTruncationMarker: true,
      allowNonZeroExit: true,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("treats Git for Windows exit code 2 as an installer launch", () => {
  const calls: VcsProcess.VcsProcessInput[] = [];
  const layer = Layer.effect(
    SourceControlToolMaintenance.SourceControlToolMaintenance,
    SourceControlToolMaintenance.make({
      platform: "win32",
      commandAvailable: (command) => command === "git",
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "source-tool-update-test-" })),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          calls.push(input);
          return Effect.succeed({
            ...processOutput,
            exitCode: ChildProcessSpawner.ExitCode(2),
            stderr: "Update 2.55.0.windows.5 is available",
          });
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const maintenance = yield* SourceControlToolMaintenance.SourceControlToolMaintenance;
    const result = yield* maintenance.update({ target: "git" });

    assert.deepStrictEqual(result, { status: "started" });
    assert.deepStrictEqual(calls[0]?.args, ["update-git-for-windows", "--yes"]);
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

it.effect("explains when WinGet has no applicable GitHub CLI update", () => {
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
    const result = yield* Effect.result(maintenance.update({ target: "github-cli" }));

    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.match(
        result.failure.reason,
        /does not currently offer a newer compatible GitHub CLI/i,
      );
      assert.match(result.failure.reason, /official release/i);
    }
  }).pipe(Effect.provide(layer));
});

it.effect("explains a cancelled Windows installer and lets the user retry", () => {
  const cancelledExitCodes = [0x8a15010c, 0x8a15010c - 2 ** 32];
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
          const exitCode = cancelledExitCodes.shift();
          return exitCode === undefined
            ? Effect.succeed(processOutput)
            : Effect.fail(
                new VcsProcessExitError({
                  operation: input.operation,
                  command: [input.command, ...input.args].join(" "),
                  cwd: input.cwd,
                  exitCode,
                  detail: "Installer transcript",
                }),
              );
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const maintenance = yield* SourceControlToolMaintenance.SourceControlToolMaintenance;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = yield* Effect.result(
        maintenance.update({ target: "git", operation: "install" }),
      );
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.strictEqual(
          result.failure.reason,
          "Git installation was cancelled. Try again and approve the Windows permission prompt.",
        );
        assert.strictEqual((yield* maintenance.getState)[0]?.message, result.failure.reason);
      }
    }
    yield* maintenance.update({ target: "git", operation: "install" });
    assert.strictEqual((yield* maintenance.getState)[0]?.status, "succeeded");
  }).pipe(Effect.provide(layer));
});

it.effect("asks the user to rescan after a Windows installer times out", () => {
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
            new VcsProcessTimeoutError({
              operation: input.operation,
              command: [input.command, ...input.args].join(" "),
              cwd: input.cwd,
              timeoutMs: 300_000,
            }),
          ),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const maintenance = yield* SourceControlToolMaintenance.SourceControlToolMaintenance;
    const result = yield* Effect.result(
      maintenance.update({ target: "github-cli", operation: "install" }),
    );
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.strictEqual(
        result.failure.reason,
        "GitHub CLI installation timed out. Check for a Windows permission prompt, then rescan before retrying. The installer may still finish.",
      );
      assert.deepStrictEqual(yield* maintenance.getState, [
        {
          target: "github-cli",
          operation: "install",
          status: "failed",
          message: result.failure.reason,
        },
      ]);
    }
  }).pipe(Effect.provide(layer));
});

it.effect("explains when Homebrew does not manage the tool it was asked to upgrade", () => {
  const layer = Layer.effect(
    SourceControlToolMaintenance.SourceControlToolMaintenance,
    SourceControlToolMaintenance.make({
      platform: "darwin",
      commandAvailable: (command) => command === "brew",
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
              exitCode: 1,
              detail: "==> Auto-updated Homebrew!\nError: gh not installed",
            }),
          ),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const maintenance = yield* SourceControlToolMaintenance.SourceControlToolMaintenance;
    const result = yield* Effect.result(maintenance.update({ target: "github-cli" }));

    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.match(result.failure.reason, /not installed with Homebrew/i);
      // The readable classification, not the raw brew auto-update transcript.
      assert.notMatch(result.failure.reason, /Auto-updated Homebrew/i);
    }
  }).pipe(Effect.provide(layer));
});

it.effect(
  "queues different tools, rejects duplicates, and keeps installing after the caller leaves",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const layer = Layer.effect(
        SourceControlToolMaintenance.SourceControlToolMaintenance,
        SourceControlToolMaintenance.make({
          platform: "win32",
          commandAvailable: (command) => command === "winget" || command === "git",
        }),
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "source-tool-update-test-" }),
        ),
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

        const duplicate = yield* Effect.result(maintenance.update({ target: "github-cli" }));
        assert.strictEqual(duplicate._tag, "Failure");
        const second = yield* maintenance.update({ target: "git" }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(
          (yield* maintenance.getState).map((state) => [state.target, state.status]),
          [
            ["github-cli", "running"],
            ["git", "queued"],
          ],
        );
        assert.strictEqual(calls, 1);

        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(second);
        assert.strictEqual(calls, 2);
        assert.deepStrictEqual(
          (yield* maintenance.getState).map((state) => state.status),
          ["succeeded", "succeeded"],
        );
      }).pipe(Effect.provide(layer));
    }),
);

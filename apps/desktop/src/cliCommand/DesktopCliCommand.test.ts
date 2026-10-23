import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { appImageCommandArgs } from "./appImageCommand.ts";
import { type CliCommandLaunch, renderCliCommandScript } from "./cliCommandScript.ts";
import {
  type CliCommandSetup,
  type CliCommandSystem,
  make,
  type WindowsUserPath,
} from "./DesktopCliCommand.ts";

/** The administrator prompt and the Windows registry, as the tests answer them. */
function fakeSystem(answer: "done" | "cancelled" = "cancelled") {
  const calls = { administrator: [] as string[], userPath: null as WindowsUserPath | null };
  const system: CliCommandSystem = {
    runAsAdministrator: (shellCommand) =>
      Effect.sync(() => {
        calls.administrator.push(shellCommand);
        return answer;
      }),
    readUserPath: Effect.sync(() => calls.userPath),
    writeUserPath: (path) =>
      Effect.sync(() => {
        calls.userPath = path;
      }),
  };
  return { system, calls };
}

function setupIn(directory: string, overrides: Partial<CliCommandSetup> = {}): CliCommandSetup {
  const launch: CliCommandLaunch = {
    platform: "darwin",
    executablePath: "/Applications/Threadlines.app/Contents/MacOS/Threadlines",
    entryPath: "/Applications/Threadlines.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
    threadlinesHome: null,
    appImagePath: null,
    ...overrides.launch,
  };
  return {
    platform: launch.platform,
    directory,
    devCommand: null,
    unavailableReason: null,
    processPath: () => "/usr/bin:/bin",
    ...overrides,
    launch,
  };
}

const temp = (name: string) => mkdtempSync(join(tmpdir(), `threadlines-cli-command-${name}-`));

describe("DesktopCliCommand", () => {
  it.effect("installs a script that runs this app's server as the command, and removes it", () =>
    Effect.gen(function* () {
      const root = temp("posix");
      const directory = join(root, "bin");
      // Stands in for the app's executable: says what it was started with.
      const executablePath = join(root, "fake electron");
      writeFileSync(
        executablePath,
        `#!/bin/sh\nprintf '%s\\n' "$ELECTRON_RUN_AS_NODE" "$THREADLINES_CLI_ONLY" "$THREADLINES_HOME" "$@"\n`,
      );
      chmodSync(executablePath, 0o755);
      const home = join(root, "it's home");
      const { system, calls } = fakeSystem();
      const command = yield* make(
        setupIn(directory, {
          launch: {
            platform: "linux",
            executablePath,
            entryPath: "/opt/Threadlines/resources/app.asar/apps/server/dist/bin.mjs",
            threadlinesHome: home,
            appImagePath: null,
          },
          platform: "linux",
        }),
        system,
      );

      const before = yield* command.status;
      assert.equal(before.state, "not_installed");
      assert.equal(before.path, join(directory, "threadlines"));
      assert.isFalse(before.folderOnPath);

      const installed = yield* command.install;
      assert.equal(installed.outcome, "done");
      assert.equal(installed.status.state, "installed");
      const target = join(directory, "threadlines");
      assert.equal(statSync(target).mode & 0o777, 0o755);

      const output = execFileSync(target, ["thread", "start", "web", "fix the login bug"], {
        encoding: "utf8",
      });
      assert.deepEqual(output.trimEnd().split("\n"), [
        "1",
        "1",
        home,
        "/opt/Threadlines/resources/app.asar/apps/server/dist/bin.mjs",
        "thread",
        "start",
        "web",
        "fix the login bug",
      ]);

      // Another copy's script is told apart, and Install again replaces it.
      writeFileSync(target, readFileSync(target, "utf8").replace(executablePath, "/elsewhere"));
      assert.equal((yield* command.status).state, "other_copy");
      assert.equal((yield* command.install).status.state, "installed");

      const removed = yield* command.remove;
      assert.equal(removed.outcome, "done");
      assert.equal(removed.status.state, "not_installed");
      assert.isFalse(existsSync(target));
      assert.deepEqual(calls.administrator, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces npm's threadlines link without writing through it", () =>
    Effect.gen(function* () {
      const root = temp("link");
      const directory = join(root, "bin");
      mkdirSync(directory);
      const npmBin = join(root, "npm-bin.mjs");
      writeFileSync(npmBin, "// npm's threadlines\n");
      symlinkSync(npmBin, join(directory, "threadlines"));
      const command = yield* make(setupIn(directory), fakeSystem().system);

      assert.equal((yield* command.status).state, "other_copy");
      assert.equal((yield* command.install).status.state, "installed");
      assert.equal(readFileSync(npmBin, "utf8"), "// npm's threadlines\n");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "asks for an administrator on macOS when the folder isn't the user's, and Cancel changes nothing",
    () =>
      Effect.gen(function* () {
        const directory = temp("locked");
        chmodSync(directory, 0o555);
        const { system, calls } = fakeSystem("cancelled");
        const command = yield* make(setupIn(directory), system);

        const result = yield* command.install;
        chmodSync(directory, 0o755);
        assert.equal(result.outcome, "cancelled");
        assert.equal(result.status.state, "not_installed");
        assert.equal(calls.administrator.length, 1);
        assert.match(
          calls.administrator[0] ?? "",
          /\/bin\/cp '.+' '.+\/threadlines' && \/bin\/chmod 755/u,
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "on Windows, writes threadlines.cmd and adds its folder to the user's PATH, keeping the rest",
    () =>
      Effect.gen(function* () {
        const directory = temp("windows");
        const { system, calls } = fakeSystem();
        calls.userPath = { value: "%USERPROFILE%\\bin;C:\\Tools", kind: "ExpandString" };
        const command = yield* make(
          setupIn(directory, {
            platform: "win32",
            processPath: () => "C:\\Windows",
            launch: {
              platform: "win32",
              executablePath:
                "C:\\Users\\a\\AppData\\Local\\Programs\\Threadlines\\Threadlines.exe",
              entryPath:
                "C:\\Users\\a\\AppData\\Local\\Programs\\Threadlines\\resources\\app.asar\\apps\\server\\dist\\bin.mjs",
              threadlinesHome: "C:\\Data\\100% mine",
              appImagePath: null,
            },
          }),
          system,
        );

        const installed = yield* command.install;
        assert.equal(installed.status.state, "installed");
        assert.isTrue(installed.status.folderOnPath);
        assert.deepEqual(calls.userPath, {
          value: `%USERPROFILE%\\bin;C:\\Tools;${directory}`,
          kind: "ExpandString",
        });
        const script = readFileSync(join(directory, "threadlines.cmd"), "utf8");
        assert.include(script, "\r\nset ELECTRON_RUN_AS_NODE=1\r\nset THREADLINES_CLI_ONLY=1\r\n");
        assert.include(script, 'set "THREADLINES_HOME=C:\\Data\\100%% mine"');
        assert.include(script, '\\Threadlines.exe" "C:\\Users\\a\\');
        assert.include(script, 'bin.mjs" %*\r\n');

        yield* command.remove;
        assert.deepEqual(calls.userPath, {
          value: "%USERPROFILE%\\bin;C:\\Tools",
          kind: "ExpandString",
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("installs nothing in a dev build, and says how to run it from the repo", () =>
    Effect.gen(function* () {
      const directory = temp("dev");
      const command = yield* make(
        setupIn(directory, { devCommand: "node /repo/apps/server/src/bin.ts connect --dev" }),
        fakeSystem().system,
      );
      const result = yield* command.install;
      assert.equal(result.outcome, "failed");
      assert.equal(result.status.state, "unavailable");
      assert.equal(result.status.devCommand, "node /repo/apps/server/src/bin.ts connect --dev");
      assert.isFalse(existsSync(join(directory, "threadlines")));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("the AppImage's command", () => {
  it("runs the persistent AppImage file and hands on only the command's own arguments", () => {
    const script = renderCliCommandScript({
      platform: "linux",
      executablePath: "/tmp/.mount_ThreadXYZ/threadlines",
      entryPath: "/tmp/.mount_ThreadXYZ/resources/app.asar/apps/server/dist/bin.mjs",
      threadlinesHome: null,
      appImagePath: "/home/a/Apps/Threadlines.AppImage",
    });
    assert.notInclude(script, ".mount_");
    assert.include(
      script,
      `export THREADLINES_APPIMAGE_COMMAND=1\nexec '/home/a/Apps/Threadlines.AppImage' --threadlines-command "$@"`,
    );
    // The AppImage launcher may add --no-sandbox in front.
    assert.deepEqual(
      appImageCommandArgs([
        "/tmp/.mount_ThreadABC/threadlines",
        "--no-sandbox",
        "--threadlines-command",
        "thread",
        "list",
      ]),
      ["thread", "list"],
    );
  });
});

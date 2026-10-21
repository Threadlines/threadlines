import fsPromises from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertSuccess } from "@effect/vitest/utils";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  isCommandAvailable,
  launchBrowser,
  launchEditorProcess,
  quoteWindowsShellArg,
  resolveAvailableEditors,
  resolveBrowserLaunch,
  resolveEditorLaunch,
} from "./externalLauncher.ts";

function encodeUtf16LeBase64(input: string): string {
  const bytes = new Uint8Array(input.length * 2);
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >>> 8;
  }
  return Encoding.encodeBase64(bytes);
}

function makeMockDetachedHandle(onUnref: () => void = () => undefined, exitCode = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.sync(() => {
      onUnref();
      return Effect.void;
    }),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function expectedHiddenWindowsOptions<T extends ChildProcess.CommandOptions>(options: T): T {
  return process.platform === "win32" ? ({ ...options, windowsHide: true } as T) : options;
}

it.layer(NodeServices.layer)("resolveEditorLaunch", (it) => {
  it.effect("returns commands for command-based editors", () =>
    Effect.gen(function* () {
      const antigravityLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "antigravity" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(antigravityLaunch, {
        command: "agy",
        args: ["/tmp/workspace"],
      });

      const cursorLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "cursor" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(cursorLaunch, {
        command: "cursor",
        args: ["/tmp/workspace"],
      });

      const traeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "trae" },
        "darwin",
      );
      assert.deepEqual(traeLaunch, {
        command: "trae",
        args: ["/tmp/workspace"],
      });

      const kiroLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "kiro" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(kiroLaunch, {
        command: "kiro",
        args: ["ide", "/tmp/workspace"],
      });

      const vscodeLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(vscodeLaunch, {
        command: "code",
        args: ["/tmp/workspace"],
      });

      const vscodeInsidersLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode-insiders" },
        "darwin",
      );
      assert.deepEqual(vscodeInsidersLaunch, {
        command: "code-insiders",
        args: ["/tmp/workspace"],
      });

      const vscodiumLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscodium" },
        "darwin",
      );
      assert.deepEqual(vscodiumLaunch, {
        command: "codium",
        args: ["/tmp/workspace"],
      });

      const zedLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "zed" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(zedLaunch, {
        command: "zed",
        args: ["/tmp/workspace"],
      });

      const ideaLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "idea" },
        "darwin",
      );
      assert.deepEqual(ideaLaunch, {
        command: "idea",
        args: ["/tmp/workspace"],
      });

      const aquaLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "aqua" },
        "darwin",
      );
      assert.deepEqual(aquaLaunch, {
        command: "aqua",
        args: ["/tmp/workspace"],
      });

      const clionLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "clion" },
        "darwin",
      );
      assert.deepEqual(clionLaunch, {
        command: "clion",
        args: ["/tmp/workspace"],
      });

      const datagripLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "datagrip" },
        "darwin",
      );
      assert.deepEqual(datagripLaunch, {
        command: "datagrip",
        args: ["/tmp/workspace"],
      });

      const dataspellLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "dataspell" },
        "darwin",
      );
      assert.deepEqual(dataspellLaunch, {
        command: "dataspell",
        args: ["/tmp/workspace"],
      });

      const golandLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "goland" },
        "darwin",
      );
      assert.deepEqual(golandLaunch, {
        command: "goland",
        args: ["/tmp/workspace"],
      });

      const phpstormLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "phpstorm" },
        "darwin",
      );
      assert.deepEqual(phpstormLaunch, {
        command: "phpstorm",
        args: ["/tmp/workspace"],
      });

      const pycharmLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "pycharm" },
        "darwin",
      );
      assert.deepEqual(pycharmLaunch, {
        command: "pycharm",
        args: ["/tmp/workspace"],
      });

      const riderLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "rider" },
        "darwin",
      );
      assert.deepEqual(riderLaunch, {
        command: "rider",
        args: ["/tmp/workspace"],
      });

      const rubymineLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "rubymine" },
        "darwin",
      );
      assert.deepEqual(rubymineLaunch, {
        command: "rubymine",
        args: ["/tmp/workspace"],
      });

      const rustroverLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "rustrover" },
        "darwin",
      );
      assert.deepEqual(rustroverLaunch, {
        command: "rustrover",
        args: ["/tmp/workspace"],
      });

      const webstormLaunch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "webstorm" },
        "darwin",
      );
      assert.deepEqual(webstormLaunch, {
        command: "webstorm",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("applies launch-style-specific navigation arguments", () =>
    Effect.gen(function* () {
      const lineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "cursor" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(lineOnly, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/AGENTS.md:48"],
      });

      const lineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "cursor" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(lineAndColumn, {
        command: "cursor",
        args: ["--goto", "/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const traeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "trae" },
        "darwin",
      );
      assert.deepEqual(traeLineAndColumn, {
        command: "trae",
        args: ["--goto", "/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const kiroLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "kiro" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(kiroLineAndColumn, {
        command: "kiro",
        args: ["ide", "--goto", "/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const vscodeLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "vscode" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(vscodeLineAndColumn, {
        command: "code",
        args: ["--goto", "/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const vscodeInsidersLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "vscode-insiders" },
        "darwin",
      );
      assert.deepEqual(vscodeInsidersLineAndColumn, {
        command: "code-insiders",
        args: ["--goto", "/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const vscodiumLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "vscodium" },
        "darwin",
      );
      assert.deepEqual(vscodiumLineAndColumn, {
        command: "codium",
        args: ["--goto", "/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const zedLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "zed" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(zedLineAndColumn, {
        command: "zed",
        args: ["/tmp/workspace/src/process/externalLauncher.ts:71:5"],
      });

      const zedLineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "zed" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(zedLineOnly, {
        command: "zed",
        args: ["/tmp/workspace/AGENTS.md:48"],
      });

      const ideaLineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "idea" },
        "darwin",
      );
      assert.deepEqual(ideaLineOnly, {
        command: "idea",
        args: ["--line", "48", "/tmp/workspace/AGENTS.md"],
      });

      const ideaLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "idea" },
        "darwin",
      );
      assert.deepEqual(ideaLineAndColumn, {
        command: "idea",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const aquaLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "aqua" },
        "darwin",
      );
      assert.deepEqual(aquaLineAndColumn, {
        command: "aqua",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const clionLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "clion" },
        "darwin",
      );
      assert.deepEqual(clionLineAndColumn, {
        command: "clion",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const datagripLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "datagrip" },
        "darwin",
      );
      assert.deepEqual(datagripLineAndColumn, {
        command: "datagrip",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const dataspellLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "dataspell" },
        "darwin",
      );
      assert.deepEqual(dataspellLineAndColumn, {
        command: "dataspell",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const golandLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "goland" },
        "darwin",
      );
      assert.deepEqual(golandLineAndColumn, {
        command: "goland",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const phpstormLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "phpstorm" },
        "darwin",
      );
      assert.deepEqual(phpstormLineAndColumn, {
        command: "phpstorm",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const pycharmLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "pycharm" },
        "darwin",
      );
      assert.deepEqual(pycharmLineAndColumn, {
        command: "pycharm",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const riderLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "rider" },
        "darwin",
      );
      assert.deepEqual(riderLineAndColumn, {
        command: "rider",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const rubymineLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "rubymine" },
        "darwin",
      );
      assert.deepEqual(rubymineLineAndColumn, {
        command: "rubymine",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const rustroverLineAndColumn = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/src/process/externalLauncher.ts:71:5", editor: "rustrover" },
        "darwin",
      );
      assert.deepEqual(rustroverLineAndColumn, {
        command: "rustrover",
        args: ["--line", "71", "--column", "5", "/tmp/workspace/src/process/externalLauncher.ts"],
      });

      const webstormLineOnly = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/AGENTS.md:48", editor: "webstorm" },
        "darwin",
      );
      assert.deepEqual(webstormLineOnly, {
        command: "webstorm",
        args: ["--line", "48", "/tmp/workspace/AGENTS.md"],
      });
    }),
  );

  it.effect("opens file targets inside their workspace folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-root-test-" });
      const root = path.join(base, "project");
      const srcDir = path.join(root, "src");
      const filePath = path.join(srcDir, "index.ts");
      const otherRoot = path.join(base, "other");
      const otherFile = path.join(otherRoot, "index.ts");
      yield* fs.makeDirectory(srcDir, { recursive: true });
      yield* fs.makeDirectory(otherRoot);
      yield* fs.writeFileString(filePath, "export {};\n");
      yield* fs.writeFileString(otherFile, "export {};\n");
      const launchArgs = (
        cwd: string,
        editor: "vscode" | "kiro" | "zed" | "idea",
        workspaceRoot = root,
      ) =>
        resolveEditorLaunch({ cwd, editor, workspaceRoot }, "darwin", { PATH: "" }).pipe(
          Effect.map((launch) => launch.args),
        );

      assert.deepEqual(yield* launchArgs(filePath, "vscode"), [root, filePath]);
      assert.deepEqual(yield* launchArgs(`${filePath}:12:3`, "vscode"), [
        root,
        "--goto",
        `${filePath}:12:3`,
      ]);
      assert.deepEqual(yield* launchArgs(`${filePath}:12`, "kiro"), [
        "ide",
        root,
        "--goto",
        `${filePath}:12`,
      ]);
      assert.deepEqual(yield* launchArgs(`${filePath}:12:3`, "zed"), [root, `${filePath}:12:3`]);
      assert.deepEqual(yield* launchArgs(`${filePath}:12:3`, "idea"), [
        root,
        "--line",
        "12",
        "--column",
        "3",
        filePath,
      ]);
      // A file the agent has not written yet still opens inside the project.
      const newFile = path.join(srcDir, "new.ts");
      assert.deepEqual(yield* launchArgs(newFile, "vscode"), [root, newFile]);

      // The root named through a symlink still holds the file's real path.
      const linkedRoot = path.join(base, "linked");
      yield* Effect.promise(() =>
        fsPromises.symlink(root, linkedRoot, process.platform === "win32" ? "junction" : "dir"),
      );
      assert.deepEqual(yield* launchArgs(filePath, "vscode", linkedRoot), [linkedRoot, filePath]);

      // Folders open on their own, and so does anything outside the root or
      // a root that is gone.
      assert.deepEqual(yield* launchArgs(srcDir, "vscode"), [srcDir]);
      assert.deepEqual(yield* launchArgs(root, "vscode"), [root]);
      assert.deepEqual(yield* launchArgs(otherFile, "vscode"), [otherFile]);
      const climbsOut = `${root}/../other/index.ts`;
      assert.deepEqual(yield* launchArgs(climbsOut, "vscode"), [climbsOut]);
      const goneRoot = path.join(root, "gone");
      const goneFile = path.join(goneRoot, "index.ts");
      assert.deepEqual(yield* launchArgs(goneFile, "vscode", goneRoot), [goneFile]);
    }),
  );

  it.effect("falls back to zeditor when zed is not installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-launcher-test-" });
      const commandPath =
        process.platform === "win32" ? path.join(dir, "zeditor.CMD") : path.join(dir, "zeditor");
      yield* fs.writeFileString(
        commandPath,
        process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
      );
      yield* fs.chmod(commandPath, 0o755);

      const result = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "zed" },
        process.platform === "win32" ? "win32" : "linux",
        {
          PATH: dir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
      );

      assert.deepEqual(result, {
        command: "zeditor",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("falls back to the primary command when no alias is installed", () =>
    Effect.gen(function* () {
      const result = yield* resolveEditorLaunch({ cwd: "/tmp/workspace", editor: "zed" }, "linux", {
        PATH: "",
      });
      assert.deepEqual(result, {
        command: "zed",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("maps file-manager editor to OS open commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-file-manager-test-" });
      const filePath = path.join(dir, "preview.html");
      yield* fs.writeFileString(filePath, "<!doctype html>");

      const launch1 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(launch1, {
        command: "open",
        args: ["/tmp/workspace"],
      });

      const launch2 = yield* resolveEditorLaunch(
        { cwd: filePath, editor: "file-manager" },
        "win32",
        { PATH: "", SYSTEMROOT: "C:\\Windows" },
      );
      assert.deepEqual(launch2, {
        command: "C:\\Windows\\explorer.exe",
        args: [`/select,${filePath}`],
        shell: false,
        windowsHide: false,
      });

      const launch3 = yield* resolveEditorLaunch({ cwd: dir, editor: "file-manager" }, "win32", {
        PATH: "",
        SYSTEMROOT: "C:\\Windows",
      });
      assert.deepEqual(launch3, {
        command: "C:\\Windows\\explorer.exe",
        args: [dir],
        shell: false,
        windowsHide: false,
      });

      const launch4 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "file-manager" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(launch4, {
        command: "xdg-open",
        args: ["/tmp/workspace"],
      });
    }),
  );

  it.effect("reveals file targets in the file manager instead of opening them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-file-manager-test-" });
      const filePath = path.join(dir, "preview.html");
      yield* fs.writeFileString(filePath, "<!doctype html>");

      const darwinLaunch = yield* resolveEditorLaunch(
        { cwd: filePath, editor: "file-manager" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(darwinLaunch, {
        command: "open",
        args: ["-R", filePath],
      });

      const linuxLaunch = yield* resolveEditorLaunch(
        { cwd: filePath, editor: "file-manager" },
        "linux",
        { PATH: "" },
      );
      assert.deepEqual(linuxLaunch, {
        command: "xdg-open",
        args: [dir],
      });

      const darwinDirectoryLaunch = yield* resolveEditorLaunch(
        { cwd: dir, editor: "file-manager" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(darwinDirectoryLaunch, {
        command: "open",
        args: [dir],
      });
    }),
  );

  it.effect("strips editor line positions before launching a file manager target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-file-manager-test-" });
      const filePath = path.join(dir, "preview.html");
      yield* fs.writeFileString(filePath, "<!doctype html>");

      const launch1 = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace/docs/preview.html:12:3", editor: "file-manager" },
        "darwin",
        { PATH: "" },
      );
      assert.deepEqual(launch1, {
        command: "open",
        args: ["/tmp/workspace/docs/preview.html"],
      });

      const launch2 = yield* resolveEditorLaunch(
        { cwd: `${filePath}:12:3`, editor: "file-manager" },
        "win32",
        { PATH: "", SYSTEMROOT: "C:\\Windows" },
      );
      assert.deepEqual(launch2, {
        command: "C:\\Windows\\explorer.exe",
        args: [`/select,${filePath}`],
        shell: false,
        windowsHide: false,
      });
    }),
  );

  it.effect("asks the Linux file manager to select a file, opening its folder otherwise", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-file-manager-test-" });
      const binDir = path.join(dir, "bin");
      const filePath = path.join(dir, "a,b.html");
      yield* fs.makeDirectory(binDir);
      yield* fs.writeFileString(filePath, "<!doctype html>");
      yield* fs.writeFileString(path.join(binDir, "dbus-send"), "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(path.join(binDir, "dbus-send"), 0o755);

      const launch = yield* resolveEditorLaunch(
        { cwd: `${filePath}:3`, editor: "file-manager" },
        "linux",
        { PATH: binDir },
      );
      assert.deepEqual(launch, {
        command: "dbus-send",
        args: [
          "--session",
          "--print-reply",
          "--reply-timeout=20000",
          "--dest=org.freedesktop.FileManager1",
          "--type=method_call",
          "/org/freedesktop/FileManager1",
          "org.freedesktop.FileManager1.ShowItems",
          `array:string:${pathToFileURL(dir).href}/a%2Cb.html`,
          "string:",
        ],
        fallback: { command: "xdg-open", args: [dir] },
      });

      // Folders still open directly.
      assert.deepEqual(
        yield* resolveEditorLaunch({ cwd: dir, editor: "file-manager" }, "linux", {
          PATH: binDir,
        }),
        { command: "xdg-open", args: [dir] },
      );
    }),
  );

  it.effect("opens the nearest existing directory for missing file-manager targets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-file-manager-test-" });
      const missingTarget = path.join(dir, "missing", "preview.html");

      const launch = yield* resolveEditorLaunch(
        { cwd: missingTarget, editor: "file-manager" },
        "win32",
        { PATH: "", SYSTEMROOT: "C:\\Windows" },
      );

      assert.deepEqual(launch, {
        command: "C:\\Windows\\explorer.exe",
        args: [dir],
        shell: false,
        windowsHide: false,
      });
    }),
  );
});

it("resolveBrowserLaunch maps default browser launchers by platform", () => {
  const target = "https://example.com/some path?name=o'hara";

  assert.deepEqual(resolveBrowserLaunch(target, "darwin").command, "open");
  assert.deepEqual(resolveBrowserLaunch(target, "darwin").args, [target]);
  assert.deepEqual(resolveBrowserLaunch(target, "darwin").options, {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });

  assert.deepEqual(resolveBrowserLaunch(target, "linux", {}).command, "xdg-open");
  assert.deepEqual(resolveBrowserLaunch(target, "linux", {}).args, [target]);

  const windows = resolveBrowserLaunch(target, "win32", {
    SYSTEMROOT: "C:\\Windows",
  });
  assert.equal(windows.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(windows.args, [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodeUtf16LeBase64(
      "$ProgressPreference = 'SilentlyContinue'; Start 'https://example.com/some path?name=o''hara'",
    ),
  ]);
  assert.deepEqual(windows.options, {
    detached: true,
    shell: false,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
});

it("resolveBrowserLaunch opens through Windows from WSL when not remote", () => {
  const launch = resolveBrowserLaunch("https://example.com", "linux", {
    WSL_DISTRO_NAME: "Ubuntu",
  });
  assert.equal(launch.command, "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
  assert.equal(launch.options.detached, true);
});

it("resolveBrowserLaunch keeps xdg-open for WSL over SSH", () => {
  const launch = resolveBrowserLaunch("https://example.com", "linux", {
    WSL_DISTRO_NAME: "Ubuntu",
    SSH_CONNECTION: "client server",
  });
  assert.equal(launch.command, "xdg-open");
});

it.layer(NodeServices.layer)("launchBrowser", (it) => {
  it.effect("spawns through the ChildProcessSpawner service and unrefs the handle", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.StandardCommand | undefined;
      let didUnref = false;

      const spawnerLayer = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
        spawn: (command) =>
          Effect.sync(() => {
            assert.equal(ChildProcess.isStandardCommand(command), true);
            if (!ChildProcess.isStandardCommand(command)) {
              throw new Error("Expected a standard command");
            }
            spawnedCommand = command;
            return makeMockDetachedHandle(() => {
              didUnref = true;
            });
          }),
      });

      const result = yield* launchBrowser("https://example.com").pipe(
        Effect.provide(spawnerLayer),
        Effect.result,
      );

      assertSuccess(result, undefined);
      assert.ok(spawnedCommand);
      const expectedLaunch = resolveBrowserLaunch("https://example.com");
      assert.equal(spawnedCommand.command, expectedLaunch.command);
      assert.deepEqual(spawnedCommand.args, expectedLaunch.args);
      assert.deepEqual(
        spawnedCommand.options,
        expectedHiddenWindowsOptions(expectedLaunch.options),
      );
      assert.equal(didUnref, true);
    }),
  );
});

it.layer(NodeServices.layer)("launchEditorProcess", (it) => {
  it.effect("spawns through the ChildProcessSpawner service and unrefs the handle", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.StandardCommand | undefined;
      let didUnref = false;
      const expectedArgs = ["-e", "process.exit(0)"];

      const spawnerLayer = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
        spawn: (command) =>
          Effect.sync(() => {
            assert.equal(ChildProcess.isStandardCommand(command), true);
            if (!ChildProcess.isStandardCommand(command)) {
              throw new Error("Expected a standard command");
            }
            spawnedCommand = command;
            return makeMockDetachedHandle(() => {
              didUnref = true;
            });
          }),
      });

      const result = yield* launchEditorProcess({
        command: process.execPath,
        args: expectedArgs,
      }).pipe(Effect.provide(spawnerLayer), Effect.result);

      assertSuccess(result, undefined);
      assert.ok(spawnedCommand);
      const isWin32 = process.platform === "win32";
      // Windows: the full path, quoted for cmd.exe, and the user's environment.
      assert.equal(spawnedCommand.command, isWin32 ? `"${process.execPath}"` : process.execPath);
      assert.deepEqual(
        spawnedCommand.args,
        isWin32 ? expectedArgs.map((arg) => `"${arg}"`) : expectedArgs,
      );
      assert.deepEqual(
        spawnedCommand.options,
        expectedHiddenWindowsOptions({
          detached: true,
          shell: isWin32,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          ...(isWin32 ? { env: process.env, extendEnv: false } : {}),
        }),
      );
      assert.equal(didUnref, true);
    }),
  );

  it.effect("starts the fallback only when an attached launch fails", () =>
    Effect.gen(function* () {
      const run = (firstExitCode: number) => {
        const spawned: Array<ReadonlyArray<string>> = [];
        const spawnerLayer = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
          spawn: (command) =>
            Effect.sync(() => {
              if (!ChildProcess.isStandardCommand(command)) {
                throw new Error("Expected a standard command");
              }
              spawned.push(command.args);
              return makeMockDetachedHandle(undefined, spawned.length === 1 ? firstExitCode : 0);
            }),
        });
        return launchEditorProcess({
          command: process.execPath,
          args: ["ask"],
          fallback: { command: process.execPath, args: ["open-folder"] },
        }).pipe(
          Effect.provide(spawnerLayer),
          Effect.map(() => spawned),
        );
      };

      assert.deepEqual(yield* run(0), [["ask"]]);
      const afterFailure = yield* run(1);
      assert.equal(afterFailure.length, 2);
      assert.ok(afterFailure[1]?.some((arg) => arg.includes("open-folder")));
    }),
  );

  it.effect("lets a slow attached launch finish on its own instead of falling back", () =>
    Effect.gen(function* () {
      let spawnCount = 0;
      let didUnref = false;
      const spawnerLayer = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
        spawn: () =>
          Effect.sync(() => {
            spawnCount += 1;
            return ChildProcessSpawner.makeHandle({
              ...makeMockDetachedHandle(() => {
                didUnref = true;
              }),
              exitCode: Effect.never,
            });
          }),
      });

      const fiber = yield* launchEditorProcess({
        command: process.execPath,
        args: ["ask"],
        fallback: { command: process.execPath, args: ["open-folder"] },
      }).pipe(Effect.provide(spawnerLayer), Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(fiber);

      assert.equal(spawnCount, 1);
      assert.equal(didUnref, true);
    }),
  );

  it("quotes Windows shell args so a trailing backslash cannot escape the quote", () => {
    assert.equal(quoteWindowsShellArg("C:\\work space\\a.ts"), '"C:\\work space\\a.ts"');
    assert.equal(quoteWindowsShellArg("C:\\"), '"C:\\\\"');
    assert.equal(quoteWindowsShellArg("\\\\server\\share\\"), '"\\\\server\\share\\\\"');
  });

  it.effect("does not wrap args, use a shell, or hide the window when a launch opts out", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.StandardCommand | undefined;
      const expectedArgs = ["/select,C:\\workspace\\src\\file.ts"];

      const spawnerLayer = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {
        spawn: (command) =>
          Effect.sync(() => {
            assert.equal(ChildProcess.isStandardCommand(command), true);
            if (!ChildProcess.isStandardCommand(command)) {
              throw new Error("Expected a standard command");
            }
            spawnedCommand = command;
            return makeMockDetachedHandle();
          }),
      });

      const result = yield* launchEditorProcess({
        command: process.execPath,
        args: expectedArgs,
        shell: false,
        windowsHide: false,
      }).pipe(Effect.provide(spawnerLayer), Effect.result);

      assertSuccess(result, undefined);
      assert.ok(spawnedCommand);
      assert.equal(spawnedCommand.command, process.execPath);
      assert.deepEqual(spawnedCommand.args, expectedArgs);
      assert.deepEqual(spawnedCommand.options, {
        detached: true,
        shell: false,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        ...(process.platform === "win32" ? { env: process.env, extendEnv: false } : {}),
      });
    }),
  );

  it.effect("rejects when command does not exist", () =>
    Effect.gen(function* () {
      const spawnerLayer = Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {});
      const result = yield* launchEditorProcess({
        command: `threadlines-no-such-command-${yield* randomUUIDv4}`,
        args: [],
      }).pipe(Effect.provide(spawnerLayer), Effect.result);
      assert.equal(result._tag, "Failure");
    }),
  );
});

it.layer(NodeServices.layer)("isCommandAvailable", (it) => {
  it.effect("resolves win32 commands with PATHEXT", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-launcher-test-" });
      yield* fs.writeFileString(path.join(dir, "code.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );

  it("returns false when a command is not on PATH", () => {
    const env = {
      PATH: "",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    } satisfies NodeJS.ProcessEnv;
    assert.equal(isCommandAvailable("definitely-not-installed", { platform: "win32", env }), false);
  });

  it.effect("does not treat bare files without executable extension as available on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-launcher-test-" });
      yield* fs.writeFileString(path.join(dir, "npm"), "echo nope\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("npm", { platform: "win32", env }), false);
    }),
  );

  it.effect("appends PATHEXT for commands with non-executable extensions on win32", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-launcher-test-" });
      yield* fs.writeFileString(path.join(dir, "my.tool.CMD"), "@echo off\r\n");
      const env = {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("my.tool", { platform: "win32", env }), true);
    }),
  );

  it.effect("uses platform-specific PATH delimiter for platform overrides", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const firstDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-launcher-test-" });
      const secondDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-launcher-test-" });
      yield* fs.writeFileString(path.join(firstDir, "code.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(secondDir, "code.CMD"), "MZ");
      const env = {
        PATH: `${firstDir};${secondDir}`,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      } satisfies NodeJS.ProcessEnv;
      assert.equal(isCommandAvailable("code", { platform: "win32", env }), true);
    }),
  );
});

it.layer(NodeServices.layer)("resolveAvailableEditors", (it) => {
  it.effect("returns installed editors for command launches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editors-" });

      yield* fs.writeFileString(path.join(dir, "trae.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "kiro.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "code-insiders.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "codium.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "aqua.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "clion.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "datagrip.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "dataspell.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "goland.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "phpstorm.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "pycharm.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "rider.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "rubymine.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "rustrover.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "webstorm.CMD"), "@echo off\r\n");
      yield* fs.writeFileString(path.join(dir, "explorer.CMD"), "MZ");
      const editors = resolveAvailableEditors("win32", {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(editors, [
        "trae",
        "kiro",
        "vscode-insiders",
        "vscodium",
        "aqua",
        "clion",
        "datagrip",
        "dataspell",
        "goland",
        "phpstorm",
        "pycharm",
        "rider",
        "rubymine",
        "rustrover",
        "webstorm",
        "file-manager",
      ]);
    }),
  );

  it.effect("includes zed when only the zeditor command is installed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editors-" });
      const platform = process.platform === "win32" ? "win32" : "linux";
      const zeditorCommand = platform === "win32" ? "zeditor.CMD" : "zeditor";
      const fileManagerCommand = platform === "win32" ? "explorer.CMD" : "xdg-open";
      const commandContents =
        platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n";

      yield* fs.writeFileString(path.join(dir, zeditorCommand), commandContents);
      yield* fs.writeFileString(path.join(dir, fileManagerCommand), commandContents);
      yield* fs.chmod(path.join(dir, zeditorCommand), 0o755);
      yield* fs.chmod(path.join(dir, fileManagerCommand), 0o755);

      const editors = resolveAvailableEditors(platform, {
        PATH: dir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      });
      assert.deepEqual(editors, ["zed", "file-manager"]);
    }),
  );

  it.effect("finds macOS editors inside their app when the command is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const applications = yield* fs.makeTempDirectoryScoped({ prefix: "t3-applications-" });
      const binDir = path.join(applications, "Visual Studio Code.app/Contents/Resources/app/bin");
      const codePath = path.join(binDir, "code");
      yield* fs.makeDirectory(binDir, { recursive: true });
      yield* fs.writeFileString(codePath, "#!/bin/sh\nexit 0\n");
      yield* fs.chmod(codePath, 0o755);

      assert.deepEqual(resolveAvailableEditors("darwin", { PATH: "" }, [applications]), ["vscode"]);
      const launch = yield* resolveEditorLaunch(
        { cwd: "/tmp/workspace", editor: "vscode" },
        "darwin",
        { PATH: "" },
        [applications],
      );
      assert.equal(launch.command, codePath);
      // App folders are a macOS idea; Linux keeps to PATH.
      assert.deepEqual(resolveAvailableEditors("linux", { PATH: "" }, [applications]), []);
    }),
  );

  it("omits file-manager when the platform opener is unavailable", () => {
    const editors = resolveAvailableEditors("linux", {
      PATH: "",
    });
    assert.deepEqual(editors, []);
  });
});

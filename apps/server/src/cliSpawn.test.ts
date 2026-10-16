import { describe, expect, it } from "vite-plus/test";

import { planCliSpawn, type CliSpawnFileSystem } from "./cliSpawn.ts";

const NPM = "C:\\Users\\me\\AppData\\Roaming\\npm";
const NODE_DIR = "C:\\Program Files\\nodejs";
const WIN_ENV = { Path: `${NPM};${NODE_DIR}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

/** npm's launcher for `codex`, as cmd-shim 9 writes it. */
const NPM_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  "",
].join("\r\n");
const CODEX_SCRIPT = `${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`;

/** A Windows filesystem holding `files` (path → launcher text, or "" for a binary). */
function windowsFiles(files: Record<string, string>): CliSpawnFileSystem {
  const byPath = new Map(Object.entries(files).map(([path, text]) => [path.toLowerCase(), text]));
  return {
    isFile: (path) => byPath.has(path.toLowerCase()),
    canAccess: () => true,
    readSmallTextFile: (path) => byPath.get(path.toLowerCase()) ?? null,
  };
}

const plan = (command: string, args: ReadonlyArray<string>, files: Record<string, string>) =>
  planCliSpawn(command, args, WIN_ENV, { platform: "win32", fileSystem: windowsFiles(files) });

describe("planCliSpawn", () => {
  it("leaves the command and argv alone off Windows", () => {
    expect(planCliSpawn("claude", ["--version"], WIN_ENV, { platform: "darwin" })).toEqual({
      command: "claude",
      args: ["--version"],
      options: {},
    });
  });

  it("starts a native executable by its full PATH location with argv verbatim", () => {
    expect(
      plan("claude", ["--json-schema", '{"a":"b c"}'], { [`${NODE_DIR}\\claude.exe`]: "" }),
    ).toEqual({
      command: `${NODE_DIR}\\claude.exe`,
      args: ["--json-schema", '{"a":"b c"}'],
      options: {},
    });
  });

  it("starts npm's launcher as node and its script, never the working folder's node", () => {
    expect(
      plan("codex", ["app-server"], {
        [`${NPM}\\codex.cmd`]: NPM_SHIM,
        [CODEX_SCRIPT]: "",
        [`${NODE_DIR}\\node.exe`]: "",
      }),
    ).toEqual({
      command: `${NODE_DIR}\\node.exe`,
      args: [CODEX_SCRIPT, "app-server"],
      options: {},
    });
  });

  it("uses the node.exe beside npm's launcher first, and accepts cmd-shim 8's text and node flags", () => {
    const cmdShim8 = NPM_SHIM.replace(
      '  SET "_prog=node"\r\n',
      '  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n',
    )
      .replace("set PATHEXT=%PATHEXT:;.JS;=;% & ", "")
      .replace('"%_prog%"  "', '"%_prog%" --no-warnings "');
    expect(
      plan("codex", [], {
        [`${NPM}\\codex.cmd`]: cmdShim8,
        [CODEX_SCRIPT]: "",
        [`${NPM}\\node.exe`]: "",
        [`${NODE_DIR}\\node.exe`]: "",
      }),
    ).toEqual({ command: `${NPM}\\node.exe`, args: ["--no-warnings", CODEX_SCRIPT], options: {} });
  });

  it("runs any other batch launcher through cmd.exe by its full path, quoted", () => {
    const withVariable = NPM_SHIM.replace("CALL :find_dp0\r\n", "CALL :find_dp0\r\nSET X=1\r\n");
    expect(
      plan("codex", ["--json-schema", '{"a":"b c"}', "C:\\path with space\\"], {
        [`${NPM}\\codex.cmd`]: withVariable,
        [CODEX_SCRIPT]: "",
        [`${NODE_DIR}\\node.exe`]: "",
      }),
    ).toEqual({
      command: `${NPM}\\codex.cmd --json-schema "{\\"a\\":\\"b c\\"}" "C:\\path with space\\\\"`,
      args: [],
      options: { shell: true },
    });
    expect(plan("npx", ["x"], { [`${NODE_DIR}\\npx.cmd`]: "@echo off" }).command).toBe(
      `"${NODE_DIR}\\npx.cmd" x`,
    );
  });

  it("follows PATH order before PATHEXT order, as Windows does", () => {
    expect(
      plan("claude", [], { [`${NPM}\\claude.cmd`]: "@echo off", [`${NODE_DIR}\\claude.exe`]: "" })
        .options,
    ).toEqual({ shell: true });
    expect(
      plan("claude", [], { [`${NPM}\\claude.cmd`]: "@echo off", [`${NPM}\\claude.exe`]: "" }),
    ).toEqual({ command: `${NPM}\\claude.exe`, args: [], options: {} });
  });

  it("takes a command named with its extension as exactly that file", () => {
    expect(
      planCliSpawn(
        "C:\\tools\\tool.exe",
        [],
        { Path: NPM, PATHEXT: ".CMD" },
        {
          platform: "win32",
          fileSystem: windowsFiles({ "C:\\tools\\tool.exe": "", "C:\\tools\\tool.exe.cmd": "" }),
        },
      ),
    ).toEqual({ command: "C:\\tools\\tool.exe", args: [], options: {} });
  });

  it("spawns an unresolved command as given, through cmd.exe only for a batch file", () => {
    expect(plan("claude", ["--version"], {})).toEqual({
      command: "claude",
      args: ["--version"],
      options: {},
    });
    expect(plan("C:\\tools\\npm.cmd", ["install"], {})).toEqual({
      command: "C:\\tools\\npm.cmd install",
      args: [],
      options: { shell: true },
    });
  });
});

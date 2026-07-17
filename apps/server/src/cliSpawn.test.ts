// @effect-diagnostics nodeBuiltinImport:off
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { cliSpawnNeedsShell, planCliSpawn } from "./cliSpawn.ts";

const BIN = join(resolve("/"), "fake", "bin");
const ALT = join(resolve("/"), "alt", "bin");
const WIN_ENV = { PATH: [BIN, ALT].join(delimiter), PATHEXT: ".EXE;.CMD;.BAT;.COM" };

/** Build an `exists` predicate over a fixed set of present files. */
const existsOver = (present: ReadonlyArray<string>) => {
  const set = new Set(present);
  return (path: string) => set.has(path);
};

describe("cliSpawnNeedsShell", () => {
  it("never requests a shell on non-Windows platforms", () => {
    const exists = existsOver([join(BIN, "claude.cmd")]);
    expect(cliSpawnNeedsShell("claude", WIN_ENV, { platform: "linux", exists })).toBe(false);
    expect(cliSpawnNeedsShell("claude.cmd", WIN_ENV, { platform: "darwin", exists })).toBe(false);
  });

  it("does not request a shell for a bare name resolving to a native .exe", () => {
    const exists = existsOver([join(BIN, "claude.EXE")]);
    expect(cliSpawnNeedsShell("claude", WIN_ENV, { platform: "win32", exists })).toBe(false);
  });

  it("requests a shell for a bare name resolving to a .cmd shim", () => {
    const exists = existsOver([join(BIN, "claude.CMD")]);
    expect(cliSpawnNeedsShell("claude", WIN_ENV, { platform: "win32", exists })).toBe(true);
  });

  it("prefers the executable found earliest in PATH (mirrors the OS)", () => {
    // .cmd sits in the first PATH dir, .exe in the second: the shim wins.
    const exists = existsOver([join(BIN, "claude.CMD"), join(ALT, "claude.EXE")]);
    expect(cliSpawnNeedsShell("claude", WIN_ENV, { platform: "win32", exists })).toBe(true);
  });

  it("prefers an earlier PATHEXT entry within the same directory", () => {
    // Both extensions exist in the same dir: .EXE precedes .CMD in PATHEXT.
    const exists = existsOver([join(BIN, "claude.EXE"), join(BIN, "claude.CMD")]);
    expect(cliSpawnNeedsShell("claude", WIN_ENV, { platform: "win32", exists })).toBe(false);
  });

  it("honors an explicit executable extension on an absolute path", () => {
    const exe = join(BIN, "claude.exe");
    const cmd = join(BIN, "claude.cmd");
    expect(cliSpawnNeedsShell(exe, WIN_ENV, { platform: "win32", exists: existsOver([exe]) })).toBe(
      false,
    );
    expect(cliSpawnNeedsShell(cmd, WIN_ENV, { platform: "win32", exists: existsOver([cmd]) })).toBe(
      true,
    );
  });

  it("defaults to no shell when a bare name cannot be resolved", () => {
    const exists = existsOver([]);
    expect(cliSpawnNeedsShell("claude", WIN_ENV, { platform: "win32", exists })).toBe(false);
  });
});

describe("planCliSpawn", () => {
  it("passes argv verbatim for native executables", () => {
    const exists = existsOver([join(BIN, "claude.exe")]);
    const plan = planCliSpawn("claude", ["--json-schema", '{"a":"b c"}'], WIN_ENV, {
      platform: "win32",
      exists,
    });
    expect(plan).toEqual({
      command: "claude",
      args: ["--json-schema", '{"a":"b c"}'],
      options: {},
    });
  });

  it("composes a quoted single-string command for batch shims", () => {
    const exists = existsOver([join(BIN, "claude.CMD")]);
    const plan = planCliSpawn("claude", ["--json-schema", '{"a":"b c"}'], WIN_ENV, {
      platform: "win32",
      exists,
    });
    expect(plan.args).toEqual([]);
    expect(plan.options).toEqual({ shell: true });
    expect(plan.command).toBe('claude --json-schema "{\\"a\\":\\"b c\\"}"');
  });

  it("leaves plain flags unquoted and quotes args with spaces", () => {
    const exists = existsOver([join(BIN, "codex.CMD")]);
    const plan = planCliSpawn(
      "codex",
      ["app-server", "-c", "features.mode=true", "two words"],
      WIN_ENV,
      { platform: "win32", exists },
    );
    expect(plan.command).toBe('codex app-server -c features.mode=true "two words"');
  });

  it("doubles trailing backslashes before the closing quote", () => {
    const exists = existsOver([join(BIN, "tool.CMD")]);
    const plan = planCliSpawn("tool", ["C:\\path with space\\"], WIN_ENV, {
      platform: "win32",
      exists,
    });
    expect(plan.command).toBe('tool "C:\\path with space\\\\"');
  });
});

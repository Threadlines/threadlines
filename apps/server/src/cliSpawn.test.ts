// @effect-diagnostics nodeBuiltinImport:off
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { cliSpawnNeedsShell } from "./cliSpawn.ts";

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

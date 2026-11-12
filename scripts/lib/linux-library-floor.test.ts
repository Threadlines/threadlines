// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import {
  checkLinuxAppLibraryFloor,
  readElfVersionNeeds,
  versionNeedsAboveLinuxFloor,
} from "./linux-library-floor.ts";

/**
 * One small library that opens a terminal the way node-pty does
 * (scripts/fixtures/linux-library-floor/fixture.cc), compiled unchanged with
 * `g++ -shared -fPIC -O1 -s` on Ubuntu 24.04 and on Ubuntu 26.04: the two
 * machines that built 0.8.0, which ran everywhere, and 0.9.0, which did not.
 */
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/linux-library-floor/${name}`, import.meta.url));
const builtOnUbuntu2404 = fixture("built-on-ubuntu-24.04.so");
const builtOnUbuntu2604 = fixture("built-on-ubuntu-26.04.so");

describe("linux-library-floor", () => {
  const appDirs: string[] = [];
  afterEach(() => {
    for (const dir of appDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A packaged app folder holding the given files. */
  function packagedApp(files: Record<string, Uint8Array | string>): string {
    const appDir = mkdtempSync(join(tmpdir(), "linux-library-floor-"));
    appDirs.push(appDir);
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(appDir, name)), { recursive: true });
      writeFileSync(join(appDir, name), contents);
    }
    return appDir;
  }

  const terminalModule = "resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node";

  it("reads the same library versions out of a binary that readelf does", () => {
    // `readelf -V` on the fixture, across its four libraries.
    assert.deepStrictEqual([...(readElfVersionNeeds(builtOnUbuntu2404) ?? [])].sort(), [
      "CXXABI_1.3",
      "CXXABI_1.3.9",
      "GCC_3.0",
      "GLIBCXX_3.4",
      "GLIBCXX_3.4.11",
      "GLIBCXX_3.4.22",
      "GLIBC_2.2.5",
      "GLIBC_2.29",
      "GLIBC_2.34",
      "GLIBC_2.4",
    ]);
    assert.isNull(readElfVersionNeeds(new TextEncoder().encode("#!/bin/sh\n")));
  });

  it("passes the app built on Ubuntu 24.04 and fails the same code built on Ubuntu 26.04", () => {
    assert.isNull(
      checkLinuxAppLibraryFloor(
        packagedApp({
          threadlines: builtOnUbuntu2404,
          [terminalModule]: builtOnUbuntu2404,
          "resources/app.asar": "not a binary",
        }),
      ),
    );

    const problem =
      checkLinuxAppLibraryFloor(
        packagedApp({ threadlines: builtOnUbuntu2404, [terminalModule]: builtOnUbuntu2604 }),
      ) ?? "";
    assert.include(problem, `${terminalModule} needs GLIBC_2.42\n`);
    assert.notInclude(problem, "threadlines needs");
  });

  it("checks binaries shipped outside the app folder too", () => {
    const appDir = packagedApp({ threadlines: builtOnUbuntu2404 });
    const outside = join(
      packagedApp({ "Threadlines.AppImage": builtOnUbuntu2604 }),
      "Threadlines.AppImage",
    );

    assert.include(
      checkLinuxAppLibraryFloor(appDir, [outside]) ?? "",
      "Threadlines.AppImage needs GLIBC_2.42",
    );
  });

  it("holds the compiler's own libraries to the floor as well as glibc", () => {
    assert.deepStrictEqual(
      versionNeedsAboveLinuxFloor([
        // At the floor, or older.
        "GLIBC_2.34",
        "GLIBC_2.4",
        "GLIBCXX_3.4.29",
        "CXXABI_1.3.13",
        "CXXABI_FLOAT128",
        "GCC_11.0",
        // Other libraries are not ours to judge.
        "NSS_3.30",
        // Newer than the floor.
        "GLIBC_2.35",
        "GLIBCXX_3.4.30",
        "CXXABI_1.3.14",
        "GCC_12.0.0",
        // glibc 2.36 and newer only, with no version number to compare.
        "GLIBC_ABI_DT_RELR",
      ]),
      ["GLIBC_2.35", "GLIBCXX_3.4.30", "CXXABI_1.3.14", "GCC_12.0.0", "GLIBC_ABI_DT_RELR"],
    );
  });

  it("fails instead of passing an app it could not check", () => {
    assert.include(
      checkLinuxAppLibraryFloor(packagedApp({ "resources/app.asar": "not a binary" })) ?? "",
      "Found no Linux binaries",
    );

    const thirtyTwoBit = Uint8Array.from(builtOnUbuntu2604);
    thirtyTwoBit[4] = 1;
    const cutShort = builtOnUbuntu2604.subarray(0, 1024);
    const problem =
      checkLinuxAppLibraryFloor(packagedApp({ threadlines: thirtyTwoBit, "pty.node": cutShort })) ??
      "";
    assert.include(problem, "threadlines could not be checked");
    assert.include(problem, "pty.node could not be checked");
  });
});

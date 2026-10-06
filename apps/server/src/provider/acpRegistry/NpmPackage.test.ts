// @effect-diagnostics nodeBuiltinImport:off - writes a package to look a program up in
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  findNpmBin,
  isExactNpmVersion,
  isNpmPackageName,
  managedNodeEnvironment,
  nodeSatisfiesRange,
} from "./NpmPackage.ts";

describe("nodeSatisfiesRange", () => {
  it("reads the ranges npm packages put in engines.node", () => {
    const cases: ReadonlyArray<readonly [version: string, range: string, fits: boolean]> = [
      ["24.21.0", ">=18", true],
      ["24.21.0", ">=18.17.0", true],
      ["24.21.0", ">= 20", true],
      ["24.21.0", ">=22.19 <23 || >=24 <27", true],
      ["22.20.0", ">=22.19 <23 || >=24 <27", true],
      ["23.5.0", ">=22.19 <23 || >=24 <27", false],
      ["24.21.0", "^20.0.0 || ^22.0.0", false],
      ["24.21.0", "^20 || ^22 || ^24", true],
      ["24.21.0", "^24.21.1", false],
      ["24.21.0", "~24.21", true],
      ["24.21.0", "~24.20.0", false],
      ["24.21.0", "24.x", true],
      ["24.21.0", "24", true],
      ["24.21.0", "22.x || 23.*", false],
      ["24.21.0", "*", true],
      ["24.21.0", "", true],
      ["24.21.0", "20 - 22", false],
      ["24.21.0", "20 - 24", true],
      ["24.21.0", "<24", false],
      ["24.21.0", "<=24", true],
      ["24.21.0", ">24.21.0", false],
      ["24.21.0", ">24.20", true],
      ["24.21.0", "=24.21.0", true],
      ["24.21.0", "v24.21.0", true],
      // A prerelease sorts just below its release, and no release equals one.
      ["24.21.0", ">=24.0.0-rc.1", true],
      ["24.21.0", ">24.21.0-rc.1", true],
      ["24.21.0", "<=24.21.0-rc.1", false],
      ["24.21.0", "=24.21.0-rc.1", false],
      ["24.21.0", "^24.21.0-rc.1", true],
      ["24.21.0", ">=24.21.0+build.5", true],
      // Zero-major carets move with the first number that isn't zero.
      ["0.2.5", "^0.2.3", true],
      ["0.3.0", "^0.2.3", false],
      ["0.0.4", "^0.0.3", false],
    ];
    for (const [version, range, fits] of cases) {
      assert.equal(nodeSatisfiesRange(version, range), fits, `${version} in "${range}"`);
    }
  });

  it("says when it can't tell, instead of guessing", () => {
    assert.isUndefined(nodeSatisfiesRange("24.21.0", "latest"));
    assert.isUndefined(nodeSatisfiesRange("24.21.0", ">=18 || lts/iron"));
    assert.isUndefined(nodeSatisfiesRange("24.21.0", ">=24.21-rc.1"));
    assert.isUndefined(nodeSatisfiesRange("not-a-version", ">=18"));
  });
});

describe("npm package names and versions", () => {
  it("accepts registry names and exact versions, and nothing npm would read as something else", () => {
    for (const name of ["tool", "@scope/tool", "a.b-c_d", "@a/b.c"]) {
      assert.isTrue(isNpmPackageName(name), name);
    }
    for (const name of [
      "",
      "--global",
      "../tool",
      "@scope",
      "@scope/a/b",
      "Tool",
      "a b",
      "file:x",
      "a@1",
    ]) {
      assert.isFalse(isNpmPackageName(name), name);
    }
    for (const version of ["1.2.3", "0.0.1-beta.2", "1.0.0+build.5"]) {
      assert.isTrue(isExactNpmVersion(version), version);
    }
    for (const version of ["latest", "^1.2.3", "1.2", "1.x", "file:../x", "npm:other@1.0.0", ""]) {
      assert.isFalse(isExactNpmVersion(version), version);
    }
  });
});

describe("managedNodeEnvironment", () => {
  it("puts the managed Node.js first on PATH and drops the server's Node flags", () => {
    assert.deepStrictEqual(
      managedNodeEnvironment(
        { PATH: "/usr/bin:/bin", NODE_OPTIONS: "--inspect", HOME: "/home/me", UNSET: undefined },
        "/tools/node/bin",
        "linux",
      ),
      { PATH: "/tools/node/bin:/usr/bin:/bin", HOME: "/home/me" },
    );
    // Windows spells the variable any way it likes; there must be one of it.
    assert.deepStrictEqual(
      managedNodeEnvironment(
        { Path: "C:\\Windows", node_options: "--inspect", USERPROFILE: "C:\\Users\\me" },
        "C:\\tools\\node",
        "win32",
      ),
      { PATH: "C:\\tools\\node;C:\\Windows", USERPROFILE: "C:\\Users\\me" },
    );
    assert.deepStrictEqual(managedNodeEnvironment({}, "/tools/node/bin", "linux"), {
      PATH: "/tools/node/bin",
    });
  });
});

describe("findNpmBin", () => {
  it("doesn't take a program path longer than any real one to the filesystem", async () => {
    const prefix = await NodeFS.mkdtemp(path.join(os.tmpdir(), "threadlines-npm-bin-"));
    try {
      const packageDir = path.join(prefix, "node_modules", "pkg");
      await NodeFS.mkdir(packageDir, { recursive: true });
      await NodeFS.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "pkg", bin: `${"a/".repeat(3000)}cli.js` }),
      );
      const found = await findNpmBin({ prefix, packageName: "pkg", agentId: "pkg" });
      assert.deepInclude(found, { problem: "noFile" });
      // What it says about the package's text is bounded.
      assert.isBelow("detail" in found ? found.detail.length : 0, 500);
    } finally {
      await NodeFS.rm(prefix, { recursive: true, force: true });
    }
  });
});

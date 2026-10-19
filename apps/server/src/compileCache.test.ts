// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { pruneCompileCacheFolders, resolveCompileCacheRoot } from "./compileCache.ts";

const home = "/Users/test";
const cacheRootIn = (...homePath: ReadonlyArray<string>) =>
  NodePath.resolve(...homePath, "caches", "compile-cache");

describe("resolveCompileCacheRoot", () => {
  it("follows the server's home order: --base-dir, then THREADLINES_HOME, then ~/.threadlines", () => {
    const resolve = (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) =>
      resolveCompileCacheRoot({ argv, env, homeDirectory: home });

    expect(resolve(["--base-dir", "/flag"], { THREADLINES_HOME: "/env" })).toBe(
      cacheRootIn("/flag"),
    );
    expect(resolve(["serve", "--base-dir=~/flagged"])).toBe(cacheRootIn(home, "flagged"));
    expect(resolve([], { BADCODE_HOME: " /legacy " })).toBe(cacheRootIn("/legacy"));
    expect(resolve([])).toBe(cacheRootIn(home, ".threadlines"));
  });

  it("skips a bootstrap launch whose home only the bootstrap names", () => {
    expect(
      resolveCompileCacheRoot({ argv: ["--bootstrap-fd", "3"], env: {}, homeDirectory: home }),
    ).toBeUndefined();
    expect(
      resolveCompileCacheRoot({
        argv: [],
        env: { THREADLINES_BOOTSTRAP_FD: "3" },
        homeDirectory: home,
      }),
    ).toBeUndefined();
    // The desktop app repeats the home as --base-dir, so its launches keep a cache.
    expect(
      resolveCompileCacheRoot({
        argv: ["--bootstrap-fd", "3", "--base-dir", "/desktop-home"],
        env: {},
        homeDirectory: home,
      }),
    ).toBe(cacheRootIn("/desktop-home"));
  });
});

describe("pruneCompileCacheFolders", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("keeps the current build and the three most recently used others", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "compile-cache-prune-"));
    roots.push(root);
    const now = Date.now() / 1000;
    // "current" is the oldest on disk: it must survive anyway.
    const ages = { current: 900, a: 10, b: 20, c: 30, d: 40, e: 50 } as const;
    for (const [name, ageSeconds] of Object.entries(ages)) {
      const folder = NodePath.join(root, name);
      NodeFS.mkdirSync(folder);
      NodeFS.writeFileSync(NodePath.join(folder, "entry"), "cached");
      NodeFS.utimesSync(folder, now - ageSeconds, now - ageSeconds);
    }

    await pruneCompileCacheFolders(root, "current");

    expect(NodeFS.readdirSync(root).toSorted()).toEqual(["a", "b", "c", "current"]);
  });
});

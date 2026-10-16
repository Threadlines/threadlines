// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, assert, describe, it } from "@effect/vitest";

import { parseGitConfigList } from "./gitConfigSnapshot.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

/** A repository whose config holds no user or system settings, only what the test writes. */
function makeRepo(): { readonly git: (...args: string[]) => string; readonly cwd: string } {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "git-config-snapshot-"));
  tempDirs.push(cwd);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: NodePath.join(cwd, "no-global-config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, { cwd, env, encoding: "utf8" });
    } catch (error) {
      // `git config --get` exits 1 for an unset key; that is an answer, not a failure.
      if ((error as { status?: number }).status === 1) return "";
      throw error;
    }
  };
  git("init", "-q");
  return { git, cwd };
}

describe("parseGitConfigList", () => {
  it("answers each key the way `git config --get` does", () => {
    const { git, cwd } = makeRepo();
    git("remote", "add", "zeta", "https://example.com/z.git");
    git("remote", "add", "alpha", "https://example.com/a.git");
    git("config", "remote.beta.pushurl", "https://example.com/b.git");
    git("config", "branch.Feature/X.remote", "alpha");
    git("config", "branch.release.v1.2.gh-merge-base", "main");
    git("config", "--add", "remote.alpha.fetch", "+refs/pull/*:refs/remotes/alpha/pull/*");
    git("config", "branch.empty.remote", "");
    NodeFS.appendFileSync(NodePath.join(cwd, ".git", "config"), '[branch "bare"]\n\tflag\n');

    const snapshot = parseGitConfigList(git("config", "-z", "--list"));

    for (const key of [
      "remote.zeta.url",
      "REMOTE.alpha.URL",
      "remote.ALPHA.url",
      "remote.alpha.fetch",
      "remote.beta.pushurl",
      "branch.Feature/X.remote",
      "branch.feature/x.remote",
      "branch.release.v1.2.gh-merge-base",
      "branch.empty.remote",
      "branch.bare.flag",
      "remote.origin.url",
      "core.bare",
      "nosuchkey",
    ]) {
      const expected = git("config", "--get", key).trim();
      assert.strictEqual(snapshot.get(key), expected.length > 0 ? expected : null, key);
    }
    assert.deepStrictEqual(snapshot.remoteNames, git("remote").trim().split("\n"));
  });
});

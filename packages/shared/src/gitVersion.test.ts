import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { resolveGitReleaseVersion } from "./gitVersion.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "threadlines-git-version-"));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: ReadonlyArray<string>): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", ...args], {
    cwd,
    stdio: "ignore",
  });
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveGitReleaseVersion", () => {
  it("returns undefined outside a git repository", () => {
    expect(resolveGitReleaseVersion({ cwd: makeTempDir() })).toBeUndefined();
  });

  it("returns undefined for tag-less repositories", () => {
    const repo = makeTempDir();
    git(repo, ["init"]);
    git(repo, ["commit", "--allow-empty", "-m", "initial"]);

    expect(resolveGitReleaseVersion({ cwd: repo })).toBeUndefined();
  });

  it("resolves the checked-out tag with the v prefix stripped", () => {
    const repo = makeTempDir();
    git(repo, ["init"]);
    git(repo, ["commit", "--allow-empty", "-m", "initial"]);
    git(repo, ["tag", "v1.2.3-nightly.4"]);

    expect(resolveGitReleaseVersion({ cwd: repo })).toBe("1.2.3-nightly.4");
  });

  it("falls back to the nearest tag for commits after the release", () => {
    const repo = makeTempDir();
    git(repo, ["init"]);
    git(repo, ["commit", "--allow-empty", "-m", "initial"]);
    git(repo, ["tag", "v0.9.0"]);
    git(repo, ["commit", "--allow-empty", "-m", "next"]);

    expect(resolveGitReleaseVersion({ cwd: repo })).toBe("0.9.0");
  });
});

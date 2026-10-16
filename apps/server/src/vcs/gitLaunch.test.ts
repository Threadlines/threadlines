import { describe, expect, it } from "@effect/vitest";

import { isPlainGitRead, planGitLaunch, probeGitInstall } from "./gitLaunch.ts";
import type { GitInstallProbeShape } from "./gitLaunch.ts";

const GIT_FOR_WINDOWS = "C:\\Program Files\\Git";
const REAL_GIT = `${GIT_FOR_WINDOWS}\\mingw64\\bin\\git.exe`;
const LAUNCHER = `${GIT_FOR_WINDOWS}\\cmd\\git.exe`;

function windowsProbe(input: {
  readonly onPath: string | null;
  readonly execPath?: string | null;
  readonly files?: ReadonlyArray<string>;
}): GitInstallProbeShape {
  const files = new Set(input.files ?? [REAL_GIT, `${GIT_FOR_WINDOWS}\\usr\\bin\\sh.exe`]);
  return {
    platform: "win32",
    findOnPath: () => input.onPath,
    isFile: (path) => files.has(path),
    readExecPath: async () =>
      input.execPath === undefined
        ? "C:/Program Files/Git/mingw64/libexec/git-core"
        : input.execPath,
  };
}

describe("isPlainGitRead", () => {
  it("accepts reads of refs, config and commits that start nothing else", () => {
    for (const args of [
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["rev-parse", "--verify", "--quiet", "origin/main^{commit}"],
      ["rev-list", "--left-right", "--count", "HEAD...origin/main"],
      ["rev-list", "--count", "main..HEAD"],
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--git-common-dir"],
      ["show-ref", "--verify", "--quiet", "refs/heads/main"],
      ["config", "-z", "--list"],
      ["config", "--get", "remote.origin.url"],
      ["config", "get", "remote.origin.url"],
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      ["remote"],
      ["remote", "-v"],
      ["remote", "get-url", "origin"],
      ["-c", "core.quotepath=false", "-C", "/repo", "--git-dir", "/repo/.git", "rev-parse", "HEAD"],
      ["--no-optional-locks", "--git-dir=/repo/.git", "rev-parse", "--git-common-dir"],
    ]) {
      expect(isPlainGitRead(args), args.join(" ")).toBe(true);
    }
  });

  it("refuses anything that can write, ask for help, or start another program", () => {
    for (const args of [
      ["status", "--porcelain=2"],
      ["-c", "diff.autoRefreshIndex=false", "diff", "HEAD", "--numstat"],
      ["log", "-1"],
      ["commit", "-m", "message"],
      ["fetch", "origin"],
      ["config", "user.name", "Someone"],
      ["config", "--unset", "branch.main.remote"],
      ["config", "--edi"],
      ["symbolic-ref", "HEAD", "refs/heads/other"],
      ["symbolic-ref", "--del", "HEAD"],
      ["remote", "add", "fork", "https://example.com/fork.git"],
      // Formats can verify signatures, run describe or follow the locale.
      ["for-each-ref", "--format=%(refname)", "refs/heads"],
      ["merge-base", "HEAD", "main"],
      ["rev-list", "--count", "--grep=^fix", "HEAD..main"],
      // Paths, trees and the index can fetch in a partial clone or run fsmonitor.
      ["rev-list", "--objects", "--all"],
      ["rev-list", "--count", "HEAD", "src"],
      ["rev-list", "--count", "HEAD..main", "--", "src"],
      ["rev-parse", "HEAD~1:dir/file"],
      ["rev-parse", ":file"],
      ["rev-parse", "HEAD^{tree}"],
      ["rev-parse", "--shared-index-path"],
      ["show-ref", "--heads"],
      ["rev-parse", "--help"],
      ["--help", "rev-parse"],
      ["-h", "rev-parse"],
      ["--paginate", "rev-parse", "HEAD"],
      ["--exec-path=C:\\other", "rev-parse", "HEAD"],
      ["-c", "a=b"],
      [],
    ]) {
      expect(isPlainGitRead(args), args.join(" ")).toBe(false);
    }
  });
});

describe("planGitLaunch", () => {
  it("starts plain reads on the real git.exe, detached and with the C locale", () => {
    expect(planGitLaunch({ realGit: REAL_GIT }, ["rev-parse", "HEAD"])).toEqual({
      command: REAL_GIT,
      detached: true,
      windowsHide: true,
      env: { LC_ALL: "C" },
    });
  });

  it("starts everything else through the launcher, as before", () => {
    expect(planGitLaunch({ realGit: REAL_GIT }, ["status"])).toEqual({ command: "git", env: {} });
    expect(planGitLaunch({ realGit: null }, ["rev-parse", "HEAD"])).toEqual({
      command: "git",
      env: {},
    });
  });
});

describe("probeGitInstall", () => {
  it("finds the real git.exe behind Git for Windows' launcher", async () => {
    expect(await probeGitInstall({ PATH: "x" }, windowsProbe({ onPath: LAUNCHER }))).toEqual({
      realGit: REAL_GIT,
    });
    // Newer x64 builds live under ucrt64.
    const ucrt = `${GIT_FOR_WINDOWS}\\ucrt64\\bin\\git.exe`;
    expect(
      await probeGitInstall(
        {},
        windowsProbe({
          onPath: `${GIT_FOR_WINDOWS}\\bin\\git.exe`,
          execPath: `${GIT_FOR_WINDOWS}\\ucrt64\\libexec\\git-core`,
          files: [ucrt, `${GIT_FOR_WINDOWS}\\usr\\bin\\sh.exe`],
        }),
      ),
    ).toEqual({ realGit: ucrt });
  });

  it("leaves git alone wherever the real binary can't be trusted to act the same", async () => {
    const none = { realGit: null };
    // Started from Git Bash: the real binary would leave PATH without `sh`.
    expect(
      await probeGitInstall({ MSYSTEM: "MINGW64" }, windowsProbe({ onPath: LAUNCHER })),
    ).toEqual(none);
    // GIT_EXEC_PATH can point the probe at another install.
    expect(
      await probeGitInstall(
        { GIT_EXEC_PATH: "D:\\git\\mingw64\\libexec\\git-core" },
        windowsProbe({ onPath: LAUNCHER }),
      ),
    ).toEqual(none);
    // A shim can add arguments or settings of its own; it is not even run.
    let shimRan = false;
    expect(
      await probeGitInstall(
        {},
        {
          ...windowsProbe({ onPath: "C:\\Users\\me\\scoop\\shims\\git.exe" }),
          readExecPath: async () => {
            shimRan = true;
            return "C:/Users/me/scoop/apps/git/current/mingw64/libexec/git-core";
          },
        },
      ),
    ).toEqual(none);
    expect(shimRan).toBe(false);
    expect(await probeGitInstall({}, windowsProbe({ onPath: "C:\\tools\\git.cmd" }))).toEqual(none);
    expect(await probeGitInstall({}, windowsProbe({ onPath: null }))).toEqual(none);
    expect(await probeGitInstall({}, windowsProbe({ onPath: LAUNCHER, execPath: null }))).toEqual(
      none,
    );
    // Cygwin or MSYS2 git reports a POSIX exec path.
    expect(
      await probeGitInstall({}, windowsProbe({ onPath: LAUNCHER, execPath: "/usr/lib/git-core" })),
    ).toEqual(none);
    // No shell for hooks: not a Git for Windows layout.
    expect(
      await probeGitInstall({}, windowsProbe({ onPath: LAUNCHER, files: [REAL_GIT] })),
    ).toEqual(none);
    expect(
      await probeGitInstall({}, { ...windowsProbe({ onPath: LAUNCHER }), platform: "darwin" }),
    ).toEqual(none);
  });
});

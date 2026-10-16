// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { win32 as WindowsPath } from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { makeCommandPathResolver } from "@threadlines/shared/shell";

/**
 * How the server starts git on Windows, where every process start is felt.
 *
 * Git for Windows puts a launcher on PATH (`<Git>\cmd\git.exe`) that starts
 * the real git.exe as a second process, and Windows gives each console
 * program started from the server a console host process of its own. Plain
 * reads of refs, config and objects, which are most of what the server runs,
 * start the real git.exe directly, without a console and with the C locale
 * (which skips Git for Windows' slow locale lookup). Their output does not
 * change. Everything else (fetch, push, commit, status, diff, anything that
 * can run a hook, filter, credential helper or ssh) still starts through the
 * launcher: the real binary orders PATH slightly differently from it, so
 * helpers it finds could differ. Off Windows nothing here changes how git
 * starts.
 */
export interface GitInstall {
  /** Git for Windows' real git.exe behind the launcher on PATH; null to start `git` as is. */
  readonly realGit: string | null;
}

/** How one git command is started. */
export interface GitLaunch {
  readonly command: string;
  readonly detached?: true;
  readonly windowsHide?: true;
  readonly env: Readonly<Record<string, string>>;
}

const NO_REAL_GIT: GitInstall = { realGit: null };
export const PLAIN_GIT_LAUNCH: GitLaunch = { command: "git", env: {} };

// Options git takes before the subcommand that consume the next argument.
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);
// Options before the subcommand that start nothing; anything else (a pager,
// `--help`, `--exec-path=`) keeps today's launch.
const QUIET_GLOBAL_FLAGS = new Set([
  "--no-pager",
  "--no-optional-locks",
  "--literal-pathspecs",
  "--no-replace-objects",
  "--no-lazy-fetch",
]);
const GLOBAL_OPTIONS_WITH_INLINE_VALUE = ["--git-dir=", "--work-tree=", "--namespace="];

const CONFIG_READ_OPTIONS = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l"]);
const CONFIG_MODIFIERS = new Set([
  "-z",
  "--null",
  "--includes",
  "--no-includes",
  "--local",
  "--global",
  "--system",
  "--worktree",
  "--show-origin",
  "--show-scope",
  "--name-only",
]);
const SYMBOLIC_REF_OPTIONS = new Set(["-q", "--quiet", "--short"]);
// Each read below is limited to the forms the server's status and detection
// code runs. Wider forms can read the index (and run fsmonitor), fetch
// missing objects in a partial clone, verify signatures, or format dates by
// locale, so they keep today's launch.
const REV_PARSE_OPTIONS = new Set([
  "--abbrev-ref",
  "--symbolic-full-name",
  "--git-common-dir",
  "--show-toplevel",
  "--is-inside-work-tree",
  "--verify",
  "--quiet",
  "-q",
]);
const REV_LIST_OPTIONS = new Set(["--count", "--left-right"]);
const SHOW_REF_OPTIONS = new Set(["--verify", "--quiet", "-q"]);

/** A revision that names a commit or ref: no `:path`, no tree or blob peeling. */
function isCommitRevision(arg: string): boolean {
  if (arg.length === 0 || arg.includes(":") || /\s/.test(arg)) {
    return false;
  }
  const peel = arg.indexOf("^{");
  return peel === -1 || arg.slice(peel) === "^{commit}";
}

/**
 * True for the git commands that only read refs, config or commits and start
 * no other program: no hook, fsmonitor, filter, pager, signature check,
 * credential helper or fetch. Only these may skip the launcher and the
 * console.
 */
export function isPlainGitRead(args: ReadonlyArray<string>): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? "";
    if (GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index += 2;
      continue;
    }
    if (!arg.startsWith("-")) {
      break;
    }
    if (
      !QUIET_GLOBAL_FLAGS.has(arg) &&
      !GLOBAL_OPTIONS_WITH_INLINE_VALUE.some((prefix) => arg.startsWith(prefix))
    ) {
      return false;
    }
    index += 1;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  if (subcommand === undefined) {
    return false;
  }
  const options = rest.filter((arg) => arg.startsWith("-"));
  const positionals = rest.filter((arg) => !arg.startsWith("-"));
  switch (subcommand) {
    case "rev-parse":
      return (
        options.every((option) => REV_PARSE_OPTIONS.has(option)) &&
        positionals.every(isCommitRevision)
      );
    case "rev-list": {
      const [range] = positionals;
      return (
        options.every((option) => REV_LIST_OPTIONS.has(option)) &&
        positionals.length === 1 &&
        range !== undefined &&
        range.includes("..") &&
        isCommitRevision(range)
      );
    }
    case "show-ref":
      return (
        options.every((option) => SHOW_REF_OPTIONS.has(option)) &&
        positionals.length > 0 &&
        positionals.every((ref) => ref.startsWith("refs/") && isCommitRevision(ref))
      );
    case "symbolic-ref":
      return (
        positionals.length === 1 &&
        positionals.every(isCommitRevision) &&
        options.every((option) => SYMBOLIC_REF_OPTIONS.has(option))
      );
    case "config": {
      if (positionals[0] === "get" || positionals[0] === "list") {
        return options.every((option) => CONFIG_MODIFIERS.has(option));
      }
      const reads = options.filter((option) => CONFIG_READ_OPTIONS.has(option));
      return (
        reads.length === 1 &&
        options.every((option) => CONFIG_READ_OPTIONS.has(option) || CONFIG_MODIFIERS.has(option))
      );
    }
    case "remote":
      if (positionals.length === 0) {
        return options.every((option) => option === "-v" || option === "--verbose");
      }
      return (
        positionals[0] === "get-url" &&
        positionals.length === 2 &&
        options.every((option) => option === "--push" || option === "--all")
      );
    default:
      return false;
  }
}

/** How to start one git command on `install`. */
export function planGitLaunch(install: GitInstall, args: ReadonlyArray<string>): GitLaunch {
  if (install.realGit === null || !isPlainGitRead(args)) {
    return PLAIN_GIT_LAUNCH;
  }
  return {
    command: install.realGit,
    // libuv maps this to DETACHED_PROCESS: no console host for the child.
    detached: true,
    windowsHide: true,
    // Without a locale, Git for Windows picks C.UTF-8 and then enumerates
    // every system locale looking for it, ~11 ms per process.
    env: { LC_ALL: "C" },
  };
}

export interface GitInstallProbeShape {
  readonly platform: NodeJS.Platform;
  readonly findOnPath: (env: NodeJS.ProcessEnv) => string | null;
  readonly isFile: (path: string) => boolean;
  /** `git --exec-path` from the given executable; null when it fails. */
  readonly readExecPath: (executable: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
}

const defaultProbe: GitInstallProbeShape = {
  platform: process.platform,
  findOnPath: (env) => makeCommandPathResolver({ platform: "win32", env })("git"),
  isFile: (path) => {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  readExecPath: (executable, env) =>
    new Promise((resolve) => {
      execFile(
        executable,
        ["--exec-path"],
        { env, timeout: 10_000, windowsHide: true, encoding: "utf8" },
        (error, stdout) => resolve(error ? null : stdout.trim() || null),
      );
    }),
};

function samePath(left: string, right: string): boolean {
  return WindowsPath.normalize(left).toLowerCase() === WindowsPath.normalize(right).toLowerCase();
}

/**
 * Finds the real git.exe of the Git for Windows install whose launcher is
 * on PATH. Git reports its exec path (`<Git>\<build>\libexec\git-core`), and
 * the real binary is `<Git>\<build>\bin\git.exe`. Only Git for Windows' own
 * `cmd\git.exe`, `bin\git.exe` or real binary in that same install counts:
 * a shim in front of it can add arguments or settings of its own, and
 * GIT_EXEC_PATH can point at another install. With MSYSTEM set (a server
 * started from Git Bash) the real binary would leave PATH without the tools
 * the launcher adds, so nothing changes there either.
 */
export async function probeGitInstall(
  env: NodeJS.ProcessEnv,
  probe: GitInstallProbeShape,
): Promise<GitInstall> {
  if (probe.platform !== "win32" || env.MSYSTEM || env.GIT_EXEC_PATH) {
    return NO_REAL_GIT;
  }
  const onPath = probe.findOnPath(env);
  // Git for Windows keeps its launcher in `cmd` (or `bin` in portable
  // builds) and the real binary in `<build>\bin`. Anything else, a shim
  // included, is not run even for the probe.
  const folder = onPath === null ? "" : WindowsPath.basename(WindowsPath.dirname(onPath));
  if (
    onPath === null ||
    WindowsPath.basename(onPath).toLowerCase() !== "git.exe" ||
    !["cmd", "bin"].includes(folder.toLowerCase())
  ) {
    return NO_REAL_GIT;
  }
  const execPath = await probe.readExecPath(onPath, env);
  if (execPath === null) {
    return NO_REAL_GIT;
  }
  const gitCore = WindowsPath.normalize(execPath);
  if (!gitCore.toLowerCase().endsWith(WindowsPath.join("libexec", "git-core"))) {
    return NO_REAL_GIT;
  }
  const buildRoot = WindowsPath.resolve(gitCore, "..", "..");
  const installRoot = WindowsPath.dirname(buildRoot);
  const realGit = WindowsPath.join(buildRoot, "bin", "git.exe");
  const ownExecutables = [
    WindowsPath.join(installRoot, "cmd", "git.exe"),
    WindowsPath.join(installRoot, "bin", "git.exe"),
    realGit,
  ];
  if (!ownExecutables.some((candidate) => samePath(candidate, onPath))) {
    return NO_REAL_GIT;
  }
  return probe.isFile(realGit) &&
    probe.isFile(WindowsPath.join(installRoot, "usr", "bin", "sh.exe"))
    ? { realGit }
    : NO_REAL_GIT;
}

/** How git is looked for; tests stand in a Windows machine here. */
export const GitInstallProbe = Context.Reference<GitInstallProbeShape>(
  "threadlines/GitInstallProbe",
  { defaultValue: () => defaultProbe },
);

// A probe that found nothing is asked again after this long: it may have
// timed out, or Git may have been installed since.
const NO_REAL_GIT_RECHECK_MS = 5 * 60_000;

interface RememberedInstall {
  readonly install: Promise<GitInstall>;
  readonly probedAtMs: number;
}

/**
 * One probe per PATH for the whole server: git's location does not change
 * while PATH stays the same. A spawn that fails on the remembered binary
 * (Git upgraded or moved) forgets it, and the next command probes again.
 */
const installsByProbe = new WeakMap<GitInstallProbeShape, Map<string, RememberedInstall>>();

function installsFor(probe: GitInstallProbeShape): Map<string, RememberedInstall> {
  let installs = installsByProbe.get(probe);
  if (installs === undefined) {
    installs = new Map();
    installsByProbe.set(probe, installs);
  }
  return installs;
}

function installCacheKey(env: NodeJS.ProcessEnv): string {
  const path = env.PATH ?? env.Path ?? env.path ?? "";
  return [path, env.PATHEXT ?? "", env.MSYSTEM ?? "", env.GIT_EXEC_PATH ?? ""].join("\0");
}

export const resolveGitInstall = Effect.fnUntraced(function* (env: NodeJS.ProcessEnv) {
  const probe = yield* GitInstallProbe;
  if (probe.platform !== "win32") {
    return NO_REAL_GIT;
  }
  return yield* Effect.promise(async () => {
    const installs = installsFor(probe);
    const key = installCacheKey(env);
    const remembered = installs.get(key);
    if (remembered !== undefined) {
      const install = await remembered.install;
      if (install.realGit !== null || Date.now() - remembered.probedAtMs < NO_REAL_GIT_RECHECK_MS) {
        return install;
      }
      // Another caller may already have started the recheck.
      const current = installs.get(key);
      if (current !== undefined && current !== remembered) {
        return current.install;
      }
    }
    const install = probeGitInstall(env, probe).catch(() => NO_REAL_GIT);
    installs.set(key, { install, probedAtMs: Date.now() });
    return install;
  });
});

export const forgetGitInstall = Effect.fnUntraced(function* (env: NodeJS.ProcessEnv) {
  const probe = yield* GitInstallProbe;
  installsFor(probe).delete(installCacheKey(env));
});

/**
 * How to start `git <args>` with `env`. Only a plain read looks up the real
 * binary; everything else starts as it always has, with no probe first.
 */
export const resolveGitLaunch = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) {
  if (!isPlainGitRead(args)) {
    return PLAIN_GIT_LAUNCH;
  }
  return planGitLaunch(yield* resolveGitInstall(env), args);
});

/**
 * Starts one git command as `launch` says, falling back to plain `git` when
 * the real binary cannot be started (Git upgraded or moved since the probe).
 */
export const spawnGitWithFallback = <A, E, R>(
  launch: GitLaunch,
  env: NodeJS.ProcessEnv,
  spawn: (launch: GitLaunch) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  launch.command === PLAIN_GIT_LAUNCH.command
    ? spawn(launch)
    : spawn(launch).pipe(
        Effect.catch(() => forgetGitInstall(env).pipe(Effect.andThen(spawn(PLAIN_GIT_LAUNCH)))),
      );

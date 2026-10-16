/**
 * Node's compile cache for the server's own modules.
 *
 * The server loads a few hundred modules on every start, and V8 can skip most
 * of the compile work when it gets back the code it produced last time. The
 * cache lives in the Threadlines home, one folder per server build:
 * `<home>/caches/compile-cache/<version>-<build>`. Older build folders are
 * pruned at startup, so updates do not leave megabytes behind.
 *
 * Enabled with the programmatic call only, never the NODE_COMPILE_CACHE
 * environment variable: terminals, provider CLIs and every Node process an
 * agent runs would inherit that, and fill this folder with their caches.
 *
 * Imported by the launcher before the Node version check has passed, so it
 * sticks to old Node APIs; node:module is a namespace import because its newer
 * functions may be missing.
 *
 * @module compileCache
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

/** The current build's folder plus the most recently used others. */
const KEPT_BUILD_FOLDERS = 4;

const HOME_ENV_NAMES = ["THREADLINES_HOME", "BADCODE_HOME", "T3CODE_HOME"] as const;
const BOOTSTRAP_FD_ENV_NAMES = [
  "THREADLINES_BOOTSTRAP_FD",
  "BADCODE_BOOTSTRAP_FD",
  "T3CODE_BOOTSTRAP_FD",
] as const;

function readFlag(argv: ReadonlyArray<string>, name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) return argv[index + 1];
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

/**
 * The cache folder for the home the server is about to use, following the
 * server's own order: `--base-dir`, then THREADLINES_HOME (and its legacy
 * names), then `~/.threadlines`. A desktop bootstrap can name the home too,
 * but it is read later and cannot be read twice, so a bootstrap launch
 * without `--base-dir` or a home variable gets no cache (`undefined`) rather
 * than one in a home it may not use. The desktop app passes `--base-dir`.
 */
export function resolveCompileCacheRoot(input: {
  readonly argv: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
}): string | undefined {
  const fromFlag = readFlag(input.argv, "--base-dir")?.trim();
  const fromEnv = HOME_ENV_NAMES.map((name) => input.env[name]?.trim()).find(
    (value) => value !== undefined && value.length > 0,
  );
  const explicitHome = fromFlag !== undefined && fromFlag.length > 0 ? fromFlag : fromEnv;
  if (explicitHome === undefined) {
    const bootstrapLaunch =
      readFlag(input.argv, "--bootstrap-fd") !== undefined ||
      BOOTSTRAP_FD_ENV_NAMES.some((name) => (input.env[name]?.trim() ?? "") !== "");
    if (bootstrapLaunch) return undefined;
  }
  const rawHome = explicitHome ?? NodePath.join(input.homeDirectory, ".threadlines");
  const home =
    rawHome === "~"
      ? input.homeDirectory
      : rawHome.startsWith("~/") || rawHome.startsWith("~\\")
        ? NodePath.join(input.homeDirectory, rawHome.slice(2))
        : rawHome;
  return NodePath.resolve(home, "caches", "compile-cache");
}

/**
 * Removes build folders beyond the current one and the most recently used
 * others. Several builds can share a home (a dev build next to the installed
 * app), so recent siblings stay. Removal runs in the background and ignores
 * failures: the cache is only an optimization. Resolves once it is done.
 */
export async function pruneCompileCacheFolders(root: string, currentFolder: string): Promise<void> {
  let siblings: Array<{ readonly path: string; readonly usedAt: number }>;
  try {
    siblings = NodeFS.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== currentFolder)
      .map((entry) => {
        const path = NodePath.join(root, entry.name);
        return { path, usedAt: NodeFS.statSync(path).mtimeMs };
      });
  } catch {
    return;
  }
  siblings.sort((left, right) => right.usedAt - left.usedAt);
  await Promise.all(
    siblings
      .slice(KEPT_BUILD_FOLDERS - 1)
      .map((stale) =>
        NodeFS.promises.rm(stale.path, { recursive: true, force: true }).catch(() => {}),
      ),
  );
}

/** Names this build: the version, plus a hash of the entry (which names the server chunk) and Node. */
function buildFolderName(version: string, entryUrl: string): string {
  const hash = NodeCrypto.createHash("sha256").update(process.version);
  try {
    hash.update(NodeFS.readFileSync(fileURLToPath(entryUrl)));
  } catch {
    // Unreadable entry: the version alone still separates releases.
  }
  return `${version}-${hash.digest("hex").slice(0, 12)}`;
}

/**
 * Turns the cache on for this process. Call before loading the server: Node
 * only caches what it compiles afterwards. Skipped under coverage, where
 * cached code would hide what ran, and where Node lacks the API.
 */
export function enableServerCompileCache(input: {
  readonly version: string;
  readonly entryUrl: string;
}): void {
  const enableCompileCache = NodeModule.enableCompileCache;
  if (typeof enableCompileCache !== "function") return;
  if ((process.env.NODE_V8_COVERAGE ?? "") !== "") return;
  const root = resolveCompileCacheRoot({
    argv: process.argv.slice(2),
    env: process.env,
    homeDirectory: NodeOS.homedir(),
  });
  if (root === undefined) return;
  const folder = buildFolderName(input.version, input.entryUrl);
  const directory = NodePath.join(root, folder);
  // Not ENABLED when NODE_COMPILE_CACHE already chose a folder, the user set
  // NODE_DISABLE_COMPILE_CACHE, or the folder is unusable: leave ours alone.
  const { status } = enableCompileCache(directory);
  if (status !== NodeModule.constants.compileCacheStatus.ENABLED) return;
  try {
    // Marks this build as recently used, which is what pruning keeps.
    const now = new Date();
    NodeFS.utimesSync(directory, now, now);
  } catch {
    // Not fatal; at worst this folder is pruned early by another build.
  }
  void pruneCompileCacheFolders(root, folder);
}

/** How long after listening the server writes its cache; see below. */
const FLUSH_DELAY_AFTER_LISTENING_MS = 10_000;

/**
 * Writes what has been compiled once startup has settled. Node also writes at
 * a clean exit, but the desktop app stops its backend with a hard kill on
 * Windows, which skips that. The server calls this once it is listening; the
 * write waits a little because it blocks the event loop (about 50 ms after an
 * update, under 1 ms otherwise), and right after listening it would hold up
 * the desktop's readiness check and the window's first requests. No-op when
 * the cache is off.
 */
export function scheduleServerCompileCacheFlush(): void {
  const flushCompileCache = NodeModule.flushCompileCache;
  if (typeof flushCompileCache !== "function") return;
  setTimeout(() => flushCompileCache(), FLUSH_DELAY_AFTER_LISTENING_MS).unref();
}

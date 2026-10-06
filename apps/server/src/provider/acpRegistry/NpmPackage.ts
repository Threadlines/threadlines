// @effect-diagnostics nodeBuiltinImport:off - runs npm and reads the package it installed
/**
 * NpmPackage — what installing an agent from npm needs around the install
 * store: running npm with Threadlines' own Node.js, checking a package's
 * `engines`, and finding the program a package ships.
 *
 * @module provider/acpRegistry/NpmPackage
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const NPM_PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/u;
const NPM_EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/**
 * A registry package name, safe to hand npm as an argument and to look up
 * under `node_modules`: nothing that reads as an option, a path or a URL.
 */
export const isNpmPackageName = (name: string) => name.length <= 214 && NPM_PACKAGE_NAME.test(name);

/** One version: not a range, a tag, a path or a URL. */
export const isExactNpmVersion = (version: string) =>
  version.length <= 128 && NPM_EXACT_VERSION.test(version);

type Version = readonly [major: number, minor: number, patch: number];

/** The versions one comparator allows: from `from` up to, not including, `below`. */
interface Bounds {
  readonly from: Version;
  readonly below: Version | undefined;
}

const LOWEST: Version = [0, 0, 0];
const ANYTHING: Bounds = { from: LOWEST, below: undefined };
const NOTHING: Bounds = { from: LOWEST, below: LOWEST };

const compareVersions = (left: Version, right: Version) =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

const PARTIAL_VERSION =
  /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const COMPARATOR = /^(>=|<=|>|<|=|\^|~>|~)?(.*)$/u;
const SPACE_AFTER_OPERATOR = /(>=|<=|>|<|=|\^|~>|~)\s+/gu;
const HYPHEN_RANGE = /^(\S+)\s+-\s+(\S+)$/u;

/** The version a comparator names. */
interface Pinned {
  /** Its leading numbers: none for `*`, one for `22` or `22.x`, up to three. */
  readonly numbers: ReadonlyArray<number>;
  /** It is a prerelease (`24.0.0-rc.1`): to a release, the point just below those numbers. */
  readonly prerelease: boolean;
}

function pinnedVersion(text: string): Pinned | undefined {
  const match = PARTIAL_VERSION.exec(text);
  if (!match) return undefined;
  const numbers: Array<number> = [];
  for (const part of [match[1], match[2], match[3]]) {
    if (part === undefined || !/^\d+$/u.test(part)) break;
    numbers.push(Number(part));
  }
  const prerelease = match[4] !== undefined;
  // A prerelease tag only goes on a whole version.
  return prerelease && numbers.length < 3 ? undefined : { numbers, prerelease };
}

function comparatorBounds(operator: string, pinned: Pinned): Bounds {
  const [major, minor, patch] = pinned.numbers;
  const floor: Version = [major ?? 0, minor ?? 0, patch ?? 0];
  if (pinned.prerelease) {
    // No release equals a prerelease, and every release from its numbers up is above it.
    if (operator === "" || operator === "=") return NOTHING;
    if (operator === ">") return { from: floor, below: undefined };
    if (operator === "<=") return { from: LOWEST, below: floor };
  }
  // The first version past everything the pinned numbers cover.
  const ceiling: Version | undefined =
    major === undefined
      ? undefined
      : minor === undefined
        ? [major + 1, 0, 0]
        : patch === undefined
          ? [major, minor + 1, 0]
          : [major, minor, patch + 1];
  switch (operator) {
    case ">=":
      return { from: floor, below: undefined };
    case ">":
      return ceiling === undefined ? NOTHING : { from: ceiling, below: undefined };
    case "<":
      return major === undefined ? NOTHING : { from: LOWEST, below: floor };
    case "<=":
      return { from: LOWEST, below: ceiling };
    case "~":
    case "~>":
      return {
        from: floor,
        below:
          major === undefined
            ? undefined
            : minor === undefined
              ? [major + 1, 0, 0]
              : [major, minor + 1, 0],
      };
    case "^":
      // Up to the next change of the leftmost number that isn't zero.
      if (major === undefined) return ANYTHING;
      if (major > 0 || minor === undefined) return { from: floor, below: [major + 1, 0, 0] };
      if (minor > 0 || patch === undefined) return { from: floor, below: [0, minor + 1, 0] };
      return { from: floor, below: [0, 0, patch + 1] };
    default:
      return { from: floor, below: ceiling };
  }
}

/** The comparators of one `||` alternative, all of which must hold. */
function alternativeBounds(alternative: string): ReadonlyArray<Bounds> | undefined {
  const text = alternative.trim();
  if (text === "") return [ANYTHING];
  const hyphen = HYPHEN_RANGE.exec(text);
  if (hyphen) {
    const from = pinnedVersion(hyphen[1] ?? "");
    const to = pinnedVersion(hyphen[2] ?? "");
    return from && to ? [comparatorBounds(">=", from), comparatorBounds("<=", to)] : undefined;
  }
  const bounds: Array<Bounds> = [];
  for (const comparator of text.replace(SPACE_AFTER_OPERATOR, "$1").split(/\s+/u)) {
    const match = COMPARATOR.exec(comparator);
    const pinned = match ? pinnedVersion(match[2] ?? "") : undefined;
    if (!match || !pinned) return undefined;
    bounds.push(comparatorBounds(match[1] ?? "", pinned));
  }
  return bounds;
}

/**
 * Whether a released Node.js `version` is inside an `engines.node` range:
 * npm's range syntax (`>=`, `<`, `^`, `~`, `x`, `*`, `A - B`, spaces for
 * "and", `||` for "or"). Undefined when the range isn't one this reads, so
 * a caller can tell "doesn't fit" from "can't tell".
 */
export function nodeSatisfiesRange(version: string, range: string): boolean | undefined {
  const parsed = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version.trim());
  if (!parsed) return undefined;
  const wanted: Version = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
  let satisfied = false;
  for (const alternative of range.split("||")) {
    const bounds = alternativeBounds(alternative);
    if (bounds === undefined) return undefined;
    satisfied ||= bounds.every(
      ({ from, below }) =>
        compareVersions(wanted, from) >= 0 &&
        (below === undefined || compareVersions(wanted, below) < 0),
    );
  }
  return satisfied;
}

/**
 * The environment for a program that runs on the managed Node.js: `base`
 * with the managed Node's folder first on `PATH`, so `node`, `npm` and
 * `npx` resolve to it, and without `NODE_OPTIONS`, which holds the server's
 * own Node flags. For npm, and for the agents it installs.
 */
export function managedNodeEnvironment(
  base: NodeJS.ProcessEnv,
  binDir: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  // Windows variable names ignore case, and a copied environment keeps whichever spelling it had.
  const isNamed = (name: string, wanted: string) =>
    windows ? name.toUpperCase() === wanted : name === wanted;
  const environment: NodeJS.ProcessEnv = {};
  let path = "";
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || isNamed(name, "NODE_OPTIONS")) continue;
    if (isNamed(name, "PATH")) {
      path ||= value;
      continue;
    }
    environment[name] = value;
  }
  environment.PATH = path === "" ? binDir : `${binDir}${windows ? ";" : ":"}${path}`;
  return environment;
}

const MAX_LINE_LENGTH = 300;
const MAX_PENDING_LENGTH = 64 * 1024;
const MAX_STDOUT_LENGTH = 1024 * 1024;
/** How much of a program's last output a result carries. */
const OUTPUT_TAIL_LENGTH = 2000;
/** How long output still in the pipes is waited for once the program has exited. */
const DRAIN_MS = 1000;
/** How long a stopped program gets to exit before it is ended directly. */
const STOP_GRACE_MS = 5000;

const ESCAPE = 0x1b;

/** A line of program output as plain text: no colour codes, no control characters, bounded. */
function cleanLine(line: string): string {
  let text = "";
  for (let index = 0; index < line.length && text.length < MAX_LINE_LENGTH; index += 1) {
    const code = line.charCodeAt(index);
    if (code === ESCAPE && line[index + 1] === "[") {
      // A terminal sequence ends at its first letter-like byte.
      index += 2;
      while (
        index < line.length &&
        (line.charCodeAt(index) < 0x40 || line.charCodeAt(index) > 0x7e)
      ) {
        index += 1;
      }
      continue;
    }
    if (code === 0x09) text += " ";
    else if (code >= 0x20 && code !== 0x7f) text += line[index];
  }
  return text.trimEnd();
}

export interface NodeRunInput {
  /** The managed `node`. */
  readonly node: string;
  /** Its arguments, the script first (npm's entry script). */
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Aborting stops the program and everything it started. */
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  /** Each line it prints, as it arrives. */
  readonly onLine?: (line: string) => void;
}

export interface NodeRunResult {
  /** Null when it was stopped. */
  readonly exitCode: number | null;
  /** It ran past `timeoutMs` and was stopped. */
  readonly timedOut: boolean;
  /** What it wrote to stdout, up to 1 MiB. */
  readonly stdout: string;
  /** Its last lines, stdout and stderr together: about 2000 characters. */
  readonly tail: string;
}

/**
 * Stops `child` and the programs it started (npm runs packages' install
 * scripts). Where the whole tree can't be stopped, `child` itself still is.
 */
function stopTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => child.kill());
    killer.once("exit", (code) => {
      if (code !== 0) child.kill();
    });
    return;
  }
  try {
    // The child leads its own process group (`detached` below).
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Runs the managed Node.js with a script (npm) to its end, with no shell.
 * Settles only once the program has exited: on abort (it rejects), on
 * timeout (`timedOut`), or by itself. Rejects when it can't be started.
 *
 * A program that npm started and that outlives it (an install script's
 * background job) is not stopped: once npm has exited, its id is no longer
 * this program's to signal.
 */
export function runNode(input: NodeRunInput): Promise<NodeRunResult> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) {
      reject(input.signal.reason);
      return;
    }
    const child = spawn(input.node, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      // Its own process group, so what it starts can be stopped with it.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    const tail: Array<string> = [];
    let tailLength = 0;
    const pushLine = (raw: string) => {
      const line = cleanLine(raw);
      if (line === "") return;
      tail.push(line);
      tailLength += line.length + 1;
      while (tailLength > OUTPUT_TAIL_LENGTH && tail.length > 1) {
        tailLength -= (tail.shift() ?? "").length + 1;
      }
      try {
        input.onLine?.(line);
      } catch {
        // Reporting a line never fails the run.
      }
    };
    /** Feeds a stream's lines to `pushLine`; the returned function flushes a last unfinished line. */
    const readLines = (stream: Readable, isStdout: boolean) => {
      const decoder = new StringDecoder("utf8");
      let pending = "";
      stream.on("error", () => undefined);
      stream.on("data", (chunk: Buffer) => {
        const text = decoder.write(chunk);
        if (isStdout && stdout.length < MAX_STDOUT_LENGTH) {
          stdout += text.slice(0, MAX_STDOUT_LENGTH - stdout.length);
        }
        const lines = (pending + text).split(/\r\n|\n|\r/u);
        pending = (lines.pop() ?? "").slice(-MAX_PENDING_LENGTH);
        for (const line of lines) pushLine(line);
      });
      return () => {
        if (pending !== "") pushLine(pending);
        pending = "";
      };
    };
    const flushStdout = readLines(child.stdout, true);
    const flushStderr = readLines(child.stderr, false);

    let stopped: "aborted" | "timedOut" | undefined;
    let exited = false;
    let lastResort: NodeJS.Timeout | undefined;
    const stop = (reason: "aborted" | "timedOut") => {
      // Once it has exited its pid is no longer this program's to signal.
      if (stopped || exited) return;
      stopped = reason;
      stopTree(child);
      // If that didn't end it, the caller must not wait forever.
      lastResort = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, STOP_GRACE_MS);
    };
    const timer = setTimeout(() => stop("timedOut"), input.timeoutMs);
    const onAbort = () => stop("aborted");
    input.signal.addEventListener("abort", onAbort, { once: true });
    const stopWatching = () => {
      clearTimeout(timer);
      clearTimeout(lastResort);
      input.signal.removeEventListener("abort", onAbort);
    };
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      stopWatching();
      finish();
    };

    child.once("error", (cause) => settle(() => reject(cause)));
    child.once("exit", (exitCode) => {
      exited = true;
      stopWatching();
      // Read what is still in the pipes, but don't wait on a program that
      // inherited them and lives on.
      const drained = Promise.allSettled([finished(child.stdout), finished(child.stderr)]);
      let drainTimer: NodeJS.Timeout | undefined;
      const waited = new Promise((done) => {
        drainTimer = setTimeout(done, DRAIN_MS);
      });
      void Promise.race([drained, waited]).then(() => {
        clearTimeout(drainTimer);
        child.stdout.destroy();
        child.stderr.destroy();
        flushStdout();
        flushStderr();
        settle(() => {
          if (stopped === "aborted") {
            reject(input.signal.reason);
            return;
          }
          resolve({
            exitCode: stopped ? null : exitCode,
            timedOut: stopped === "timedOut",
            stdout,
            tail: tail.join("\n").slice(-OUTPUT_TAIL_LENGTH),
          });
        });
      });
    });
  });
}

/** A program an npm package ships. */
export interface NpmBin {
  /** What `node_modules/.bin` calls it. */
  readonly name: string;
  /** The file, relative to the install prefix, `/`-separated. */
  readonly path: string;
  /** Node runs it: a `#!` line naming node, or a JavaScript file extension. */
  readonly javascript: boolean;
}

export type NpmBinResult =
  | { readonly bin: NpmBin }
  /** `noBin`: the package doesn't say which program to run. `noFile`: the one it names isn't a file in it. */
  | { readonly problem: "noBin" | "noFile"; readonly detail: string };

const PackageManifest = Schema.Struct({
  bin: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])),
});
const decodePackageManifest = Schema.decodeUnknownOption(Schema.fromJsonString(PackageManifest));

const unscopedName = (packageName: string) => packageName.slice(packageName.indexOf("/") + 1);

/**
 * The package's `bin` entry to launch: the only one, else the one named
 * like the package (without its scope), else the one named like the agent.
 */
function chooseNpmBin(
  bin: string | Readonly<Record<string, unknown>> | undefined,
  packageName: string,
  agentId: string,
): { readonly name: string; readonly target: string } | undefined {
  if (typeof bin === "string") return { name: unscopedName(packageName), target: bin };
  const entries = Object.entries(bin ?? {}).flatMap(([name, target]) =>
    typeof target === "string" ? [{ name, target }] : [],
  );
  if (entries.length === 1) return entries[0];
  return (
    entries.find((entry) => entry.name === unscopedName(packageName)) ??
    entries.find((entry) => entry.name === agentId)
  );
}

const JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const MAX_BIN_PATH_LENGTH = 1024;
const NODE_PROGRAM = /^node(?:js)?(?:\.exe)?$/iu;

/** Whether a file's first line is a `#!` that runs node, directly or through `env`. */
function shebangNamesNode(head: string): boolean {
  if (!head.startsWith("#!")) return false;
  const words = (head.slice(2).split(/\r?\n/u)[0] ?? "").trim().split(/\s+/u);
  const programName = (word: string | undefined) => (word ?? "").split(/[\\/]/u).pop() ?? "";
  if (programName(words[0]) !== "env") return NODE_PROGRAM.test(programName(words[0]));
  // `env` may carry options (`-S`) and assignments before the program.
  const program = words.slice(1).find((word) => !word.startsWith("-") && !word.includes("="));
  return NODE_PROGRAM.test(programName(program));
}

async function readHead(file: string, bytes: number): Promise<string> {
  const handle = await NodeFS.open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

const isInside = (parent: string, child: string) => {
  const relative = NodePath.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
};

/**
 * Finds the program of `packageName` as installed under `prefix`. The
 * package must be a real folder in `node_modules`, and the program a
 * regular file inside it. Throws only what the filesystem does.
 */
export async function findNpmBin(input: {
  /** The folder npm installed into: holds `node_modules`. */
  readonly prefix: string;
  readonly packageName: string;
  readonly agentId: string;
}): Promise<NpmBinResult> {
  const packageDir = NodePath.join(input.prefix, "node_modules", ...input.packageName.split("/"));
  const missing = (cause: unknown) => {
    if (typeof cause === "object" && cause !== null && "code" in cause) {
      const { code } = cause;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG" || code === "ELOOP") {
        return undefined;
      }
    }
    throw cause;
  };
  const packageStats = await NodeFS.lstat(packageDir).catch(missing);
  if (!packageStats?.isDirectory()) {
    return { problem: "noFile", detail: `${input.packageName} is not a folder in node_modules` };
  }
  const rawManifest = await NodeFS.readFile(
    NodePath.join(packageDir, "package.json"),
    "utf8",
  ).catch(missing);
  const manifest =
    rawManifest === undefined
      ? undefined
      : Option.getOrUndefined(decodePackageManifest(rawManifest));
  if (!manifest) {
    return { problem: "noBin", detail: `${input.packageName} has no readable package.json` };
  }
  const chosen = chooseNpmBin(manifest.bin, input.packageName, input.agentId);
  if (!chosen) {
    const names = typeof manifest.bin === "object" ? Object.keys(manifest.bin) : [];
    return {
      problem: "noBin",
      detail:
        names.length === 0
          ? `${input.packageName} declares no bin`
          : `${input.packageName} declares ${names.length} bins and none is named like it: ${names.join(", ").slice(0, 300)}`,
    };
  }
  const file = NodePath.resolve(packageDir, chosen.target);
  const notInPackage: NpmBinResult = {
    problem: "noFile",
    detail: `bin "${chosen.name.slice(0, 100)}" points at "${chosen.target.slice(0, 300)}", which is not a file in the package`,
  };
  // A path no system could hold never reaches the filesystem, whose error would quote all of it.
  if (chosen.target.length > MAX_BIN_PATH_LENGTH || chosen.target.includes("\0")) {
    return notInPackage;
  }
  if (!isInside(packageDir, file)) return notInPackage;
  const fileStats = await NodeFS.lstat(file).catch(missing);
  if (!fileStats?.isFile()) return notInPackage;
  // No folder on the way to it may be a link out of the package either.
  const [realPackageDir, realFile] = await Promise.all([
    NodeFS.realpath(packageDir),
    NodeFS.realpath(file),
  ]);
  if (!isInside(realPackageDir, realFile)) return notInPackage;
  const javascript =
    JAVASCRIPT_EXTENSIONS.has(NodePath.extname(file).toLowerCase()) ||
    shebangNamesNode(await readHead(file, 256));
  return {
    bin: {
      name: chosen.name,
      path: NodePath.relative(input.prefix, file).split(NodePath.sep).join("/"),
      javascript,
    },
  };
}

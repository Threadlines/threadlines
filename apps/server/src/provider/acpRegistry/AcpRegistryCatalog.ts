// @effect-diagnostics nodeBuiltinImport:off - keeps the registry's lists and icons in files
/**
 * AcpRegistryCatalog — the community agents a user could add: the ACP
 * registry (agentclientprotocol/registry), reduced to what this computer
 * would install.
 *
 * The registry is somebody else's and changes without review, so nothing in
 * it is taken on trust. Each entry is checked on its own: one that breaks a
 * rule is left out with a logged reason, and the rest of the list stands.
 * What passes is a recipe (`AcpRegistryRecipe.ts`), named by its digest,
 * and the few facts a client shows beside it.
 *
 * Kept under `cacheDir`, so the list survives a restart and a lost
 * connection:
 *
 *     registry.json     the index, as the registry sent it
 *     quarantine.json   the agents the registry has pulled, likewise
 *     icons/<sha256 of the icon's address>.svg
 *
 * A list file's modification time is when it was read from the registry.
 *
 * @module provider/acpRegistry/AcpRegistryCatalog
 */
import { createHash, randomBytes } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type AcpRegistryCatalog,
  type AcpRegistryCatalogAgent,
  AcpRegistryError,
} from "@threadlines/contracts";
import { ACP_REGISTRY_BUILT_IN_AGENT_IDS } from "@threadlines/shared/acpRegistry";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { isIpAddressHostname, makeHttpsFetch } from "../managedRuntime/HttpsFetch.ts";
import type { DownloadFetch } from "../managedRuntime/VerifiedDownload.ts";
import {
  type AcpRegistryDownloadRecipe,
  type AcpRegistryNpmRecipe,
  type AcpRegistryRecipe,
  acpRegistryRecipeDigest,
} from "./AcpRegistryRecipe.ts";

export const ACP_REGISTRY_INDEX_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
/** Agents the registry has pulled. They stay in the published index, so this is the only way to know. */
export const ACP_REGISTRY_QUARANTINE_URL =
  "https://raw.githubusercontent.com/agentclientprotocol/registry/main/quarantine.json";
/** The only host an icon is fetched from. */
export const ACP_REGISTRY_ICON_HOST = "cdn.agentclientprotocol.com";

const INDEX_MAX_BYTES = 1024 * 1024;
const QUARANTINE_MAX_BYTES = 64 * 1024;
const ICON_MAX_BYTES = 32 * 1024;
const LIST_TIMEOUT = Duration.seconds(30);
const ICON_TIMEOUT = Duration.seconds(10);
/** For all icons together: a slow icon host delays the list by this much at most. */
const ICONS_TIMEOUT = Duration.seconds(20);
const ICON_CONCURRENCY = 6;
const MEMORY_MAX_AGE_MS = 5 * 60 * 1000;
/** Dropped entries remembered as logged, before the memory starts over. */
const MAX_LOGGED_DROPS = 4096;

const MAX_AGENTS = 512;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_AUTHORS = 16;
const MAX_AUTHOR_LENGTH = 256;
const MAX_LICENSE_LENGTH = 128;
const MAX_ADDRESS_LENGTH = 2048;
const MAX_HOST_LENGTH = 255;
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 1024;
const MAX_ENV_ENTRIES = 64;
const MAX_ENV_NAME_LENGTH = 128;
const MAX_ENV_VALUE_LENGTH = 4096;
const MAX_COMMAND_LENGTH = 1024;
const MAX_PACKAGE_SPEC_LENGTH = 256;
/** npm's own limit. */
const MAX_PACKAGE_NAME_LENGTH = 214;

/** Short enough that `acp_<id>` is a valid instance id. */
const AGENT_ID = /^[a-z][a-z0-9-]{0,58}$/u;
const AGENT_VERSION = /^[A-Za-z0-9._+-]{1,64}$/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SHA256 = /^[0-9a-f]{64}$/iu;
/** A package name as npm accepts one today, with or without a scope. */
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/u;
/** One version, as semver.org spells it: no range, no tag, no leading `v`. */
const EXACT_SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;

const UNAVAILABLE_DETAIL =
  "Couldn't read the community agent list. Check your internet connection and try again.";

const RESERVED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);
const RESERVED_ENV_PREFIXES = ["LD_", "DYLD_", "PYTHON", "NPM_CONFIG_", "THREADLINES_"];

/**
 * Whether an agent may not be handed this environment variable by the
 * registry or by its own sign-in method: it would change where programs are
 * found, what they load, where their files and traffic go, or how
 * Threadlines itself runs. Names compare without regard to case, as Windows
 * compares them.
 */
export function isReservedAcpRegistryEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    RESERVED_ENV_NAMES.has(upper) ||
    RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

/** The registry's name for a computer (`darwin-aarch64`), or undefined when it has none. */
export function acpRegistryPlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  const system =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : undefined;
  const processor = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : undefined;
  return system && processor ? `${system}-${processor}` : undefined;
}

/** One listed agent: what clients see, and the recipe behind it. `agent.recipeDigest === acpRegistryRecipeDigest(recipe)`. */
export interface AcpRegistryCatalogEntry {
  readonly agent: AcpRegistryCatalogAgent;
  readonly recipe: AcpRegistryRecipe;
}

export interface AcpRegistryCatalogSnapshot {
  /** Sorted by name. */
  readonly entries: ReadonlyArray<AcpRegistryCatalogEntry>;
  /** When the index behind this was read from the registry, as an ISO time. */
  readonly fetchedAt: string | null;
  /** Some of this is the saved copy: the registry couldn't be read, or wasn't asked. */
  readonly stale: boolean;
  /** False until the quarantine list has been read once. Callers refuse installs until then. */
  readonly quarantineKnown: boolean;
  /** Agents left out because they have no build for this computer. */
  readonly unsupportedCount: number;
}

export interface AcpRegistryCatalogShape {
  /**
   * The catalog. Served from memory when the registry was asked less than
   * five minutes ago, unless `refresh`. When the registry can't be read, the
   * saved copy, marked stale. Fails with `catalogUnavailable` only when
   * there is no copy at all. Calls that overlap share one read.
   */
  readonly get: (options?: {
    readonly refresh?: boolean;
  }) => Effect.Effect<AcpRegistryCatalogSnapshot, AcpRegistryError>;
  /**
   * What is in memory or saved on disk, without touching the network. A
   * copy that comes from disk alone is marked stale, and has only the icons
   * that were saved with it.
   */
  readonly peek: Effect.Effect<AcpRegistryCatalogSnapshot | undefined>;
}

export interface AcpRegistryCatalogOptions {
  /** `<stateDir>/caches/acp-registry`: where the last good index, quarantine list and icons are kept. */
  readonly cacheDir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /**
   * Default: `makeHttpsFetch({ publicAddressesOnly: true })`, and for icons
   * one that also refuses every host but the registry's. Tests pass a stub.
   */
  readonly fetch?: DownloadFetch;
}

/** A listed agent before its icon is fetched: `agent.iconSvg` is null, and `iconUrl` says where the icon is. */
export interface AcpRegistryReducedEntry extends AcpRegistryCatalogEntry {
  /** On the registry's icon host, or null. */
  readonly iconUrl: string | null;
}

export interface AcpRegistryReduction {
  /** Sorted by name. */
  readonly entries: ReadonlyArray<AcpRegistryReducedEntry>;
  /** Well-formed agents with no build for this computer. */
  readonly unsupportedCount: number;
  /** Entries left out for breaking a rule, and which. For the log. */
  readonly dropped: ReadonlyArray<{ readonly agentId: string | null; readonly reason: string }>;
}

/** A checked value, or why its agent is left out. */
type Checked<A> = Result.Result<A, string>;
const refused = (reason: string): Checked<never> => Result.fail(reason);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Free text cut to `max` UTF-16 units, without splitting a character in two. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** `value` as an https address without credentials, or undefined. */
function httpsUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > MAX_ADDRESS_LENGTH) return undefined;
  const url = URL.parse(value);
  return url !== null &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.href.length <= MAX_ADDRESS_LENGTH
    ? url
    : undefined;
}

/**
 * Whether text holds a character that draws nothing or reorders what is
 * drawn: control characters, zero-width characters and direction marks.
 */
const hasHiddenCharacter = (text: string) =>
  Array.from(text).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code < 0x20 ||
      code === 0x7f ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      code === 0xfeff
    );
  });

function checkedArgs(value: unknown): Checked<ReadonlyArray<string>> {
  if (value === undefined) return Result.succeed([]);
  if (!Array.isArray(value) || value.length > MAX_ARGS) {
    return refused(`its args are not a list of at most ${MAX_ARGS}`);
  }
  const args: Array<string> = [];
  for (const arg of value) {
    if (typeof arg !== "string" || arg.length > MAX_ARG_LENGTH || arg.includes("\u0000")) {
      return refused(`one of its args is not text of at most ${MAX_ARG_LENGTH} characters`);
    }
    args.push(arg);
  }
  return Result.succeed(args);
}

/** The registry's environment for an agent, without the names an agent may not set. */
function checkedEnv(value: unknown): Checked<Record<string, string>> {
  if (value === undefined) return Result.succeed({});
  if (!isRecord(value)) return refused("its env is not an object");
  const entries = Object.entries(value);
  if (entries.length > MAX_ENV_ENTRIES) {
    return refused(`its env has more than ${MAX_ENV_ENTRIES} entries`);
  }
  const kept: Array<[string, string]> = [];
  for (const [name, entry] of entries) {
    if (name.length > MAX_ENV_NAME_LENGTH || !ENV_NAME.test(name)) {
      return refused("its env has a name that is not a plain variable name");
    }
    if (
      typeof entry !== "string" ||
      entry.length > MAX_ENV_VALUE_LENGTH ||
      entry.includes("\u0000")
    ) {
      return refused(
        `its env value for ${name} is not text of at most ${MAX_ENV_VALUE_LENGTH} characters`,
      );
    }
    if (!isReservedAcpRegistryEnvName(name)) kept.push([name, entry]);
  }
  // `fromEntries` defines each name as its own property, `__proto__` included.
  return Result.succeed(Object.fromEntries(kept));
}

/**
 * How a download is unpacked, read off the file name its address ends in;
 * undefined for a kind Threadlines doesn't unpack. A name with no suffix is
 * the program itself. A suffix is a dot and then letters or digits with at
 * least one letter, so the end of a version number (`tool-1.2.3`) is not one.
 */
function downloadFormat(url: URL): AcpRegistryDownloadRecipe["format"] | undefined {
  const file = (url.pathname.split("/").at(-1) ?? "").toLowerCase();
  if (file.endsWith(".zip")) return "zip";
  if (file.endsWith(".tar.gz") || file.endsWith(".tgz")) return "tar.gz";
  if (file.endsWith(".tar.bz2") || file.endsWith(".tbz2")) return "tar.bz2";
  if (file.endsWith(".exe") || file.endsWith(".bin")) return "raw";
  return /\.[a-z0-9]*[a-z][a-z0-9]*$/u.test(file) ? undefined : "raw";
}

/**
 * The program to launch, as a `/`-separated path that can only name
 * something inside the download: no drive, no root, no `..`. The registry
 * writes it as `./goose` or `./bin\devin.exe`.
 */
function checkedCommand(
  value: unknown,
  format: AcpRegistryDownloadRecipe["format"],
): Checked<string> {
  if (typeof value !== "string") return refused("it has no cmd");
  const cmd = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  const parts = cmd.split("/");
  if (
    cmd.length > MAX_COMMAND_LENGTH ||
    // A drive letter or a stream name on Windows.
    cmd.includes(":") ||
    hasHiddenCharacter(cmd) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    return refused("its cmd is not a plain path inside the download");
  }
  if (format === "raw" && parts.length !== 1) {
    return refused("its cmd is a path, but the download is the program itself");
  }
  return Result.succeed(cmd);
}

interface RecipeBase {
  readonly agentId: string;
  readonly version: string;
}

const downloadRecipe = (base: RecipeBase, build: unknown): Checked<AcpRegistryDownloadRecipe> =>
  Result.gen(function* () {
    if (!isRecord(build)) return yield* refused("its build for this computer is not an object");
    const url = httpsUrl(build.archive);
    if (url === undefined) {
      return yield* refused("its archive is not an https address without credentials");
    }
    if (isIpAddressHostname(url.hostname) || url.hostname.length > MAX_HOST_LENGTH) {
      return yield* refused("its archive is not on a named host");
    }
    const format = downloadFormat(url);
    if (format === undefined) {
      return yield* refused("its archive is of a kind Threadlines doesn't unpack");
    }
    // No checksum is a listing of its own kind; a broken one is a broken listing.
    const sha256 = build.sha256;
    if (sha256 !== undefined && (typeof sha256 !== "string" || !SHA256.test(sha256))) {
      return yield* refused("its sha256 is not 64 hex digits");
    }
    const cmd = yield* checkedCommand(build.cmd, format);
    const args = yield* checkedArgs(build.args);
    const env = yield* checkedEnv(build.env);
    return {
      kind: "download" as const,
      ...base,
      args,
      env,
      url: url.href,
      sha256: sha256?.toLowerCase() ?? null,
      format,
      cmd,
    };
  });

const npmRecipe = (base: RecipeBase, npx: unknown): Checked<AcpRegistryNpmRecipe> =>
  Result.gen(function* () {
    if (!isRecord(npx)) return yield* refused("its npx entry is not an object");
    const spec = npx.package;
    if (typeof spec !== "string" || spec.length > MAX_PACKAGE_SPEC_LENGTH) {
      return yield* refused("it names no npm package");
    }
    // A scope starts with `@` too, so the version is after the last one.
    const at = spec.lastIndexOf("@");
    const packageName = at > 0 ? spec.slice(0, at) : spec;
    if (packageName.length > MAX_PACKAGE_NAME_LENGTH || !NPM_PACKAGE_NAME.test(packageName)) {
      return yield* refused("its npm package is not a package name");
    }
    const packageVersion = at > 0 ? spec.slice(at + 1) : "";
    if (!EXACT_SEMVER.test(packageVersion)) {
      return yield* refused("its npm package is not pinned to one exact version");
    }
    const args = yield* checkedArgs(npx.args);
    const env = yield* checkedEnv(npx.env);
    return { kind: "npm" as const, ...base, args, env, packageName, packageVersion };
  });

/** Where a recipe's files come from, as a client is told. */
const sourceOf = (
  recipe: AcpRegistryRecipe,
): Pick<AcpRegistryCatalogAgent, "source" | "packageSpec" | "host" | "integrity"> =>
  recipe.kind === "npm"
    ? {
        source: "npm",
        packageSpec: `${recipe.packageName}@${recipe.packageVersion}`,
        host: null,
        integrity: "package",
      }
    : {
        source: "download",
        packageSpec: null,
        host: new URL(recipe.url).hostname,
        integrity: recipe.sha256 === null ? "none" : "checksum",
      };

/** The icon's address when it is on the registry's icon host, else null. */
function iconUrlOf(value: unknown): string | null {
  const url = httpsUrl(value);
  return url !== undefined && url.hostname === ACP_REGISTRY_ICON_HOST ? url.href : null;
}

/**
 * One entry with a valid id, reduced. Undefined when it is well-formed but
 * has nothing to install on this computer.
 */
const reduceAgent = (
  raw: Record<string, unknown>,
  agentId: string,
  platformKey: string | undefined,
): Checked<AcpRegistryReducedEntry | undefined> =>
  Result.gen(function* () {
    const version = raw.version;
    if (typeof version !== "string" || !AGENT_VERSION.test(version)) {
      return yield* refused("its version is missing or not a plain version");
    }
    const name = typeof raw.name === "string" ? clip(raw.name.trim(), MAX_NAME_LENGTH) : "";
    if (name === "") return yield* refused("it has no name");
    const distribution = raw.distribution;
    if (!isRecord(distribution)) return yield* refused("it has no distribution");
    const binary = distribution.binary;
    if (binary !== undefined && !isRecord(binary)) {
      return yield* refused("its binary entry is not an object");
    }

    const base = { agentId, version };
    let recipe: AcpRegistryRecipe;
    if (platformKey !== undefined && binary !== undefined && Object.hasOwn(binary, platformKey)) {
      recipe = yield* downloadRecipe(base, binary[platformKey]);
    } else if (distribution.npx !== undefined) {
      recipe = yield* npmRecipe(base, distribution.npx);
    } else {
      // Only builds for other computers, or only a Python package (`uvx`).
      return undefined;
    }

    const license = typeof raw.license === "string" ? raw.license.trim() : "";
    return {
      agent: {
        agentId,
        name,
        version,
        recipeDigest: acpRegistryRecipeDigest(recipe),
        description:
          typeof raw.description === "string"
            ? clip(raw.description.trim(), MAX_DESCRIPTION_LENGTH)
            : "",
        authors: Array.isArray(raw.authors)
          ? raw.authors
              .filter((author): author is string => typeof author === "string")
              .map((author) => clip(author.trim(), MAX_AUTHOR_LENGTH))
              .filter((author) => author !== "")
              .slice(0, MAX_AUTHORS)
          : [],
        license: license === "" ? null : clip(license, MAX_LICENSE_LENGTH),
        website: httpsUrl(raw.website)?.href ?? null,
        repository: httpsUrl(raw.repository)?.href ?? null,
        iconSvg: null,
        ...sourceOf(recipe),
      },
      recipe,
      iconUrl: iconUrlOf(raw.icon),
    };
  });

/** The agents of a parsed index, or undefined when the JSON isn't an index. */
const agentsOfIndex = (index: unknown): ReadonlyArray<unknown> | undefined =>
  isRecord(index) && Array.isArray(index.agents) ? index.agents : undefined;

/**
 * Turns the registry's index, as parsed JSON, into what this computer could
 * install. Pure: no icons, no network.
 *
 * - Agents Threadlines supports itself and quarantined agents are hidden,
 *   and are neither listed nor counted.
 * - An agent takes its `binary` build for this computer when it has one,
 *   else its npm package. One with neither is counted in `unsupportedCount`.
 * - An agent that breaks a bound is dropped, never cut to fit, except free
 *   text (name, description, authors, license), which is cut. Links that
 *   aren't plain https become null.
 */
export function reduceAcpRegistryIndex(input: {
  readonly index: unknown;
  readonly quarantined: ReadonlySet<string>;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): AcpRegistryReduction {
  const agents = agentsOfIndex(input.index) ?? [];
  const platformKey = acpRegistryPlatformKey(input.platform, input.arch);
  const entries: Array<AcpRegistryReducedEntry> = [];
  const dropped: Array<{ readonly agentId: string | null; readonly reason: string }> = [];
  const seen = new Set<string>();
  let unsupportedCount = 0;

  if (agents.length > MAX_AGENTS) {
    dropped.push({
      agentId: null,
      reason: `the index lists ${agents.length} agents; only the first ${MAX_AGENTS} are read`,
    });
  }
  for (const raw of agents.slice(0, MAX_AGENTS)) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !AGENT_ID.test(raw.id)) {
      dropped.push({ agentId: null, reason: "its id is missing or not an agent id" });
      continue;
    }
    const agentId = raw.id;
    if (ACP_REGISTRY_BUILT_IN_AGENT_IDS.has(agentId) || input.quarantined.has(agentId)) continue;
    if (seen.has(agentId)) {
      dropped.push({ agentId, reason: "an earlier entry has the same id" });
      continue;
    }
    seen.add(agentId);
    const reduced = reduceAgent(raw, agentId, platformKey);
    if (Result.isFailure(reduced)) dropped.push({ agentId, reason: reduced.failure });
    else if (reduced.success === undefined) unsupportedCount += 1;
    else entries.push(reduced.success);
  }

  return {
    // By name without regard to case, the same on every computer; ids are
    // unique and settle a tie.
    entries: entries.toSorted((left, right) => {
      const [leftName, rightName] = [left.agent.name.toLowerCase(), right.agent.name.toLowerCase()];
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      return left.agent.agentId < right.agent.agentId ? -1 : 1;
    }),
    unsupportedCount,
    dropped,
  };
}

/** Client-facing form of a snapshot. */
export function toAcpRegistryCatalog(snapshot: AcpRegistryCatalogSnapshot): AcpRegistryCatalog {
  return {
    agents: snapshot.entries.map((entry) => entry.agent),
    fetchedAt: snapshot.fetchedAt,
    stale: snapshot.stale,
    quarantineKnown: snapshot.quarantineKnown,
    unsupportedCount: snapshot.unsupportedCount,
  };
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Why something couldn't be read from the registry, or kept in its saved copy. For the log. */
class RegistryReadError extends Data.TaggedError("RegistryReadError")<{
  readonly detail: string;
}> {}
const readError = (cause: unknown) =>
  new RegistryReadError({ detail: cause instanceof Error ? cause.message : String(cause) });

/**
 * GETs `url` and returns its body. Fails when the answer is an error, is
 * larger than `maxBytes`, or takes longer than `timeout`.
 */
const fetchBounded = (
  fetch: DownloadFetch,
  url: string,
  maxBytes: number,
  timeout: Duration.Duration,
) =>
  Effect.tryPromise({
    try: async (signal) => {
      // The bytes as published, so the cap counts what is kept.
      const response = await fetch(url, { headers: { "accept-encoding": "identity" }, signal });
      if (!response.ok || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`${url} answered HTTP ${response.status}`);
      }
      const chunks: Array<Uint8Array> = [];
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > maxBytes) throw new Error(`${url} is larger than ${maxBytes} bytes`);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
    catch: readError,
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(
          new RegistryReadError({
            detail: `${url} took longer than ${Duration.toSeconds(timeout)} seconds`,
          }),
        ),
    }),
  );

/**
 * A file's bytes and modification time. Undefined when it isn't there, or
 * is larger than anything this module would have written.
 */
async function readSavedFile(path: string, maxBytes: number) {
  let handle: NodeFS.FileHandle;
  try {
    handle = await NodeFS.open(path, "r");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) return undefined;
    return { bytes: await handle.readFile(), modifiedAtMs: Math.round(stats.mtimeMs) };
  } finally {
    await handle.close();
  }
}

/**
 * Replaces `path` in one step: a reader sees the old file or the new one,
 * never part of one. `modifiedAtMs` sets the new file's modification time.
 */
async function writeFileAtomically(path: string, bytes: Uint8Array, modifiedAtMs?: number) {
  await NodeFS.mkdir(NodePath.dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await NodeFS.writeFile(temp, bytes);
    if (modifiedAtMs !== undefined) {
      await NodeFS.utimes(temp, modifiedAtMs / 1000, modifiedAtMs / 1000);
    }
    await NodeFS.rename(temp, path);
  } catch (cause) {
    await NodeFS.rm(temp, { force: true }).catch(() => undefined);
    throw cause;
  }
}

/** One of the registry's lists, as last read. */
interface SavedList<A> {
  readonly value: A;
  readonly fetchedAtMs: number;
}

/**
 * One list the registry publishes, and the last good copy of it: in memory
 * once read, and in `file` across restarts. Neither effect fails; a list
 * that can't be had is undefined, and why is logged.
 */
function makeRegistryList<A>(input: {
  /** For the log. */
  readonly label: string;
  readonly url: string;
  readonly file: string;
  readonly maxBytes: number;
  readonly fetch: DownloadFetch;
  /** The list, or undefined when the JSON isn't one. */
  readonly decode: (json: unknown) => A | undefined;
}) {
  let latest: SavedList<A> | undefined;
  const parse = (bytes: Uint8Array) => {
    const value = input.decode(JSON.parse(strictUtf8.decode(bytes)));
    if (value === undefined) throw new Error(`not the registry's ${input.label}`);
    return value;
  };

  /** Reads the list from the registry and saves it. */
  const fromRegistry: Effect.Effect<SavedList<A> | undefined> = Effect.gen(function* () {
    const bytes = yield* fetchBounded(input.fetch, input.url, input.maxBytes, LIST_TIMEOUT);
    const value = yield* Effect.try({ try: () => parse(bytes), catch: readError });
    const fetchedAtMs = yield* Clock.currentTimeMillis;
    latest = { value, fetchedAtMs };
    // The copy in memory still serves when this fails.
    yield* Effect.tryPromise({
      try: () => writeFileAtomically(input.file, bytes, fetchedAtMs),
      catch: readError,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Couldn't save the ACP registry's ${input.label}`, {
          file: input.file,
          cause: error.detail,
        }),
      ),
    );
    return latest;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(`Couldn't read the ACP registry's ${input.label}`, {
        url: input.url,
        cause: error.detail,
      }).pipe(Effect.as(undefined)),
    ),
  );

  /** The last good copy, without touching the network. */
  const saved: Effect.Effect<SavedList<A> | undefined> = Effect.suspend(() => {
    if (latest) return Effect.succeed(latest);
    return Effect.tryPromise({
      try: async () => {
        const file = await readSavedFile(input.file, input.maxBytes);
        return file && { value: parse(file.bytes), fetchedAtMs: file.modifiedAtMs };
      },
      catch: readError,
    }).pipe(
      // A read from the registry that finished meanwhile is newer.
      Effect.map((fromDisk) => (latest ??= fromDisk)),
      Effect.catch((error) =>
        Effect.logWarning(`Couldn't use the saved copy of the ACP registry's ${input.label}`, {
          file: input.file,
          cause: error.detail,
        }).pipe(Effect.as(undefined)),
      ),
    );
  });

  return { fromRegistry, saved };
}

/** The icon as SVG text, or undefined when the bytes aren't one. */
function svgText(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength > ICON_MAX_BYTES) return undefined;
  try {
    const text = strictUtf8.decode(bytes);
    return text.includes("<svg") ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Builds the catalog for one cache folder. Cheap; holds no resources. */
export function makeAcpRegistryCatalog(
  options: AcpRegistryCatalogOptions,
): AcpRegistryCatalogShape {
  const fetchList = options.fetch ?? makeHttpsFetch({ publicAddressesOnly: true });
  const fetchIcon =
    options.fetch ??
    makeHttpsFetch({ publicAddressesOnly: true, allowedHosts: [ACP_REGISTRY_ICON_HOST] });

  const index = makeRegistryList({
    label: "index",
    url: ACP_REGISTRY_INDEX_URL,
    file: NodePath.join(options.cacheDir, "registry.json"),
    maxBytes: INDEX_MAX_BYTES,
    fetch: fetchList,
    decode: (json) => (agentsOfIndex(json) === undefined ? undefined : json),
  });
  const quarantine = makeRegistryList({
    label: "quarantine list",
    url: ACP_REGISTRY_QUARANTINE_URL,
    file: NodePath.join(options.cacheDir, "quarantine.json"),
    maxBytes: QUARANTINE_MAX_BYTES,
    fetch: fetchList,
    // `{ "<agentId>": "<reason>" }`. Anything else is not the list, rather
    // than a list that quarantines nobody.
    decode: (json): ReadonlySet<string> | undefined =>
      isRecord(json) && Object.values(json).every((reason) => typeof reason === "string")
        ? new Set(Object.keys(json))
        : undefined,
  });

  const iconFile = (url: string) =>
    NodePath.join(
      options.cacheDir,
      "icons",
      `${createHash("sha256").update(url).digest("hex")}.svg`,
    );
  const savedIcon = (url: string) =>
    Effect.promise(() =>
      readSavedFile(iconFile(url), ICON_MAX_BYTES).then(
        (file) => file && svgText(file.bytes),
        () => undefined,
      ),
    );
  /** Fetches an icon and saves it. Only an SVG is kept. */
  const fetchedIcon = (url: string) =>
    fetchBounded(fetchIcon, url, ICON_MAX_BYTES, ICON_TIMEOUT).pipe(
      Effect.flatMap((bytes) => {
        const svg = svgText(bytes);
        return svg === undefined
          ? Effect.fail(new RegistryReadError({ detail: "not an SVG" }))
          : Effect.promise(() =>
              writeFileAtomically(iconFile(url), bytes).then(
                () => svg,
                // Fetched again next time.
                () => svg,
              ),
            );
      }),
      Effect.catch((error) =>
        Effect.logDebug("Couldn't read an ACP registry icon", { url, cause: error.detail }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  /**
   * Icons by address: the saved ones, and with `fetchMissing` the rest from
   * the registry, a few at a time. Past the time limit, the list goes out
   * with the icons that made it.
   */
  const iconsFor = (urls: ReadonlyArray<string>, fetchMissing: boolean) =>
    Effect.gen(function* () {
      const icons = new Map<string, string>();
      yield* Effect.forEach(
        new Set(urls),
        (url) =>
          savedIcon(url).pipe(
            Effect.flatMap((saved) =>
              saved !== undefined || !fetchMissing ? Effect.succeed(saved) : fetchedIcon(url),
            ),
            Effect.map((svg) => {
              if (svg !== undefined) icons.set(url, svg);
            }),
          ),
        { concurrency: ICON_CONCURRENCY, discard: true },
      ).pipe(Effect.timeoutOption(ICONS_TIMEOUT));
      return icons;
    });

  /** Reasons already logged, so a refresh doesn't repeat them. */
  const loggedDrops = new Set<string>();

  const build = (input: {
    readonly index: SavedList<unknown>;
    readonly quarantine: SavedList<ReadonlySet<string>> | undefined;
    readonly stale: boolean;
    readonly fetchIcons: boolean;
  }): Effect.Effect<AcpRegistryCatalogSnapshot> =>
    Effect.gen(function* () {
      const reduction = reduceAcpRegistryIndex({
        index: input.index.value,
        quarantined: input.quarantine?.value ?? new Set(),
        platform: options.platform,
        arch: options.arch,
      });
      for (const drop of reduction.dropped) {
        const key = `${drop.agentId}\u0000${drop.reason}`;
        if (loggedDrops.has(key)) continue;
        // A registry that keeps inventing broken entries doesn't get to grow this forever.
        if (loggedDrops.size >= MAX_LOGGED_DROPS) loggedDrops.clear();
        loggedDrops.add(key);
        yield* Effect.logWarning("Left an ACP registry entry out of the community agents", drop);
      }
      const icons = yield* iconsFor(
        reduction.entries.flatMap((entry) => (entry.iconUrl === null ? [] : [entry.iconUrl])),
        input.fetchIcons,
      );
      return {
        entries: reduction.entries.map(({ agent, recipe, iconUrl }) => ({
          agent: { ...agent, iconSvg: iconUrl === null ? null : (icons.get(iconUrl) ?? null) },
          recipe,
        })),
        fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(input.index.fetchedAtMs)),
        stale: input.stale,
        quarantineKnown: input.quarantine !== undefined,
        unsupportedCount: reduction.unsupportedCount,
      };
    });

  /**
   * The last snapshot built, and when the registry was last asked for it
   * (undefined: it was put together from disk alone).
   */
  let memory:
    | { readonly snapshot: AcpRegistryCatalogSnapshot; readonly askedAtMs: number | undefined }
    | undefined;
  let loading: Deferred.Deferred<AcpRegistryCatalogSnapshot, AcpRegistryError> | undefined;

  const load: Effect.Effect<AcpRegistryCatalogSnapshot, AcpRegistryError> = Effect.gen(
    function* () {
      const askedAtMs = yield* Clock.currentTimeMillis;
      const [readIndex, readQuarantine] = yield* Effect.all(
        [index.fromRegistry, quarantine.fromRegistry],
        { concurrency: "unbounded" },
      );
      const usedIndex = readIndex ?? (yield* index.saved);
      if (usedIndex === undefined) {
        return yield* new AcpRegistryError({
          reason: "catalogUnavailable",
          detail: UNAVAILABLE_DETAIL,
        });
      }
      const usedQuarantine = readQuarantine ?? (yield* quarantine.saved);
      const snapshot = yield* build({
        index: usedIndex,
        quarantine: usedQuarantine,
        stale:
          readIndex === undefined || (readQuarantine === undefined && usedQuarantine !== undefined),
        // The icons are on the index's host: when that can't be reached,
        // asking for each of them would only add to the wait.
        fetchIcons: readIndex !== undefined,
      });
      memory = { snapshot, askedAtMs };
      return snapshot;
    },
  );

  /**
   * `load`, shared: callers that overlap wait for the same read. It runs on
   * a fiber of its own, so a caller that is interrupted doesn't take the
   * others' read down with it. Claiming the read and starting it can't be
   * interrupted apart, or a claim nobody works on would block every later
   * call.
   */
  const sharedLoad = Effect.uninterruptible(
    Effect.suspend(() => {
      if (loading) return Effect.succeed(loading);
      const started = Deferred.makeUnsafe<AcpRegistryCatalogSnapshot, AcpRegistryError>();
      loading = started;
      return load.pipe(
        Effect.onExit((exit) => {
          loading = undefined;
          return Deferred.done(started, exit);
        }),
        Effect.forkDetach,
        Effect.as(started),
      );
    }),
  ).pipe(Effect.flatMap((started) => Deferred.await(started)));

  /** The snapshot in memory, when the registry was asked for it recently enough. */
  const recent = (nowMs: number) => {
    if (memory?.askedAtMs === undefined) return undefined;
    const ageMs = nowMs - memory.askedAtMs;
    // A clock that was set back makes the copy old, not fresh.
    return ageMs >= 0 && ageMs < MEMORY_MAX_AGE_MS ? memory.snapshot : undefined;
  };

  const get: AcpRegistryCatalogShape["get"] = (getOptions) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) => {
        const snapshot = getOptions?.refresh === true ? undefined : recent(nowMs);
        return snapshot ? Effect.succeed(snapshot) : sharedLoad;
      }),
    );

  const peek: AcpRegistryCatalogShape["peek"] = Effect.gen(function* () {
    if (memory) return memory.snapshot;
    const savedIndex = yield* index.saved;
    if (savedIndex === undefined) return undefined;
    const snapshot = yield* build({
      index: savedIndex,
      quarantine: yield* quarantine.saved,
      stale: true,
      fetchIcons: false,
    });
    // A read from the registry that finished meanwhile is newer.
    memory ??= { snapshot, askedAtMs: undefined };
    return memory.snapshot;
  });

  return { get, peek };
}

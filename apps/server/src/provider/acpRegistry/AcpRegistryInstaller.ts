// @effect-diagnostics nodeBuiltinImport:off - downloads, unpacks and installs an agent's files
/**
 * AcpRegistryInstaller — installs one community agent, from the recipe the
 * user confirmed and nothing else.
 *
 * `confirm` records a recipe; `install` takes a digest and installs exactly
 * the recipe recorded under it. An update is a newly confirmed recipe. What
 * the first install of a recipe turned out to be (the archive's hash; for
 * npm the manifest, lockfile and Node.js release) is recorded too, and a
 * later install of that recipe must turn out the same.
 *
 * Layout under `<toolsDir>/<sha256(agentId)[0:16]>/` (folder names are never
 * registry strings: an id like `con` is not a safe Windows name):
 *
 *     trust.json            the confirmed recipes and their first installs (`AcpRegistryTrust`)
 *     install.lock.<token>  one installer at a time, across processes (`InstallLock`)
 *     active.json           the store's: which version runs
 *     versions/<digest16>/  the store's: the receipt (its marker), and `payload/` with the agent's files
 *
 * The versions are a `ManagedRuntimeStore`: it activates, leases and prunes
 * them, and removes the folder. `<digest16>` is the first sixteen hex digits
 * of the recipe digest.
 *
 * Everything that writes here holds the agent's lock: a semaphore in this
 * installer, then `install.lock`.
 *
 * @module provider/acpRegistry/AcpRegistryInstaller
 */
import { createHash } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ArchiveError, extractArchive } from "../managedRuntime/ArchiveExtractor.ts";
import { makeHttpsFetch } from "../managedRuntime/HttpsFetch.ts";
import {
  type ManagedNode,
  type ManagedNodePaths,
  type ManagedNodePlatformRelease,
  makeManagedNode,
  managedNodeReleaseFor,
} from "../managedRuntime/ManagedNode.ts";
import {
  abortable,
  MANAGED_RELEASE_ID_PATTERN,
  managedFsTry,
  type ManagedInstallProgress,
  managedIoError,
  type ManagedRuntimeError,
  managedRuntimeError,
  type ManagedStaging,
  type ManagedVersion,
  makeManagedRuntimeStore,
} from "../managedRuntime/ManagedRuntimeStore.ts";
import type { DownloadFetch } from "../managedRuntime/VerifiedDownload.ts";
import {
  type AcpRegistryDownloadRecipe,
  type AcpRegistryNpmRecipe,
  AcpRegistryRecipe,
  acpRegistryRecipeDigest,
} from "./AcpRegistryRecipe.ts";
import {
  AcpRegistryNodeRelease,
  AcpRegistryTrustDamagedError,
  type AcpRegistryTrustedRecipe,
  deleteTrustLeftovers,
  readTrust,
  writeTrust,
} from "./AcpRegistryTrust.ts";
import { downloadCapped } from "./CappedDownload.ts";
import {
  deleteInstallLockLeftovers,
  holdsInstallLock,
  releaseInstallLock,
  tryAcquireInstallLock,
} from "./InstallLock.ts";
import {
  findNpmBin,
  isExactNpmVersion,
  isNpmPackageName,
  managedNodeEnvironment,
  type NodeRunResult,
  nodeSatisfiesRange,
  runNode,
} from "./NpmPackage.ts";

/** What a version's marker records: what was installed, from which recipe, and how it was checked. */
export interface AcpRegistryReceipt {
  readonly recipe: AcpRegistryRecipe;
  readonly recipeDigest: string;
  /** The program to launch. Paths are relative to `payload/` and `/`-separated. */
  readonly program: {
    /**
     * `direct`: the file is the program. `node`: the file is a script the
     * managed Node.js runs. `cmdShim`: Windows, a program npm wrapped in a
     * `.cmd`, which only starts through the shell.
     */
    readonly kind: "direct" | "node" | "cmdShim";
    readonly path: string;
    /** `cmdShim`: npm's `.cmd` for the program. */
    readonly shim: string | null;
  };
  /** Downloads: sha256 of the archive that was unpacked. */
  readonly archiveSha256: string | null;
  /** npm: sha256 over the `package.json` and `package-lock.json` it was installed from. */
  readonly manifestSha256: string | null;
  /** How the installed copy was verified. */
  readonly verification: "publisher" | "firstInstall" | "packageRegistry";
  /** npm agents: the managed Node.js it was installed with and must run with. */
  readonly node: AcpRegistryNodeRelease | null;
  /** ISO time. */
  readonly installedAt: string;
}

/** A complete installed version, with absolute paths. */
export interface AcpRegistryInstalledAgent {
  readonly receipt: AcpRegistryReceipt;
  /** The version's payload folder. */
  readonly payloadDir: string;
  /**
   * How to start it, with no shell: `program`, then `prefixArgs`, then the
   * recipe's own `args`. A JavaScript program: the managed node and the
   * script. A native program: itself. With `needsShell` (a Windows `.cmd`),
   * the caller decides whether its arguments are safe for one.
   */
  readonly launch: {
    readonly program: string;
    readonly prefixArgs: ReadonlyArray<string>;
    readonly needsShell: boolean;
  };
  /** npm agents: the managed Node.js, whose `binDir` goes first on the agent's `PATH`. */
  readonly node: ManagedNodePaths | null;
}

export type AcpRegistryInstallProgress =
  | ManagedInstallProgress
  /** npm is running; `line` is a line it printed. */
  | { readonly phase: "installing"; readonly line?: string };

export interface AcpRegistryInstaller {
  /** The active version, if it is complete on disk (for an npm agent, with its Node.js). Never fails. */
  readonly installed: Effect.Effect<AcpRegistryInstalledAgent | undefined>;
  /** The recipes the user has confirmed, newest last, or none. Never fails. */
  readonly confirmed: Effect.Effect<
    ReadonlyArray<{
      readonly recipeDigest: string;
      readonly recipe: AcpRegistryRecipe;
      readonly confirmedAt: string;
    }>
  >;
  /**
   * Records that the user confirmed this recipe, as the newest one. Confirming
   * the newest again changes nothing. Must happen before `install` of it.
   */
  readonly confirm: (recipe: AcpRegistryRecipe) => Effect.Effect<void, ManagedRuntimeError>;
  /**
   * Installs and activates a confirmed recipe, by digest, then prunes. A
   * complete copy already on disk is reused. Fails with `validate` when the
   * digest was never confirmed. Interruptible until the final activation;
   * interrupted or failed, it leaves no files of the version behind.
   */
  readonly install: (
    recipeDigest: string,
    onProgress?: (progress: AcpRegistryInstallProgress) => void,
  ) => Effect.Effect<AcpRegistryInstalledAgent, ManagedRuntimeError>;
  /** Leases the active version, and its Node.js release, until the scope closes. */
  readonly acquire: Effect.Effect<AcpRegistryInstalledAgent, ManagedRuntimeError, Scope.Scope>;
  /** Deletes versions nobody leases, and leftovers. Best effort; skipped while an install runs. */
  readonly prune: Effect.Effect<void>;
  /** Deletes the agent's files and its trust record. Refuses while anything leases them. */
  readonly remove: Effect.Effect<void, ManagedRuntimeError>;
}

export interface AcpRegistryInstallerOptions {
  readonly agentId: string;
  /** The agent's display name, for messages. */
  readonly label: string;
  /** `<stateDir>/tools/acp`. */
  readonly toolsDir: string;
  /** `<stateDir>/tools/node`: where managed Node.js releases live. */
  readonly nodeToolsDir: string;
  /** The system whose naming and launch rules apply. Default: this one. */
  readonly platform?: NodeJS.Platform;
  /** Default: this computer's. */
  readonly arch?: string;
  /**
   * For the agent's download and for Node.js. Default: `makeHttpsFetch`, held
   * to the public internet for the agent's download.
   */
  readonly fetch?: DownloadFetch;
  /**
   * Test seam: the Node.js release new npm installs use; null for a computer
   * with none. Default: `managedNodeReleaseFor(platform, arch)`.
   */
  readonly nodeRelease?: ManagedNodePlatformRelease | null;
  /** Test seam: the manager of one Node.js release. Default: `makeManagedNode` under `nodeToolsDir`. */
  readonly makeNode?: (release: ManagedNodePlatformRelease) => ManagedNode;
  /** Test seam: the environment npm starts from. Default: the server's. */
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam: limits small enough to reach in a test. */
  readonly limits?: {
    /** Default 1 GiB. */
    readonly maxDownloadBytes?: number;
    /** Default 20 minutes. */
    readonly downloadTimeoutMs?: number;
    /** How long another process's install is waited for. Default 10 seconds. */
    readonly lockWaitMs?: number;
  };
}

/**
 * The agent's files inside a version folder. npm names a lockfile's root
 * after the folder it installs into, so this name is part of what a later
 * `npm ci` is held to.
 */
const PAYLOAD_DIR = "payload";
const ARCHIVE_FILE = "a";
const MAX_DOWNLOAD_BYTES = 1024 ** 3;
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000;
const NPM_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const NPM_VIEW_TIMEOUT_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 100;
/** Download progress is reported this often when the server declares no size. */
const PROGRESS_STEP_BYTES = 256 * 1024;
const MAX_LABEL_LENGTH = 80;
const MAX_RANGE_LENGTH = 80;
const RECIPE_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
/**
 * How many confirmed recipes the trust record keeps, besides the one that
 * is installed. An npm entry holds a whole lockfile, and every update adds
 * one. A recipe that falls off the end is unconfirmed again.
 */
const MAX_TRUSTED_RECIPES = 8;
/** A bin name that is safe inside a command line a shell reads. */
const SHIM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Settings that decide what an npm install produces, pinned whatever the
 * user's npm configuration says. The rest of that configuration (registry,
 * sign-in, proxy, certificates) stays in effect.
 * - `global`, `package-lock`: a local tree with a lockfile.
 * - `ignore-scripts`: install scripts run; some agents fetch their program in one.
 * - `bin-links`, `install-strategy`: the package and its `.bin` entry are where they are looked for.
 * - `include`, `legacy-peer-deps`, `strict-peer-deps`, `force`, `dry-run`:
 *   the whole tree the lockfile names is installed. A reinstall is held to
 *   the first install's lockfile, and npm leaves out of the tree, without
 *   complaint, what these tell it to (`omit=optional` in a user's
 *   configuration, say).
 * - `update-notifier`: npm's last lines are about this install.
 */
const NPM_PINNED_FLAGS = [
  "--global=false",
  "--package-lock=true",
  "--no-audit",
  "--no-fund",
  "--ignore-scripts=false",
  "--bin-links=true",
  "--install-strategy=hoisted",
  "--include=optional",
  "--include=peer",
  "--legacy-peer-deps=false",
  "--strict-peer-deps=false",
  "--force=false",
  "--dry-run=false",
  "--no-update-notifier",
] as const;

const ReceiptMarker = Schema.Struct({
  releaseId: Schema.String.check(Schema.isPattern(MANAGED_RELEASE_ID_PATTERN)),
  version: Schema.String,
  recipe: AcpRegistryRecipe,
  recipeDigest: Schema.String,
  program: Schema.Struct({
    kind: Schema.Literals(["direct", "node", "cmdShim"]),
    path: Schema.String,
    shim: Schema.NullOr(Schema.String),
  }),
  archiveSha256: Schema.NullOr(Schema.String),
  manifestSha256: Schema.NullOr(Schema.String),
  verification: Schema.Literals(["publisher", "firstInstall", "packageRegistry"]),
  node: Schema.NullOr(AcpRegistryNodeRelease),
  installedAt: Schema.String,
});
type ReceiptMarker = typeof ReceiptMarker.Type;
const ReceiptMarkerJson = Schema.fromJsonString(ReceiptMarker);
const decodeReceiptMarker = Schema.decodeUnknownOption(ReceiptMarkerJson);
const encodeReceiptMarker = Schema.encodeSync(ReceiptMarkerJson);

const NpmViewOutput = Schema.Struct({ engines: Schema.optional(Schema.Unknown) });
const decodeNpmViewOutput = Schema.decodeUnknownOption(Schema.fromJsonString(NpmViewOutput));

/** An agent's folder under `<stateDir>/tools/acp`. */
export const acpRegistryAgentRoot = (toolsDir: string, agentId: string) =>
  NodePath.join(toolsDir, createHash("sha256").update(agentId).digest("hex").slice(0, 16));

/** Text from a registry or a package, fit for a message: one line, bounded. */
function boundedText(text: string, maxLength: number): string {
  const plain = Array.from(text, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : character;
  }).join("");
  return plain.trim().slice(0, maxLength);
}

/** A `/`-separated path that stays inside the folder it is joined to. */
function staysInside(path: string): boolean {
  if (path === "" || path.length > 1024 || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  return (
    !/^[A-Za-z]:/u.test(path) &&
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

const inPayload = (payloadDir: string, relative: string) =>
  NodePath.join(payloadDir, ...relative.split("/"));

/** Why a recipe can't be installed as written, for logs; undefined when it can. */
function recipeProblem(recipe: AcpRegistryRecipe, agentId: string): string | undefined {
  if (recipe.agentId !== agentId) return "the recipe is for another agent";
  if (recipe.kind === "npm") {
    if (!isNpmPackageName(recipe.packageName)) return "the package name is not a package name";
    if (!isExactNpmVersion(recipe.packageVersion)) return "the package version is not one version";
    return undefined;
  }
  const url = URL.canParse(recipe.url) ? new URL(recipe.url) : undefined;
  if (url?.protocol !== "https:" || url.username !== "" || url.password !== "") {
    return "the download address is not a plain https address";
  }
  if (recipe.sha256 !== null && !/^[0-9a-fA-F]{64}$/u.test(recipe.sha256)) {
    return "the checksum is not a sha256";
  }
  if (!staysInside(recipe.cmd) || (recipe.format === "raw" && recipe.cmd.includes("/"))) {
    return "the program path is not a path inside the agent's folder";
  }
  return undefined;
}

const manifestDigest = (packageJson: string, packageLock: string) =>
  createHash("sha256")
    .update(JSON.stringify([packageJson, packageLock]))
    .digest("hex");

async function lstatIfExists(path: string) {
  try {
    return await NodeFS.lstat(path);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause) {
      if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return undefined;
    }
    throw cause;
  }
}

async function readFileIfExists(path: string): Promise<string | undefined> {
  return (await lstatIfExists(path))?.isFile() ? NodeFS.readFile(path, "utf8") : undefined;
}

/** The program a receipt names is there, as a regular file (and its `.cmd`, when it has one). */
async function programIntact(versionDir: string, marker: ReceiptMarker): Promise<boolean> {
  const payloadDir = NodePath.join(versionDir, PAYLOAD_DIR);
  const paths = [
    marker.program.path,
    ...(marker.program.shim === null ? [] : [marker.program.shim]),
  ];
  for (const path of paths) {
    if (!(await lstatIfExists(inPayload(payloadDir, path)))?.isFile()) return false;
  }
  return true;
}

/** Windows starts these through its shell and nothing else. */
const WINDOWS_BATCH_FILE = /\.(?:cmd|bat)$/iu;

function installedAgentOf(
  version: ManagedVersion<ReceiptMarker>,
  node: ManagedNodePaths | null,
  platform: NodeJS.Platform,
): AcpRegistryInstalledAgent {
  const { releaseId: _releaseId, version: _version, ...receipt } = version.marker;
  const payloadDir = NodePath.join(version.dir, PAYLOAD_DIR);
  const program = inPayload(payloadDir, receipt.program.path);
  const launch =
    receipt.program.kind === "node" && node
      ? { program: node.node, prefixArgs: [program], needsShell: false }
      : receipt.program.kind === "cmdShim" && receipt.program.shim !== null
        ? { program: inPayload(payloadDir, receipt.program.shim), prefixArgs: [], needsShell: true }
        : {
            program,
            prefixArgs: [],
            // A download whose program is a batch file.
            needsShell: platform === "win32" && WINDOWS_BATCH_FILE.test(program),
          };
  return { receipt, payloadDir, launch, node };
}

/** Builds the installer for one agent. Cheap; holds no resources. */
export function makeAcpRegistryInstaller(
  options: AcpRegistryInstallerOptions,
): AcpRegistryInstaller {
  const { agentId } = options;
  const label = boundedText(options.label, MAX_LABEL_LENGTH) || "This agent";
  const platform = options.platform ?? process.platform;
  const root = acpRegistryAgentRoot(options.toolsDir, agentId);
  const maxDownloadBytes = options.limits?.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  const downloadTimeoutMs = options.limits?.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const lockWaitMs = options.limits?.lockWaitMs ?? LOCK_WAIT_MS;
  // One install, confirm, prune or remove at a time in this installer.
  const operationLock = Semaphore.makeUnsafe(1);
  // The address comes from a list Threadlines doesn't write: the download
  // may only reach the public internet, on every redirect hop.
  let defaultFetch: DownloadFetch | undefined;
  const fetchDownload: DownloadFetch = (url, init) =>
    (options.fetch ?? (defaultFetch ??= makeHttpsFetch({ publicAddressesOnly: true })))(url, init);

  const MESSAGES = {
    busy: `${label} is being installed by another Threadlines window. Try again in a moment.`,
    unconfirmed: `This version of ${label} hasn't been confirmed, so nothing was installed.`,
    invalidRecipe: `The registry's entry for ${label} isn't one Threadlines can install.`,
    changed: `The ${label} download changed since you installed it, so nothing was installed.`,
    publisherMismatch: `The ${label} download didn't match its publisher's checksum, so nothing was installed.`,
    archive: `The ${label} download wasn't in the expected format, so nothing was installed.`,
    noProgram: `The ${label} download doesn't hold the program its registry entry names, so nothing was installed.`,
    downloadTooSlow: `The ${label} download took too long, so it was stopped. Try again.`,
    churn: `${label}'s files changed while Threadlines was installing them. Try again.`,
    damaged: `${label}'s files changed since they were installed. Remove ${label} and add it again.`,
    trustDamaged: `Threadlines' record of what was installed for ${label} is damaged. Remove ${label} and add it again.`,
    noNode: `${label} needs Node.js, and there is no Node.js that Threadlines can install on this computer.`,
    nodeMissing: `${label}'s copy of Node.js is missing. Install ${label} again.`,
    npmStart: `Couldn't start npm to install ${label}.`,
    npmLookup: `Couldn't look up ${label} on the npm registry. Check your internet connection and try again.`,
    npmFailed: `npm couldn't install ${label}, so nothing was installed.`,
    npmTooSlow: `Installing ${label} with npm took too long, so it was stopped. Try again.`,
    noBin: `${label}'s package doesn't say which program to run, so it can't be used here.`,
    noBinFile: `${label}'s package names a program that isn't in it, so it can't be used here.`,
  } as const;

  const fsTry = <A>(action: string, run: () => Promise<A>) => managedFsTry(label, action, run);
  /**
   * A short write into staging. It finishes even when the install is
   * interrupted, so it isn't still writing when the store deletes staging.
   */
  const fsStep = <A>(action: string, run: () => Promise<A>) =>
    fsTry(action, run).pipe(Effect.uninterruptible);

  /** A marker that describes its own folder and this agent, or undefined. */
  const decodeMarker = (raw: string): ReceiptMarker | undefined => {
    const marker = Option.getOrUndefined(decodeReceiptMarker(raw));
    if (!marker || marker.recipe.agentId !== agentId) return undefined;
    const { recipe, program } = marker;
    const consistent =
      acpRegistryRecipeDigest(recipe) === marker.recipeDigest &&
      marker.recipeDigest.slice(0, 16) === marker.releaseId &&
      staysInside(program.path) &&
      (program.shim === null || staysInside(program.shim)) &&
      (program.kind === "cmdShim") === (program.shim !== null) &&
      (recipe.kind === "npm"
        ? marker.node !== null && marker.manifestSha256 !== null
        : marker.node === null && marker.archiveSha256 !== null && program.kind === "direct");
    return consistent ? marker : undefined;
  };

  const store = makeManagedRuntimeStore<ReceiptMarker>({
    root,
    label,
    marker: { decode: decodeMarker, encode: encodeReceiptMarker },
    intact: programIntact,
  });

  const nodes = new Map<string, ManagedNode>();
  /** The manager of one Node.js release: the pinned one, or the one an installed agent names. */
  const nodeFor = (release: ManagedNodePlatformRelease): ManagedNode => {
    const key = `${release.version}/${release.assetKey}/${release.asset.sha256}`;
    const known = nodes.get(key);
    if (known) return known;
    const node = options.makeNode
      ? options.makeNode(release)
      : makeManagedNode({
          toolsDir: options.nodeToolsDir,
          release,
          platform,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
    nodes.set(key, node);
    return node;
  };
  const pinnedNodeRelease = () =>
    options.nodeRelease === undefined
      ? managedNodeReleaseFor(platform, options.arch ?? process.arch)
      : (options.nodeRelease ?? undefined);

  const installed: AcpRegistryInstaller["installed"] = Effect.gen(function* () {
    const version = yield* store.installed;
    if (!version) return undefined;
    if (version.marker.node === null) return installedAgentOf(version, null, platform);
    // Without its Node.js an npm agent can't start, so it isn't installed.
    const node = yield* nodeFor(version.marker.node).installed;
    return node ? installedAgentOf(version, node, platform) : undefined;
  });

  const acquire: AcpRegistryInstaller["acquire"] = Effect.gen(function* () {
    const version = yield* store.acquire;
    if (version.marker.node === null) return installedAgentOf(version, null, platform);
    const node = yield* nodeFor(version.marker.node).acquire.pipe(
      Effect.mapError((error) =>
        error.reason === "notInstalled"
          ? managedRuntimeError("notInstalled", MESSAGES.nodeMissing)
          : error,
      ),
    );
    return installedAgentOf(version, node, platform);
  });

  /**
   * Runs `body` holding `install.lock`. Waiting for the lock is
   * interruptible; taking it and giving it back are not.
   */
  const withInstallLock = <A, E>(
    mode: { readonly createFolder: boolean; readonly wait: boolean },
    body: (token: string) => Effect.Effect<A, E>,
  ): Effect.Effect<
    | { readonly held: true; readonly value: A }
    | { readonly held: false; readonly why: "busy" | "noFolder" },
    E | ManagedRuntimeError
  > =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const deadline = (yield* Clock.currentTimeMillis) + (mode.wait ? lockWaitMs : 0);
        for (;;) {
          if (mode.createFolder) {
            yield* fsTry(`create ${label}'s folder`, () => NodeFS.mkdir(root, { recursive: true }));
          }
          const attempt = yield* fsTry(`lock ${label}'s files`, () => tryAcquireInstallLock(root));
          if (attempt.outcome === "acquired") {
            return yield* restore(body(attempt.token)).pipe(
              Effect.map((value) => ({ held: true, value }) as const),
              Effect.ensuring(Effect.promise(() => releaseInstallLock(root, attempt.token))),
            );
          }
          if (attempt.outcome === "noFolder" && !mode.createFolder) {
            return { held: false, why: "noFolder" } as const;
          }
          if ((yield* Clock.currentTimeMillis) >= deadline) {
            return { held: false, why: "busy" } as const;
          }
          // Not in step with another process that is waiting too.
          yield* restore(
            Effect.sleep(Duration.millis(LOCK_POLL_MS + Math.floor(Math.random() * LOCK_POLL_MS))),
          );
        }
      }),
    );

  /** Fails rather than read a damaged record as an empty one: nothing is written over it. */
  const loadTrust = Effect.tryPromise({
    try: () => readTrust(root, agentId),
    catch: (cause) =>
      cause instanceof AcpRegistryTrustDamagedError
        ? managedRuntimeError("validate", MESSAGES.trustDamaged, { detail: cause.message, cause })
        : managedIoError(label, `read ${label}'s install record`, cause),
  });

  /** Replaces `trust.json`, after checking that `install.lock` is still this caller's. */
  const saveTrust = (token: string, recipes: ReadonlyArray<AcpRegistryTrustedRecipe>) =>
    Effect.gen(function* () {
      const held = yield* Effect.promise(() => holdsInstallLock(root, token).catch(() => false));
      if (!held) {
        return yield* managedRuntimeError("io", MESSAGES.churn, {
          detail: "install.lock was taken over while this install held it",
        });
      }
      yield* fsTry(`save ${label}'s install record`, () => writeTrust(root, agentId, recipes));
    }).pipe(Effect.uninterruptible);

  const confirmed: AcpRegistryInstaller["confirmed"] = Effect.promise(() =>
    readTrust(root, agentId).then(
      (recipes) =>
        recipes.map(({ recipeDigest, recipe, confirmedAt }) => ({
          recipeDigest,
          recipe,
          confirmedAt,
        })),
      () => [],
    ),
  );

  /**
   * What an earlier install of a recipe recorded, for a recipe the trust
   * record doesn't list (the record was lost). A version on disk is such an
   * install: its receipt becomes the first install again, so the next one
   * is held to it. A version whose receipt can't say what it was is not
   * taken for "never installed".
   */
  const firstInstallOnDisk = (recipeDigest: string) =>
    Effect.gen(function* () {
      const none = { archiveSha256: null, npm: null } as const;
      const receipt = yield* store.describe(recipeDigest.slice(0, 16));
      if (receipt === undefined) return none;
      if (receipt === "unreadable" || receipt.recipeDigest !== recipeDigest) {
        return yield* managedRuntimeError("validate", MESSAGES.damaged, {
          detail: `versions/${recipeDigest.slice(0, 16)} is there without a receipt for this recipe`,
        });
      }
      if (receipt.node === null) return { archiveSha256: receipt.archiveSha256, npm: null };
      const payloadDir = NodePath.join(root, "versions", receipt.releaseId, PAYLOAD_DIR);
      const [packageJson, packageLock] = yield* fsTry(`read ${label}'s files`, () =>
        Promise.all([
          readFileIfExists(NodePath.join(payloadDir, "package.json")),
          readFileIfExists(NodePath.join(payloadDir, "package-lock.json")),
        ]),
      );
      if (
        packageJson === undefined ||
        packageLock === undefined ||
        manifestDigest(packageJson, packageLock) !== receipt.manifestSha256
      ) {
        return yield* managedRuntimeError("validate", MESSAGES.damaged, {
          detail: "package.json or package-lock.json is not what was installed",
        });
      }
      return { archiveSha256: null, npm: { packageJson, packageLock, node: receipt.node } };
    });

  const confirm: AcpRegistryInstaller["confirm"] = (recipe) => {
    const problem = recipeProblem(recipe, agentId);
    if (problem) {
      return Effect.fail(
        managedRuntimeError("validate", MESSAGES.invalidRecipe, { detail: problem }),
      );
    }
    const recipeDigest = acpRegistryRecipeDigest(recipe);
    return operationLock.withPermit(
      withInstallLock({ createFolder: true, wait: true }, (token) =>
        Effect.gen(function* () {
          const recipes = yield* loadTrust;
          if (recipes.at(-1)?.recipeDigest === recipeDigest) return;
          const confirmedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          // A recipe confirmed before keeps what its first install recorded.
          const known = recipes.find((entry) => entry.recipeDigest === recipeDigest);
          const next = [
            ...recipes.filter((entry) => entry !== known),
            known
              ? { ...known, confirmedAt }
              : { recipeDigest, recipe, confirmedAt, ...(yield* firstInstallOnDisk(recipeDigest)) },
          ];
          const active = (yield* store.installed)?.marker.recipeDigest;
          yield* saveTrust(
            token,
            next.filter(
              (entry, index) =>
                index >= next.length - MAX_TRUSTED_RECIPES || entry.recipeDigest === active,
            ),
          );
        }),
      ).pipe(
        Effect.flatMap((result) =>
          result.held ? Effect.void : Effect.fail(managedRuntimeError("io", MESSAGES.busy)),
        ),
      ),
    );
  };

  /**
   * The store's check before a version is activated, the staged copy or one
   * already on disk: its program is there, and it is what the trust record
   * says the first install of its recipe was. With no first install on
   * record, this is it, and it is recorded.
   */
  const validateVersion =
    (token: string, recipeDigest: string) => (version: ManagedVersion<ReceiptMarker>) =>
      Effect.gen(function* () {
        const { marker } = version;
        if (marker.recipeDigest !== recipeDigest) {
          return yield* managedRuntimeError("io", MESSAGES.churn, {
            detail: `versions/${version.releaseId} holds recipe ${marker.recipeDigest}`,
          });
        }
        const intact = yield* Effect.promise(() =>
          programIntact(version.dir, marker).catch(() => false),
        );
        if (!intact) {
          return yield* managedRuntimeError("validate", MESSAGES.damaged, {
            detail: `${marker.program.path} is not a regular file`,
          });
        }
        const recipes = yield* loadTrust;
        const record = recipes.find((entry) => entry.recipeDigest === recipeDigest);
        if (!record) return yield* managedRuntimeError("validate", MESSAGES.unconfirmed);
        const recordFirstInstall = (first: Partial<AcpRegistryTrustedRecipe>) =>
          saveTrust(
            token,
            recipes.map((entry) => (entry === record ? { ...record, ...first } : entry)),
          );

        // A download: held to the archive's hash.
        if (marker.node === null) {
          if (record.archiveSha256 === null) {
            return yield* recordFirstInstall({ archiveSha256: marker.archiveSha256 });
          }
          if (record.archiveSha256 !== marker.archiveSha256) {
            return yield* managedRuntimeError("checksum", MESSAGES.changed, {
              detail: `first installed from an archive with sha256 ${record.archiveSha256}, this one has ${marker.archiveSha256}`,
            });
          }
          return;
        }
        // An npm package: held to the manifest and lockfile it was installed from.
        if (record.npm !== null) {
          const first = manifestDigest(record.npm.packageJson, record.npm.packageLock);
          if (first !== marker.manifestSha256) {
            return yield* managedRuntimeError("checksum", MESSAGES.changed, {
              detail: "the installed package-lock.json is not the first install's",
            });
          }
          return;
        }
        // The receipt's hash, not the files alone, says what was installed:
        // an agent may have rewritten the files next to it since.
        const payloadDir = NodePath.join(version.dir, PAYLOAD_DIR);
        const [packageJson, packageLock] = yield* fsTry(`read ${label}'s files`, () =>
          Promise.all([
            readFileIfExists(NodePath.join(payloadDir, "package.json")),
            readFileIfExists(NodePath.join(payloadDir, "package-lock.json")),
          ]),
        );
        if (
          packageJson === undefined ||
          packageLock === undefined ||
          manifestDigest(packageJson, packageLock) !== marker.manifestSha256
        ) {
          return yield* managedRuntimeError("validate", MESSAGES.damaged, {
            detail: "package.json or package-lock.json is not what was installed",
          });
        }
        yield* recordFirstInstall({ npm: { packageJson, packageLock, node: marker.node } });
      });

  /** Downloads the recipe's file into staging, checks it and unpacks it into `payload/`. */
  const buildDownload =
    (
      recipe: AcpRegistryDownloadRecipe,
      record: AcpRegistryTrustedRecipe,
      report: (progress: AcpRegistryInstallProgress) => void,
    ) =>
    (staging: ManagedStaging) =>
      Effect.gen(function* () {
        const payloadDir = NodePath.join(staging.unpackDir, PAYLOAD_DIR);
        const archivePath = NodePath.join(staging.dir, ARCHIVE_FILE);
        const programPath = inPayload(payloadDir, recipe.cmd);
        yield* fsStep(`create ${label}'s folder`, () => NodeFS.mkdir(payloadDir));

        report({ phase: "downloading", receivedBytes: 0 });
        let reported = 0;
        const download = yield* abortable(
          (signal) =>
            downloadCapped({
              fetch: fetchDownload,
              label,
              url: recipe.url,
              maxBytes: maxDownloadBytes,
              destination: archivePath,
              signal,
              onReceived: (receivedBytes, totalBytes) => {
                const step =
                  totalBytes === undefined
                    ? PROGRESS_STEP_BYTES
                    : Math.max(1, Math.floor(totalBytes / 100));
                if (reported !== 0 && receivedBytes - reported < step) return;
                reported = receivedBytes;
                report({
                  phase: "downloading",
                  receivedBytes,
                  ...(totalBytes === undefined ? {} : { totalBytes }),
                });
              },
            }),
          (cause) => managedIoError(label, `save the ${label} download`, cause),
        ).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(downloadTimeoutMs),
            orElse: () => Effect.fail(managedRuntimeError("download", MESSAGES.downloadTooSlow)),
          }),
        );
        report({ phase: "downloading", receivedBytes: download.bytes, totalBytes: download.bytes });

        if (record.archiveSha256 !== null && record.archiveSha256 !== download.sha256) {
          return yield* managedRuntimeError("checksum", MESSAGES.changed, {
            detail: `first installed from an archive with sha256 ${record.archiveSha256}, this download has ${download.sha256}`,
          });
        }
        if (recipe.sha256 !== null && recipe.sha256.toLowerCase() !== download.sha256) {
          return yield* managedRuntimeError("checksum", MESSAGES.publisherMismatch, {
            detail: `the publisher lists sha256 ${recipe.sha256}, this download has ${download.sha256}`,
          });
        }

        if (recipe.format === "raw") {
          yield* fsStep(`save ${label}'s files`, () => NodeFS.rename(archivePath, programPath));
        } else {
          const kind = recipe.format;
          report({ phase: "extracting" });
          yield* abortable(
            (signal) => extractArchive({ archivePath, kind, outDir: payloadDir, platform, signal }),
            (cause) =>
              cause instanceof ArchiveError
                ? managedRuntimeError("archive", MESSAGES.archive, { detail: cause.message, cause })
                : managedIoError(label, `save ${label}'s files`, cause),
          );
          yield* fsStep(`save ${label}'s files`, () => NodeFS.rm(archivePath, { force: true }));
        }

        // A regular file inside `payload/`: not a link, and not reached through one that leaves it.
        const isProgram = yield* fsTry(`read ${label}'s files`, async () => {
          if (!(await lstatIfExists(programPath))?.isFile()) return false;
          const [realPayloadDir, realProgram] = await Promise.all([
            NodeFS.realpath(payloadDir),
            NodeFS.realpath(programPath),
          ]);
          return realProgram.startsWith(`${realPayloadDir}${NodePath.sep}`);
        });
        if (!isProgram) {
          return yield* managedRuntimeError("archive", MESSAGES.noProgram, {
            detail: `${recipe.cmd} is not a regular file in the download`,
          });
        }
        if (platform !== "win32") {
          yield* fsStep(`save ${label}'s files`, () => NodeFS.chmod(programPath, 0o755));
        }
        const marker: ReceiptMarker = {
          releaseId: record.recipeDigest.slice(0, 16),
          version: recipe.version,
          recipe,
          recipeDigest: record.recipeDigest,
          program: { kind: "direct", path: recipe.cmd, shim: null },
          archiveSha256: download.sha256,
          manifestSha256: null,
          verification: recipe.sha256 === null ? "firstInstall" : "publisher",
          node: null,
          installedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        };
        return marker;
      });

  const runNpm = (
    node: ManagedNodePaths,
    cwd: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
    onLine?: (line: string) => void,
  ) =>
    abortable(
      (signal) =>
        runNode({
          node: node.node,
          // npm's entry script, never `npm` or `npm.cmd`: nothing goes through a shell.
          args: [node.npmCli, ...args],
          cwd,
          env: managedNodeEnvironment(options.env ?? process.env, node.binDir, platform),
          signal,
          timeoutMs,
          ...(onLine ? { onLine } : {}),
        }),
      (cause) =>
        managedRuntimeError("io", MESSAGES.npmStart, {
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    );

  const npmFailure = (result: NodeRunResult) =>
    managedRuntimeError("download", result.timedOut ? MESSAGES.npmTooSlow : MESSAGES.npmFailed, {
      detail: result.tail || `npm exited with code ${result.exitCode}`,
    });

  /** Refuses a package whose `engines.node` leaves out the managed Node.js, before any of its code runs. */
  const checkEngines = (node: ManagedNodePaths, cwd: string, spec: string) =>
    Effect.gen(function* () {
      // `name` and `version` are always there: with a single field npm prints its bare value.
      const view = yield* runNpm(
        node,
        cwd,
        ["view", spec, "name", "version", "engines", "--json", "--no-update-notifier"],
        NPM_VIEW_TIMEOUT_MS,
      );
      const output =
        view.exitCode === 0 ? Option.getOrUndefined(decodeNpmViewOutput(view.stdout)) : undefined;
      if (!output) {
        return yield* managedRuntimeError("download", MESSAGES.npmLookup, {
          detail: view.tail || `npm view exited with code ${view.exitCode}`,
        });
      }
      const { engines } = output;
      const range =
        typeof engines === "object" &&
        engines !== null &&
        "node" in engines &&
        typeof engines.node === "string"
          ? engines.node
          : undefined;
      if (range === undefined) return;
      const fits = nodeSatisfiesRange(node.version, range);
      if (fits === undefined) {
        yield* Effect.logWarning("Couldn't read a community agent's Node.js range; installing", {
          agentId,
          range: boundedText(range, MAX_RANGE_LENGTH),
        });
        return;
      }
      if (!fits) {
        return yield* managedRuntimeError(
          "unsupportedPlatform",
          `${label} needs Node.js ${boundedText(range, MAX_RANGE_LENGTH)}, and Threadlines installs ${node.version}.`,
        );
      }
    });

  /** The package's program and how it starts on this system. */
  const npmProgram = (payloadDir: string, recipe: AcpRegistryNpmRecipe) =>
    Effect.gen(function* () {
      const found = yield* fsTry(`read ${label}'s files`, () =>
        findNpmBin({ prefix: payloadDir, packageName: recipe.packageName, agentId }),
      );
      if ("problem" in found) {
        return yield* managedRuntimeError(
          "validate",
          found.problem === "noBin" ? MESSAGES.noBin : MESSAGES.noBinFile,
          { detail: found.detail },
        );
      }
      const { bin } = found;
      if (bin.javascript) return { kind: "node", path: bin.path, shim: null } as const;
      if (platform !== "win32") {
        yield* fsStep(`save ${label}'s files`, () =>
          NodeFS.chmod(inPayload(payloadDir, bin.path), 0o755),
        );
        return { kind: "direct", path: bin.path, shim: null } as const;
      }
      // Windows can't start a script by its `#!` line: the `.cmd` npm wrote for the bin does.
      const shim = `node_modules/.bin/${bin.name}.cmd`;
      const shimIsFile =
        SHIM_NAME_PATTERN.test(bin.name) &&
        (yield* fsTry(`read ${label}'s files`, () =>
          lstatIfExists(inPayload(payloadDir, shim)),
        ))?.isFile() === true;
      if (!shimIsFile) {
        return yield* managedRuntimeError("validate", MESSAGES.noBinFile, {
          detail: `npm wrote no usable ${shim.slice(0, 300)}`,
        });
      }
      return { kind: "cmdShim", path: bin.path, shim } as const;
    });

  /**
   * Installs the package into `payload/` with the managed Node.js: `npm
   * install` the first time, `npm ci` from the first install's manifest and
   * lockfile after that, so the tree is the same one.
   */
  const buildNpm =
    (
      recipe: AcpRegistryNpmRecipe,
      record: AcpRegistryTrustedRecipe,
      node: ManagedNodePaths,
      nodeRelease: AcpRegistryNodeRelease,
      report: (progress: AcpRegistryInstallProgress) => void,
    ) =>
    (staging: ManagedStaging) =>
      Effect.gen(function* () {
        const payloadDir = NodePath.join(staging.unpackDir, PAYLOAD_DIR);
        const manifestPath = NodePath.join(payloadDir, "package.json");
        const lockPath = NodePath.join(payloadDir, "package-lock.json");
        const spec = `${recipe.packageName}@${recipe.packageVersion}`;
        const onLine = (line: string) => report({ phase: "installing", line });
        yield* fsStep(`create ${label}'s folder`, () => NodeFS.mkdir(payloadDir));
        // npm gets the folder's real path. Through a linked folder it takes
        // the install for a link and writes that folder's path into the
        // lockfile, which then fits no other folder.
        const prefix = yield* fsTry(`read ${label}'s files`, () => NodeFS.realpath(payloadDir));

        let manifest: { readonly packageJson: string; readonly packageLock: string };
        if (record.npm !== null) {
          const first = record.npm;
          report({ phase: "installing" });
          yield* fsStep(`save ${label}'s files`, async () => {
            await NodeFS.writeFile(manifestPath, first.packageJson, { flag: "wx" });
            await NodeFS.writeFile(lockPath, first.packageLock, { flag: "wx" });
          });
          const result = yield* runNpm(
            node,
            prefix,
            ["ci", "--prefix", prefix, ...NPM_PINNED_FLAGS],
            NPM_INSTALL_TIMEOUT_MS,
            onLine,
          );
          if (result.exitCode !== 0) return yield* npmFailure(result);
          manifest = first;
        } else {
          yield* checkEngines(node, prefix, spec);
          report({ phase: "installing" });
          const result = yield* runNpm(
            node,
            prefix,
            [
              "install",
              "--prefix",
              prefix,
              spec,
              "--save=true",
              "--save-exact",
              ...NPM_PINNED_FLAGS,
            ],
            NPM_INSTALL_TIMEOUT_MS,
            onLine,
          );
          if (result.exitCode !== 0) return yield* npmFailure(result);
          const [packageJson, packageLock] = yield* fsTry(`read ${label}'s files`, () =>
            Promise.all([readFileIfExists(manifestPath), readFileIfExists(lockPath)]),
          );
          if (packageJson === undefined || packageLock === undefined) {
            return yield* managedRuntimeError("download", MESSAGES.npmFailed, {
              detail: "npm finished without writing package.json and package-lock.json",
            });
          }
          manifest = { packageJson, packageLock };
        }

        const marker: ReceiptMarker = {
          releaseId: record.recipeDigest.slice(0, 16),
          version: recipe.version,
          recipe,
          recipeDigest: record.recipeDigest,
          program: yield* npmProgram(payloadDir, recipe),
          archiveSha256: null,
          manifestSha256: manifestDigest(manifest.packageJson, manifest.packageLock),
          verification: "packageRegistry",
          node: nodeRelease,
          installedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        };
        return marker;
      });

  const install: AcpRegistryInstaller["install"] = (recipeDigest, onProgress) => {
    const report = (progress: AcpRegistryInstallProgress) => {
      try {
        onProgress?.(progress);
      } catch {
        // Progress reporting never fails an install.
      }
    };
    const unconfirmed = managedRuntimeError("validate", MESSAGES.unconfirmed);
    const underLock = (token: string) =>
      Effect.gen(function* () {
        const record = RECIPE_DIGEST_PATTERN.test(recipeDigest)
          ? (yield* loadTrust).find((entry) => entry.recipeDigest === recipeDigest)
          : undefined;
        if (!record) return yield* unconfirmed;
        const { recipe } = record;
        const problem = recipeProblem(recipe, agentId);
        if (problem) {
          return yield* managedRuntimeError("validate", MESSAGES.invalidRecipe, {
            detail: problem,
          });
        }
        const versionInput = {
          releaseId: recipeDigest.slice(0, 16),
          version: recipe.version,
          // Sizes aren't known up front. The store still keeps its own margin
          // free, and the download checks the size the server declares.
          neededBytes: 0,
          validate: validateVersion(token, recipeDigest),
          onPhase: (phase: "validating" | "activating") => report({ phase }),
        };
        if (recipe.kind === "download") {
          yield* store.install({ ...versionInput, build: buildDownload(recipe, record, report) });
        } else {
          // A reinstall runs on the Node.js the first install used, even after the pin moved on.
          const release = record.npm?.node ?? pinnedNodeRelease();
          if (!release) return yield* managedRuntimeError("unsupportedPlatform", MESSAGES.noNode);
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* nodeFor(release).install(report);
              // Leased while npm runs on it, so nothing removes it meanwhile.
              const node = yield* nodeFor(release).acquire;
              const nodeRelease: AcpRegistryNodeRelease = {
                version: release.version,
                releaseId: node.releaseId,
                assetKey: release.assetKey,
                asset: release.asset,
              };
              yield* store.install({
                ...versionInput,
                build: buildNpm(recipe, record, node, nodeRelease, report),
              });
            }),
          );
        }
        const agent = yield* installed;
        if (agent?.receipt.recipeDigest !== recipeDigest) {
          return yield* managedRuntimeError("io", MESSAGES.churn, {
            detail: "the installed version was not there after the install",
          });
        }
        return agent;
      });
    return operationLock.withPermit(
      withInstallLock({ createFolder: false, wait: true }, underLock).pipe(
        Effect.flatMap((result) =>
          result.held
            ? Effect.succeed(result.value)
            : Effect.fail(
                // No folder: nothing was ever confirmed for this agent.
                result.why === "busy" ? managedRuntimeError("io", MESSAGES.busy) : unconfirmed,
              ),
        ),
      ),
    );
  };

  /** Files a writer left when it was cut off. Run holding the lock, so nobody is writing `trust.json`. */
  const deleteLeftovers = Effect.promise(() =>
    deleteTrustLeftovers(root).then(() => deleteInstallLockLeftovers(root)),
  );

  // Pruning and removing can't be interrupted: an interrupt would give the
  // lock back while their file work was still going on.
  const prune: AcpRegistryInstaller["prune"] = operationLock
    .withPermitsIfAvailable(1)(
      withInstallLock({ createFolder: false, wait: false }, () =>
        store.prune.pipe(Effect.andThen(deleteLeftovers), Effect.uninterruptible),
      ),
    )
    .pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning(`Couldn't prune versions of ${label}`, {
          root,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  // The store retires the whole folder, `trust.json` and `install.lock`
  // with it, and refuses while a version is leased. Nothing is deleted
  // after that: the folder is no longer locked, so anything in it is new.
  const remove: AcpRegistryInstaller["remove"] = operationLock.withPermit(
    withInstallLock({ createFolder: false, wait: true }, () =>
      store.remove.pipe(Effect.uninterruptible),
    ).pipe(
      Effect.flatMap((result) =>
        result.held
          ? Effect.void
          : result.why === "busy"
            ? Effect.fail(managedRuntimeError("io", MESSAGES.busy))
            : // No folder to remove; the store still clears what an earlier remove left.
              store.remove,
      ),
    ),
  );

  return { installed, confirmed, confirm, install, acquire, prune, remove };
}

// @effect-diagnostics nodeBuiltinImport:off - unpacks Node.js and runs it once to check it
/**
 * ManagedNode — Threadlines' own copy of Node.js, for agents that ship as
 * npm packages. They are installed and run with this Node and its npm,
 * whether or not the computer has a Node of its own: one known version
 * instead of whatever is on `PATH`, and no global install.
 *
 * The release is pinned below, one official build per platform, by size and
 * sha256. It lives in a `ManagedRuntimeStore` of its own under
 * `<stateDir>/tools/node/<version>-<platform>`, so a later pin installs
 * beside it and an agent keeps the Node it was installed with.
 *
 * @module provider/managedRuntime/ManagedNode
 */
import { execFile } from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { ArchiveError, extractArchive } from "./ArchiveExtractor.ts";
import { makeHttpsFetch } from "./HttpsFetch.ts";
import {
  abortable,
  MANAGED_RELEASE_ID_PATTERN,
  managedFsTry,
  type ManagedInstallProgress,
  managedIoError,
  type ManagedRuntimeError,
  managedRuntimeError,
  type ManagedVersion,
  makeManagedRuntimeStore,
  statIfExists,
} from "./ManagedRuntimeStore.ts";
import { type DownloadFetch, downloadVerified } from "./VerifiedDownload.ts";

export type ManagedNodeAssetKey =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win32-arm64"
  | "win32-x64";

export interface ManagedNodeAsset {
  readonly url: string;
  /** Lowercase hex sha256 of the archive. */
  readonly sha256: string;
  readonly archiveBytes: number;
  /** Size of the files once unpacked, for the free-space check. */
  readonly unpackedBytes: number;
  readonly kind: "tar.gz" | "zip";
}

export interface ManagedNodeRelease {
  /** Without the leading `v`. */
  readonly version: string;
  readonly assets: Readonly<Record<ManagedNodeAssetKey, ManagedNodeAsset>>;
}

/** One platform's pinned download, as `makeManagedNode` installs it. */
export interface ManagedNodePlatformRelease {
  readonly version: string;
  readonly assetKey: ManagedNodeAssetKey;
  readonly asset: ManagedNodeAsset;
}

const DIST_URL = "https://nodejs.org/dist";

/**
 * Node.js 24.21.0 (LTS). Sizes and hashes were taken from the published
 * archives and match the release's signed `SHASUMS256.txt`. Every npm agent
 * in the ACP registry accepts this line in its `engines`.
 */
export const MANAGED_NODE_RELEASE: ManagedNodeRelease = {
  version: "24.21.0",
  assets: {
    "darwin-arm64": {
      url: `${DIST_URL}/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz`,
      sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
      archiveBytes: 52_909_993,
      unpackedBytes: 196_895_972,
      kind: "tar.gz",
    },
    "darwin-x64": {
      url: `${DIST_URL}/v24.21.0/node-v24.21.0-darwin-x64.tar.gz`,
      sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
      archiveBytes: 54_203_979,
      unpackedBytes: 200_037_713,
      kind: "tar.gz",
    },
    "linux-arm64": {
      url: `${DIST_URL}/v24.21.0/node-v24.21.0-linux-arm64.tar.gz`,
      sha256: "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5",
      archiveBytes: 57_824_078,
      unpackedBytes: 197_660_444,
      kind: "tar.gz",
    },
    "linux-x64": {
      url: `${DIST_URL}/v24.21.0/node-v24.21.0-linux-x64.tar.gz`,
      sha256: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
      archiveBytes: 58_088_022,
      unpackedBytes: 201_362_264,
      kind: "tar.gz",
    },
    "win32-arm64": {
      url: `${DIST_URL}/v24.21.0/node-v24.21.0-win-arm64.zip`,
      sha256: "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
      archiveBytes: 33_679_608,
      unpackedBytes: 95_287_819,
      kind: "zip",
    },
    "win32-x64": {
      url: `${DIST_URL}/v24.21.0/node-v24.21.0-win-x64.zip`,
      sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
      archiveBytes: 37_618_919,
      unpackedBytes: 106_986_507,
      kind: "zip",
    },
  },
};

let cachedLinuxLibc: "glibc" | "musl" | undefined;

/**
 * The C library this Linux runs on. Node's official builds need glibc; on
 * musl (Alpine) they don't start. Says glibc when it can't tell: a wrong
 * guess then fails the install's own check, with its reason.
 */
export function linuxLibc(): "glibc" | "musl" {
  if (cachedLinuxLibc) return cachedLinuxLibc;
  let libc: "glibc" | "musl" = "glibc";
  try {
    // `excludeNetwork` is newer than the typings.
    const report = process.report as
      | (NodeJS.ProcessReport & { excludeNetwork: boolean | undefined })
      | undefined;
    if (report) {
      // The report lists network interfaces unless told not to, which is slow.
      const excludedNetwork = report.excludeNetwork;
      report.excludeNetwork = true;
      try {
        const header = (report.getReport() as { header?: { glibcVersionRuntime?: unknown } })
          .header;
        if (header && !header.glibcVersionRuntime) libc = "musl";
      } finally {
        report.excludeNetwork = excludedNetwork;
      }
    }
  } catch {
    // Can't tell.
  }
  cachedLinuxLibc = libc;
  return libc;
}

/** The pinned release for this machine, or undefined when Node publishes no build for it. */
export function managedNodeReleaseFor(
  platform: NodeJS.Platform,
  arch: string,
  libc: "glibc" | "musl" = platform === "linux" ? linuxLibc() : "glibc",
): ManagedNodePlatformRelease | undefined {
  if (arch !== "arm64" && arch !== "x64") return undefined;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return undefined;
  if (platform === "linux" && libc !== "glibc") return undefined;
  const assetKey: ManagedNodeAssetKey = `${platform}-${arch}`;
  return {
    version: MANAGED_NODE_RELEASE.version,
    assetKey,
    asset: MANAGED_NODE_RELEASE.assets[assetKey],
  };
}

/** Where a release's store lives under `<stateDir>/tools/node`. */
export const managedNodeRoot = (
  toolsDir: string,
  release: Pick<ManagedNodePlatformRelease, "version" | "assetKey">,
) => NodePath.join(toolsDir, `${release.version}-${release.assetKey}`);

export interface ManagedNodePaths {
  /** Without the leading `v`. */
  readonly version: string;
  /** Names the installed copy: sixteen hex digits of the archive's sha256. */
  readonly releaseId: string;
  readonly node: string;
  /**
   * npm's entry script, run as `node <npmCli> …`: never `npm.cmd`, so
   * nothing goes through a shell on Windows.
   */
  readonly npmCli: string;
  /**
   * The folder to put first on `PATH`, for installs and for agents: scripts
   * that call `node`, `npm` or `npx` then find this Node.
   */
  readonly binDir: string;
}

export interface ManagedNodeOptions {
  /** `<stateDir>/tools/node`. */
  readonly toolsDir: string;
  readonly release: ManagedNodePlatformRelease;
  /** Default: `makeHttpsFetch()`, which honours the environment's proxy. */
  readonly fetch?: DownloadFetch;
  /** Test seam: the system whose layout and naming rules apply. Default: this one. */
  readonly platform?: NodeJS.Platform;
}

export interface ManagedNode {
  /** The installed copy, if it is complete on disk. Never fails. */
  readonly installed: Effect.Effect<ManagedNodePaths | undefined>;
  /**
   * Downloads, unpacks, checks and activates the release. A complete copy
   * already on disk is checked again and reused. Interruptible until the
   * final activation.
   */
  readonly install: (
    onProgress?: (progress: ManagedInstallProgress) => void,
  ) => Effect.Effect<ManagedNodePaths, ManagedRuntimeError>;
  /** Leases the installed copy until the scope closes, so `remove` leaves it alone. */
  readonly acquire: Effect.Effect<ManagedNodePaths, ManagedRuntimeError, Scope.Scope>;
  /** Deletes leftovers of interrupted installs. Best effort. */
  readonly prune: Effect.Effect<void>;
  /** Deletes this release. Refuses while anything leases it. */
  readonly remove: Effect.Effect<void, ManagedRuntimeError>;
}

const LABEL = "Node.js";
const ARCHIVE_FILE = "a";
const VALIDATE_TIMEOUT_MS = 30_000;

const NodeMarker = Schema.Struct({
  releaseId: Schema.String.check(Schema.isPattern(MANAGED_RELEASE_ID_PATTERN)),
  version: Schema.String,
  /** Size of the `node` program, so a damaged copy isn't taken for installed. */
  nodeBytes: Schema.Int,
});
type NodeMarker = typeof NodeMarker.Type;
const NodeMarkerJson = Schema.fromJsonString(NodeMarker);
const decodeNodeMarker = Schema.decodeUnknownOption(NodeMarkerJson);
const encodeNodeMarker = Schema.encodeSync(NodeMarkerJson);

/** Where things are inside an official build, once its wrapping folder is dropped. */
const layoutFor = (platform: NodeJS.Platform) =>
  platform === "win32"
    ? { node: ["node.exe"], npmCli: ["node_modules", "npm", "bin", "npm-cli.js"], bin: [] }
    : {
        node: ["bin", "node"],
        npmCli: ["lib", "node_modules", "npm", "bin", "npm-cli.js"],
        bin: ["bin"],
      };

/** Runs a program to its end. Aborting kills it, and this settles only once it has exited. */
const runOnce = (
  program: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) =>
  new Promise<string>((resolve, reject) => {
    execFile(
      program,
      [...args],
      { env, signal, timeout: VALIDATE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim())),
    );
  });

/** Builds the manager for one pinned release. Cheap; holds no resources. */
export function makeManagedNode(options: ManagedNodeOptions): ManagedNode {
  const { release } = options;
  const { asset } = release;
  const platform = options.platform ?? process.platform;
  const fetchArchive = options.fetch ?? makeHttpsFetch();
  const releaseId = asset.sha256.slice(0, 16).toLowerCase();
  const layout = layoutFor(platform);

  const pathsIn = (dir: string): ManagedNodePaths => ({
    version: release.version,
    releaseId,
    node: NodePath.join(dir, ...layout.node),
    npmCli: NodePath.join(dir, ...layout.npmCli),
    binDir: NodePath.join(dir, ...layout.bin),
  });
  const pathsOf = (version: ManagedVersion<NodeMarker>) => pathsIn(version.dir);

  const store = makeManagedRuntimeStore<NodeMarker>({
    root: managedNodeRoot(options.toolsDir, release),
    label: LABEL,
    marker: {
      decode: (raw) => Option.getOrUndefined(decodeNodeMarker(raw)),
      encode: encodeNodeMarker,
    },
    intact: async (dir, marker) => {
      const paths = pathsIn(dir);
      const [node, npmCli] = await Promise.all([
        statIfExists(paths.node),
        statIfExists(paths.npmCli),
      ]);
      return node?.isFile() === true && node.size === marker.nodeBytes && npmCli?.isFile() === true;
    },
  });

  /**
   * Runs the unpacked Node and its npm once each. Both have exited when
   * this returns, interrupted or not: the folder they run from is about to
   * be moved or deleted.
   */
  const validate = (paths: ManagedNodePaths) =>
    abortable(
      async (signal) => {
        // The server's own Node flags are not this Node's.
        const { NODE_OPTIONS: _serverNodeOptions, ...inherited } = process.env;
        const env = {
          ...inherited,
          PATH: [paths.binDir, process.env.PATH ?? ""].join(NodePath.delimiter),
        };
        const reported = await runOnce(paths.node, ["--version"], env, signal);
        if (reported !== `v${release.version}`) {
          throw new Error(`node --version said "${reported}", expected v${release.version}`);
        }
        signal.throwIfAborted();
        await runOnce(paths.node, [paths.npmCli, "--version"], env, signal);
      },
      (cause) =>
        managedRuntimeError("validate", "Node.js was downloaded but didn't start correctly.", {
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    );

  const build =
    (report: (progress: ManagedInstallProgress) => void) =>
    (staging: { readonly dir: string; readonly unpackDir: string }) =>
      Effect.gen(function* () {
        const archivePath = NodePath.join(staging.dir, ARCHIVE_FILE);

        report({ phase: "downloading", receivedBytes: 0, totalBytes: asset.archiveBytes });
        let reportedPercent = 0;
        yield* abortable(
          (signal) =>
            downloadVerified({
              fetch: fetchArchive,
              label: LABEL,
              url: asset.url,
              sha256: asset.sha256,
              bytes: asset.archiveBytes,
              destination: archivePath,
              signal,
              onReceived: (receivedBytes) => {
                const percent = Math.floor((receivedBytes * 100) / asset.archiveBytes);
                if (percent === reportedPercent) return;
                reportedPercent = percent;
                report({ phase: "downloading", receivedBytes, totalBytes: asset.archiveBytes });
              },
            }),
          (cause) => managedIoError(LABEL, "save the Node.js download", cause),
        );

        report({ phase: "extracting" });
        yield* abortable(
          (signal) =>
            extractArchive({
              archivePath,
              kind: asset.kind,
              outDir: staging.unpackDir,
              // Official builds wrap everything in `node-v<version>-<platform>/`.
              stripComponents: 1,
              platform,
              signal,
            }),
          (cause) =>
            cause instanceof ArchiveError
              ? managedRuntimeError(
                  "archive",
                  "The Node.js download wasn't in the expected format, so nothing was installed.",
                  { detail: cause.message, cause },
                )
              : managedIoError(LABEL, "save Node.js's files", cause),
        );
        yield* managedFsTry(LABEL, "save Node.js's files", () =>
          NodeFS.rm(archivePath, { force: true }),
        );
        const node = yield* managedFsTry(LABEL, "save Node.js's files", () =>
          statIfExists(pathsIn(staging.unpackDir).node),
        );
        if (!node?.isFile()) {
          return yield* managedRuntimeError(
            "archive",
            "The Node.js download wasn't in the expected format, so nothing was installed.",
            { detail: "the archive holds no node program where one is expected" },
          );
        }
        return { releaseId, version: release.version, nodeBytes: node.size };
      });

  const installedPaths = store.installed.pipe(
    Effect.map((version) => (version ? pathsOf(version) : undefined)),
  );

  const install: ManagedNode["install"] = (onProgress) => {
    const report = (progress: ManagedInstallProgress) => {
      try {
        onProgress?.(progress);
      } catch {
        // Progress reporting never fails an install.
      }
    };
    return store
      .install({
        releaseId,
        version: release.version,
        neededBytes: asset.archiveBytes + asset.unpackedBytes,
        build: build(report),
        validate: (version) => validate(pathsOf(version)),
        onPhase: (phase) => report({ phase }),
      })
      .pipe(
        Effect.andThen(installedPaths),
        Effect.flatMap((paths) =>
          paths
            ? Effect.succeed(paths)
            : Effect.fail(
                managedRuntimeError(
                  "io",
                  "Node.js's files changed while Threadlines was installing them. Try again.",
                ),
              ),
        ),
      );
  };

  return {
    installed: installedPaths,
    install,
    acquire: store.acquire.pipe(Effect.map(pathsOf)),
    prune: store.prune,
    remove: store.remove,
  };
}

// @effect-diagnostics nodeBuiltinImport:off - a synchronous check for community agents' Node.js cleanup
/**
 * The two device tools (docs/design/devices.md): expo-device-hub streams and
 * takes input, agent-device is the command line agents drive devices with.
 *
 * Each is installed from npm at the version pinned in deviceToolVersions.json
 * into `<stateDir>/tools/device/<name>/<version>`: npm installs into a staging
 * folder beside it, the entry point is checked, a `.install-complete` marker
 * is written, and only then is the folder moved into place. Install scripts
 * run: the hub's native addons need them. npm and the tools run on
 * Threadlines' managed Node.js, never `npx` and never the server's own
 * runtime (which is Electron in the desktop app). Both tools load only N-API
 * addons, so a later Node.js release runs an earlier install.
 *
 * Nothing here installs on its own: the hub only after "Use devices", the
 * agent tool only after "Agents can use devices" (DeviceService decides).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { DeviceToolVersions } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { npmPinnedFlags } from "../provider/acpRegistry/AcpRegistryInstaller.ts";
import { acpRegistryNodes } from "../provider/acpRegistry/AcpRegistryNodes.ts";
import { managedNodeEnvironment, runNode } from "../provider/acpRegistry/NpmPackage.ts";
import {
  type ManagedNodePaths,
  managedNodeReleaseFor,
} from "../provider/managedRuntime/ManagedNode.ts";
import DEVICE_TOOL_VERSIONS from "./deviceToolVersions.json" with { type: "json" };

const DEVICE_HUB_PACKAGE = "expo-device-hub";
const AGENT_DEVICE_PACKAGE = "agent-device";
export const DEVICE_HUB_VERSION = DEVICE_TOOL_VERSIONS[DEVICE_HUB_PACKAGE];
export const AGENT_DEVICE_VERSION = DEVICE_TOOL_VERSIONS[AGENT_DEVICE_PACKAGE];

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/;
/** One install at a time in this process: two would race for the same staging parent. */
const installLock = Semaphore.makeUnsafe(1);

export type DeviceToolKey = "hub" | "agent";

interface ToolSpec {
  readonly key: DeviceToolKey;
  readonly name: string;
  readonly version: string;
  /** The entry point inside the package, run as `node <entry>`. */
  readonly entry: ReadonlyArray<string>;
}

const SPECS: Record<DeviceToolKey, ToolSpec> = {
  hub: {
    key: "hub",
    name: DEVICE_HUB_PACKAGE,
    version: DEVICE_HUB_VERSION,
    entry: ["dist", "server", "cli.mjs"],
  },
  agent: {
    key: "agent",
    name: AGENT_DEVICE_PACKAGE,
    version: AGENT_DEVICE_VERSION,
    entry: ["bin", "agent-device.mjs"],
  },
};

export interface DeviceToolPaths {
  readonly installDir: string;
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export class DeviceToolchainInstallError extends Schema.TaggedError<DeviceToolchainInstallError>()(
  "DeviceToolchainInstallError",
  {
    tool: Schema.String,
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    reason: Schema.optional(Schema.Literals(["no_node", "timed_out"])),
    /** npm's last lines. Kept in logs only: they can carry registry credentials. */
    tail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "no_node") {
      return "Device support needs Node.js, and Threadlines has no Node.js it can install on this computer.";
    }
    if (this.reason === "timed_out")
      return `Installing ${this.tool} took too long and was stopped.`;
    const suffix = this.exitCode === undefined ? "" : ` (exit code ${this.exitCode})`;
    return `Installing ${this.tool} failed while ${this.step}${suffix}.`;
  }
}

/** `<stateDir>/tools/device`. */
export const deviceToolsRoot = (path: Path.Path, stateDir: string) =>
  path.join(stateDir, "tools", "device");

/** `<stateDir>/device`: hub.json, claims.json, agent-device's state, launchers. */
export const deviceStateDir = (path: Path.Path, stateDir: string) => path.join(stateDir, "device");

/** agent-device's own state folder, isolated from the user's `~/.agent-device`. */
export const agentDeviceStateDir = (path: Path.Path, stateDir: string): string =>
  path.join(deviceStateDir(path, stateDir), "agent-device");

const toolPaths = (path: Path.Path, stateDir: string, spec: ToolSpec): DeviceToolPaths => {
  const installDir = path.join(deviceToolsRoot(path, stateDir), spec.name, spec.version);
  return {
    installDir,
    entryPath: path.join(installDir, "node_modules", spec.name, ...spec.entry),
    sentinelPath: path.join(installDir, ".install-complete"),
  };
};

export const deviceToolPaths = (path: Path.Path, stateDir: string, tool: DeviceToolKey) =>
  toolPaths(path, stateDir, SPECS[tool]);

const isInstalledAt = Effect.fn("DeviceToolchain.isInstalledAt")(function* (
  paths: DeviceToolPaths,
  version: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const [entryExists, sentinel] = yield* Effect.all([
    fs.exists(paths.entryPath).pipe(Effect.orElseSucceed(() => false)),
    fs.readFileString(paths.sentinelPath).pipe(Effect.orElseSucceed(() => "")),
  ]);
  return entryExists && sentinel.trim() === version;
});

export const isDeviceToolInstalled = Effect.fn("DeviceToolchain.isInstalled")(function* (
  stateDir: string,
  tool: DeviceToolKey,
) {
  const path = yield* Path.Path;
  return yield* isInstalledAt(deviceToolPaths(path, stateDir, tool), SPECS[tool].version);
});

/** Is `tool` installed under `stateDir`, without Effect: for community agents' Node.js cleanup. */
const installedSync = (stateDir: string, tool: DeviceToolKey) => {
  const spec = SPECS[tool];
  const installDir = NodePath.join(stateDir, "tools", "device", spec.name, spec.version);
  try {
    return (
      NodeFS.readFileSync(NodePath.join(installDir, ".install-complete"), "utf8").trim() ===
      spec.version
    );
  } catch {
    return false;
  }
};

/** Threadlines' managed Node.js under `<stateDir>/tools/node`, shared with community agents. */
const nodesFor = (path: Path.Path, stateDir: string) => {
  const nodes = acpRegistryNodes(path.join(stateDir, "tools", "node"));
  if (!registeredKeepers.has(stateDir)) {
    registeredKeepers.add(stateDir);
    // Community agents' cleanup keeps the release device tools run on while one is installed.
    nodes.keepAlso(
      Effect.sync(() => {
        const release = managedNodeReleaseFor(process.platform, process.arch);
        return release && (installedSync(stateDir, "hub") || installedSync(stateDir, "agent"))
          ? [release]
          : [];
      }),
    );
  }
  return nodes;
};
const registeredKeepers = new Set<string>();

/**
 * The managed Node.js, installed if missing and leased until `scope` closes,
 * so community agents' cleanup leaves it while a device tool runs on it.
 */
export const leaseDeviceNode = Effect.fn("DeviceToolchain.leaseDeviceNode")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  const release = managedNodeReleaseFor(process.platform, process.arch);
  if (!release) {
    return yield* new DeviceToolchainInstallError({
      tool: "Node.js",
      step: "finding Node.js",
      reason: "no_node",
    });
  }
  const nodes = nodesFor(path, stateDir);
  const node = nodes.nodeFor(release);
  const installed = yield* node.installed;
  if (!installed) {
    yield* nodes
      .whileInstalling(node.install())
      .pipe(
        Effect.mapError(
          (cause) =>
            new DeviceToolchainInstallError({ tool: "Node.js", step: "installing Node.js", cause }),
        ),
      );
  }
  return yield* node.acquire.pipe(
    Effect.mapError(
      (cause) =>
        new DeviceToolchainInstallError({ tool: "Node.js", step: "starting Node.js", cause }),
    ),
  );
});

const installTool = Effect.fn("DeviceToolchain.installTool")(function* (
  spec: ToolSpec,
  paths: DeviceToolPaths,
  node: ManagedNodePaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (step: string) => (cause: unknown) =>
    new DeviceToolchainInstallError({ tool: spec.name, step, cause });

  if (yield* isInstalledAt(paths, spec.version)) return paths;

  const parentDir = path.dirname(paths.installDir);
  yield* fs
    .remove(paths.installDir, { recursive: true, force: true })
    .pipe(Effect.mapError(fail("removing an incomplete install")));
  yield* fs
    .makeDirectory(parentDir, { recursive: true })
    .pipe(Effect.mapError(fail("preparing the install folder")));
  const stagingDir = yield* fs
    .makeTempDirectory({ directory: parentDir, prefix: ".staging-" })
    .pipe(Effect.mapError(fail("preparing the install folder")));

  return yield* Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: (signal) =>
        runNode({
          node: node.node,
          args: [
            node.npmCli,
            "install",
            "--prefix",
            stagingDir,
            ...npmPinnedFlags(false),
            `${spec.name}@${spec.version}`,
          ],
          cwd: stagingDir,
          env: managedNodeEnvironment(process.env, node.binDir, process.platform),
          signal,
          timeoutMs: INSTALL_TIMEOUT_MS,
        }),
      catch: fail("running npm install"),
    });
    if (result.timedOut) {
      return yield* new DeviceToolchainInstallError({
        tool: spec.name,
        step: "running npm install",
        reason: "timed_out",
      });
    }
    if (result.exitCode !== 0) {
      return yield* new DeviceToolchainInstallError({
        tool: spec.name,
        step: "running npm install",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        tail: result.tail,
      });
    }
    const stagedEntry = path.join(stagingDir, "node_modules", spec.name, ...spec.entry);
    if (!(yield* fs.exists(stagedEntry).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new DeviceToolchainInstallError({
        tool: spec.name,
        step: "checking the installed entry point",
      });
    }
    yield* fs
      .writeFileString(path.join(stagingDir, ".install-complete"), `${spec.version}\n`)
      .pipe(Effect.mapError(fail("recording the finished install")));
    yield* fs.rename(stagingDir, paths.installDir).pipe(
      // Another server on this state folder may have published the same version first.
      Effect.catch((cause) =>
        isInstalledAt(paths, spec.version).pipe(
          Effect.flatMap((published) =>
            published ? Effect.void : Effect.fail(fail("publishing the install")(cause)),
          ),
        ),
      ),
    );
    return paths;
  }).pipe(
    Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

/**
 * Installs the pinned version of `tool` if it is missing and returns where it
 * is. Holds a lease on the managed Node.js until `scope` closes.
 */
export const ensureDeviceTool = Effect.fn("DeviceToolchain.ensure")(function* (
  stateDir: string,
  tool: DeviceToolKey,
) {
  const path = yield* Path.Path;
  const node = yield* leaseDeviceNode(stateDir);
  const spec = SPECS[tool];
  const paths = yield* installLock.withPermit(
    installTool(spec, toolPaths(path, stateDir, spec), node),
  );
  return { paths, node };
});

/** The entry of the first installed agent-device among `versions`; never installs. */
export const installedAgentDeviceEntry = Effect.fn("DeviceToolchain.installedAgentDeviceEntry")(
  function* (stateDir: string, versions: ReadonlyArray<string>) {
    const path = yield* Path.Path;
    for (const version of versions) {
      if (!VERSION_PATTERN.test(version)) continue;
      const paths = toolPaths(path, stateDir, { ...SPECS.agent, version });
      if (yield* isInstalledAt(paths, version)) return paths.entryPath;
    }
    return null;
  },
);

/** What is on disk for each tool and what runs, for Settings → Devices. */
export const deviceToolVersions = Effect.fn("DeviceToolchain.versions")(function* (
  stateDir: string,
  running: { readonly hub?: string | undefined; readonly agent?: string | undefined } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inspect = Effect.fn("DeviceToolchain.inspect")(function* (spec: ToolSpec) {
    const directory = path.join(deviceToolsRoot(path, stateDir), spec.name);
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
    const versions = yield* Effect.filter(names, (version) =>
      VERSION_PATTERN.test(version)
        ? isInstalledAt(toolPaths(path, stateDir, { ...spec, version }), version)
        : Effect.succeed(false),
    );
    return {
      requiredVersion: spec.version,
      installedVersions: versions.sort(),
      runningVersion: running[spec.key] ?? null,
    };
  });
  return {
    hub: yield* inspect(SPECS.hub),
    agent: yield* inspect(SPECS.agent),
  } satisfies DeviceToolVersions;
});

/**
 * Deletes installed versions of `tool` other than the pinned one and the most
 * recent other one, never one a running process was started from (another
 * Threadlines server may still run an older pin). Only once the pinned
 * version is installed. Best effort.
 */
export const pruneDeviceTool = Effect.fn("DeviceToolchain.prune")(function* (
  stateDir: string,
  tool: DeviceToolKey,
  runningCommandLines: Effect.Effect<string | null>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spec = SPECS[tool];
  const parent = path.join(deviceToolsRoot(path, stateDir), spec.name);
  const names = yield* fs.readDirectory(parent).pipe(Effect.orElseSucceed(() => []));
  const completed: Array<{ version: string; dir: string; modified: number }> = [];
  for (const version of names) {
    if (!VERSION_PATTERN.test(version)) continue;
    const paths = toolPaths(path, stateDir, { ...spec, version });
    if (!(yield* isInstalledAt(paths, version))) continue;
    const info = yield* fs.stat(paths.sentinelPath).pipe(Effect.option);
    const modified =
      info._tag === "Some" && info.value.mtime._tag === "Some"
        ? info.value.mtime.value.getTime()
        : 0;
    completed.push({ version, dir: paths.installDir, modified });
  }
  if (!completed.some((entry) => entry.version === spec.version)) return;
  const others = completed.filter((entry) => entry.version !== spec.version);
  if (others.length <= 1) return;
  // A process scan that fails keeps everything: never delete what may be running.
  const commandLines = yield* runningCommandLines;
  if (commandLines === null) return;
  const previous = others.toSorted(
    (a, b) =>
      b.modified - a.modified || b.version.localeCompare(a.version, "en", { numeric: true }),
  )[0]?.version;
  for (const entry of others) {
    if (entry.version === previous) continue;
    if (commandLines.includes(entry.dir + path.sep)) continue;
    yield* fs.remove(entry.dir, { recursive: true, force: true }).pipe(Effect.ignore);
  }
});

/**
 * PiRuntime — the copy of Pi that Threadlines installs, for a computer with
 * no `pi` of its own (docs/providers/pi-plan.md, "Install and update").
 *
 * Pi is an npm package, so it is installed the way npm community agents are
 * (`AcpRegistryInstaller`): `npm install` with Threadlines' own Node.js into
 * a new version folder, activated once complete, with a lease per running
 * process so an update never touches files a running Pi has loaded. Pi says
 * it needs no install scripts, so none run.
 *
 * Pi runs with the managed Node.js named in full; that Node.js is not put on
 * Pi's PATH, so the commands Pi runs in a project use the project's own Node.
 * The Node.js release Pi was installed with is kept by the community agents'
 * cleanup (`AcpRegistryNodes.keepAlso`).
 *
 * Layout: `<stateDir>/tools/pi/<sha256("pi")[0:16]>/`, the installer's.
 *
 * @module provider/pi/PiRuntime
 */
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { acpRegistryNodes } from "../acpRegistry/AcpRegistryNodes.ts";
import {
  type AcpRegistryInstallProgress,
  makeAcpRegistryInstaller,
} from "../acpRegistry/AcpRegistryInstaller.ts";
import {
  acpRegistryRecipeDigest,
  type AcpRegistryNpmRecipe,
} from "../acpRegistry/AcpRegistryRecipe.ts";
import { managedNodeReleaseFor } from "../managedRuntime/ManagedNode.ts";
import {
  type ManagedRuntimeError,
  managedRuntimeError,
} from "../managedRuntime/ManagedRuntimeStore.ts";
import { PI_PACKAGE_NAME } from "./PiBinary.ts";
import type { PiLauncher } from "./PiLaunch.ts";

const AGENT_ID = "pi";

export interface PiManagedRuntime {
  /** The active copy's version, if it is complete on disk. Never fails. */
  readonly installed: Effect.Effect<string | undefined>;
  /** Installs `version` from npm and makes it the active copy (or reuses a complete one). */
  readonly install: (
    version: string,
    onProgress?: (progress: AcpRegistryInstallProgress) => void,
  ) => Effect.Effect<string, ManagedRuntimeError>;
  /** The active copy, leased until the scope closes. */
  readonly acquire: Effect.Effect<
    { readonly launcher: PiLauncher; readonly version: string },
    ManagedRuntimeError,
    Scope.Scope
  >;
  /** Deletes versions nobody leases. Best effort. */
  readonly prune: Effect.Effect<void>;
}

const runtimes = new Map<string, PiManagedRuntime>();

const recipeFor = (version: string): AcpRegistryNpmRecipe => ({
  kind: "npm",
  agentId: AGENT_ID,
  version,
  args: [],
  env: {},
  packageName: PI_PACKAGE_NAME,
  packageVersion: version,
});

/**
 * The managed Pi under `stateDir`, one per process, or undefined where
 * Threadlines has no Node.js for this computer.
 */
export function piManagedRuntime(stateDir: string): PiManagedRuntime | undefined {
  if (!managedNodeReleaseFor(process.platform, process.arch)) return undefined;
  const known = runtimes.get(stateDir);
  if (known) return known;

  const nodeDir = NodePath.join(stateDir, "tools", "node");
  const nodes = acpRegistryNodes(nodeDir);
  const installer = makeAcpRegistryInstaller({
    agentId: AGENT_ID,
    label: "Pi",
    toolsDir: NodePath.join(stateDir, "tools", "pi"),
    nodeToolsDir: nodeDir,
    makeNode: nodes.nodeFor,
    npmIgnoreScripts: true,
  });
  nodes.keepAlso(
    installer.installed.pipe(
      Effect.map((installed) => (installed?.receipt.node ? [installed.receipt.node] : [])),
    ),
  );

  const runtime: PiManagedRuntime = {
    installed: installer.installed.pipe(
      Effect.map((installed) => installed?.receipt.recipe.version),
    ),
    install: (version, onProgress) =>
      Effect.gen(function* () {
        const recipe = recipeFor(version);
        // The click on Install or Update is the confirmation.
        yield* installer.confirm(recipe);
        const installed = yield* nodes.whileInstalling(
          installer.install(acpRegistryRecipeDigest(recipe), onProgress),
        );
        return installed.receipt.recipe.version;
      }),
    acquire: Effect.gen(function* () {
      const installed = yield* installer.acquire;
      // Pi's program is a script the managed Node.js runs: never a shell.
      if (installed.launch.needsShell || installed.receipt.program.kind !== "node") {
        return yield* managedRuntimeError(
          "validate",
          "Threadlines' copy of Pi is not one it can start. Reinstall it from Settings.",
          { detail: `program kind ${installed.receipt.program.kind}` },
        );
      }
      return {
        launcher: { command: installed.launch.program, prefixArgs: installed.launch.prefixArgs },
        version: installed.receipt.recipe.version,
      };
    }),
    prune: installer.prune,
  };
  runtimes.set(stateDir, runtime);
  return runtime;
}

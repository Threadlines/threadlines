// @effect-diagnostics nodeBuiltinImport:off - lists the installed Node.js releases
/**
 * AcpRegistryNodes — the Node.js releases npm community agents run on, shared
 * by every agent's installer.
 *
 * One manager per release, so two agents installing at once download Node.js
 * once. A release stays for as long as an installed agent names it (each
 * agent runs on the Node.js it was installed with, even after Threadlines
 * moves on to a newer one), and `prune` deletes the rest.
 *
 * @module provider/acpRegistry/AcpRegistryNodes
 */
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import {
  type ManagedNode,
  type ManagedNodePlatformRelease,
  makeManagedNode,
  managedNodeRoot,
} from "../managedRuntime/ManagedNode.ts";
import { makeManagedRuntimeStore } from "../managedRuntime/ManagedRuntimeStore.ts";

type NodeReleaseName = Pick<ManagedNodePlatformRelease, "version" | "assetKey">;

export interface AcpRegistryNodes {
  /** The manager of one release, the same one for every caller. */
  readonly nodeFor: (release: ManagedNodePlatformRelease) => ManagedNode;
  /** Runs an install that may use Node.js. `prune` leaves every release alone until it ends. */
  readonly whileInstalling: <A, E, R>(install: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Deletes the releases that none of `inUse` names. `inUse` is read once no
   * install is running; while one is, or when `inUse` can't tell
   * (undefined), nothing is deleted. A release a running agent leases is
   * kept. Best effort: never fails.
   */
  readonly prune: (
    inUse: Effect.Effect<ReadonlyArray<NodeReleaseName> | undefined>,
  ) => Effect.Effect<void>;
}

const registries = new Map<string, AcpRegistryNodes>();

/** A release folder is `<version>-<assetKey>`; the store's leftovers start with a dot or carry one. */
const RELEASE_FOLDER = /^\d+\.\d+\.\d+-[a-z0-9]+-[a-z0-9]+$/u;

/** The Node.js releases under `toolsDir` (`<stateDir>/tools/node`), created on first use. */
export function acpRegistryNodes(toolsDir: string): AcpRegistryNodes {
  const known = registries.get(toolsDir);
  if (known) return known;

  const managers = new Map<string, ManagedNode>();
  const nodeFor: AcpRegistryNodes["nodeFor"] = (release) => {
    const key = `${release.version}/${release.assetKey}/${release.asset.sha256}`;
    let manager = managers.get(key);
    if (!manager) {
      manager = makeManagedNode({ toolsDir, release });
      managers.set(key, manager);
    }
    return manager;
  };

  // Held to count an install in or out, and for the whole of a prune: an
  // install that starts while releases are being deleted waits for it.
  const turnstile = Semaphore.makeUnsafe(1);
  let installing = 0;
  const whileInstalling: AcpRegistryNodes["whileInstalling"] = (install) =>
    Effect.acquireUseRelease(
      turnstile.withPermit(
        Effect.sync(() => {
          installing += 1;
        }),
      ),
      () => install,
      () =>
        Effect.sync(() => {
          installing -= 1;
        }),
    );

  const prune: AcpRegistryNodes["prune"] = (inUse) =>
    turnstile
      .withPermit(
        Effect.gen(function* () {
          if (installing > 0) return;
          const releases = yield* inUse;
          if (releases === undefined) return;
          const keep = new Set(
            releases.map((release) => NodePath.basename(managedNodeRoot(toolsDir, release))),
          );
          const names = yield* Effect.promise(() =>
            NodeFS.readdir(toolsDir).catch(() => [] as Array<string>),
          );
          for (const name of names) {
            if (keep.has(name) || !RELEASE_FOLDER.test(name)) continue;
            // The store's own removal: it refuses while a running agent leases the release.
            yield* makeManagedRuntimeStore<never>({
              root: NodePath.join(toolsDir, name),
              label: "Node.js",
              marker: { decode: () => undefined, encode: () => "" },
              intact: () => Promise.resolve(false),
            }).remove.pipe(Effect.ignore);
          }
        }),
      )
      .pipe(Effect.ignore);

  const registry: AcpRegistryNodes = { nodeFor, whileInstalling, prune };
  registries.set(toolsDir, registry);
  return registry;
}

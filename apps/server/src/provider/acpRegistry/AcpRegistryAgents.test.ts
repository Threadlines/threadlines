// @effect-diagnostics nodeBuiltinImport:off - builds a download and looks at what was written
import { existsSync } from "node:fs";
import * as zlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ACP_REGISTRY_DRIVER_KIND,
  type AcpRegistryCatalogAgent,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@threadlines/contracts";
import { acpRegistryInstanceId } from "@threadlines/shared/acpRegistry";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ProviderAuthSessions } from "../auth/ProviderAuthSessions.ts";
import {
  acpRegistryAgentContext,
  acpRegistryToolsDirs,
  writeAcpRegistryListing,
} from "../Drivers/AcpRegistryDriver.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import { holdLaunchGate } from "../managedRuntime/LaunchGate.ts";
import { ProviderMaintenanceRunner } from "../providerMaintenanceRunner.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { makeTar } from "../testUtils/archiveFixtures.ts";
import { AcpRegistryAgents, makeAcpRegistryAgents } from "./AcpRegistryAgents.ts";
import type {
  AcpRegistryCatalogEntry,
  AcpRegistryCatalogShape,
  AcpRegistryCatalogSnapshot,
} from "./AcpRegistryCatalog.ts";
import { makeAcpRegistryInstaller } from "./AcpRegistryInstaller.ts";
import { type AcpRegistryDownloadRecipe, acpRegistryRecipeDigest } from "./AcpRegistryRecipe.ts";

const AGENT_ID = "test-agent";
const INSTANCE_ID = acpRegistryInstanceId(AGENT_ID);
const ARCHIVE = zlib.gzipSync(
  makeTar([{ name: "bin/agent", data: Buffer.from("#!/bin/sh\necho agent\n") }]),
);

const recipeFor = (version: string): AcpRegistryDownloadRecipe => ({
  kind: "download",
  agentId: AGENT_ID,
  version,
  args: ["acp"],
  env: {},
  url: `https://downloads.test/agent-${version}.tar.gz`,
  sha256: null,
  format: "tar.gz",
  cmd: "bin/agent",
});

const entryFor = (version: string): AcpRegistryCatalogEntry => {
  const recipe = recipeFor(version);
  return {
    recipe,
    agent: {
      agentId: AGENT_ID,
      name: "Test Agent",
      version,
      recipeDigest: acpRegistryRecipeDigest(recipe),
      description: "An agent for tests.",
      authors: ["Someone"],
      license: "MIT",
      website: null,
      repository: null,
      iconSvg: null,
      source: "download",
      packageSpec: null,
      host: "downloads.test",
      integrity: "none",
    } as AcpRegistryCatalogAgent,
  };
};

const snapshotOf = (
  entries: ReadonlyArray<AcpRegistryCatalogEntry>,
  overrides: Partial<AcpRegistryCatalogSnapshot> = {},
): AcpRegistryCatalogSnapshot => ({
  entries,
  fetchedAt: "2026-10-05T00:00:00.000Z",
  stale: false,
  quarantineKnown: true,
  unsupportedCount: 0,
  ...overrides,
});

/** The registry's list as a test sets it, and everything the service asked of its neighbours. */
function makeWorld(initial: AcpRegistryCatalogSnapshot) {
  let snapshot = initial;
  const catalog: AcpRegistryCatalogShape = {
    get: () => Effect.sync(() => snapshot),
    peek: Effect.sync(() => snapshot),
  };
  const installs: Array<{
    readonly instanceId: unknown;
    readonly action: unknown;
    /** What the agent's maintenance action would install: the digest it was handed. */
    readonly recipeDigest: string | undefined;
  }> = [];
  const run: {
    /** What a maintenance run does after taking its digest, given the state folder. */
    during: (stateDir: string) => Effect.Effect<void>;
  } = { during: () => Effect.void };
  const events: Array<readonly [string, unknown]> = [];
  const refreshed: Array<ProviderInstanceId> = [];
  const stopped: Array<string> = [];
  return {
    catalog,
    list: (next: AcpRegistryCatalogSnapshot) => {
      snapshot = next;
    },
    installs,
    run,
    events,
    refreshed,
    stopped,
  };
}

/** A registry whose instances are the ones in settings. */
const settingsBackedRegistry = (stopped: Array<string>) =>
  Layer.effect(
    ProviderInstanceRegistry,
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      return ProviderInstanceRegistry.of({
        getInstance: (instanceId: ProviderInstanceId) =>
          settings.getSettings.pipe(
            Effect.map((current) =>
              instanceId in deriveProviderInstanceConfigMap(current)
                ? {
                    adapter: {
                      stopAll: () =>
                        Effect.sync(() => {
                          stopped.push(instanceId);
                        }),
                    },
                  }
                : undefined,
            ),
            Effect.orDie,
          ),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.die("unused"),
      } as never);
    }),
  );

function makeLayer(world: ReturnType<typeof makeWorld>) {
  return Layer.effect(AcpRegistryAgents, makeAcpRegistryAgents({ catalog: world.catalog })).pipe(
    Layer.provideMerge(settingsBackedRegistry(world.stopped)),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(Layer.mock(ProviderAuthSessions)({ stop: () => Effect.void })),
    Layer.provideMerge(
      Layer.mock(ProviderRegistry)({
        refreshInstance: (instanceId) =>
          Effect.sync(() => {
            world.refreshed.push(instanceId);
            return [];
          }),
      }),
    ),
    Layer.provideMerge(
      // Stands in for the maintenance runner and the agent's own action:
      // like that action, a run takes the digest it was handed, once.
      Layer.effect(
        ProviderMaintenanceRunner,
        Effect.gen(function* () {
          const config = yield* ServerConfig;
          return ProviderMaintenanceRunner.of({
            updateProvider: (target) =>
              Effect.gen(function* () {
                if (typeof target !== "object") return {} as never;
                const { state } = acpRegistryAgentContext({
                  stateDir: config.stateDir,
                  agentId: AGENT_ID,
                  displayName: "Test Agent",
                });
                const recipeDigest = state.requestedRecipeDigest;
                state.requestedRecipeDigest = undefined;
                world.installs.push({
                  instanceId: target.instanceId,
                  action: target.action,
                  recipeDigest,
                });
                yield* world.run.during(config.stateDir);
                return {} as never;
              }),
            resolveUpdateBlockers: () => Effect.die("unused"),
          });
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(AnalyticsService, {
        record: (event, properties) =>
          Effect.sync(() => {
            world.events.push([event, properties]);
          }),
        flush: Effect.void,
      }),
    ),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "threadlines-acp-agents-" })),
    ),
  );
}

/** The agent's state and installer, as the service and the driver share them. */
const agentContext = Effect.gen(function* () {
  const config = yield* ServerConfig;
  return acpRegistryAgentContext({
    stateDir: config.stateDir,
    agentId: AGENT_ID,
    displayName: "Test Agent",
  });
});

/** Installs a version the way a finished install leaves it, without the network. */
const installOnDisk = (version: string) =>
  ServerConfig.pipe(Effect.flatMap((config) => installOnDiskAt(config.stateDir, version)));

const installOnDiskAt = (stateDir: string, version: string) =>
  Effect.gen(function* () {
    const dirs = acpRegistryToolsDirs(stateDir);
    const recipe = recipeFor(version);
    const installer = makeAcpRegistryInstaller({
      agentId: AGENT_ID,
      label: "Test Agent",
      toolsDir: dirs.agents,
      nodeToolsDir: dirs.node,
      fetch: async () => new Response(new Uint8Array(ARCHIVE)),
    });
    yield* installer.confirm(recipe);
    yield* installer.install(acpRegistryRecipeDigest(recipe));
  });

const waitFor = (met: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 1000 && !met(); turn += 1) {
      yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
    }
    assert.isTrue(met());
  });

it.layer(NodeServices.layer)("AcpRegistryAgents", (it) => {
  it.effect("adds exactly the listing the user confirmed, and starts its install", () => {
    const entry = entryFor("1.0.0");
    const world = makeWorld(snapshotOf([entry]));
    return Effect.gen(function* () {
      const agents = yield* AcpRegistryAgents;
      const settings = yield* ServerSettingsService;

      const added = yield* agents.add({
        agentId: entry.agent.agentId,
        recipeDigest: entry.agent.recipeDigest,
      });

      assert.equal(added.instanceId, INSTANCE_ID);
      assert.deepInclude((yield* settings.getSettings).providerInstances[INSTANCE_ID], {
        driver: ACP_REGISTRY_DRIVER_KIND,
        displayName: "Test Agent",
        enabled: true,
        config: { agentId: AGENT_ID },
      });
      // The recipe was recorded as confirmed before anything is fetched,
      // and it is the one the install will use.
      const context = yield* agentContext;
      assert.deepStrictEqual(
        (yield* context.installer.confirmed).map((confirmed) => confirmed.recipeDigest),
        [entry.agent.recipeDigest],
      );
      yield* waitFor(() => world.installs.length > 0);
      assert.deepStrictEqual(world.installs, [
        { instanceId: INSTANCE_ID, action: "install", recipeDigest: entry.agent.recipeDigest },
      ]);

      const again = yield* Effect.flip(
        agents.add({ agentId: entry.agent.agentId, recipeDigest: entry.agent.recipeDigest }),
      );
      assert.equal(again.reason, "alreadyAdded");
    }).pipe(Effect.provide(makeLayer(world)));
  });

  it.effect("refuses to add what the user wasn't shown, and records nothing for it", () => {
    const entry = entryFor("1.0.0");
    const world = makeWorld(snapshotOf([entry]));
    return Effect.gen(function* () {
      const agents = yield* AcpRegistryAgents;
      const settings = yield* ServerSettingsService;
      const input = { agentId: entry.agent.agentId, recipeDigest: entry.agent.recipeDigest };

      // The registry listed a newer version between the look and the click.
      world.list(snapshotOf([entryFor("1.1.0")]));
      assert.equal((yield* Effect.flip(agents.add(input))).reason, "staleRecipe");

      // The quarantine list couldn't be read: nobody knows the agent isn't on it.
      world.list(snapshotOf([entry], { quarantineKnown: false }));
      assert.equal((yield* Effect.flip(agents.add(input))).reason, "quarantineUnknown");

      world.list(snapshotOf([]));
      assert.equal((yield* Effect.flip(agents.add(input))).reason, "unknownAgent");

      assert.isUndefined((yield* settings.getSettings).providerInstances[INSTANCE_ID]);
      assert.deepStrictEqual(yield* (yield* agentContext).installer.confirmed, []);
      assert.deepStrictEqual(world.installs, []);
    }).pipe(Effect.provide(makeLayer(world)));
  });

  it.effect("offers a newer listing as an update, and installs only the one that was shown", () => {
    const installed = entryFor("1.0.0");
    const newer = entryFor("1.1.0");
    const world = makeWorld(snapshotOf([installed]));
    return Effect.gen(function* () {
      const agents = yield* AcpRegistryAgents;
      yield* agents.add({
        agentId: installed.agent.agentId,
        recipeDigest: installed.agent.recipeDigest,
      });
      yield* installOnDisk("1.0.0");
      const context = yield* agentContext;

      // Nothing newer is listed: no notice.
      yield* agents.list({});
      assert.isUndefined(context.state.updateCandidate);

      world.list(snapshotOf([newer]));
      // Two clients read the list at the same moment: both get it.
      const [listed] = yield* Effect.all([agents.list({}), agents.list({})], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(
        listed.agents.map((agent) => agent.version),
        ["1.1.0"],
      );
      assert.deepStrictEqual(context.state.updateCandidate, {
        version: "1.1.0",
        recipeDigest: newer.agent.recipeDigest,
      });
      // The row is told, and nothing was installed by the notice itself.
      assert.include(world.refreshed, INSTANCE_ID);
      assert.equal((yield* context.installer.installed)?.receipt.recipe.version, "1.0.0");

      yield* waitFor(() => world.installs.length === 1);
      const run = (
        action: "install" | "update",
        recipeDigest: string | undefined,
        provider = "acpRegistry",
      ) =>
        agents.updateProvider({
          provider: ProviderDriverKind.make(provider),
          instanceId: INSTANCE_ID,
          action,
          ...(recipeDigest === undefined ? {} : { recipeDigest }),
        });
      const lookAgain = "A newer version was listed. Look again.";
      // Not the notice the user saw, or no digest at all: refused before anything runs.
      assert.equal(
        (yield* Effect.flip(run("update", installed.agent.recipeDigest))).message,
        lookAgain,
      );
      assert.equal((yield* Effect.flip(run("update", undefined))).message, lookAgain);
      // Calling the agent by another driver's name doesn't get around the check.
      assert.equal((yield* Effect.flip(run("update", undefined, "codex"))).message, lookAgain);
      // A repair installs only something that was confirmed before.
      assert.equal(
        (yield* Effect.flip(run("install", acpRegistryRecipeDigest(recipeFor("9.9.9"))))).message,
        lookAgain,
      );
      assert.lengthOf(world.installs, 1);
      assert.lengthOf(yield* context.installer.confirmed, 1);

      // Two requests at once: each run installs what its own request named.
      const firstRunning = yield* Deferred.make<void>();
      const finishFirst = yield* Deferred.make<void>();
      world.run.during = () =>
        Deferred.succeed(firstRunning, undefined).pipe(Effect.andThen(Deferred.await(finishFirst)));
      const update = yield* run("update", newer.agent.recipeDigest).pipe(Effect.forkChild);
      yield* Deferred.await(firstRunning);
      world.run.during = () => Effect.void;
      const repair = yield* run("install", installed.agent.recipeDigest).pipe(Effect.forkChild);
      // The repair waits its turn: it hasn't touched what the update is installing.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 30)));
      assert.lengthOf(world.installs, 2);
      yield* Deferred.succeed(finishFirst, undefined);
      yield* Fiber.join(update);
      yield* Fiber.join(repair);
      assert.deepStrictEqual(world.installs.slice(1), [
        { instanceId: INSTANCE_ID, action: "update", recipeDigest: newer.agent.recipeDigest },
        { instanceId: INSTANCE_ID, action: "install", recipeDigest: installed.agent.recipeDigest },
      ]);
      // Nothing is left for a run that nobody checked a digest for.
      assert.isUndefined(context.state.requestedRecipeDigest);
      assert.deepStrictEqual(
        (yield* context.installer.confirmed).map((confirmed) => confirmed.recipe.version),
        ["1.0.0", "1.1.0"],
      );

      // A listing that went backward offers nothing.
      world.list(snapshotOf([entryFor("0.9.0")]));
      yield* agents.list({});
      assert.isUndefined(context.state.updateCandidate);
    }).pipe(Effect.provide(makeLayer(world)));
  });

  it.effect("counts an install once, when it is the retry that succeeds", () => {
    const entry = entryFor("1.0.0");
    const world = makeWorld(snapshotOf([entry]));
    return Effect.gen(function* () {
      const agents = yield* AcpRegistryAgents;
      // The first try fails to download: nothing is installed, nothing is counted.
      yield* agents.add({ agentId: entry.agent.agentId, recipeDigest: entry.agent.recipeDigest });
      yield* waitFor(() => world.installs.length === 1);
      assert.deepStrictEqual(world.events, []);

      // "Try again" works.
      world.run.during = (stateDir) => installOnDiskAt(stateDir, "1.0.0").pipe(Effect.orDie);
      yield* agents.updateProvider({
        provider: ProviderDriverKind.make("acpRegistry"),
        instanceId: INSTANCE_ID,
        action: "install",
        recipeDigest: entry.agent.recipeDigest,
      });
      const installed = [
        "provider.community_agent.installed",
        { agentId: AGENT_ID, version: "1.0.0" },
      ] as const;
      assert.deepStrictEqual(world.events, [installed]);

      // A repair of what is already installed is not another install.
      yield* agents.updateProvider({
        provider: ProviderDriverKind.make("acpRegistry"),
        instanceId: INSTANCE_ID,
        action: "install",
        recipeDigest: entry.agent.recipeDigest,
      });
      assert.deepStrictEqual(world.events, [installed]);
    }).pipe(Effect.provide(makeLayer(world)));
  });

  it.effect("removes an agent's row and files, and not while it is still running", () => {
    const entry = entryFor("1.0.0");
    const world = makeWorld(snapshotOf([entry]));
    return Effect.gen(function* () {
      const agents = yield* AcpRegistryAgents;
      const settings = yield* ServerSettingsService;
      yield* agents.add({ agentId: entry.agent.agentId, recipeDigest: entry.agent.recipeDigest });
      yield* installOnDisk("1.0.0");
      const context = yield* agentContext;
      assert.isTrue(existsSync(context.root));

      // A session that won't stop holds the agent.
      const session = yield* Scope.make();
      yield* holdLaunchGate(context.state.gate, () => "closed").pipe(Scope.provide(session));
      const blocked = yield* agents.remove({ instanceId: INSTANCE_ID }).pipe(Effect.forkChild);
      yield* waitFor(() => world.stopped.length > 0);
      yield* TestClock.adjust(Duration.seconds(46));
      const stillRunning = yield* Effect.flip(Fiber.join(blocked));
      assert.equal(stillRunning.reason, "stillRunning");
      assert.equal(
        stillRunning.detail,
        "Couldn't remove Test Agent: it is still running. Try again.",
      );
      // Nothing was taken away, and the agent can start again.
      assert.isTrue((yield* settings.getSettings).providerInstances[INSTANCE_ID]?.enabled);
      assert.isDefined(yield* context.installer.installed);
      assert.isFalse(context.state.gate.busy);

      yield* Scope.close(session, Exit.void);
      yield* agents.remove({ instanceId: INSTANCE_ID });
      assert.isUndefined((yield* settings.getSettings).providerInstances[INSTANCE_ID]);
      assert.isFalse(existsSync(context.root));
      // A read of the list that was under way saves its listing late: not into a new folder.
      yield* writeAcpRegistryListing(context.root, {
        authors: ["Someone"],
        website: null,
        repository: null,
        iconSvg: null,
        source: "download",
        packageSpec: null,
        host: "downloads.test",
      });
      assert.isFalse(existsSync(context.root));
      assert.deepInclude(world.events, [
        "provider.community_agent.removed",
        { agentId: AGENT_ID, version: "1.0.0" },
      ]);

      assert.equal(
        (yield* Effect.flip(agents.remove({ instanceId: INSTANCE_ID }))).reason,
        "unknownInstance",
      );
    }).pipe(Effect.provide(makeLayer(world)));
  });

  it.effect("a removal whose client goes away is not left half done", () => {
    const entry = entryFor("1.0.0");
    const world = makeWorld(snapshotOf([entry]));
    return Effect.gen(function* () {
      const agents = yield* AcpRegistryAgents;
      const settings = yield* ServerSettingsService;
      yield* agents.add({ agentId: entry.agent.agentId, recipeDigest: entry.agent.recipeDigest });
      yield* installOnDisk("1.0.0");
      const context = yield* agentContext;

      const removal = yield* agents.remove({ instanceId: INSTANCE_ID }).pipe(Effect.forkChild);
      // Its sessions were told to stop: the agent is closed, the removal under way.
      yield* waitFor(() => world.stopped.length > 0);
      yield* Fiber.interrupt(removal);

      // Either it finished, or the agent can be used and removed again: never
      // a row whose agent stays closed to everything.
      const rowIsThere = (yield* settings.getSettings).providerInstances[INSTANCE_ID] !== undefined;
      assert.isFalse(rowIsThere && context.state.gate.busy);
      assert.isFalse(rowIsThere);
      assert.isFalse(existsSync(context.root));
      // Added again, it starts from nothing: what was confirmed before is gone with it.
      assert.deepStrictEqual(yield* (yield* agentContext).installer.confirmed, []);
    }).pipe(Effect.provide(makeLayer(world)));
  });
});

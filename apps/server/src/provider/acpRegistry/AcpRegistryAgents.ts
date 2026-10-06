// @effect-diagnostics nodeBuiltinImport:off - the registry's cache folder
/**
 * AcpRegistryAgents — what a client can do with community agents: read the
 * list, add one, update one, remove one.
 *
 * Nothing is installed without a confirm, and a confirm names exactly what
 * the user was shown: the digest of the recipe. The server refuses a digest
 * that is no longer the listing's (the registry moved between the look and
 * the click), so "install" and "update" can't land on something else.
 *
 * Removal is ordered so a failure stays visible and can be retried: the
 * agent is closed and stopped first, its files are retired next, and only
 * then does its row leave settings.
 *
 * @module provider/acpRegistry/AcpRegistryAgents
 */
import * as NodePath from "node:path";

import {
  ACP_REGISTRY_DRIVER_KIND,
  type AcpRegistryAddInput,
  type AcpRegistryAddResult,
  type AcpRegistryCatalog,
  AcpRegistryError,
  type AcpRegistryListInput,
  type AcpRegistryRemoveInput,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProviderMaintenanceAction,
  type ServerProviderUpdatedPayload,
  ServerProviderUpdateError,
  type ServerProviderUpdateInput,
} from "@threadlines/contracts";
import { acpRegistryInstanceId } from "@threadlines/shared/acpRegistry";
import { compareSemverVersions } from "@threadlines/shared/semver";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ProviderAuthSessions } from "../auth/ProviderAuthSessions.ts";
import {
  type AcpRegistryAgentContext,
  acpRegistryAgentContext,
  acpRegistryToolsDirs,
  forgetAcpRegistryAgentContext,
  writeAcpRegistryListing,
} from "../Drivers/AcpRegistryDriver.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import { closeLaunchGate } from "../managedRuntime/LaunchGate.ts";
import { managedNodeReleaseFor } from "../managedRuntime/ManagedNode.ts";
import { ProviderMaintenanceRunner } from "../providerMaintenanceRunner.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { forgetAcpRegistryAgentState } from "./AcpRegistryAgentState.ts";
import {
  type AcpRegistryCatalogEntry,
  type AcpRegistryCatalogShape,
  type AcpRegistryCatalogSnapshot,
  makeAcpRegistryCatalog,
  toAcpRegistryCatalog,
} from "./AcpRegistryCatalog.ts";
import { acpRegistryNodes } from "./AcpRegistryNodes.ts";

/** How often the registry is read again for update notices, while a community agent is installed. */
const UPDATE_CHECK_INTERVAL = Duration.hours(6);
const INSTANCE_READY_ATTEMPTS = 100;

export interface AcpRegistryAgentsShape {
  readonly list: (
    input: AcpRegistryListInput,
  ) => Effect.Effect<AcpRegistryCatalog, AcpRegistryError>;
  /** Adds the agent's instance and starts its install on the server. */
  readonly add: (
    input: AcpRegistryAddInput,
  ) => Effect.Effect<AcpRegistryAddResult, AcpRegistryError>;
  readonly remove: (input: AcpRegistryRemoveInput) => Effect.Effect<void, AcpRegistryError>;
  /**
   * `server.updateProvider`, for every provider. An instance that is a
   * community agent (whatever driver the request names) is installed or
   * updated only to the recipe the request names, after that digest has
   * been checked; one such run per agent at a time, and it finishes even
   * if the client goes away. Anything else goes straight to the
   * maintenance runner.
   */
  readonly updateProvider: (
    input: ServerProviderUpdateInput,
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
  /** "Check again": the next status check starts the agent whatever it last found. */
  readonly requestCheck: (instanceId: ProviderInstanceId) => Effect.Effect<void>;
}

export class AcpRegistryAgents extends Context.Service<AcpRegistryAgents, AcpRegistryAgentsShape>()(
  "threadlines/provider/acpRegistry/AcpRegistryAgents",
) {}

const fail = (reason: AcpRegistryError["reason"], detail: string) =>
  Effect.fail(new AcpRegistryError({ reason, detail }));

const readConfigString = (config: unknown, key: string): string => {
  if (typeof config !== "object" || config === null) return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
};

const listingOf = (entry: AcpRegistryCatalogEntry) => ({
  authors: entry.agent.authors,
  website: entry.agent.website,
  repository: entry.agent.repository,
  iconSvg: entry.agent.iconSvg,
  source: entry.agent.source,
  packageSpec: entry.agent.packageSpec,
  host: entry.agent.host,
});

export const makeAcpRegistryAgents = Effect.fn("makeAcpRegistryAgents")(function* (options?: {
  /** Test seam: the registry's list. Default: read from the registry, cached under the state folder. */
  readonly catalog?: AcpRegistryCatalogShape;
}) {
  const settingsService = yield* ServerSettingsService;
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry;
  const authSessions = yield* ProviderAuthSessions;
  const maintenanceRunner = yield* ProviderMaintenanceRunner;
  const serverConfig = yield* ServerConfig;
  const analytics = yield* AnalyticsService;

  const catalog =
    options?.catalog ??
    makeAcpRegistryCatalog({
      cacheDir: NodePath.join(serverConfig.stateDir, "caches", "acp-registry"),
      platform: process.platform,
      arch: process.arch,
    });

  /** The community agents in settings, by instance id. Fails when settings can't be read. */
  const readCommunityInstances = settingsService.getSettings.pipe(
    Effect.map((settings) =>
      Object.entries(deriveProviderInstanceConfigMap(settings)).flatMap(
        ([instanceId, instance]): Array<
          readonly [ProviderInstanceId, ProviderInstanceConfig, string]
        > => {
          const agentId = readConfigString(instance.config, "agentId");
          return instance.driver === ACP_REGISTRY_DRIVER_KIND && agentId
            ? [[instanceId as ProviderInstanceId, instance, agentId]]
            : [];
        },
      ),
    ),
  );
  const communityInstances = readCommunityInstances.pipe(Effect.orElseSucceed(() => []));

  const contextFor = (agentId: string, displayName: string): AcpRegistryAgentContext =>
    acpRegistryAgentContext({ stateDir: serverConfig.stateDir, agentId, displayName });

  // npm agents run on a Node.js that Threadlines installs. Where there is
  // none for this computer they can't be installed, so they aren't listed.
  const hasManagedNode = managedNodeReleaseFor(process.platform, process.arch) !== undefined;
  const installable = (snapshot: AcpRegistryCatalogSnapshot): AcpRegistryCatalogSnapshot => {
    if (hasManagedNode) return snapshot;
    const entries = snapshot.entries.filter((entry) => entry.recipe.kind !== "npm");
    return {
      ...snapshot,
      entries,
      unsupportedCount: snapshot.unsupportedCount + snapshot.entries.length - entries.length,
    };
  };

  /** Deletes the Node.js releases that no installed community agent runs on any more. */
  const pruneNode = acpRegistryNodes(acpRegistryToolsDirs(serverConfig.stateDir).node).prune(
    Effect.gen(function* () {
      const releases = [];
      for (const [, instance, agentId] of yield* readCommunityInstances) {
        const installed = yield* contextFor(agentId, instance.displayName ?? agentId).installer
          .installed;
        if (installed?.receipt.node) releases.push(installed.receipt.node);
      }
      return releases;
      // Settings that can't be read say nothing about which agents are there.
    }).pipe(Effect.orElseSucceed(() => undefined)),
  );

  /**
   * Compares what is installed with the listing: a newer version becomes the
   * agent's update notice (memory only, never installed by itself), and the
   * saved listing is brought up to date. A version that moved backward
   * offers nothing.
   */
  const noteUpdates = (snapshot: AcpRegistryCatalogSnapshot) =>
    Effect.gen(function* () {
      const entries = new Map(snapshot.entries.map((entry) => [entry.agent.agentId, entry]));
      for (const [instanceId, instance, agentId] of yield* communityInstances) {
        const entry = entries.get(agentId);
        const context = contextFor(agentId, instance.displayName ?? agentId);
        const installed = yield* context.installer.installed;
        const before = context.state.updateCandidate?.recipeDigest;
        const newer =
          entry !== undefined &&
          installed !== undefined &&
          entry.agent.recipeDigest !== installed.receipt.recipeDigest &&
          compareSemverVersions(entry.agent.version, installed.receipt.recipe.version) > 0;
        context.state.updateCandidate = newer
          ? { version: entry.agent.version, recipeDigest: entry.agent.recipeDigest }
          : undefined;
        if (entry) yield* writeAcpRegistryListing(context.root, listingOf(entry));
        if (context.state.updateCandidate?.recipeDigest !== before) {
          yield* providerRegistry.refreshInstance(instanceId).pipe(Effect.ignore);
        }
      }
    });

  const readCatalog = (refresh: boolean) =>
    catalog.get({ refresh }).pipe(
      Effect.map(installable),
      Effect.tap((snapshot) => noteUpdates(snapshot)),
    );

  const waitForInstance = (instanceId: ProviderInstanceId, present: boolean) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < INSTANCE_READY_ATTEMPTS; attempt += 1) {
        const instance = yield* instanceRegistry.getInstance(instanceId);
        if ((instance !== undefined) === present) return true;
        yield* Effect.sleep("200 millis");
      }
      return false;
    });

  const add: AcpRegistryAgentsShape["add"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* readCatalog(false);
      const entry = snapshot.entries.find((candidate) => candidate.agent.agentId === input.agentId);
      if (!entry) return yield* fail("unknownAgent", "That agent is no longer listed.");
      if (!snapshot.quarantineKnown) {
        return yield* fail(
          "quarantineUnknown",
          "Couldn't check the registry's quarantine list. Try again.",
        );
      }
      if (entry.agent.recipeDigest !== input.recipeDigest) {
        return yield* fail("staleRecipe", "The listing changed since you looked. Look again.");
      }
      const instanceId = acpRegistryInstanceId(input.agentId);
      // Before anything is recorded: an agent that is here is updated, not added.
      if ((yield* communityInstances).some(([id]) => id === instanceId)) {
        return yield* fail("alreadyAdded", `${entry.agent.name} is already added.`);
      }
      const context = contextFor(input.agentId, entry.agent.name);

      // Recorded before anything is fetched: what the user agreed to install.
      yield* context.installer
        .confirm(entry.recipe)
        .pipe(Effect.catch((error) => fail("filesFailed", error.message)));
      yield* writeAcpRegistryListing(context.root, listingOf(entry));

      yield* settingsService
        .updateSettingsWith((latest) =>
          Effect.gen(function* () {
            if (instanceId in deriveProviderInstanceConfigMap(latest)) {
              return yield* fail("alreadyAdded", `${entry.agent.name} is already added.`);
            }
            const instance: ProviderInstanceConfig = {
              driver: ACP_REGISTRY_DRIVER_KIND,
              displayName: entry.agent.name,
              enabled: true,
              config: { agentId: input.agentId },
            };
            return { providerInstances: { ...latest.providerInstances, [instanceId]: instance } };
          }),
        )
        .pipe(
          Effect.catch((error) =>
            error instanceof AcpRegistryError
              ? Effect.fail(error)
              : fail("settingsFailed", `${entry.agent.name} could not be saved.`),
          ),
        );

      // The install runs here, on the server: it doesn't need the client
      // that asked to stay connected, and it shows on the agent's row.
      if (yield* waitForInstance(instanceId, true)) {
        yield* runMaintenance({
          instanceId,
          agentId: input.agentId,
          displayName: entry.agent.name,
          action: "install",
          recipeDigest: entry.agent.recipeDigest,
        }).pipe(Effect.ignore, Effect.forkDetach);
      } else {
        yield* Effect.logWarning("community agent added but its instance isn't running yet", {
          instanceId,
        });
      }
      return { instanceId };
    });

  const remove: AcpRegistryAgentsShape["remove"] = (input) =>
    // Waiting for the agent to stop can be given up. Past that, the removal
    // runs to its end whoever asked: a client that goes away halfway must
    // not leave the agent closed to everything and half removed.
    Effect.uninterruptibleMask((restore) => removeAgent(input, restore));

  const removeAgent = (
    input: AcpRegistryRemoveInput,
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const instanceId = input.instanceId;
      const found = (yield* communityInstances).find(([id]) => id === instanceId);
      if (!found) return yield* fail("unknownInstance", "That agent is no longer here.");
      const [, instance, agentId] = found;
      const displayName = instance.displayName ?? agentId;
      const context = contextFor(agentId, displayName);
      const stillRunning = () =>
        new AcpRegistryError({
          reason: "stillRunning",
          detail: `Couldn't remove ${displayName}: it is still running. Try again.`,
        });

      // From here no process of the agent can start: not a chat, a
      // recovery, a check, a sign-in or an install.
      const stopSessions = Effect.gen(function* () {
        yield* authSessions.stop({ instanceId }).pipe(Effect.ignore);
        const running = yield* instanceRegistry.getInstance(instanceId);
        if (running) yield* running.adapter.stopAll().pipe(Effect.ignore);
      });
      const reopen = yield* restore(
        closeLaunchGate(context.state.gate, {
          whenAlreadyClosed: stillRunning,
          whenStillHeld: stillRunning,
          stop: stopSessions,
        }),
      );

      const version = (yield* context.installer.installed)?.receipt.recipe.version;
      const removed = yield* Effect.gen(function* () {
        // Off first, so nothing restarts it while its files go.
        yield* settingsService
          .updateSettingsWith((latest) => {
            const current = latest.providerInstances?.[instanceId];
            return Effect.succeed(
              current
                ? {
                    providerInstances: {
                      ...latest.providerInstances,
                      [instanceId]: { ...current, enabled: false },
                    },
                  }
                : {},
            );
          })
          .pipe(
            Effect.catch(() => fail("settingsFailed", `${displayName} could not be turned off.`)),
          );
        yield* context.installer.remove.pipe(Effect.catch(() => Effect.fail(stillRunning())));
        yield* settingsService
          .updateSettingsWith((latest) => {
            const { [instanceId]: _removed, ...rest } = latest.providerInstances ?? {};
            return Effect.succeed({
              providerInstances: rest,
              ...(latest.textGenerationBackupModelSelection?.instanceId === instanceId
                ? { textGenerationBackupModelSelection: null }
                : {}),
            });
          })
          .pipe(
            Effect.catch(() =>
              fail("settingsFailed", `${displayName} could not be removed from settings.`),
            ),
          );
      }).pipe(Effect.exit);

      if (removed._tag === "Failure") {
        // The row stays, turned off, and can be removed again.
        yield* reopen;
        return yield* Effect.failCause(removed.cause);
      }
      forgetAcpRegistryAgentState(agentId);
      forgetAcpRegistryAgentContext(serverConfig.stateDir, agentId);
      yield* analytics
        .record("provider.community_agent.removed", { agentId, version: version ?? "unknown" })
        .pipe(Effect.ignore);
      yield* waitForInstance(instanceId, false);
      // Its Node.js goes too, when it was the last agent on that release.
      yield* pruneNode.pipe(Effect.forkDetach);
    });

  interface MaintenanceTarget {
    readonly instanceId: ProviderInstanceId;
    readonly agentId: string;
    readonly displayName: string;
    readonly action: ServerProviderMaintenanceAction;
    readonly recipeDigest: string | undefined;
  }

  /**
   * Whether the recipe a request names may be installed now. An install
   * (first try, try again, repair) takes only a recipe the user already
   * confirmed. An update takes the notice the user saw, as it is now, and
   * confirms a copy of its recipe so the run uses that one even if the
   * registry moves meanwhile. Fails with the sentence to show.
   */
  const checkRecipe = (context: AcpRegistryAgentContext, target: MaintenanceTarget) =>
    Effect.gen(function* () {
      const lookAgain = { message: "A newer version was listed. Look again." };
      const { recipeDigest } = target;
      if (!recipeDigest) return yield* Effect.fail(lookAgain);

      if (target.action === "install") {
        const confirmed = yield* context.installer.confirmed;
        if (!confirmed.some((entry) => entry.recipeDigest === recipeDigest)) {
          return yield* Effect.fail(lookAgain);
        }
        return recipeDigest;
      }
      if (context.state.updateCandidate?.recipeDigest !== recipeDigest) {
        return yield* Effect.fail(lookAgain);
      }
      const peeked = yield* catalog.peek;
      const snapshot = peeked && installable(peeked);
      const entry = snapshot?.entries.find(
        (candidate) =>
          candidate.agent.agentId === target.agentId &&
          candidate.agent.recipeDigest === recipeDigest,
      );
      if (!entry || !snapshot?.quarantineKnown) return yield* Effect.fail(lookAgain);
      yield* context.installer
        .confirm(entry.recipe)
        .pipe(Effect.mapError((error) => ({ message: error.message })));
      return recipeDigest;
    });

  /**
   * One install or update of a community agent, from the check of its
   * digest to the end of its run. The digest is handed to the run under the
   * agent's lock and taken back when the run is over, so no other request
   * can change what this one installs, and nothing installs without a
   * check. Not interruptible: the run goes on in the maintenance runner
   * whether or not its caller stays, and the lock is its.
   */
  const runMaintenance = (target: MaintenanceTarget) => {
    const context = contextFor(target.agentId, target.displayName);
    const { state } = context;
    return state.maintenanceLock
      .withPermit(
        Effect.gen(function* () {
          const recipeDigest = yield* checkRecipe(context, target).pipe(
            Effect.mapError(
              ({ message }) =>
                new ServerProviderUpdateError({
                  provider: ACP_REGISTRY_DRIVER_KIND,
                  reason: message,
                }),
            ),
          );
          const wasInstalled = (yield* context.installer.installed) !== undefined;
          state.requestedRecipeDigest = recipeDigest;
          const result = yield* maintenanceRunner
            .updateProvider({
              provider: ACP_REGISTRY_DRIVER_KIND,
              instanceId: target.instanceId,
              action: target.action,
            })
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  state.requestedRecipeDigest = undefined;
                }),
              ),
            );
          const installed = yield* context.installer.installed;
          if (!wasInstalled && installed) {
            // The registry's public id and version: which community agents get used.
            yield* analytics
              .record("provider.community_agent.installed", {
                agentId: target.agentId,
                version: installed.receipt.recipe.version,
              })
              .pipe(Effect.ignore);
          }
          return result;
        }),
      )
      .pipe(Effect.uninterruptible);
  };

  const updateProvider: AcpRegistryAgentsShape["updateProvider"] = (input) =>
    Effect.gen(function* () {
      // By the instance, not by the driver the request names: a community
      // agent's install goes through the digest check whatever it is called.
      const found =
        input.instanceId === undefined
          ? undefined
          : (yield* communityInstances).find(([id]) => id === input.instanceId);
      if (found) {
        const [instanceId, instance, agentId] = found;
        return yield* runMaintenance({
          instanceId,
          agentId,
          displayName: instance.displayName ?? agentId,
          action: input.action ?? "update",
          recipeDigest: input.recipeDigest,
        });
      }
      if (input.provider === ACP_REGISTRY_DRIVER_KIND) {
        return yield* new ServerProviderUpdateError({
          provider: input.provider,
          reason: "That agent is no longer here.",
        });
      }
      return yield* maintenanceRunner.updateProvider(input);
    });

  const requestCheck: AcpRegistryAgentsShape["requestCheck"] = (instanceId) =>
    Effect.gen(function* () {
      const found = (yield* communityInstances).find(([id]) => id === instanceId);
      if (!found) return;
      contextFor(found[2], found[1].displayName ?? found[2]).state.checkRequested = true;
    });

  // Update notices: read the registry now and then, but only while a
  // community agent is there to have one. The same round clears Node.js
  // releases an update or a removal left without an agent.
  yield* Effect.gen(function* () {
    yield* pruneNode;
    if ((yield* communityInstances).length === 0) return;
    yield* readCatalog(true).pipe(Effect.ignore);
  }).pipe(
    Effect.repeat(Schedule.spaced(UPDATE_CHECK_INTERVAL)),
    Effect.delay("1 minute"),
    Effect.ignore,
    Effect.forkScoped,
  );

  return {
    list: (input) => readCatalog(input.refresh === true).pipe(Effect.map(toAcpRegistryCatalog)),
    add,
    remove,
    updateProvider,
    requestCheck,
  } satisfies AcpRegistryAgentsShape;
});

export const AcpRegistryAgentsLive = Layer.effect(AcpRegistryAgents, makeAcpRegistryAgents());

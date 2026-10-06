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
} from "@threadlines/contracts";
import { acpRegistryInstanceId } from "@threadlines/shared/acpRegistry";
import { compareSemver } from "@threadlines/shared/semver";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAuthSessions } from "../auth/ProviderAuthSessions.ts";
import {
  type AcpRegistryAgentContext,
  acpRegistryAgentContext,
  forgetAcpRegistryAgentContext,
  writeAcpRegistryListing,
} from "../Drivers/AcpRegistryDriver.ts";
import { deriveProviderInstanceConfigMap } from "../Layers/ProviderInstanceRegistryHydration.ts";
import { closeLaunchGate } from "../managedRuntime/LaunchGate.ts";
import { ProviderMaintenanceRunner } from "../providerMaintenanceRunner.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { forgetAcpRegistryAgentState } from "./AcpRegistryAgentState.ts";
import {
  type AcpRegistryCatalogEntry,
  type AcpRegistryCatalogSnapshot,
  makeAcpRegistryCatalog,
  toAcpRegistryCatalog,
} from "./AcpRegistryCatalog.ts";

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
   * For `server.updateProvider` on a community agent: checks the recipe the
   * client named and makes it the one the install or update will use. Fails
   * with a message to show when the listing has moved on.
   */
  readonly prepareMaintenance: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly action: ServerProviderMaintenanceAction;
    readonly recipeDigest: string | undefined;
  }) => Effect.Effect<void, { readonly message: string }>;
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

export const makeAcpRegistryAgents = Effect.fn("makeAcpRegistryAgents")(function* () {
  const settingsService = yield* ServerSettingsService;
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry;
  const authSessions = yield* ProviderAuthSessions;
  const maintenanceRunner = yield* ProviderMaintenanceRunner;
  const serverConfig = yield* ServerConfig;

  const catalog = makeAcpRegistryCatalog({
    cacheDir: NodePath.join(serverConfig.stateDir, "caches", "acp-registry"),
    platform: process.platform,
    arch: process.arch,
  });

  /** The community agents in settings, by instance id. */
  const communityInstances = settingsService.getSettings.pipe(
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
    Effect.orElseSucceed(() => []),
  );

  const contextFor = (agentId: string, displayName: string): AcpRegistryAgentContext =>
    acpRegistryAgentContext({ stateDir: serverConfig.stateDir, agentId, displayName });

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
          compareSemver(entry.agent.version, installed.receipt.recipe.version) > 0;
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
    catalog.get({ refresh }).pipe(Effect.tap((snapshot) => noteUpdates(snapshot)));

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
      const context = contextFor(input.agentId, entry.agent.name);

      // Recorded before anything is fetched: what the user agreed to install.
      yield* context.installer
        .confirm(entry.recipe)
        .pipe(Effect.catch((error) => fail("filesFailed", error.message)));
      yield* writeAcpRegistryListing(context.root, listingOf(entry));
      context.state.requestedRecipeDigest = entry.agent.recipeDigest;

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
        yield* maintenanceRunner
          .updateProvider({ provider: ACP_REGISTRY_DRIVER_KIND, instanceId, action: "install" })
          .pipe(Effect.ignore, Effect.forkDetach);
      } else {
        yield* Effect.logWarning("community agent added but its instance isn't running yet", {
          instanceId,
        });
      }
      return { instanceId };
    });

  const remove: AcpRegistryAgentsShape["remove"] = (input) =>
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
      const reopen = yield* closeLaunchGate(context.state.gate, {
        whenAlreadyClosed: stillRunning,
        whenStillHeld: stillRunning,
        stop: stopSessions,
      });

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
      yield* waitForInstance(instanceId, false);
    });

  const prepareMaintenance: AcpRegistryAgentsShape["prepareMaintenance"] = (input) =>
    Effect.gen(function* () {
      const found = (yield* communityInstances).find(([id]) => id === input.instanceId);
      if (!found) return yield* Effect.fail({ message: "That agent is no longer here." });
      const [, instance, agentId] = found;
      const displayName = instance.displayName ?? agentId;
      const context = contextFor(agentId, displayName);
      const lookAgain = { message: "A newer version was listed. Look again." };
      const { recipeDigest } = input;
      if (!recipeDigest) return yield* Effect.fail(lookAgain);

      if (input.action === "install") {
        // Try again, repair: only something the user already confirmed.
        const confirmed = yield* context.installer.confirmed;
        if (!confirmed.some((entry) => entry.recipeDigest === recipeDigest)) {
          return yield* Effect.fail(lookAgain);
        }
      } else {
        // The notice the user saw, taken as it is now: a copy of the recipe
        // is confirmed here, so the install uses it even if the registry
        // moves while it waits its turn.
        if (context.state.updateCandidate?.recipeDigest !== recipeDigest) {
          return yield* Effect.fail(lookAgain);
        }
        const snapshot = yield* catalog.peek;
        const entry = snapshot?.entries.find(
          (candidate) =>
            candidate.agent.agentId === agentId && candidate.agent.recipeDigest === recipeDigest,
        );
        if (!entry || !snapshot?.quarantineKnown) return yield* Effect.fail(lookAgain);
        yield* context.installer
          .confirm(entry.recipe)
          .pipe(Effect.mapError((error) => ({ message: error.message })));
      }
      context.state.requestedRecipeDigest = recipeDigest;
    });

  const requestCheck: AcpRegistryAgentsShape["requestCheck"] = (instanceId) =>
    Effect.gen(function* () {
      const found = (yield* communityInstances).find(([id]) => id === instanceId);
      if (!found) return;
      contextFor(found[2], found[1].displayName ?? found[2]).state.checkRequested = true;
    });

  // Update notices: read the registry now and then, but only while a
  // community agent is there to have one.
  yield* Effect.gen(function* () {
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
    prepareMaintenance,
    requestCheck,
  } satisfies AcpRegistryAgentsShape;
});

export const AcpRegistryAgentsLive = Layer.effect(AcpRegistryAgents, makeAcpRegistryAgents());

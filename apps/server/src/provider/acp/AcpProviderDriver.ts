/**
 * AcpProviderDriver — turns an `AcpProviderDescriptor` into a `ProviderDriver`.
 *
 * Every ACP-backed provider (Cursor, fx, …) is this factory applied to a
 * descriptor. The instance bundles a managed snapshot (CLI probe + ACP
 * model discovery with background enrichment), the generic ACP adapter and
 * ACP-backed text generation.
 *
 * @module provider/acp/AcpProviderDriver
 */
import type { ServerProvider, ServerProviderSlashCommand } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../../config.ts";
import { appendUsageLedgerEntry, type UsageLedgerEntry } from "../../usage/usageLedger.ts";
import { ProviderDriverError } from "../Errors.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { resolveCommandPath } from "@threadlines/shared/shell";

import {
  commandActionFrom,
  installerReinstallAction,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import { withKnownCliDirsOnPath } from "../providerDetection.ts";
import {
  groupSessionCommands,
  type ServerProviderDraft,
  withSessionCommands,
} from "../providerSnapshot.ts";
export { groupSessionCommands, withSessionCommands };
import { type AcpAdapterOptions, makeAcpAdapter } from "./AcpAdapter.ts";
import {
  buildInitialAcpProviderSnapshot,
  checkAcpProviderStatus,
  enrichAcpSnapshot,
  makeAcpCatalogCache,
} from "./AcpProvider.ts";
import type { AcpProviderDescriptor, AcpProviderSettings } from "./AcpProviderDescriptor.ts";
import { makeAcpTextGeneration } from "./AcpTextGeneration.ts";

const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type AcpProviderDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

/**
 * The descriptor's static update capabilities, plus its platform install
 * command while the binary is missing from PATH (a configured absolute path
 * is the user's business, so it never triggers an install offer). A binary
 * found where that installer puts it gets the installer as its reinstall,
 * for when it cannot start: the update is the agent's own CLI.
 */
export function makeAcpProviderMaintenanceResolver<Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (options) => {
      const binaryPath = options?.binaryPath?.trim() || "";
      const platform = options?.platform ?? process.platform;
      const install = descriptor.install?.[platform];
      const isBareName = binaryPath.length > 0 && !/[\\/]/.test(binaryPath);
      const resolves =
        binaryPath.length > 0 &&
        (options?.realCommandPath ||
          resolveCommandPath(binaryPath, {
            platform,
            ...(options?.env ? { env: options.env } : {}),
          }));
      // The updater is the agent's own CLI (`cursor-agent update`); find it where a
      // session would, including installer dirs a stale server PATH misses.
      const update = descriptor.maintenance.update;
      const maintenance = update
        ? {
            ...descriptor.maintenance,
            update: {
              ...update,
              executable: resolveAcpBinaryPath(
                descriptor,
                update.executable,
                options?.env ?? process.env,
                platform,
              ),
            },
          }
        : descriptor.maintenance;
      if (!install) {
        return maintenance;
      }
      if (isBareName && !resolves) {
        return { ...maintenance, install: commandActionFrom(install) };
      }
      // Found, by name or by a configured path: the installer's own copy is
      // the installer's to put back.
      const env = options?.env ?? process.env;
      const found = normalizeCommandPath(
        resolveAcpBinaryPath(descriptor, binaryPath, env, platform),
      );
      const isInstallersCopy = (descriptor.installerBinaries?.(env, platform) ?? []).some(
        (candidate) => normalizeCommandPath(candidate) === found,
      );
      return isInstallersCopy
        ? {
            ...maintenance,
            // Under the update's lock when there is one: both write this copy.
            repair: installerReinstallAction(install, update?.lockKey ?? install.lockKey, env),
          }
        : maintenance;
    },
  };
}

const isBareCommandName = (binaryPath: string): boolean =>
  binaryPath.length > 0 && !/[\\/]/.test(binaryPath);

export function resolveAcpBinaryPath<Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
  binaryPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = binaryPath.trim();
  if (!isBareCommandName(trimmed) || descriptor.resolveBinaryOnHost?.(platform) === false) {
    return trimmed;
  }
  return (
    resolveCommandPath(trimmed, { platform, env: withKnownCliDirsOnPath(env, platform) }) ?? trimmed
  );
}

export interface AcpProviderDriverOptions<Settings extends AcpProviderSettings, R = never> {
  readonly promptSuggestions?: (context: {
    readonly descriptor: AcpProviderDescriptor<Settings>;
    readonly settings: Settings;
    readonly environment: NodeJS.ProcessEnv;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
  }) => Effect.Effect<NonNullable<AcpAdapterOptions<Settings>["promptSuggestions"]>, never, R>;
}

export function makeAcpProviderDriver<Settings extends AcpProviderSettings, R = never>(
  descriptor: AcpProviderDescriptor<Settings>,
  driverOptions?: AcpProviderDriverOptions<Settings, R>,
): ProviderDriver<Settings, AcpProviderDriverEnv | R> {
  const DRIVER_KIND = descriptor.driverKind;
  const maintenanceResolver = makeAcpProviderMaintenanceResolver(descriptor);

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: descriptor.presentation.displayName,
      supportsMultipleInstances: true,
    },
    configSchema: descriptor.settingsSchema,
    defaultConfig: descriptor.defaultSettings,
    create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const httpClient = yield* HttpClient.HttpClient;
        const eventLoggers = yield* ProviderEventLoggers;
        const processEnv = mergeProviderInstanceEnvironment(environment);
        const continuationIdentity = descriptor.continuationKey
          ? {
              driverKind: DRIVER_KIND,
              continuationKey: descriptor.continuationKey(config, processEnv),
            }
          : defaultProviderContinuationIdentity({ driverKind: DRIVER_KIND, instanceId });
        // What each running session listed (`agentCommands` descriptors),
        // by session key: live state on the status, never stored, so every
        // snapshot (a scheduled check included) carries the current lists.
        const sessionCommands = new Map<string, ReadonlyArray<ServerProviderSlashCommand>>();
        const stampInstance = (snapshot: ServerProviderDraft): ServerProvider => ({
          ...snapshot,
          instanceId,
          driver: DRIVER_KIND,
          ...(displayName ? { displayName } : {}),
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
          ...(descriptor.agentCommands?.slashSkills === true ? { slashSkills: true } : {}),
          ...descriptor.snapshotExtras?.(),
        });
        // Every snapshot carries the lists as they are now, never ones it was
        // built from (an enrichment that read the status before a session ended).
        const stampIdentity = (snapshot: ServerProviderDraft): ServerProvider =>
          withSessionCommands(stampInstance(snapshot), sessionCommands);
        // A bare binary name is resolved once against the server's PATH plus
        // the known CLI install folders, so a CLI installed after the process
        // started (or one living outside cmd.exe's view) still spawns.
        const effectiveConfig: Settings = {
          ...config,
          enabled,
          binaryPath: resolveAcpBinaryPath(descriptor, config.binaryPath, processEnv),
        };
        let maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          maintenanceResolver,
          { binaryPath: config.binaryPath, env: processEnv },
        );
        const refreshMaintenance = (options?: { readonly allowNetworkWait?: boolean }) =>
          descriptor.resolveMaintenance
            ? descriptor.resolveMaintenance(effectiveConfig, options).pipe(
                Effect.tap((capabilities) =>
                  Effect.sync(() => {
                    maintenanceCapabilities = capabilities;
                  }),
                ),
              )
            : Effect.void;

        const serverConfig = yield* ServerConfig;
        const usageLedger = descriptor.usageLedger;
        const recordTurnUsage = usageLedger
          ? (entry: UsageLedgerEntry) =>
              appendUsageLedgerEntry({
                stateDir: serverConfig.stateDir,
                provider: usageLedger.provider,
                entry,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                // A lost usage line must never fail the turn it describes.
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not record a turn's usage", { instanceId, cause }),
                ),
              )
          : undefined;
        // Set once the snapshot exists; sessions only start after that.
        let liveSnapshot: ServerProviderShape | undefined;
        const agentCommandHooks =
          descriptor.agentCommands === undefined
            ? {}
            : {
                onSessionCommands: (
                  sessionKey: string,
                  commands: ReadonlyArray<ServerProviderSlashCommand> | undefined,
                ) =>
                  Effect.suspend(() => {
                    if (commands === undefined) sessionCommands.delete(sessionKey);
                    else sessionCommands.set(sessionKey, commands);
                    // An unchanged status is not published again.
                    return (
                      liveSnapshot?.patchSnapshot((current) =>
                        withSessionCommands(current, sessionCommands),
                      ) ?? Effect.void
                    );
                  }).pipe(Effect.ignoreCause({ log: true })),
                skillNames: Effect.suspend(
                  () => liveSnapshot?.getSnapshot ?? Effect.succeed(undefined),
                ).pipe(
                  Effect.map(
                    (current): ReadonlySet<string> =>
                      new Set(
                        (current?.skills ?? [])
                          .filter((skill) => skill.enabled)
                          .map((skill) => skill.name),
                      ),
                  ),
                ),
              };
        const promptSuggestions = driverOptions?.promptSuggestions
          ? yield* driverOptions.promptSuggestions({
              descriptor,
              settings: effectiveConfig,
              environment: processEnv,
              getSnapshot: Effect.suspend(
                () => liveSnapshot?.getSnapshot ?? Effect.die("ACP provider snapshot not ready"),
              ),
            })
          : undefined;
        const adapter = yield* makeAcpAdapter(descriptor, effectiveConfig, {
          environment: processEnv,
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
          instanceId,
          ...(recordTurnUsage ? { recordTurnUsage } : {}),
          ...(promptSuggestions ? { promptSuggestions } : {}),
          ...agentCommandHooks,
        });
        const textGeneration = yield* makeAcpTextGeneration(
          descriptor,
          effectiveConfig,
          processEnv,
        );

        // Reading the catalog opens a session, which some agents keep on
        // disk: the scheduled check reuses the last one while it is fresh.
        const catalog = makeAcpCatalogCache();
        const check = (reuseCatalog: boolean) =>
          checkAcpProviderStatus(descriptor, effectiveConfig, processEnv, process.platform, {
            cache: catalog,
            reuse: reuseCatalog,
          }).pipe(
            Effect.tap(() => refreshMaintenance({ allowNetworkWait: true })),
            Effect.map(stampIdentity),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(Path.Path, path),
          );
        const checkProvider = check(false);
        let initialSettingsLoaded = false;

        const snapshot = yield* makeManagedServerProvider<Settings>({
          get maintenanceCapabilities() {
            return maintenanceCapabilities;
          },
          getSettings: Effect.suspend(() => {
            const allowNetworkWait = initialSettingsLoaded;
            initialSettingsLoaded = true;
            return refreshMaintenance({ allowNetworkWait }).pipe(Effect.as(effectiveConfig));
          }),
          streamSettings: Stream.never,
          haveSettingsChanged: () => false,
          initialSnapshot: (settings) =>
            buildInitialAcpProviderSnapshot(descriptor, settings, processEnv).pipe(
              Effect.map(stampIdentity),
            ),
          checkProvider,
          scheduledCheckProvider: check(true),
          ...(descriptor.reconcileSnapshot
            ? { reconcileSnapshot: descriptor.reconcileSnapshot }
            : {}),
          enrichSnapshot: ({
            settings,
            snapshot: currentSnapshot,
            publishSnapshot,
            updateSnapshot,
          }) =>
            enrichAcpSnapshot({
              descriptor,
              settings,
              environment: processEnv,
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              publishSnapshot,
              updateSnapshot,
              stampIdentity,
              httpClient,
              catalog,
            }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
          shouldScheduleRefresh: (settings) => settings.enabled,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Failed to build ${descriptor.presentation.displayName} snapshot: ${cause.message ?? String(cause)}`,
                cause,
              }),
          ),
        );

        liveSnapshot = snapshot;

        return {
          instanceId,
          driverKind: DRIVER_KIND,
          continuationIdentity,
          displayName,
          accentColor,
          enabled,
          snapshot,
          adapter,
          textGeneration,
        } satisfies ProviderInstance;
      }),
  };
}

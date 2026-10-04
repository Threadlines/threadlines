/**
 * OpenCodeDriver — `ProviderDriver` for OpenCode 2.
 *
 * Each instance owns one `OpenCodeServerManager`: a private OpenCode server
 * shared by the instance's adapter (every thread), its snapshot probe and its
 * text generation, started on first use and stopped when idle. Instances with
 * a `serverUrl` talk to that server instead and never start one.
 *
 * @module provider/Drivers/OpenCodeDriver
 */
import { OpenCodeSettings, ProviderDriverKind, type ServerProvider } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { openCodeAccountEnvironment } from "@threadlines/shared/providerAuthCommands";

import { ServerConfig } from "../../config.ts";
import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import {
  checkOpenCodeProviderStatus,
  makePendingOpenCodeProvider,
} from "../Layers/OpenCodeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  openCodeMaintenanceBinaryPath,
  openCodeMaintenanceResolver,
  openCodeOneMigrationCapabilities,
  resolveOpenCodeBinary,
} from "../opencode/OpenCodeBinary.ts";
import { isOpenCodeOneVersion } from "../opencode/OpenCodeServer.ts";
import { makeOpenCodeServerManager } from "../opencode/OpenCodeServerManager.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  mergeProviderInstanceEnvironment,
  refreshProviderInstanceEnvironment,
} from "../ProviderInstanceEnvironment.ts";
import {
  createProviderVersionAdvisory,
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCommandAction,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";

const decodeOpenCodeSettings = Schema.decodeSync(OpenCodeSettings);

const DRIVER_KIND = ProviderDriverKind.make("opencode");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type OpenCodeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OpenCodeDriver: ProviderDriver<OpenCodeSettings, OpenCodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCodeSettings,
  defaultConfig: (): OpenCodeSettings => decodeOpenCodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const httpClient = yield* HttpClient.HttpClient;
      const eventLoggers = yield* ProviderEventLoggers;
      // An account folder gives this instance its own OpenCode database (its
      // sign-ins and sessions). With a server URL the data lives with that
      // server instead. Copied, never assigned into: the merge can return
      // `process.env` itself.
      const accountFolder = config.serverUrl.trim() ? "" : config.accountFolder.trim();
      const accountEnvironment = openCodeAccountEnvironment({
        accountFolder,
        platform: process.platform,
      });
      if (accountFolder) {
        yield* fileSystem.makeDirectory(accountFolder, { recursive: true, mode: 0o700 }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail: `Could not create the OpenCode account folder '${accountFolder}'.`,
                cause,
              }),
          ),
        );
      }
      const processEnv: NodeJS.ProcessEnv = {
        ...mergeProviderInstanceEnvironment(environment),
        ...accountEnvironment,
      };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const settings = { ...config, enabled } satisfies OpenCodeSettings;
      // Looked up each time it is needed, never once: a one-click install
      // lands in a directory this server's PATH may not include yet.
      const currentBinary = () => resolveOpenCodeBinary(settings.binaryPath, processEnv);
      // The regular install/update actions, and the Update that moves a 1.x
      // binary to OpenCode 2 instead.
      const resolveMaintenance = Effect.suspend(() => {
        const commandPath = currentBinary();
        return Effect.all({
          regular: resolveProviderMaintenanceCapabilitiesEffect(
            openCodeMaintenanceResolver(processEnv, settings.binaryPath),
            {
              binaryPath: openCodeMaintenanceBinaryPath(settings.binaryPath, processEnv),
              env: processEnv,
            },
          ),
          // A bare name here was found nowhere; there is nothing to resolve.
          realCommandPath: /[\\/]/u.test(commandPath)
            ? fileSystem.realPath(commandPath).pipe(Effect.orElseSucceed(() => commandPath))
            : Effect.succeed(commandPath),
        }).pipe(
          Effect.map(({ regular, realCommandPath }) => ({
            regular,
            oneMigration: openCodeOneMigrationCapabilities(regular, {
              commandPath,
              realCommandPath,
              env: processEnv,
            }),
          })),
        );
      }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      let maintenance = yield* resolveMaintenance;
      // From the last status check.
      let installedVersion: string | null = null;
      // The move offered for the last 1.x binary seen. A move that removed 1.x
      // but failed to install OpenCode 2 leaves no binary to classify, so
      // Install retries it (its steps tolerate the half-done state).
      let pendingMove: ProviderMaintenanceCommandAction | null = null;
      const capabilitiesFor = (version: string | null): ProviderMaintenanceCapabilities => {
        if (version) {
          return isOpenCodeOneVersion(version) ? maintenance.oneMigration : maintenance.regular;
        }
        return pendingMove ? { ...maintenance.regular, install: pendingMove } : maintenance.regular;
      };

      // Built first, so it is torn down last: the adapter's and text
      // generation's finalizers still talk to the server.
      const serverUrl = settings.serverUrl.trim();
      const manager = yield* makeOpenCodeServerManager({
        binaryPath: currentBinary,
        environment: processEnv,
        ...(serverUrl
          ? {
              externalServer: {
                url: serverUrl,
                password: settings.serverPassword.trim() || undefined,
              },
            }
          : {}),
      });

      const adapter = yield* makeOpenCodeAdapter({
        instanceId,
        settings,
        manager,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeOpenCodeTextGeneration(manager);

      const snapshot = yield* makeManagedServerProvider<OpenCodeSettings>({
        get maintenanceCapabilities() {
          return capabilitiesFor(installedVersion);
        },
        getSettings: Effect.gen(function* () {
          refreshProviderInstanceEnvironment(environment, processEnv);
          Object.assign(processEnv, accountEnvironment);
          maintenance = yield* resolveMaintenance;
          return settings;
        }),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (current) =>
          makePendingOpenCodeProvider(current, processEnv).pipe(Effect.map(stampIdentity)),
        checkProvider: Effect.suspend(() =>
          checkOpenCodeProviderStatus({
            settings: { ...settings, binaryPath: currentBinary() },
            manager,
            cwd: serverConfig.cwd,
            environment: processEnv,
            canMoveToOpenCodeTwo: maintenance.oneMigration.update !== null,
          }),
        ).pipe(
          Effect.map(stampIdentity),
          Effect.tap((current) =>
            Effect.sync(() => {
              installedVersion = current.version;
              if (current.version) {
                pendingMove = isOpenCodeOneVersion(current.version)
                  ? maintenance.oneMigration.update
                  : null;
              }
            }),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
        enrichSnapshot: ({ snapshot: current, publishSnapshot }) => {
          const capabilities = capabilitiesFor(current.version);
          // A 1.x install Threadlines cannot move gets no "update available";
          // the status message says how to install OpenCode 2.
          return current.version && isOpenCodeOneVersion(current.version) && !capabilities.update
            ? publishSnapshot({
                ...current,
                versionAdvisory: createProviderVersionAdvisory({
                  driver: current.driver,
                  currentVersion: current.version,
                  checkedAt: current.checkedAt,
                }),
              })
            : enrichProviderSnapshotWithVersionAdvisory(current, capabilities).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.flatMap(publishSnapshot),
              );
        },
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenCode snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

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

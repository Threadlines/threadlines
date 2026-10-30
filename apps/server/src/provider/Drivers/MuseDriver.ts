/**
 * MuseDriver — `ProviderDriver` for Muse Code.
 *
 * Each thread gets its own `muse serve` host (see MuseAdapter); status checks
 * and text generation start short-lived hosts that can do nothing but answer.
 * The data-sharing choice (Contributor mode) lives in Muse's own settings
 * file and is passed to every host as `--contributor-mode on|off`.
 *
 * @module provider/Drivers/MuseDriver
 */
import {
  MuseSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../../config.ts";
import { makeMuseTextGeneration } from "../../textGeneration/MuseTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeMuseAdapter } from "../Layers/MuseAdapter.ts";
import {
  checkMuseProviderStatus,
  makePendingMuseProvider,
  museAccountUsage,
} from "../Layers/MuseProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  fetchLatestMuseVersion,
  isMuseLauncherScript,
  museMaintenanceCapabilities,
  resolveMuseBinary,
} from "../muse/MuseBinary.ts";
import { museHostEnvironment, refreshMuseHostEnvironment } from "../muse/MuseLaunch.ts";
import { readMuseDataSharing, writeMuseDataSharing } from "../muse/MuseSettingsFile.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  createProviderVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import type { MuseSubscriptionUsage } from "../muse/MuseProtocol.ts";

const decodeMuseSettings = Schema.decodeSync(MuseSettings);

const DRIVER_KIND = ProviderDriverKind.make("muse");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
/** Meta's launcher script is small; anything bigger is the binary itself. */
const LAUNCHER_MAX_BYTES = 128 * 1024;

export type MuseDriverEnv =
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

export const MuseDriver: ProviderDriver<MuseSettings, MuseDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Muse Code",
    supportsMultipleInstances: true,
  },
  configSchema: MuseSettings,
  defaultConfig: (): MuseSettings => decodeMuseSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const httpClient = yield* HttpClient.HttpClient;
      const eventLoggers = yield* ProviderEventLoggers;
      // Copied, never assigned into: hosts read it live.
      const processEnv: NodeJS.ProcessEnv = museHostEnvironment(environment);
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
      const settings = { ...config, enabled } satisfies MuseSettings;
      // Looked up each time: a one-click install lands where PATH may not reach yet.
      const currentBinary = () => resolveMuseBinary(settings.binaryPath, processEnv);

      const resolveMaintenance = Effect.gen(function* () {
        const commandPath = currentBinary();
        const found = /[\\/]/u.test(commandPath);
        const realCommandPath = found
          ? yield* fileSystem.realPath(commandPath).pipe(Effect.orElseSucceed(() => commandPath))
          : commandPath;
        const isLauncher = found
          ? yield* fileSystem.stat(realCommandPath).pipe(
              Effect.flatMap((info) =>
                Number(info.size) > LAUNCHER_MAX_BYTES
                  ? Effect.succeed(false)
                  : fileSystem
                      .readFileString(realCommandPath)
                      .pipe(Effect.map(isMuseLauncherScript)),
              ),
              Effect.orElseSucceed(() => false),
            )
          : false;
        return museMaintenanceCapabilities({
          commandPath,
          realCommandPath,
          isLauncher,
          installed: found,
          env: processEnv,
        });
      });
      let maintenance: ProviderMaintenanceCapabilities = yield* resolveMaintenance;

      // What the last live host reported, for the adapter.
      let sandboxAvailable: boolean | undefined;
      let liveModels: ReadonlyArray<ServerProviderModel> = [];
      const readContributorMode = readMuseDataSharing(processEnv).pipe(
        Effect.map((state) => (state.error ? undefined : state.enabled)),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
      const dataSharingSnapshot = readMuseDataSharing(processEnv).pipe(
        Effect.map((state) => ({
          enabled: state.enabled,
          acknowledged: state.acknowledged,
          settingsPath: state.settingsPath,
          ...(state.error ? { error: state.error } : {}),
        })),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );

      // The adapter reports subscription usage and sign-in changes into the
      // snapshot, which is built after it.
      let snapshotShape: ServerProviderShape | undefined;
      const patchUsage = (usage: MuseSubscriptionUsage) =>
        Effect.gen(function* () {
          const accountUsage = museAccountUsage(usage, DateTime.formatIso(yield* DateTime.now));
          if (!accountUsage || !snapshotShape) return;
          yield* snapshotShape.patchSnapshot((current) => ({ ...current, accountUsage }));
        });

      const adapter = yield* makeMuseAdapter({
        instanceId,
        settings,
        binaryPath: currentBinary,
        environment: processEnv,
        instanceEnvironment: environment,
        readContributorMode,
        sandboxAvailable: () => sandboxAvailable,
        models: () => liveModels,
        onSubscriptionUsage: patchUsage,
        onAccountChanged: Effect.suspend(() =>
          snapshotShape ? snapshotShape.refresh.pipe(Effect.ignore) : Effect.void,
        ),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeMuseTextGeneration({
        binaryPath: currentBinary,
        environment: processEnv,
        instanceEnvironment: environment,
        allowApiKeyBilling: settings.allowApiKeyBilling,
        readContributorMode,
      });

      const snapshot = yield* makeManagedServerProvider<MuseSettings>({
        get maintenanceCapabilities() {
          return maintenance;
        },
        getSettings: Effect.gen(function* () {
          refreshMuseHostEnvironment(processEnv, environment);
          maintenance = yield* resolveMaintenance;
          return settings;
        }),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (current) =>
          makePendingMuseProvider(current, processEnv).pipe(Effect.map(stampIdentity)),
        checkProvider: Effect.gen(function* () {
          const draft = yield* checkMuseProviderStatus({
            settings,
            binaryPath: currentBinary(),
            cwd: serverConfig.cwd,
            environment: processEnv,
            instanceEnvironment: environment,
            onFacts: (facts) =>
              Effect.sync(() => {
                sandboxAvailable = facts.sandboxAvailable;
                liveModels = facts.models;
              }),
          });
          const dataSharing = yield* dataSharingSnapshot;
          return stampIdentity({ ...draft, ...(settings.enabled ? { dataSharing } : {}) });
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        // Muse is not on npm: its newest release comes from Meta's channel manifest.
        enrichSnapshot: ({ snapshot: current, updateSnapshot }) =>
          Effect.gen(function* () {
            const latestVersion =
              current.enabled && current.installed && current.version
                ? yield* fetchLatestMuseVersion(processEnv)
                : null;
            const versionAdvisory = createProviderVersionAdvisory({
              driver: DRIVER_KIND,
              currentVersion: current.version,
              latestVersion,
              checkedAt: DateTime.formatIso(yield* DateTime.now),
              maintenanceCapabilities: maintenance,
            });
            yield* updateSnapshot((now) => ({ ...now, versionAdvisory }));
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Muse Code snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      snapshotShape = snapshot;

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
        dataSharing: {
          set: (next: boolean) =>
            writeMuseDataSharing(processEnv, next).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.mapError((error) => ({ message: error.reason })),
              Effect.andThen(
                snapshot.patchSnapshot((current) =>
                  current.dataSharing
                    ? {
                        ...current,
                        dataSharing: {
                          ...current.dataSharing,
                          enabled: next,
                          acknowledged: true,
                        },
                      }
                    : null,
                ),
              ),
            ),
        },
      } satisfies ProviderInstance;
    }),
};

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
import type { ServerProvider } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { resolveCommandPath, resolveKnownWindowsCliDirs } from "@threadlines/shared/shell";

import {
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { makeAcpAdapter } from "./AcpAdapter.ts";
import {
  buildInitialAcpProviderSnapshot,
  checkAcpProviderStatus,
  enrichAcpSnapshot,
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
 * is the user's business, so it never triggers an install offer).
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
      if (!install || !isBareName || resolves) {
        return descriptor.maintenance;
      }
      return {
        ...descriptor.maintenance,
        install: {
          command: install.displayCommand ?? [install.executable, ...install.args].join(" "),
          executable: install.executable,
          args: install.args,
          lockKey: install.lockKey,
        },
      };
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
  const searchPath = [env.PATH ?? env.Path ?? "", ...resolveKnownWindowsCliDirs(env)]
    .filter((entry) => entry.length > 0)
    .join(platform === "win32" ? ";" : ":");
  return (
    resolveCommandPath(trimmed, {
      platform,
      env: platform === "win32" ? { ...env, PATH: searchPath } : env,
    }) ?? trimmed
  );
}

export function makeAcpProviderDriver<Settings extends AcpProviderSettings>(
  descriptor: AcpProviderDescriptor<Settings>,
): ProviderDriver<Settings, AcpProviderDriverEnv> {
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
        const continuationIdentity = defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId,
        });
        const stampIdentity = (snapshot: ServerProviderDraft): ServerProvider => ({
          ...snapshot,
          instanceId,
          driver: DRIVER_KIND,
          ...(displayName ? { displayName } : {}),
          ...(accentColor ? { accentColor } : {}),
          continuation: { groupKey: continuationIdentity.continuationKey },
        });
        // A bare binary name is resolved once against the server's PATH plus
        // the known CLI install folders, so a CLI installed after the process
        // started (or one living outside cmd.exe's view) still spawns.
        const effectiveConfig: Settings = {
          ...config,
          enabled,
          binaryPath: resolveAcpBinaryPath(descriptor, config.binaryPath, processEnv),
        };
        const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          maintenanceResolver,
          { binaryPath: config.binaryPath, env: processEnv },
        );

        const adapter = yield* makeAcpAdapter(descriptor, effectiveConfig, {
          environment: processEnv,
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
          instanceId,
        });
        const textGeneration = yield* makeAcpTextGeneration(
          descriptor,
          effectiveConfig,
          processEnv,
        );

        const checkProvider = checkAcpProviderStatus(descriptor, effectiveConfig, processEnv).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );

        const snapshot = yield* makeManagedServerProvider<Settings>({
          maintenanceCapabilities,
          getSettings: Effect.succeed(effectiveConfig),
          streamSettings: Stream.never,
          haveSettingsChanged: () => false,
          initialSnapshot: (settings) =>
            buildInitialAcpProviderSnapshot(descriptor, settings).pipe(Effect.map(stampIdentity)),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
            enrichAcpSnapshot({
              descriptor,
              settings,
              environment: processEnv,
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              publishSnapshot,
              stampIdentity,
              httpClient,
            }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
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

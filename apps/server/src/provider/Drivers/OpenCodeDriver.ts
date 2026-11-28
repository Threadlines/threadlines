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
import { homedir } from "node:os";
import * as NodePath from "node:path";

import {
  OpenCodeSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderSlashCommand,
} from "@threadlines/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { openCodeAccountEnvironment } from "@threadlines/shared/providerAuthCommands";
import { usageResetTimeMs } from "@threadlines/shared/usageLimits";

import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { makeOpenCodeTextGeneration } from "../../textGeneration/OpenCodeTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCodeAdapter } from "../Layers/OpenCodeAdapter.ts";
import {
  checkOpenCodeProviderStatus,
  makePendingOpenCodeProvider,
  openCodeAccountUsage,
  openCodeUsageLimitFromAccountUsage,
} from "../Layers/OpenCodeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";
import {
  openCodeMaintenanceBinaryPath,
  openCodeMaintenanceResolver,
  openCodeOneMigrationCapabilities,
  resolveOpenCodeBinary,
} from "../opencode/OpenCodeBinary.ts";
import { runOpenCode } from "../opencode/OpenCodeClient.ts";
import {
  OPENCODE_DATABASE_FILE_NAME,
  openCodeDatabaseLocation,
} from "../opencode/OpenCodeDataPaths.ts";
import { isOpenCodeOneVersion } from "../opencode/OpenCodeServer.ts";
import { makeOpenCodeServerManager } from "../opencode/OpenCodeServerManager.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { type ServerProviderDraft, withSessionCommands } from "../providerSnapshot.ts";
import {
  mergeProviderInstanceEnvironment,
  refreshProviderInstanceEnvironment,
  setEnvVar,
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
/** How often an idle OpenCode instance with active Go/Zen usage limits re-reads them. */
const OPENCODE_SCHEDULED_USAGE_REFRESH_MS = 30 * 60 * 1000;
const CATALOG_REFRESH_DEBOUNCE = Duration.millis(250);
const USAGE_LIMIT_READ_TIMEOUT_MS = 5_000;

function earliestUsageResetMs(accountUsage: ServerProvider["accountUsage"]): number | undefined {
  let earliest: number | undefined;
  for (const limit of accountUsage?.limits ?? []) {
    for (const window of [limit.primary, limit.secondary, ...(limit.scoped ?? [])]) {
      const resetMs = usageResetTimeMs(window?.resetsAt);
      if (resetMs !== undefined && (earliest === undefined || resetMs < earliest)) {
        earliest = resetMs;
      }
    }
    const spendResetMs = usageResetTimeMs(limit.individualLimit?.resetsAt);
    if (spendResetMs !== undefined && (earliest === undefined || spendResetMs < earliest)) {
      earliest = spendResetMs;
    }
  }
  return earliest;
}

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
      const driverScope = yield* Scope.Scope;
      // An account folder gives this instance its own OpenCode database (its
      // sign-ins and sessions). With a server URL the data lives with that
      // server instead. Copied, never assigned into: the merge can return
      // `process.env` itself.
      const rawAccountFolder = config.serverUrl.trim() ? "" : config.accountFolder.trim();
      const accountFolder = rawAccountFolder ? expandHomePath(rawAccountFolder) : "";
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
      const applyAccountEnvironment = (target: NodeJS.ProcessEnv) => {
        for (const [key, value] of Object.entries(accountEnvironment)) {
          setEnvVar(target, key, value);
        }
      };
      const processEnv: NodeJS.ProcessEnv = {
        ...mergeProviderInstanceEnvironment(environment),
      };
      applyAccountEnvironment(processEnv);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const sessionCommands = new Map<string, ReadonlyArray<ServerProviderSlashCommand>>();
      const stampBaseIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const stampIdentity = (draft: ServerProviderDraft): ServerProvider =>
        withSessionCommands(stampBaseIdentity(draft), sessionCommands);
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

      // Set once the snapshot exists; sessions and live SSE callbacks run after that.
      let liveSnapshot: ServerProviderShape | undefined;
      let catalogRefreshPending = false;
      const scheduleCatalogRefresh = Effect.suspend(() => {
        cachedProbe = undefined;
        if (catalogRefreshPending) return Effect.void;
        catalogRefreshPending = true;
        return Effect.sleep(CATALOG_REFRESH_DEBOUNCE).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              catalogRefreshPending = false;
              return liveSnapshot ? liveSnapshot.refresh.pipe(Effect.ignore) : Effect.void;
            }),
          ),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              catalogRefreshPending = false;
            }),
          ),
          Effect.forkIn(driverScope),
          Effect.asVoid,
        );
      });

      const readUsageLimit = Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const running = yield* manager.running;
        if (running && typeof running.client.experimental?.usage?.limits === "function") {
          const checkedAt = DateTime.formatIso(yield* DateTime.now);
          const fresh = yield* runOpenCode(
            "usage.limits",
            (signal) =>
              running.client.experimental.usage.limits(
                { location: { directory: serverConfig.cwd } },
                { signal },
              ),
            { timeoutMs: USAGE_LIMIT_READ_TIMEOUT_MS },
          ).pipe(
            Effect.map((result) => openCodeAccountUsage(result.data, checkedAt)),
            Effect.orElseSucceed(() => undefined),
          );
          if (fresh) {
            if (cachedProbe) {
              cachedProbe = {
                ...cachedProbe,
                snapshot: { ...cachedProbe.snapshot, accountUsage: fresh },
                checkedAtMs: nowMs,
                earliestResetMs: earliestUsageResetMs(fresh),
                usageLimitsFailed: false,
              };
            }
            if (liveSnapshot) {
              yield* liveSnapshot
                .patchSnapshot((current) => ({ ...current, accountUsage: fresh }))
                .pipe(Effect.ignore);
            }
            return openCodeUsageLimitFromAccountUsage(fresh, nowMs);
          }
        }
        const current = liveSnapshot ? yield* liveSnapshot.getSnapshot : undefined;
        return openCodeUsageLimitFromAccountUsage(current?.accountUsage, nowMs);
      });

      const adapter = yield* makeOpenCodeAdapter({
        instanceId,
        settings,
        manager,
        onSessionCommands: (sessionKey, commands) =>
          Effect.suspend(() => {
            if (commands === undefined) sessionCommands.delete(sessionKey);
            else sessionCommands.set(sessionKey, commands);
            return (
              liveSnapshot?.patchSnapshot((current) =>
                withSessionCommands(current, sessionCommands),
              ) ?? Effect.void
            );
          }).pipe(Effect.ignoreCause({ log: true })),
        onCatalogChanged: scheduleCatalogRefresh,
        readUsageLimit,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeOpenCodeTextGeneration(manager);

      // Scheduled ticks reuse the last check for local instances while the
      // binary, OpenCode database/auth files, and config files on disk are
      // unchanged so we never wake an idle `opencode serve` or reset its
      // 10-minute idle timer every 5 minutes. External servers are always
      // probed directly since no local process is spawned.
      let cachedProbe:
        | {
            readonly signature: string;
            readonly snapshot: ServerProvider;
            readonly checkedAtMs: number;
            readonly earliestResetMs: number | undefined;
            readonly usageLimitsFailed: boolean;
          }
        | undefined;
      let lastKnownAccountUsage: ServerProvider["accountUsage"];
      const statSig = (targetPath: string) =>
        fileSystem.stat(targetPath).pipe(
          Effect.map((info) => {
            const mtimeMs = Option.match(info.mtime, {
              onNone: () => "",
              onSome: (date) => String(date.getTime()),
            });
            return `${targetPath}\u0000${Number(info.size)}\u0000${mtimeMs}`;
          }),
          Effect.orElseSucceed(() => `missing:${targetPath}`),
        );
      const probeSignature = Effect.gen(function* () {
        if (serverUrl) return `external:${serverUrl}`;
        const binaryPath = currentBinary();
        const dbLocation = openCodeDatabaseLocation({
          accountFolder,
          environment: processEnv,
        });
        const home =
          (process.platform === "win32" ? processEnv.USERPROFILE : processEnv.HOME)?.trim() ||
          homedir();
        const configDir =
          processEnv.OPENCODE_CONFIG_DIR?.trim() ||
          NodePath.join(
            processEnv.XDG_CONFIG_HOME?.trim() || NodePath.join(home, ".config"),
            "opencode",
          );
        const pathsToStat: string[] = [
          configDir,
          NodePath.join(configDir, "opencode.json"),
          NodePath.join(configDir, "opencode.jsonc"),
          NodePath.join(configDir, "config.json"),
        ];
        const explicitConfig = processEnv.OPENCODE_CONFIG?.trim();
        if (explicitConfig) pathsToStat.push(explicitConfig);
        if ("file" in dbLocation) {
          const dir = NodePath.dirname(dbLocation.file);
          pathsToStat.push(
            dir,
            dbLocation.file,
            `${dbLocation.file}-wal`,
            NodePath.join(dir, "auth.json"),
          );
        } else {
          pathsToStat.push(
            dbLocation.folder,
            NodePath.join(dbLocation.folder, "auth.json"),
            NodePath.join(dbLocation.folder, "opencode.db"),
            NodePath.join(dbLocation.folder, "opencode.db-wal"),
          );
          const dataEntries = yield* fileSystem
            .readDirectory(dbLocation.folder)
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
          for (const entry of dataEntries.toSorted()) {
            if (OPENCODE_DATABASE_FILE_NAME.test(entry) && entry !== "opencode.db") {
              const dbPath = NodePath.join(dbLocation.folder, entry);
              pathsToStat.push(dbPath, `${dbPath}-wal`);
            }
          }
        }
        const binarySig = /[\\/]/u.test(binaryPath)
          ? yield* statSig(binaryPath)
          : `missing:${binaryPath}`;
        const diskSigs = yield* Effect.forEach(pathsToStat, statSig, { concurrency: "unbounded" });
        return [binarySig, ...diskSigs].join("\u0001");
      });

      const runFullCheck = Effect.gen(function* () {
        const [signature, nowMs] = yield* Effect.all([probeSignature, Clock.currentTimeMillis], {
          concurrency: "unbounded",
        });
        let usageLimitsFailed = false;
        const draft = yield* checkOpenCodeProviderStatus({
          settings: { ...settings, binaryPath: currentBinary() },
          manager,
          cwd: serverConfig.cwd,
          environment: processEnv,
          canMoveToOpenCodeTwo: maintenance.oneMigration.update !== null,
          onUsageLimitsFailed: () => {
            usageLimitsFailed = true;
          },
        });
        // Preserve the last known account usage across a transient `usage.limits`
        // error instead of wiping active Go/Zen meters from the UI.
        const effectiveDraft =
          usageLimitsFailed && draft.accountUsage === undefined && lastKnownAccountUsage
            ? { ...draft, accountUsage: lastKnownAccountUsage }
            : draft;
        if (!usageLimitsFailed) {
          lastKnownAccountUsage = effectiveDraft.accountUsage;
        }
        const current = stampIdentity(effectiveDraft);
        installedVersion = current.version;
        if (current.version) {
          pendingMove = isOpenCodeOneVersion(current.version)
            ? maintenance.oneMigration.update
            : null;
        }
        const isStableUnauthenticated =
          current.installed &&
          current.status === "warning" &&
          current.auth.status === "unauthenticated";
        cachedProbe =
          !serverUrl &&
          (current.status === "ready" || !current.installed || isStableUnauthenticated)
            ? {
                signature,
                snapshot: current,
                checkedAtMs: nowMs,
                earliestResetMs: earliestUsageResetMs(current.accountUsage),
                usageLimitsFailed,
              }
            : undefined;
        return current;
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const scheduledCheck = Effect.gen(function* () {
        if (!settings.enabled) {
          return stampIdentity(yield* makePendingOpenCodeProvider(settings, processEnv));
        }
        if (serverUrl) {
          return yield* runFullCheck;
        }
        const [signature, nowMs] = yield* Effect.all([probeSignature, Clock.currentTimeMillis], {
          concurrency: "unbounded",
        });
        const usageRefreshDue =
          cachedProbe !== undefined &&
          (cachedProbe.usageLimitsFailed ||
            (cachedProbe.snapshot.accountUsage !== undefined &&
              (nowMs - cachedProbe.checkedAtMs >= OPENCODE_SCHEDULED_USAGE_REFRESH_MS ||
                (cachedProbe.earliestResetMs !== undefined &&
                  nowMs >= cachedProbe.earliestResetMs))));
        if (cachedProbe && cachedProbe.signature === signature && !usageRefreshDue) {
          const running = yield* manager.running;
          if (
            running &&
            cachedProbe.snapshot.version &&
            cachedProbe.snapshot.version !== running.version
          ) {
            yield* manager.retire;
          }
          return withSessionCommands(
            {
              ...cachedProbe.snapshot,
              checkedAt: DateTime.formatIso(yield* DateTime.now),
            },
            sessionCommands,
          );
        }
        return yield* runFullCheck;
      });

      const snapshot = yield* makeManagedServerProvider<OpenCodeSettings>({
        get maintenanceCapabilities() {
          return capabilitiesFor(installedVersion);
        },
        getSettings: Effect.gen(function* () {
          refreshProviderInstanceEnvironment(environment, processEnv);
          applyAccountEnvironment(processEnv);
          maintenance = yield* resolveMaintenance;
          return settings;
        }),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (current) =>
          makePendingOpenCodeProvider(current, processEnv).pipe(Effect.map(stampIdentity)),
        checkProvider: runFullCheck,
        scheduledCheckProvider: scheduledCheck,
        enrichSnapshot: ({ snapshot: current, updateSnapshot }) => {
          const capabilities = capabilitiesFor(current.version);
          // A 1.x install Threadlines cannot move gets no "update available";
          // the status message says how to install OpenCode 2.
          return current.version && isOpenCodeOneVersion(current.version) && !capabilities.update
            ? updateSnapshot((now) => ({
                ...now,
                versionAdvisory: createProviderVersionAdvisory({
                  driver: current.driver,
                  currentVersion: current.version,
                  checkedAt: current.checkedAt,
                }),
              }))
            : enrichProviderSnapshotWithVersionAdvisory(current, capabilities).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.flatMap((enriched) =>
                  updateSnapshot((now) => ({
                    ...now,
                    ...(enriched.versionAdvisory
                      ? { versionAdvisory: enriched.versionAdvisory }
                      : {}),
                  })),
                ),
              );
        },
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
        shouldScheduleRefresh: (current) => current.enabled,
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

/**
 * PiDriver — `ProviderDriver` for Pi (docs/providers/pi-plan.md).
 *
 * Each thread runs its own `pi --mode rpc` with the Threadlines extension
 * (see PiAdapter); status checks, titles and the sign-in terminal start
 * short-lived ones. Every process starts the same way (`PiLaunch`): the
 * user's own `pi` when it is new enough, else the copy Threadlines installs
 * (`PiRuntime`), leased for as long as the process runs.
 *
 * Pi keeps its own sign-ins. Sign in asks Pi's `/login` questions in the
 * sign-in panel (`PiSignIn`); a client that can't show them, or a user who
 * prefers it, gets Pi itself in the sign-in terminal. Pi saves what the user
 * enters; Threadlines never reads Pi's credentials.
 *
 * @module provider/Drivers/PiDriver
 */
import { homedir } from "node:os";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  PiSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { resolveCommandPath } from "@threadlines/shared/shell";
import { ServerConfig } from "../../config.ts";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import {
  checkPiProviderStatus,
  makePendingPiProvider,
  type PiProbeFacts,
} from "../Layers/PiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  findUserPi,
  isDefaultPiCommand,
  PI_PACKAGE_NAME,
  PI_UPDATE_LOCK,
  piUserMaintenance,
} from "../pi/PiBinary.ts";
import { findPiInstallation, type PiInstallation, piLaunchFor } from "../pi/PiInstallation.ts";
import { type PiLaunch, parsePiLaunchArgs, piProcessEnvironment } from "../pi/PiLaunch.ts";
import { piManagedRuntime } from "../pi/PiRuntime.ts";
import { runPiSignIn } from "../pi/PiSignIn.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  npmGlobalReinstallAction,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCommandAction,
  resolveLatestProviderVersion,
} from "../providerMaintenance.ts";

const PI_DRIVER_KIND = ProviderDriverKind.make("pi");

const decodePiSettings = Schema.decodeSync(PiSettings);

const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type PiDriverEnv =
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
    driver: PI_DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

const NO_MAINTENANCE: ProviderMaintenanceCapabilities = {
  provider: PI_DRIVER_KIND,
  packageName: PI_PACKAGE_NAME,
  update: null,
  install: null,
  manualUpdateCommand: null,
  advisoryMessage: null,
};

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: PI_DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const httpClient = yield* HttpClient.HttpClient;
      const eventLoggers = yield* ProviderEventLoggers;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: PI_DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const settings = { ...config, enabled } satisfies PiSettings;
      const parsedLaunchArgs = parsePiLaunchArgs(settings.launchArgs);
      // A bad value is reported when a thread starts; titles and checks run without it.
      const launchArgs = "args" in parsedLaunchArgs ? parsedLaunchArgs.args : [];
      const managed = piManagedRuntime(serverConfig.stateDir);
      const lookupEnvironment = () => mergeProviderInstanceEnvironment(environment);

      // Which Pi runs, from the last check; looked up now when there was none.
      // Never cleared before a refresh completes so concurrent session starts
      // keep using the valid installation instead of spawning duplicate probes.
      let installation: PiInstallation | undefined;
      const installationLock = yield* Semaphore.make(1);
      const resolveInstallation = (force: boolean) =>
        Effect.suspend(() => {
          if (!force && installation) return Effect.succeed(installation);
          return installationLock.withPermit(
            Effect.suspend(() => {
              if (!force && installation) return Effect.succeed(installation);
              return findPiInstallation({
                binaryPath: settings.binaryPath,
                environment: lookupEnvironment(),
                cwd: serverConfig.cwd,
                managed,
              }).pipe(
                Effect.tap((found) =>
                  Effect.sync(() => {
                    installation = found;
                  }),
                ),
              );
            }),
          );
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const currentInstallation = resolveInstallation(false);
      const launch: PiLaunch = currentInstallation.pipe(
        Effect.flatMap((current) => piLaunchFor(current, managed)),
      );

      /** Installs (or updates to) Pi's newest npm release as Threadlines' own copy. */
      const managedAction = (
        verb: "Install" | "Update",
      ): ProviderMaintenanceCommandAction | null =>
        managed && isDefaultPiCommand(settings.binaryPath)
          ? {
              command: `${verb} Pi (Threadlines installs its own copy from npm)`,
              executable: "threadlines",
              args: [],
              lockKey: "pi-runtime",
              run: Effect.gen(function* () {
                const latest = yield* resolveLatestProviderVersion(NO_MAINTENANCE);
                if (!latest) {
                  return yield* Effect.fail({
                    message: "Threadlines couldn't reach npm to find Pi's newest version.",
                  });
                }
                const version = yield* managed
                  .install(latest)
                  .pipe(Effect.mapError((error) => ({ message: error.message })));
                // The next check picks the new copy.
                installation = undefined;
                return { output: `Pi ${version} is installed.` };
              }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
            }
          : null;

      const maintenanceFor = (
        current: PiInstallation,
        realCommandPath: string | undefined,
      ): ProviderMaintenanceCapabilities => {
        switch (current.kind) {
          case "user":
          case "unusable": {
            // For a Pi that cannot start, which `pi update --self` cannot fix:
            // npm puts back a copy found in its tree; otherwise Threadlines
            // installs its own copy, which the next check then runs.
            const reinstall =
              npmGlobalReinstallAction({
                packageName: PI_PACKAGE_NAME,
                commandPath: current.command,
                realCommandPath: realCommandPath ?? current.command,
                env: lookupEnvironment(),
                lockKey: PI_UPDATE_LOCK,
              }) ?? managedAction("Install");
            return {
              ...piUserMaintenance({
                commandPath: current.command,
                realCommandPath: realCommandPath ?? current.command,
              }),
              install: managedAction("Install"),
              ...(reinstall ? { repair: reinstall } : {}),
            };
          }
          case "managed":
            return { ...NO_MAINTENANCE, update: managedAction("Update") };
          case "missing":
            return { ...NO_MAINTENANCE, install: managedAction("Install") };
        }
      };
      let maintenance: ProviderMaintenanceCapabilities = {
        ...NO_MAINTENANCE,
        install: managedAction("Install"),
      };
      const refreshMaintenance = (current: PiInstallation) =>
        Effect.gen(function* () {
          const realCommandPath =
            current.kind === "user" || current.kind === "unusable"
              ? yield* fileSystem
                  .realPath(current.command)
                  .pipe(Effect.orElseSucceed(() => current.command))
              : undefined;
          maintenance = maintenanceFor(current, realCommandPath);
        });

      const extensionDir = NodePath.join(serverConfig.stateDir, "pi");

      // What the last check found: the models (for thinking-level checks) and Pi's default.
      let liveModels: ReadonlyArray<ServerProviderModel> = [];
      let defaultModel: PiProbeFacts["defaultModel"];

      const adapter = yield* makePiAdapter({
        instanceId,
        settings,
        launch,
        instanceEnvironment: environment,
        extensionDir,
        models: () => liveModels,
        defaultModel: () => defaultModel,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makePiTextGeneration({
        launch,
        launchArgs,
        instanceEnvironment: environment,
      });

      const statSig = (targetPath: string | undefined) =>
        targetPath
          ? fileSystem.stat(targetPath).pipe(
              Effect.map((info) => {
                const mtimeMs = Option.match(info.mtime, {
                  onNone: () => "",
                  onSome: (date) => String(date.getTime()),
                });
                return `${targetPath}\u0000${Number(info.size)}\u0000${mtimeMs}`;
              }),
              Effect.orElseSucceed(() => `missing:${targetPath}`),
            )
          : Effect.succeed("none");

      const extensionsSigEffect = (extensionsDir: string): Effect.Effect<string> =>
        Effect.gen(function* () {
          const rootSig = yield* statSig(extensionsDir);
          if (rootSig.startsWith("missing:")) return rootSig;
          const entries = yield* fileSystem
            .readDirectory(extensionsDir)
            .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
          const sorted = entries.toSorted().slice(0, 64);
          const childSigs = yield* Effect.forEach(
            sorted,
            (name) => {
              const childPath = NodePath.join(extensionsDir, name);
              return fileSystem.stat(childPath).pipe(
                Effect.flatMap((info) => {
                  const mtimeMs = Option.match(info.mtime, {
                    onNone: () => "",
                    onSome: (date) => String(date.getTime()),
                  });
                  const selfSig = `${name}\u0000${Number(info.size)}\u0000${mtimeMs}`;
                  if (info.type !== "Directory") return Effect.succeed(selfSig);
                  return fileSystem.readDirectory(childPath).pipe(
                    Effect.flatMap((subEntries) =>
                      Effect.forEach(
                        subEntries.toSorted().slice(0, 32),
                        (sub) => statSig(NodePath.join(childPath, sub)),
                        { concurrency: 8 },
                      ),
                    ),
                    Effect.map((subSigs) => [selfSig, ...subSigs].join("\u0002")),
                    Effect.orElseSucceed(() => selfSig),
                  );
                }),
                Effect.orElseSucceed(() => `missing:${name}`),
              );
            },
            { concurrency: 8 },
          );
          return [rootSig, ...childSigs].join("\u0003");
        });

      const probeSignature = Effect.gen(function* () {
        const env = lookupEnvironment();
        const userCommand = findUserPi(settings.binaryPath, env);
        const nodeCommand = userCommand
          ? resolveCommandPath("node", { platform: process.platform, env })
          : undefined;
        const standIn = isDefaultPiCommand(settings.binaryPath) ? managed : undefined;
        const piAgentDir =
          env.PI_CODING_AGENT_DIR?.trim() ||
          NodePath.join(env.HOME?.trim() || homedir(), ".pi", "agent");
        const [userSig, nodeSig, managedVersion, authSig, settingsSig, modelsSig, extensionsSig] =
          yield* Effect.all(
            [
              statSig(userCommand),
              statSig(nodeCommand ?? undefined),
              standIn ? standIn.installed : Effect.succeed(undefined),
              statSig(NodePath.join(piAgentDir, "auth.json")),
              statSig(NodePath.join(piAgentDir, "settings.json")),
              statSig(NodePath.join(piAgentDir, "models.json")),
              extensionsSigEffect(NodePath.join(piAgentDir, "extensions")),
            ],
            { concurrency: "unbounded" },
          );
        return [
          userSig,
          nodeSig,
          managedVersion ?? "",
          authSig,
          settingsSig,
          modelsSig,
          extensionsSig,
        ].join("\u0001");
      });

      let cachedProbe:
        | {
            readonly signature: string;
            readonly snapshot: ServerProvider;
          }
        | undefined;

      const runFullCheck = Effect.gen(function* () {
        if (!settings.enabled) {
          return stampIdentity(yield* makePendingPiProvider(settings, lookupEnvironment()));
        }
        const signature = yield* probeSignature;
        // Looked up afresh on every full check without clearing the existing
        // installation while the probe is in flight.
        const current = yield* resolveInstallation(true);
        yield* refreshMaintenance(current);
        const draft = yield* checkPiProviderStatus({
          settings,
          installation: current,
          launch: piLaunchFor(current, managed),
          launchArgs,
          cwd: serverConfig.cwd,
          instanceEnvironment: environment,
          onFacts: (facts) =>
            Effect.sync(() => {
              liveModels = facts.models;
              defaultModel = facts.defaultModel;
            }),
        });
        const checked = stampIdentity(draft);
        cachedProbe =
          checked.status !== "error" || !checked.installed
            ? { signature, snapshot: checked }
            : undefined;
        return checked;
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const scheduledCheck = Effect.gen(function* () {
        if (!settings.enabled) {
          return stampIdentity(yield* makePendingPiProvider(settings, lookupEnvironment()));
        }
        const signature = yield* probeSignature;
        if (cachedProbe && cachedProbe.signature === signature) {
          return {
            ...cachedProbe.snapshot,
            checkedAt: DateTime.formatIso(yield* DateTime.now),
          };
        }
        return yield* runFullCheck;
      });

      const snapshot = yield* makeManagedServerProvider<PiSettings>({
        get maintenanceCapabilities() {
          return maintenance;
        },
        getSettings: Effect.succeed(settings),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (current) =>
          makePendingPiProvider(current, lookupEnvironment()).pipe(Effect.map(stampIdentity)),
        checkProvider: runFullCheck,
        scheduledCheckProvider: scheduledCheck,
        enrichSnapshot: ({ snapshot: current, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(current, maintenance).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(publishSnapshot),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
        shouldScheduleRefresh: (current) => current.enabled,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: PI_DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // Versions of Threadlines' copy that nothing runs any more; off the start path.
      if (managed) yield* Effect.forkDetach(managed.prune);

      return {
        instanceId,
        driverKind: PI_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
        authFlows: {
          flows: ["login"],
          describe: () => "Sign in to Pi",
          // Pi's sign-in, asked in the panel: which provider, then what it needs.
          run: ({ flow, report, ask, showCode }) =>
            flow === "login"
              ? runPiSignIn({
                  launch,
                  launchArgs,
                  instanceEnvironment: environment,
                  cwd: serverConfig.cwd,
                  extensionDir,
                  report,
                  ask,
                  showCode,
                }).pipe(
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                )
              : Effect.fail({ message: "Pi has no such sign-in flow." }),
          // Pi itself, without a saved session, where the user types `/login`:
          // for a client that can't show questions, or a user who asks for it.
          // The copy it runs stays leased until the terminal closes.
          terminalCommand: (flow, client) =>
            Effect.gen(function* () {
              if (flow !== "login" || client.questions) return undefined;
              const leaseScope = yield* Scope.make();
              const launcher = yield* launch.pipe(
                Scope.provide(leaseScope),
                Effect.onError(() => Scope.close(leaseScope, Exit.void)),
                Effect.mapError((error) => ({ message: error.message })),
              );
              return {
                file: launcher.command,
                args: [...launcher.prefixArgs, "--no-session"],
                env: piProcessEnvironment({ instanceEnvironment: environment }),
                display: "pi --no-session",
                // `/login` in Pi's terminal opens each sign-in page itself.
                opensPageItself: true,
                finished: () => Scope.close(leaseScope, Exit.void),
              };
            }),
          completeRedirect: () =>
            Effect.fail({ message: "Paste the address in Pi's question instead." }),
        },
      } satisfies ProviderInstance;
    }),
};

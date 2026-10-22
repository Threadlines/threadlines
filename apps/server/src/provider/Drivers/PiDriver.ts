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
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  PiSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

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
import { isDefaultPiCommand, PI_PACKAGE_NAME, piUserMaintenance } from "../pi/PiBinary.ts";
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
      let installation: PiInstallation | undefined;
      const currentInstallation = Effect.suspend(() =>
        installation
          ? Effect.succeed(installation)
          : findPiInstallation({
              binaryPath: settings.binaryPath,
              environment: lookupEnvironment(),
              cwd: serverConfig.cwd,
              managed,
            }).pipe(Effect.tap((found) => Effect.sync(() => (installation = found)))),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
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
          case "unusable":
            return {
              ...piUserMaintenance({
                commandPath: current.command,
                realCommandPath: realCommandPath ?? current.command,
              }),
              install: managedAction("Install"),
            };
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

      const snapshot = yield* makeManagedServerProvider<PiSettings>({
        get maintenanceCapabilities() {
          return maintenance;
        },
        getSettings: Effect.succeed(settings),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (current) =>
          makePendingPiProvider(current, lookupEnvironment()).pipe(Effect.map(stampIdentity)),
        checkProvider: Effect.gen(function* () {
          if (!settings.enabled) {
            return stampIdentity(yield* makePendingPiProvider(settings, lookupEnvironment()));
          }
          // Looked up afresh on every check: Pi may have been installed,
          // updated or removed since.
          installation = undefined;
          const current = yield* currentInstallation;
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
          return stampIdentity(draft);
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        enrichSnapshot: ({ snapshot: current, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(current, maintenance).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap(publishSnapshot),
          ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
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

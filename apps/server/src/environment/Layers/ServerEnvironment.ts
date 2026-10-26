import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@threadlines/contracts";
import { randomUUIDv4 } from "@threadlines/shared/uuid";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { layer as ProcessRunnerLive } from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerEnvironment, type ServerEnvironmentShape } from "../Services/ServerEnvironment.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

function platformOs(): ExecutionEnvironmentDescriptor["platform"]["os"] {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
}

function platformArch(): ExecutionEnvironmentDescriptor["platform"]["arch"] {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x64";
    default:
      return "other";
  }
}

export const makeServerEnvironment = Effect.fn("makeServerEnvironment")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const settings = yield* ServerSettingsService;

  const readPersistedEnvironmentId = Effect.gen(function* () {
    const exists = yield* fileSystem
      .exists(serverConfig.environmentIdPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return null;
    }

    const raw = yield* fileSystem
      .readFileString(serverConfig.environmentIdPath)
      .pipe(Effect.map((value) => value.trim()));

    return raw.length > 0 ? raw : null;
  });

  const persistEnvironmentId = (value: string) =>
    fileSystem.writeFileString(serverConfig.environmentIdPath, `${value}\n`);

  const environmentIdRaw = yield* Effect.gen(function* () {
    const persisted = yield* readPersistedEnvironmentId;
    if (persisted) {
      return persisted;
    }

    const generated = yield* randomUUIDv4;
    yield* persistEnvironmentId(generated);
    return generated;
  });

  const environmentId = EnvironmentId.make(environmentIdRaw);
  const cwdBaseName = path.basename(serverConfig.cwd).trim();
  const systemLabel = yield* resolveServerEnvironmentLabel({
    cwdBaseName,
  });

  const base = {
    environmentId,
    platform: {
      os: platformOs(),
      arch: platformArch(),
    },
    serverVersion: serverConfig.appVersion,
    capabilities: {
      repositoryIdentity: true,
      pullRequests: true,
      browserApprovalWait: true,
      browserClientHosts: true,
      browserLoopbackTunnel: true,
      browserScreenshotTypes: true,
      commandRuns: true,
      followsInsertedCommands: true,
      computerLinks: true,
      scheduledTasks: true,
      eventTasks: true,
      threadMove: true,
      projectSetup: true,
      stallReports: true,
      pullRequestObservations: true,
      remoteStatusRefresh: true,
      terminalTabLists: true,
      signInAddressReplay: true,
      outsideAgents: true,
      pushAlerts: true,
      deviceNames: true,
    },
  } satisfies Omit<ExecutionEnvironmentDescriptor, "label" | "systemLabel">;

  const describe = (computerName: string | null): ExecutionEnvironmentDescriptor => ({
    ...base,
    label: computerName ?? systemLabel,
    systemLabel,
  });

  // Subscribed before the first read, so a rename landing in between is
  // replayed after it instead of lost. A replayed older value only shows
  // until the newer one behind it.
  const settingsChanges = yield* settings.subscribeChanges;
  const initialName = yield* settings.getSettings.pipe(
    Effect.map((current) => current.computerName),
    Effect.catch((error) =>
      Effect.logWarning("couldn't read this computer's name; using its system's", {
        detail: error.detail,
      }).pipe(Effect.as(null)),
    ),
  );
  const currentRef = yield* Ref.make(describe(initialName));
  const labelPubSub = yield* PubSub.sliding<ExecutionEnvironmentDescriptor>(16);
  yield* settingsChanges.pipe(
    Stream.runForEach((next) =>
      Effect.gen(function* () {
        const descriptor = describe(next.computerName);
        const previous = yield* Ref.getAndSet(currentRef, descriptor);
        if (previous.label !== descriptor.label) {
          yield* PubSub.publish(labelPubSub, descriptor);
        }
      }),
    ),
    Effect.forkScoped,
  );

  return {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Ref.get(currentRef),
    currentLabel: () => Ref.getUnsafe(currentRef).label,
    describe,
    labelChanges: Stream.fromPubSub(labelPubSub),
  } satisfies ServerEnvironmentShape;
});

/** Needs ServerSettingsService: provide the same layer the rest of the server uses. */
export const ServerEnvironmentLive = Layer.effect(ServerEnvironment, makeServerEnvironment()).pipe(
  Layer.provide(ProcessRunnerLive),
);

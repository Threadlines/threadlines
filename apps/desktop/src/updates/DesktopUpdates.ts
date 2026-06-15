import type {
  DesktopRuntimeInfo,
  DesktopUpdateActionResult,
  DesktopUpdateChannel,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine.ts";

const AUTO_UPDATE_STARTUP_DELAY = "15 seconds";
const AUTO_UPDATE_POLL_INTERVAL = "4 minutes";
const GITHUB_CLI_AUTH_TIMEOUT = Duration.seconds(3);
const PROCESS_TERMINATE_GRACE = Duration.seconds(1);
const GITHUB_AUTH_TOKEN_ENV_NAMES = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
const DESKTOP_UPDATE_PREVIEW_STATES = [
  "available",
  "downloading",
  "downloaded",
  "download-error",
] as const;
const DEFAULT_PREVIEW_UPDATE_VERSION = "99.99.99";
const DEFAULT_PREVIEW_DOWNLOAD_PERCENT = 42;
const PRIVATE_GITHUB_AUTH_REQUIRED_MESSAGE =
  "Private GitHub update feed requires authentication. Run gh auth login or set GH_TOKEN/GITHUB_TOKEN before checking for updates.";

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
type AppUpdateYmlConfig = typeof AppUpdateYmlConfig.Type;
type DesktopUpdatePreviewState = (typeof DESKTOP_UPDATE_PREVIEW_STATES)[number];

interface PrivateGitHubUpdateFeedConfig {
  readonly provider: "github";
  readonly owner: string;
  readonly repo: string;
  readonly private: true;
  readonly channel?: string;
  readonly releaseType?: "draft" | "prerelease" | "release";
}

export interface PrivateGitHubUpdateAuthToken {
  readonly source: "env" | "github-cli";
  readonly envName?: (typeof GITHUB_AUTH_TOKEN_ENV_NAMES)[number];
  readonly token: string;
}

const UpdateInfo = Schema.Struct({
  version: Schema.String,
});

const DownloadProgressInfo = Schema.Struct({
  percent: Schema.Number,
});
const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);
const decodeUpdateInfo = Schema.decodeUnknownEffect(UpdateInfo);
const decodeDownloadProgressInfo = Schema.decodeUnknownEffect(DownloadProgressInfo);

const currentIsoTimestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export class DesktopUpdateActionInProgressError extends Data.TaggedError(
  "DesktopUpdateActionInProgressError",
)<{
  readonly action: "check" | "download" | "install";
}> {
  override get message() {
    return `Cannot change update tracks while an update ${this.action} action is in progress.`;
  }
}

export class DesktopUpdatePersistenceError extends Data.TaggedError(
  "DesktopUpdatePersistenceError",
)<{
  readonly cause: DesktopAppSettings.DesktopSettingsWriteError;
}> {
  override get message() {
    return "Failed to persist desktop update settings.";
  }
}

export type DesktopUpdateConfigureError = never;

export type DesktopUpdateSetChannelError =
  | DesktopUpdateActionInProgressError
  | DesktopUpdatePersistenceError;

export interface DesktopUpdatesShape {
  readonly getState: Effect.Effect<DesktopUpdateState>;
  readonly emitState: Effect.Effect<void>;
  readonly disabledReason: Effect.Effect<Option.Option<string>>;
  readonly configure: Effect.Effect<void, DesktopUpdateConfigureError, Scope.Scope>;
  readonly setChannel: (
    channel: DesktopUpdateChannel,
  ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
  readonly check: (reason: string) => Effect.Effect<DesktopUpdateCheckResult>;
  readonly download: Effect.Effect<DesktopUpdateActionResult>;
  readonly install: Effect.Effect<DesktopUpdateActionResult>;
}

export class DesktopUpdates extends Context.Service<DesktopUpdates, DesktopUpdatesShape>()(
  "t3/desktop/Updates",
) {}

const {
  logInfo: logUpdaterInfo,
  logWarning: logUpdaterWarning,
  logError: logUpdaterError,
} = DesktopObservability.makeComponentLogger("desktop-updater");

function stringifyUpdaterLogMessage(message: unknown): string {
  if (message instanceof Error) {
    return message.stack ?? message.message;
  }
  if (typeof message === "string") {
    return message;
  }
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

function redactUpdaterLogMessage(message: unknown): string {
  return stringifyUpdaterLogMessage(message)
    .replace(
      /\bauthorization\b\s*[:=]\s*["']?token\s+[^"',\s}]+/gi,
      "authorization: token [redacted]",
    )
    .replace(/\btoken\s+[A-Za-z0-9_]{20,}/gi, "token [redacted]")
    .replace(/https?:\/\/[^\s"')]+/g, (candidate) => {
      try {
        const url = new URL(candidate);
        url.search = "";
        return url.toString();
      } catch {
        return candidate.replace(/\?.*$/, "?[redacted]");
      }
    });
}

function parseAppUpdateYml(raw: string): Effect.Effect<Option.Option<AppUpdateYmlConfig>> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => (config.provider ? Option.some(config) : Option.none())),
    Effect.catch(() => Effect.succeed(Option.none<AppUpdateYmlConfig>())),
  );
}

const trimNonEmpty = (value: string | null | undefined): Option.Option<string> =>
  Option.fromNullishOr(value).pipe(
    Option.map((entry) => entry.trim()),
    Option.filter((entry) => entry.length > 0),
  );

const normalizeYmlScalar = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed
    .replace(/^['"]|['"]$/g, "")
    .trim()
    .toLowerCase();
};

function isPrivateGitHubUpdateFeedConfig(
  appUpdateYmlConfig: Option.Option<Record<string, string>>,
): boolean {
  return Option.isSome(resolvePrivateGitHubUpdateFeedConfig(appUpdateYmlConfig));
}

function normalizeGitHubReleaseType(
  value: string | undefined,
): PrivateGitHubUpdateFeedConfig["releaseType"] | undefined {
  const normalized = normalizeYmlScalar(value);
  return normalized === "draft" || normalized === "prerelease" || normalized === "release"
    ? normalized
    : undefined;
}

function resolvePrivateGitHubUpdateFeedConfig(
  appUpdateYmlConfig: Option.Option<Record<string, string>>,
): Option.Option<PrivateGitHubUpdateFeedConfig> {
  if (Option.isNone(appUpdateYmlConfig)) return Option.none();
  const config = appUpdateYmlConfig.value;
  if (normalizeYmlScalar(config.provider) !== "github") return Option.none();
  if (normalizeYmlScalar(config.private) !== "true") return Option.none();

  const owner = trimNonEmpty(config.owner);
  const repo = trimNonEmpty(config.repo);
  if (Option.isNone(owner) || Option.isNone(repo)) {
    return Option.none();
  }

  return Option.some({
    provider: "github",
    owner: owner.value,
    repo: repo.value,
    private: true,
    ...Option.match(trimNonEmpty(config.channel), {
      onNone: () => ({}),
      onSome: (channel) => ({ channel }),
    }),
    ...Option.fromNullishOr(normalizeGitHubReleaseType(config.releaseType)).pipe(
      Option.match({
        onNone: () => ({}),
        onSome: (releaseType) => ({ releaseType }),
      }),
    ),
  });
}

function findEnvGitHubToken(env: NodeJS.ProcessEnv): Option.Option<PrivateGitHubUpdateAuthToken> {
  for (const envName of GITHUB_AUTH_TOKEN_ENV_NAMES) {
    const token = trimNonEmpty(env[envName]);
    if (Option.isSome(token)) {
      return Option.some({ source: "env", envName, token: token.value });
    }
  }
  return Option.none();
}

export function resolvePrivateGitHubUpdateAuthToken(input: {
  readonly appUpdateYmlConfig: Option.Option<Record<string, string>>;
  readonly env: NodeJS.ProcessEnv;
  readonly githubCliToken: Option.Option<string>;
}): Option.Option<PrivateGitHubUpdateAuthToken> {
  if (!isPrivateGitHubUpdateFeedConfig(input.appUpdateYmlConfig)) {
    return Option.none();
  }

  const envToken = findEnvGitHubToken(input.env);
  if (Option.isSome(envToken)) {
    return envToken;
  }

  return trimNonEmpty(Option.getOrUndefined(input.githubCliToken)).pipe(
    Option.map((token) => ({ source: "github-cli" as const, token })),
  );
}

const readGitHubCliToken: Effect.Effect<
  Option.Option<string>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(
      ChildProcess.make("gh", ["auth", "token"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        killSignal: "SIGTERM",
        forceKillAfter: PROCESS_TERMINATE_GRACE,
      }),
    )
    .pipe(
      Effect.timeoutOption(GITHUB_CLI_AUTH_TIMEOUT),
      Effect.map((output) => Option.flatMap(output, (value) => trimNonEmpty(value))),
      Effect.catch(() => Effect.succeed(Option.none<string>())),
    );
});

function createBaseUpdateState(
  channel: DesktopUpdateChannel,
  enabled: boolean,
  environment: DesktopEnvironment.DesktopEnvironmentShape,
): DesktopUpdateState {
  return {
    ...createInitialDesktopUpdateState(environment.appVersion, environment.runtimeInfo, channel),
    enabled,
    status: enabled ? "idle" : "disabled",
  };
}

function getCanRetryFromState(state: DesktopUpdateState): boolean {
  return state.availableVersion !== null || state.downloadedVersion !== null;
}

function shouldBroadcastDownloadProgress(
  currentState: DesktopUpdateState,
  nextPercent: number,
): boolean {
  if (currentState.status !== "downloading") {
    return true;
  }

  const currentPercent = currentState.downloadPercent;
  if (currentPercent === null) {
    return true;
  }

  const previousStep = Math.floor(currentPercent / 10);
  const nextStep = Math.floor(nextPercent / 10);
  return nextStep !== previousStep || nextPercent === 100;
}

function normalizeDesktopUpdatePreviewState(
  value: Option.Option<string>,
): Option.Option<DesktopUpdatePreviewState> {
  return Option.flatMap(value, (rawValue) => {
    const normalized = rawValue.trim().toLowerCase();
    if (normalized === "error") {
      return Option.some("download-error");
    }
    if ((DESKTOP_UPDATE_PREVIEW_STATES as ReadonlyArray<string>).includes(normalized)) {
      return Option.some(normalized as DesktopUpdatePreviewState);
    }
    return Option.none();
  });
}

function createDesktopUpdatePreviewState(input: {
  readonly mode: DesktopUpdatePreviewState;
  readonly channel: DesktopUpdateChannel;
  readonly environment: DesktopEnvironment.DesktopEnvironmentShape;
  readonly version: string;
  readonly checkedAt: string;
}): DesktopUpdateState {
  const availableState = reduceDesktopUpdateStateOnUpdateAvailable(
    createBaseUpdateState(input.channel, true, input.environment),
    input.version,
    input.checkedAt,
  );

  switch (input.mode) {
    case "available":
      return availableState;
    case "downloading":
      return reduceDesktopUpdateStateOnDownloadProgress(
        reduceDesktopUpdateStateOnDownloadStart(availableState),
        DEFAULT_PREVIEW_DOWNLOAD_PERCENT,
      );
    case "downloaded":
      return reduceDesktopUpdateStateOnDownloadComplete(availableState, input.version);
    case "download-error":
      return reduceDesktopUpdateStateOnDownloadFailure(
        reduceDesktopUpdateStateOnDownloadStart(availableState),
        "Preview update download failed.",
      );
  }
}

function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the THREADLINES_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage) {
    return "Automatic updates on Linux require running the AppImage build.";
  }
  return null;
}

function isArm64HostRunningIntelBuild(runtimeInfo: DesktopRuntimeInfo): boolean {
  return runtimeInfo.hostArch === "arm64" && runtimeInfo.appArch === "x64";
}

const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
  const desktopState = yield* DesktopState.DesktopState;
  const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const appUpdateYmlConfigRef = yield* Ref.make<Option.Option<AppUpdateYmlConfig>>(Option.none());
  const updateCheckInFlightRef = yield* Ref.make(false);
  const updateDownloadInFlightRef = yield* Ref.make(false);
  const updateInstallInFlightRef = yield* Ref.make(false);
  const updaterConfiguredRef = yield* Ref.make(false);
  const lastLoggedDownloadMilestoneRef = yield* Ref.make(-1);
  const privateGitHubCliTokenRef = yield* Ref.make<Option.Option<string>>(Option.none());
  const privateGitHubAuthWarningLoggedRef = yield* Ref.make(false);
  const privateGitHubCliAuthLoggedRef = yield* Ref.make(false);
  const updateStateRef = yield* Ref.make<DesktopUpdateState>(
    createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
    ),
  );

  const emitState = Ref.get(updateStateRef).pipe(
    Effect.flatMap((state) => electronWindow.sendAll(IpcChannels.UPDATE_STATE_CHANNEL, state)),
  );

  const setState = (state: DesktopUpdateState): Effect.Effect<void> =>
    Ref.set(updateStateRef, state).pipe(Effect.andThen(emitState));

  const updateState = (
    f: (state: DesktopUpdateState) => DesktopUpdateState,
  ): Effect.Effect<DesktopUpdateState> =>
    Ref.get(updateStateRef).pipe(
      Effect.flatMap((state) => {
        const nextState = f(state);
        return setState(nextState).pipe(Effect.as(nextState));
      }),
    );

  const readAppUpdateYml = fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<AppUpdateYmlConfig>()),
        onSome: parseAppUpdateYml,
      }),
    ),
  );

  const hasUpdateFeedConfig = Ref.get(appUpdateYmlConfigRef).pipe(
    Effect.map((appUpdateYmlConfig) => Option.isSome(appUpdateYmlConfig) || config.mockUpdates),
  );

  const resolveDisabledReason = Effect.gen(function* () {
    const hasFeedConfig = yield* hasUpdateFeedConfig;
    return Option.fromNullishOr(
      getAutoUpdateDisabledReason({
        isDevelopment: environment.isDevelopment,
        isPackaged: environment.isPackaged,
        platform: environment.platform,
        appImage: Option.getOrUndefined(config.appImagePath),
        disabledByEnv: config.disableAutoUpdate,
        hasUpdateFeedConfig: hasFeedConfig,
      }),
    );
  });

  const resolveUpdaterErrorContext = Effect.gen(function* () {
    if (yield* Ref.get(updateInstallInFlightRef)) return "install" as const;
    if (yield* Ref.get(updateDownloadInFlightRef)) return "download" as const;
    if (yield* Ref.get(updateCheckInFlightRef)) return "check" as const;
    return (yield* Ref.get(updateStateRef)).errorContext;
  });

  const activeUpdateAction = Effect.gen(function* () {
    if (yield* Ref.get(updateInstallInFlightRef)) return Option.some("install" as const);
    if (yield* Ref.get(updateDownloadInFlightRef)) return Option.some("download" as const);
    if (yield* Ref.get(updateCheckInFlightRef)) return Option.some("check" as const);
    return Option.none<"check" | "download" | "install">();
  });

  const applyAutoUpdaterChannel = Effect.fn("desktop.updates.applyAutoUpdaterChannel")(function* (
    channel: DesktopUpdateChannel,
  ) {
    yield* Effect.annotateCurrentSpan({ channel });
    const allowsPrerelease = channel === "nightly";
    yield* electronUpdater.setChannel(channel);
    yield* electronUpdater.setAllowPrerelease(allowsPrerelease);
    yield* electronUpdater.setAllowDowngrade(allowsPrerelease);
    yield* logUpdaterInfo("using update channel", {
      channel,
      allowPrerelease: allowsPrerelease,
      allowDowngrade: allowsPrerelease,
    });
  });

  const resolvePrivateGitHubAuthToken = Effect.gen(function* () {
    const appUpdateYmlConfig = yield* Ref.get(appUpdateYmlConfigRef);
    if (!isPrivateGitHubUpdateFeedConfig(appUpdateYmlConfig)) {
      return Option.none<PrivateGitHubUpdateAuthToken>();
    }

    const envToken = findEnvGitHubToken(process.env);
    if (Option.isSome(envToken)) {
      return envToken;
    }

    let githubCliToken = yield* Ref.get(privateGitHubCliTokenRef);
    if (Option.isNone(githubCliToken)) {
      githubCliToken = yield* readGitHubCliToken.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
      if (Option.isSome(githubCliToken)) {
        yield* Ref.set(privateGitHubCliTokenRef, githubCliToken);
      }
    }

    return resolvePrivateGitHubUpdateAuthToken({
      appUpdateYmlConfig,
      env: process.env,
      githubCliToken,
    });
  });

  const configurePrivateGitHubUpdateFeed = Effect.gen(function* () {
    const appUpdateYmlConfig = yield* Ref.get(appUpdateYmlConfigRef);
    const privateFeedConfig = resolvePrivateGitHubUpdateFeedConfig(appUpdateYmlConfig);
    if (Option.isNone(privateFeedConfig)) {
      return true;
    }

    const authToken = yield* resolvePrivateGitHubAuthToken;
    if (Option.isNone(authToken)) {
      if (!(yield* Ref.get(privateGitHubAuthWarningLoggedRef))) {
        yield* Ref.set(privateGitHubAuthWarningLoggedRef, true);
        yield* logUpdaterWarning(
          "private GitHub update feed has no runtime token; run gh auth login or set GH_TOKEN/GITHUB_TOKEN before checking for updates",
        );
      }
      return false;
    }

    yield* electronUpdater.setFeedURL({
      ...privateFeedConfig.value,
      token: authToken.value.token,
    } satisfies ElectronUpdater.ElectronUpdaterFeedUrl);

    if (
      authToken.value.source === "github-cli" &&
      !(yield* Ref.get(privateGitHubCliAuthLoggedRef))
    ) {
      yield* Ref.set(privateGitHubCliAuthLoggedRef, true);
      yield* logUpdaterInfo("using GitHub CLI authentication for private update feed");
    }

    return true;
  });

  const markPrivateGitHubAuthMissingForCheck = Effect.gen(function* () {
    const failedAt = yield* currentIsoTimestamp;
    yield* updateState((current) =>
      reduceDesktopUpdateStateOnCheckFailure(
        current,
        PRIVATE_GITHUB_AUTH_REQUIRED_MESSAGE,
        failedAt,
      ),
    );
    yield* logUpdaterWarning("skipping update check because private GitHub feed has no auth token");
  });

  const markPrivateGitHubAuthMissingForDownload = updateState((current) =>
    reduceDesktopUpdateStateOnDownloadFailure(current, PRIVATE_GITHUB_AUTH_REQUIRED_MESSAGE),
  ).pipe(
    Effect.andThen(
      logUpdaterWarning("skipping update download because private GitHub feed has no auth token"),
    ),
  );

  const ensurePrivateGitHubUpdateFeed = Effect.fn("desktop.updates.ensurePrivateGitHubUpdateFeed")(
    function* () {
      return yield* configurePrivateGitHubUpdateFeed;
    },
  );

  const shouldEnableAutoUpdates = resolveDisabledReason.pipe(Effect.map(Option.isNone));

  const checkForUpdates = Effect.fn("desktop.updates.checkForUpdates")(function* (reason: string) {
    yield* Effect.annotateCurrentSpan({ reason });
    if (yield* Ref.get(desktopState.quitting)) return false;
    if (!(yield* Ref.get(updaterConfiguredRef))) return false;
    if (yield* Ref.get(updateCheckInFlightRef)) return false;

    const state = yield* Ref.get(updateStateRef);
    if (state.status === "downloading" || state.status === "downloaded") {
      yield* logUpdaterInfo("skipping update check while update is active", {
        reason,
        status: state.status,
      });
      return false;
    }

    yield* Ref.set(updateCheckInFlightRef, true);
    const checkedAt = yield* currentIsoTimestamp;
    yield* setState(reduceDesktopUpdateStateOnCheckStart(state, checkedAt));
    yield* logUpdaterInfo("checking for updates", { reason });

    return yield* Effect.gen(function* () {
      if (!(yield* ensurePrivateGitHubUpdateFeed())) {
        yield* markPrivateGitHubAuthMissingForCheck;
        return true;
      }
      yield* electronUpdater.checkForUpdates;
      return true;
    }).pipe(
      Effect.catch(
        Effect.fn("desktop.updates.handleCheckForUpdatesFailure")(function* (error) {
          const failedAt = yield* currentIsoTimestamp;
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnCheckFailure(current, error.message, failedAt),
          );
          yield* logUpdaterError("failed to check for updates", { message: error.message });
          return true;
        }),
      ),
      Effect.ensuring(Ref.set(updateCheckInFlightRef, false)),
    );
  });

  const downloadAvailableUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (
      !(yield* Ref.get(updaterConfiguredRef)) ||
      (yield* Ref.get(updateDownloadInFlightRef)) ||
      state.status !== "available"
    ) {
      return { accepted: false, completed: false };
    }

    yield* Ref.set(updateDownloadInFlightRef, true);
    return yield* Effect.gen(function* () {
      yield* setState(reduceDesktopUpdateStateOnDownloadStart(state));
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );
      yield* logUpdaterInfo("downloading update");
      if (!(yield* ensurePrivateGitHubUpdateFeed())) {
        yield* markPrivateGitHubAuthMissingForDownload;
        return { accepted: true, completed: false };
      }
      yield* electronUpdater.downloadUpdate;
      return { accepted: true, completed: true };
    }).pipe(
      Effect.catch(
        Effect.fn("desktop.updates.handleDownloadFailure")(function* (error) {
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnDownloadFailure(current, error.message),
          );
          yield* logUpdaterError("failed to download update", { message: error.message });
          return { accepted: true, completed: false };
        }),
      ),
      Effect.ensuring(Ref.set(updateDownloadInFlightRef, false)),
    );
  }).pipe(Effect.withSpan("desktop.updates.downloadAvailableUpdate"));

  const installDownloadedUpdate = Effect.gen(function* () {
    const state = yield* Ref.get(updateStateRef);
    if (
      (yield* Ref.get(desktopState.quitting)) ||
      !(yield* Ref.get(updaterConfiguredRef)) ||
      state.status !== "downloaded"
    ) {
      return { accepted: false, completed: false };
    }

    yield* Ref.set(desktopState.quitting, true);
    yield* Ref.set(updateInstallInFlightRef, true);

    return yield* Effect.gen(function* () {
      yield* backendManager.stop({ timeout: Duration.seconds(5) });
      yield* electronWindow.destroyAll;
      yield* electronUpdater.quitAndInstall({
        isSilent: true,
        isForceRunAfter: true,
      });
      return { accepted: true, completed: false };
    }).pipe(
      Effect.catch(
        Effect.fn("desktop.updates.handleInstallFailure")(function* (error) {
          yield* Ref.set(updateInstallInFlightRef, false);
          yield* updateState((current) =>
            reduceDesktopUpdateStateOnInstallFailure(current, error.message),
          );
          yield* Ref.set(desktopState.quitting, false);
          yield* logUpdaterError("failed to install update", { message: error.message });
          return { accepted: true, completed: false };
        }),
      ),
    );
  }).pipe(Effect.withSpan("desktop.updates.installDownloadedUpdate"));

  const startUpdatePollers: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* Effect.sleep(AUTO_UPDATE_STARTUP_DELAY).pipe(
      Effect.andThen(checkForUpdates("startup")),
      Effect.catchCause((cause) =>
        logUpdaterError("startup update check failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.sleep(AUTO_UPDATE_POLL_INTERVAL).pipe(
      Effect.andThen(checkForUpdates("poll")),
      Effect.forever,
      Effect.catchCause((cause) =>
        logUpdaterError("poll update check failed", { cause: Cause.pretty(cause) }),
      ),
      Effect.forkScoped,
    );
  }).pipe(Effect.withSpan("desktop.updates.startPollers"));

  const handleUpdateAvailable = Effect.fn("desktop.updates.handleUpdateAvailable")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateAvailable")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          if (resolveDefaultDesktopUpdateChannel(info.version) !== state.channel) {
            yield* logUpdaterInfo("ignoring update that does not match selected channel", {
              version: info.version,
              channel: state.channel,
            });
            const checkedAt = yield* currentIsoTimestamp;
            yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
            yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
            return;
          }

          const checkedAt = yield* currentIsoTimestamp;
          yield* setState(
            reduceDesktopUpdateStateOnUpdateAvailable(state, info.version, checkedAt),
          );
          yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
          yield* logUpdaterInfo("update available", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) =>
        logUpdaterWarning("ignored malformed update-available event", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const handleUpdateNotAvailable = Effect.gen(function* () {
    const checkedAt = yield* currentIsoTimestamp;
    const state = yield* Ref.get(updateStateRef);
    yield* setState(reduceDesktopUpdateStateOnNoUpdate(state, checkedAt));
    yield* Ref.set(lastLoggedDownloadMilestoneRef, -1);
    yield* logUpdaterInfo("no updates available");
  }).pipe(Effect.withSpan("desktop.updates.handleUpdateNotAvailable"));

  const handleUpdaterError = Effect.fn("desktop.updates.handleUpdaterError")(function* (
    error: unknown,
  ) {
    const message = error instanceof Error ? error.message : String(error);
    if (yield* Ref.get(updateInstallInFlightRef)) {
      yield* Ref.set(updateInstallInFlightRef, false);
      yield* Ref.set(desktopState.quitting, false);
      yield* updateState((current) => reduceDesktopUpdateStateOnInstallFailure(current, message));
      yield* logUpdaterError("updater error", { message });
      return;
    }

    if (!(yield* Ref.get(updateCheckInFlightRef)) && !(yield* Ref.get(updateDownloadInFlightRef))) {
      const errorContext = yield* resolveUpdaterErrorContext;
      const checkedAt = yield* currentIsoTimestamp;
      yield* updateState((current) => ({
        ...current,
        status: "error",
        message,
        checkedAt,
        downloadPercent: null,
        errorContext,
        canRetry: getCanRetryFromState(current),
      }));
    }

    yield* logUpdaterError("updater error", { message });
  });

  const handleDownloadProgress = Effect.fn("desktop.updates.handleDownloadProgress")(function* (
    raw: unknown,
  ) {
    yield* decodeDownloadProgressInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyDownloadProgress")(function* (progress) {
          const state = yield* Ref.get(updateStateRef);
          const percent = Math.floor(progress.percent);
          if (shouldBroadcastDownloadProgress(state, progress.percent) || state.message !== null) {
            yield* setState(reduceDesktopUpdateStateOnDownloadProgress(state, progress.percent));
          }
          const milestone = percent - (percent % 10);
          const lastLoggedMilestone = yield* Ref.get(lastLoggedDownloadMilestoneRef);
          if (milestone > lastLoggedMilestone) {
            yield* Ref.set(lastLoggedDownloadMilestoneRef, milestone);
            yield* logUpdaterInfo("download progress", { percent });
          }
        }),
      ),
      Effect.catchCause((cause) =>
        logUpdaterWarning("ignored malformed download-progress event", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const handleUpdateDownloaded = Effect.fn("desktop.updates.handleUpdateDownloaded")(function* (
    raw: unknown,
  ) {
    yield* decodeUpdateInfo(raw).pipe(
      Effect.flatMap(
        Effect.fn("desktop.updates.applyUpdateDownloaded")(function* (info) {
          const state = yield* Ref.get(updateStateRef);
          yield* setState(reduceDesktopUpdateStateOnDownloadComplete(state, info.version));
          yield* logUpdaterInfo("update downloaded", { version: info.version });
        }),
      ),
      Effect.catchCause((cause) =>
        logUpdaterWarning("ignored malformed update-downloaded event", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  return DesktopUpdates.of({
    getState: Ref.get(updateStateRef),
    emitState,
    disabledReason: resolveDisabledReason,
    configure: Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const runEffect = (effect: Effect.Effect<void>) => {
        void Effect.runPromiseWith(context)(effect);
      };

      yield* electronUpdater.setLogger({
        info: (message) => {
          runEffect(
            logUpdaterInfo("electron updater log", {
              updaterMessage: redactUpdaterLogMessage(message),
            }),
          );
        },
        warn: (message) => {
          runEffect(
            logUpdaterWarning("electron updater log", {
              updaterMessage: redactUpdaterLogMessage(message),
            }),
          );
        },
        error: (message) => {
          runEffect(
            logUpdaterError("electron updater log", {
              updaterMessage: redactUpdaterLogMessage(message),
            }),
          );
        },
      });

      const appUpdateYmlConfig = yield* readAppUpdateYml;
      yield* Ref.set(appUpdateYmlConfigRef, appUpdateYmlConfig);

      const settings = yield* desktopSettings.get;
      const previewUpdateState = normalizeDesktopUpdatePreviewState(config.previewUpdateState);
      if (Option.isSome(previewUpdateState)) {
        if (environment.isDevelopment) {
          const checkedAt = yield* currentIsoTimestamp;
          const version = Option.getOrElse(
            config.previewUpdateVersion,
            () => DEFAULT_PREVIEW_UPDATE_VERSION,
          );
          yield* setState(
            createDesktopUpdatePreviewState({
              mode: previewUpdateState.value,
              channel: settings.updateChannel,
              environment,
              version,
              checkedAt,
            }),
          );
          yield* logUpdaterInfo("using desktop update preview state", {
            state: previewUpdateState.value,
            version,
          });
          return;
        }

        yield* logUpdaterWarning(
          "ignoring desktop update preview state outside development builds",
          { state: previewUpdateState.value },
        );
      }

      if (config.mockUpdates) {
        yield* electronUpdater.setFeedURL({
          provider: "generic",
          url: `http://localhost:${config.mockUpdateServerPort}`,
        } as ElectronUpdater.ElectronUpdaterFeedUrl);
      }

      const enabled = yield* shouldEnableAutoUpdates;
      yield* setState(createBaseUpdateState(settings.updateChannel, enabled, environment));
      if (!enabled) {
        return;
      }
      yield* Ref.set(updaterConfiguredRef, true);

      yield* electronUpdater.setAutoDownload(false);
      yield* electronUpdater.setAutoInstallOnAppQuit(false);
      yield* applyAutoUpdaterChannel(settings.updateChannel);
      yield* electronUpdater.setDisableDifferentialDownload(
        isArm64HostRunningIntelBuild(environment.runtimeInfo),
      );

      if (isArm64HostRunningIntelBuild(environment.runtimeInfo)) {
        yield* logUpdaterInfo(
          "Apple Silicon host detected while running Intel build; updates will switch to arm64 packages",
        );
      }

      yield* electronUpdater.on("checking-for-update", () => {
        runEffect(
          logUpdaterInfo("looking for updates").pipe(
            Effect.withSpan("desktop.updates.handleCheckingForUpdate"),
          ),
        );
      });
      yield* electronUpdater.on("update-available", (info: unknown) => {
        runEffect(handleUpdateAvailable(info));
      });
      yield* electronUpdater.on("update-not-available", () => {
        runEffect(handleUpdateNotAvailable);
      });
      yield* electronUpdater.on("error", (error: unknown) => {
        runEffect(handleUpdaterError(error));
      });
      yield* electronUpdater.on("download-progress", (progress: unknown) => {
        runEffect(handleDownloadProgress(progress));
      });
      yield* electronUpdater.on("update-downloaded", (info: unknown) => {
        runEffect(handleUpdateDownloaded(info));
      });

      yield* startUpdatePollers;
    }).pipe(Effect.withSpan("desktop.updates.configure")),
    setChannel: Effect.fn("desktop.updates.setChannel")(function* (
      nextChannel: DesktopUpdateChannel,
    ) {
      yield* Effect.annotateCurrentSpan({ channel: nextChannel });
      const activeAction = yield* activeUpdateAction;
      if (Option.isSome(activeAction)) {
        return yield* new DesktopUpdateActionInProgressError({ action: activeAction.value });
      }

      const state = yield* Ref.get(updateStateRef);
      if (nextChannel === state.channel) {
        return state;
      }

      yield* desktopSettings
        .setUpdateChannel(nextChannel)
        .pipe(Effect.mapError((cause) => new DesktopUpdatePersistenceError({ cause })));

      const enabled = yield* shouldEnableAutoUpdates;
      yield* setState(createBaseUpdateState(nextChannel, enabled, environment));

      if (!enabled || !(yield* Ref.get(updaterConfiguredRef))) {
        return yield* Ref.get(updateStateRef);
      }

      yield* applyAutoUpdaterChannel(nextChannel);
      const allowDowngrade = yield* electronUpdater.allowDowngrade;
      yield* electronUpdater.setAllowDowngrade(true);
      yield* checkForUpdates("channel-change").pipe(
        Effect.ensuring(electronUpdater.setAllowDowngrade(allowDowngrade).pipe(Effect.ignore)),
      );
      return yield* Ref.get(updateStateRef);
    }),
    check: Effect.fn("desktop.updates.check")(function* (reason: string) {
      yield* Effect.annotateCurrentSpan({ reason });
      if (!(yield* Ref.get(updaterConfiguredRef))) {
        return {
          checked: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const checked = yield* checkForUpdates(reason);
      return {
        checked,
        state: yield* Ref.get(updateStateRef),
      };
    }),
    download: Effect.gen(function* () {
      const result = yield* downloadAvailableUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.download")),
    install: Effect.gen(function* () {
      if (yield* Ref.get(desktopState.quitting)) {
        return {
          accepted: false,
          completed: false,
          state: yield* Ref.get(updateStateRef),
        };
      }
      const result = yield* installDownloadedUpdate;
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: yield* Ref.get(updateStateRef),
      };
    }).pipe(Effect.withSpan("desktop.updates.install")),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);

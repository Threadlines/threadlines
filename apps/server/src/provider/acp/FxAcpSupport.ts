/**
 * FxAcpSupport — the fx (`fx acp`, https://fx.sh) descriptor for the generic
 * ACP driver.
 *
 * fx authenticates outside ACP (`fx login`, `fx setup`, `AI_GATEWAY_API_KEY`)
 * and advertises no auth methods, so the runtime skips `authenticate`. Its
 * `configOptions` carry a `provider` picker (Gateway / Codex / Grok
 * subscription), the model catalog of the active provider, and a session
 * mode; `FX_MODEL_OPTION_MAPPING` pins the provider to Gateway and the mode
 * is driven by the runtime mode.
 *
 * fx ships Linux/macOS binaries only. On Windows every fx invocation —
 * install, probe, login, update and the ACP session itself — runs inside
 * the default WSL distro (see `@threadlines/shared/wsl`), with the workspace
 * path handed to fx as its `/mnt/<drive>` mount.
 *
 * @module provider/acp/FxAcpSupport
 */
import { FxSettings, ProviderDriverKind, type ServerProviderAuth } from "@threadlines/contracts";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import {
  describeWslLaunchFailure,
  toWslPath,
  WSL_SETUP_HINT,
  withWslForwardedEnv,
  wslCommand,
  wslShellCommand,
} from "@threadlines/shared/wsl";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";

import {
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCommandDefinition,
} from "../providerMaintenance.ts";
import {
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type CommandResult,
} from "../providerSnapshot.ts";
import type {
  AcpModelOptionMapping,
  AcpProviderDescriptor,
  AcpProviderProbeOutcome,
} from "./AcpProviderDescriptor.ts";
import {
  flattenSessionConfigSelectOptions,
  GENERIC_ACP_MODEL_OPTION_MAPPING,
  selectConfigOptionCurrentValue,
} from "./AcpProviderModels.ts";
import type { AcpSpawnInput } from "./AcpSessionRuntime.ts";
import { enrichFxModelsWithGatewayCatalog } from "./FxGatewayModels.ts";

const decodeFxSettings = Schema.decodeSync(FxSettings);

export const FX_DRIVER_KIND = ProviderDriverKind.make("fx");
// Generous: on Windows each probe may cold-boot the WSL VM first (~6s+).
const FX_PROBE_TIMEOUT_MS = 30_000;
const FX_MODEL_DISCOVERY_TIMEOUT_MS = 45_000;
const FX_INSTALL_LINE = "curl -fsSL https://fx.sh/setup.sh | bash";
const FX_SHELL_INSTALL: ProviderMaintenanceCommandDefinition = {
  executable: "bash",
  args: ["-c", FX_INSTALL_LINE],
  lockKey: "fx",
  displayCommand: FX_INSTALL_LINE,
};
const FX_WSL_INSTALL_COMMAND = wslShellCommand(FX_INSTALL_LINE);
const FX_WSL_INSTALL: ProviderMaintenanceCommandDefinition = {
  executable: FX_WSL_INSTALL_COMMAND.file,
  args: FX_WSL_INSTALL_COMMAND.args,
  lockKey: "fx",
  displayCommand: `wsl -- bash -lc '${FX_INSTALL_LINE}'`,
};

const FX_PROVIDER_CONFIG_ID = "provider";
const FX_GATEWAY_PROVIDER = "gateway";
const FX_EFFORT_CONFIG_ID = "effort";
const FX_AUTO_EFFORT = "auto";

/**
 * fx names its `auto` effort "default", but it only means fx sends no
 * reasoning setting and the model's maker applies its own level, which
 * nothing in the chain reports. Say who decides instead.
 */
function relabelFxAutoEffort(
  option: EffectAcpSchema.SessionConfigOption,
): EffectAcpSchema.SessionConfigOption {
  if (option.id !== FX_EFFORT_CONFIG_ID || option.type !== "select") {
    return option;
  }
  const choices = option.options;
  if (!isFlatSelectOptions(choices)) {
    return option;
  }
  return {
    ...option,
    options: choices.map((choice) =>
      choice.value === FX_AUTO_EFFORT ? { ...choice, name: "Model default" } : choice,
    ),
  };
}

const isFlatSelectOptions = (
  choices: EffectAcpSchema.SessionConfigSelectOptions,
): choices is ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption> =>
  choices.every((choice) => "value" in choice);

/**
 * fx's `provider` option swaps the whole catalog (Vercel AI Gateway, or a
 * Codex / Grok subscription, each behind its own `fx login`), so it is not a
 * per-model setting. Threadlines lists the Gateway catalog only: the option
 * stays out of the model picker and every session is pinned to Gateway, even
 * when fx remembers another provider from its own terminal UI.
 */
export const FX_MODEL_OPTION_MAPPING: AcpModelOptionMapping = {
  capabilitiesFromConfigOptions: (configOptions) =>
    GENERIC_ACP_MODEL_OPTION_MAPPING.capabilitiesFromConfigOptions(
      configOptions
        .filter((option) => option.id !== FX_PROVIDER_CONFIG_ID)
        .map(relabelFxAutoEffort),
    ),
  configUpdatesFromSelections: (configOptions, selections) => {
    const providerOption = configOptions.find((option) => option.id === FX_PROVIDER_CONFIG_ID);
    const needsGatewayPin =
      providerOption !== undefined &&
      selectConfigOptionCurrentValue(providerOption) !== FX_GATEWAY_PROVIDER &&
      flattenSessionConfigSelectOptions(providerOption).some(
        (choice) => choice.value === FX_GATEWAY_PROVIDER,
      );
    return [
      ...(needsGatewayPin ? [{ configId: FX_PROVIDER_CONFIG_ID, value: FX_GATEWAY_PROVIDER }] : []),
      ...GENERIC_ACP_MODEL_OPTION_MAPPING.configUpdatesFromSelections(
        configOptions.filter((option) => option.id !== FX_PROVIDER_CONFIG_ID),
        selections,
      ),
    ];
  },
};

export const runsFxThroughWsl = (platform: NodeJS.Platform = process.platform): boolean =>
  platform === "win32";

export function fxNotInstalledMessage(platform: NodeJS.Platform = process.platform): string {
  return runsFxThroughWsl(platform)
    ? "fx has no Windows build. Threadlines runs it through WSL; install it there (Install below, or `curl -fsSL https://fx.sh/setup.sh | bash` inside WSL)."
    : "fx CLI (`fx`) is not installed or not on PATH. Install it from https://fx.sh.";
}

/** The executable + argv to run `fx <args>` on this host. */
export function buildFxCommand(
  settings: Pick<FxSettings, "binaryPath"> | null | undefined,
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
): { readonly file: string; readonly args: ReadonlyArray<string> } {
  const binary = settings?.binaryPath || "fx";
  return runsFxThroughWsl(platform) ? wslCommand(binary, args) : { file: binary, args };
}

/** fx's own credential variables, which must cross into WSL to take effect. */
const FX_CREDENTIAL_ENV = ["AI_GATEWAY_API_KEY", "FX_API_KEY", "VERCEL_OIDC_TOKEN"] as const;

/** The environment for an fx process, forwarding its credentials through WSL on Windows. */
export function fxEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return runsFxThroughWsl(platform)
    ? withWslForwardedEnv(environment, FX_CREDENTIAL_ENV)
    : environment;
}

export function buildFxAcpSpawnInput(
  settings: Pick<FxSettings, "binaryPath"> | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  const command = buildFxCommand(settings, ["acp"]);
  return {
    command: command.file,
    args: command.args,
    cwd,
    ...(environment ? { env: fxEnvironment(environment) } : {}),
    // wsl.exe is a real executable; a cmd.exe layer would re-split the bash line.
    ...(runsFxThroughWsl() ? { shell: false } : {}),
  };
}

/** Subset of `fx status --json` the probe reads. */
const FxStatusJson = Schema.Struct({
  model: Schema.optional(Schema.NullOr(Schema.String)),
  auth: Schema.optional(Schema.NullOr(Schema.String)),
  auth_help: Schema.optional(Schema.NullOr(Schema.String)),
  team: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * `fx status` names its credential source in fx's own terms ("fx login").
 * Say what it signs in to, and for Gateway, which Vercel team it bills.
 */
function fxAuthLabel(source: string, team: string | undefined): string {
  if (/chatgpt|codex/iu.test(source)) return "Codex subscription";
  if (/grok|xai/iu.test(source)) return "Grok subscription";
  if (/key|env/iu.test(source)) return "Vercel AI Gateway API key";
  if (/login/iu.test(source)) return team ? `Vercel AI Gateway · ${team}` : "Vercel AI Gateway";
  return source;
}
const decodeFxStatusJson = Schema.decodeUnknownExit(Schema.fromJsonString(FxStatusJson));

export interface FxStatusResult {
  readonly auth: ServerProviderAuth;
  readonly defaultModel: string | undefined;
  readonly message: string | undefined;
}

/**
 * `fx status --json` reports `auth` as `"missing"` when no credential is
 * usable, otherwise the label of the active credential source (Gateway
 * login, API key, Codex or Grok subscription).
 */
export function parseFxStatusOutput(
  result: CommandResult,
  platform: NodeJS.Platform = process.platform,
): FxStatusResult | undefined {
  const line = result.stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("{"));
  if (!line) {
    return undefined;
  }
  const decoded = decodeFxStatusJson(line);
  if (decoded._tag !== "Success") {
    return undefined;
  }
  const status = decoded.value;
  const authSource = status.auth?.trim() ?? "";
  const defaultModel = status.model?.trim() || undefined;
  if (!authSource || authSource === "missing") {
    // fx's own `auth_help` names terminal commands and an env var that, on
    // Windows, only work inside WSL. Point at Threadlines' sign-in instead.
    return {
      auth: { status: "unauthenticated" },
      defaultModel,
      message: `fx isn't signed in to Vercel AI Gateway. Use Sign in, or run \`${
        runsFxThroughWsl(platform) ? "wsl fx login" : "fx login"
      }\` in a terminal.`,
    };
  }
  return {
    auth: {
      status: "authenticated",
      type: authSource,
      label: fxAuthLabel(authSource, status.team?.trim() || undefined),
    },
    defaultModel,
    message: undefined,
  };
}

const runFxCommand = (
  settings: FxSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) => {
  const command = buildFxCommand(settings, args);
  return spawnAndCollect(
    command.file,
    ChildProcess.make(
      command.file,
      [...command.args],
      // Through WSL the shell is `bash -lc` inside the distro; no cmd.exe layer.
      hideWindowsConsole({ env: fxEnvironment(environment), shell: false }),
    ),
  ).pipe(Effect.timeoutOption(FX_PROBE_TIMEOUT_MS), Effect.result);
};

/** Inside WSL a missing binary surfaces as bash's exit 127, not ENOENT. */
function isMissingInsideWsl(result: CommandResult): boolean {
  return (
    runsFxThroughWsl() &&
    (result.code === 127 || /command not found|No such file/iu.test(result.stderr))
  );
}

/** `fx --version` for the version, `fx status --json` for auth. */
export const probeFx = Effect.fn("probeFx")(function* (
  settings: FxSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  AcpProviderProbeOutcome,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
> {
  const notInstalled = (message: string): AcpProviderProbeOutcome => ({
    installed: false,
    version: null,
    status: "error",
    auth: { status: "unknown" },
    message,
  });

  const versionProbe = yield* runFxCommand(settings, ["--version"], environment);
  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    if (isCommandMissingCause(error)) {
      return notInstalled(
        runsFxThroughWsl()
          ? "WSL (`wsl.exe`) is not available, and fx has no Windows build. Install WSL to use fx on Windows."
          : fxNotInstalledMessage(),
      );
    }
    return {
      installed: !runsFxThroughWsl(),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `Failed to execute fx health check: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
  if (Option.isNone(versionProbe.success)) {
    return {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "fx is installed but timed out while running `fx --version`.",
    };
  }
  const versionResult = versionProbe.success.value;
  const wslFailure = runsFxThroughWsl()
    ? describeWslLaunchFailure(`${versionResult.stdout}\n${versionResult.stderr}`)
    : undefined;
  if (wslFailure) {
    return notInstalled(
      `fx runs inside WSL on Windows, and WSL isn't ready: ${wslFailure} ${WSL_SETUP_HINT}`,
    );
  }
  if (isMissingInsideWsl(versionResult)) {
    return notInstalled(fxNotInstalledMessage());
  }
  const version = parseGenericCliVersion(versionResult.stdout);

  const statusProbe = yield* runFxCommand(settings, ["status", "--json"], environment);
  const parsedStatus =
    Result.isSuccess(statusProbe) && Option.isSome(statusProbe.success)
      ? parseFxStatusOutput(statusProbe.success.value)
      : undefined;
  if (!parsedStatus) {
    return {
      installed: true,
      version,
      status: "warning",
      auth: { status: "unknown" },
      message:
        version === null
          ? "The `fx` on PATH does not look like fx.sh (`fx status --json` did not answer). Check the binary path."
          : "Could not read `fx status --json`; authentication state is unknown.",
    };
  }

  const latestVersion = yield* resolveFxLatestRelease();
  return {
    installed: true,
    version,
    status: parsedStatus.auth.status === "unauthenticated" ? "error" : "ready",
    auth: parsedStatus.auth,
    ...(parsedStatus.message ? { message: parsedStatus.message } : {}),
    ...(latestVersion ? { latestVersion } : {}),
  };
});

const FX_LATEST_RELEASE_URL = "https://api.github.com/repos/vercel-labs/fx/releases/latest";
const FX_LATEST_RELEASE_TTL_MS = 60 * 60 * 1_000;
const FX_LATEST_RELEASE_TIMEOUT_MS = 5_000;

const GitHubRelease = Schema.Struct({ tag_name: Schema.String });

let fxLatestReleaseCache: { readonly expiresAt: number; readonly version: string | null } | null =
  null;

export function clearFxLatestReleaseCacheForTests(): void {
  fxLatestReleaseCache = null;
}

/**
 * fx ships through GitHub releases, not npm, so the version advisory reads
 * the latest release tag (`v0.0.10` → `0.0.10`). Cached for an hour (the
 * unauthenticated API allows 60 requests an hour); any failure means "unknown",
 * never a blocked probe.
 */
const resolveFxLatestRelease = Effect.fn("resolveFxLatestRelease")(function* () {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (fxLatestReleaseCache && fxLatestReleaseCache.expiresAt > now) {
    return fxLatestReleaseCache.version;
  }
  // The limit covers reading the body too, not just the response headers.
  const version = yield* fetchFxLatestRelease().pipe(
    Effect.timeout(FX_LATEST_RELEASE_TIMEOUT_MS),
    Effect.catch(() => Effect.succeed(null)),
  );
  fxLatestReleaseCache = { expiresAt: now + FX_LATEST_RELEASE_TTL_MS, version };
  return version;
});

const fetchFxLatestRelease = Effect.fn("fetchFxLatestRelease")(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(
    HttpClientRequest.get(FX_LATEST_RELEASE_URL).pipe(
      HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
      HttpClientRequest.setHeader("user-agent", "threadlines"),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    return null;
  }
  const release = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(GitHubRelease)),
  );
  return release.tag_name.trim().replace(/^v/u, "") || null;
});

const fxUpdate = buildFxCommand(null, ["upgrade"]);

export const FX_ACP_DESCRIPTOR: AcpProviderDescriptor<FxSettings> = {
  driverKind: FX_DRIVER_KIND,
  presentation: {
    displayName: "fx",
    badgeLabel: "Experimental",
    planUpgradeUrl: "https://vercel.com/ai-gateway",
    showInteractionModeToggle: false,
  },
  settingsSchema: FxSettings,
  defaultSettings: () => decodeFxSettings({}),
  maintenance: makeProviderMaintenanceCapabilities({
    provider: FX_DRIVER_KIND,
    packageName: null,
    updateExecutable: fxUpdate.file,
    updateArgs: fxUpdate.args,
    updateLockKey: "fx",
    updateDisplayCommand: "fx upgrade",
  }),
  install: {
    darwin: FX_SHELL_INSTALL,
    linux: FX_SHELL_INSTALL,
    win32: FX_WSL_INSTALL,
  },
  spawn: buildFxAcpSpawnInput,
  // Inside WSL the name resolves in the distro's login shell, not on the host.
  resolveBinaryOnHost: (platform) => !runsFxThroughWsl(platform),
  // fx inside WSL needs the workspace as its Linux mount path.
  resolveSessionCwd: (cwd) => (runsFxThroughWsl() ? toWslPath(cwd) : cwd),
  // WSL's default NAT network has its own loopback, so the browser tools
  // (served on the host's 127.0.0.1) are out of reach there.
  reachesHostLoopback: (platform) => !runsFxThroughWsl(platform),
  notInstalledMessage: fxNotInstalledMessage(),
  probe: probeFx,
  modelDiscoveryTimeoutMs: FX_MODEL_DISCOVERY_TIMEOUT_MS,
  enrichDiscoveredModels: (models) => enrichFxModelsWithGatewayCatalog(models),
  modelOptions: FX_MODEL_OPTION_MAPPING,
  // fx offers reasoning effort only on models whose catalog entry lists it.
  // Switching models takes ~10ms, so one session probes all ~150 in seconds.
  modelCapabilitiesVaryByModel: true,
  modelCapabilityProbeSessions: 1,
};

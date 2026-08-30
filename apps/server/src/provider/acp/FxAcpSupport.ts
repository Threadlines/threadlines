/**
 * FxAcpSupport — the fx (`fx acp`, https://fx.sh) descriptor for the generic
 * ACP driver.
 *
 * fx authenticates outside ACP (`fx login`, `fx setup`, `AI_GATEWAY_API_KEY`)
 * and advertises no auth methods, so the runtime skips `authenticate`. Its
 * `configOptions` carry a `provider` picker (Gateway / Codex / Grok
 * subscription), the model catalog of the active provider, and a session
 * mode; the generic option mapping exposes `provider` as a model option and
 * the mode is driven by the runtime mode.
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
import { toWslPath, wslCommand, wslShellCommand } from "@threadlines/shared/wsl";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
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
import type { AcpProviderDescriptor, AcpProviderProbeOutcome } from "./AcpProviderDescriptor.ts";
import type { AcpSpawnInput } from "./AcpSessionRuntime.ts";

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
    ...(environment ? { env: environment } : {}),
    // wsl.exe is a real executable; a cmd.exe layer would re-split the bash line.
    ...(runsFxThroughWsl() ? { shell: false } : {}),
  };
}

/** Subset of `fx status --json` the probe reads. */
const FxStatusJson = Schema.Struct({
  model: Schema.optional(Schema.NullOr(Schema.String)),
  auth: Schema.optional(Schema.NullOr(Schema.String)),
  auth_help: Schema.optional(Schema.NullOr(Schema.String)),
});
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
export function parseFxStatusOutput(result: CommandResult): FxStatusResult | undefined {
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
    return {
      auth: { status: "unauthenticated" },
      defaultModel,
      message:
        status.auth_help?.trim() ||
        "fx is not signed in. Run `fx login`, `fx setup`, or set AI_GATEWAY_API_KEY.",
    };
  }
  return {
    auth: { status: "authenticated", type: authSource, label: `fx · ${authSource}` },
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
      hideWindowsConsole({ env: environment, shell: false }),
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
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
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

  return {
    installed: true,
    version,
    status: parsedStatus.auth.status === "unauthenticated" ? "error" : "ready",
    auth: parsedStatus.auth,
    ...(parsedStatus.message ? { message: parsedStatus.message } : {}),
  };
});

const fxUpdate = buildFxCommand(null, ["upgrade"]);

export const FX_ACP_DESCRIPTOR: AcpProviderDescriptor<FxSettings> = {
  driverKind: FX_DRIVER_KIND,
  presentation: {
    displayName: "fx",
    badgeLabel: "Experimental",
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
  notInstalledMessage: fxNotInstalledMessage(),
  probe: probeFx,
  modelDiscoveryTimeoutMs: FX_MODEL_DISCOVERY_TIMEOUT_MS,
  modelCapabilitiesVaryByModel: false,
};

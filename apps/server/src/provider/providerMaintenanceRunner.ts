import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ServerProviderUpdateError,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderMaintenanceAction,
  type ServerProviderUpdateBlockerResolutionResult,
  type ServerProviderUpdatedPayload,
  type ServerProviderUpdateState,
} from "@threadlines/contracts";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";
import { enrichProviderSnapshotWithVersionAdvisory } from "./providerMaintenance.ts";
import type { ProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { planCliSpawn } from "../cliSpawn.ts";
const isServerProviderUpdateError = Schema.is(ServerProviderUpdateError);

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;
const POWERSHELL_EXECUTABLE = "powershell.exe";
const WINDOWS_CLAUDE_PROCESS_QUERY_SCRIPT = `
$ErrorActionPreference = "Stop"
$processes = @(Get-CimInstance Win32_Process -Filter "name = 'claude.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine)
if ($processes.Count -gt 0) {
  ConvertTo-Json -InputObject $processes -Compress -Depth 4
}
`;
const WINDOWS_CLAUDE_PROCESS_STOP_SCRIPT = `
$ErrorActionPreference = "Stop"
$processes = @(Get-CimInstance Win32_Process -Filter "name = 'claude.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine)
$initialCount = $processes.Count
foreach ($process in $processes) {
  try {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
  } catch {
  }
}
Start-Sleep -Milliseconds 400
$remaining = @(Get-CimInstance Win32_Process -Filter "name = 'claude.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine)
$resolvedCount = [Math]::Max(0, $initialCount - $remaining.Count)
[pscustomobject]@{
  StoppedProcessCount = $resolvedCount
  RemainingProcessCount = $remaining.Count
  Remaining = $remaining
} | ConvertTo-Json -Compress -Depth 4
`;

export interface ProviderMaintenanceCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProviderMaintenanceRunnerShape {
  /**
   * Run one package-manager command for the target instance. `action`
   * selects which capability supplies the command: `"update"` (default)
   * refreshes an installed CLI, `"install"` puts a missing one on the
   * machine. Both share this path so they also share the lock, the captured
   * output, the progress state, and the post-command re-probe.
   */
  readonly updateProvider: (
    target:
      | ProviderDriverKind
      | {
          readonly provider: ProviderDriverKind;
          readonly instanceId?: ProviderInstanceId | undefined;
          readonly action?: ServerProviderMaintenanceAction | undefined;
        },
  ) => Effect.Effect<ServerProviderUpdatedPayload, ServerProviderUpdateError>;
  readonly resolveUpdateBlockers: (
    target:
      | ProviderDriverKind
      | {
          readonly provider: ProviderDriverKind;
          readonly instanceId?: ProviderInstanceId | undefined;
        },
  ) => Effect.Effect<ServerProviderUpdateBlockerResolutionResult, ServerProviderUpdateError>;
}

export class ProviderMaintenanceRunner extends Context.Service<
  ProviderMaintenanceRunner,
  ProviderMaintenanceRunnerShape
>()("threadlines/provider/ProviderMaintenanceRunner") {}

class ProviderMaintenanceCommandError extends Data.TaggedError("ProviderMaintenanceCommandError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

interface VerifiedProviderRefresh {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly verifiedProviders: ReadonlyArray<ServerProvider>;
}

interface ProviderUpdateSessionPreflight {
  readonly status: "ready" | "blocked";
  readonly message: string | null;
  readonly output: string | null;
}

interface WindowsClaudeProcessLock {
  readonly pid: number;
  readonly parentPid: number | null;
  readonly executablePath: string | null;
  readonly commandLine: string | null;
}

interface WindowsClaudeProcessStopResult {
  readonly stoppedProcessCount: number;
  readonly remainingProcessCount: number;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runProviderMaintenanceCommandWithSpawner = Effect.fn("ProviderMaintenanceRunner.runCommand")(
  function* (input: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly environmentPatch?: Readonly<Record<string, string>>;
  }) {
    const collectCommandResult = Effect.fn("ProviderMaintenanceRunner.collectCommandResult")(
      function* () {
        const commandEnvironment = { ...process.env, ...input.environmentPatch };
        const spawnPlan = planCliSpawn(input.command, input.args, commandEnvironment);
        const child = yield* input.spawner
          .spawn(
            ChildProcess.make(
              spawnPlan.command,
              [...spawnPlan.args],
              hideWindowsConsole({
                ...spawnPlan.options,
                ...(input.environmentPatch
                  ? { env: input.environmentPatch, extendEnv: true as const }
                  : {}),
              }),
            ),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderMaintenanceCommandError({
                  message: `Failed to run ${input.command}: ${cause.message}`,
                  cause,
                }),
            ),
          );
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: child.stdout,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: child.stderr,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderMaintenanceCommandError({
                message: cause instanceof Error ? cause.message : "Provider command failed to run.",
                cause,
              }),
          ),
        );

        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: Number(exitCode),
          timedOut: false,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies ProviderMaintenanceCommandResult;
      },
    );

    return yield* collectCommandResult().pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(UPDATE_TIMEOUT_MS)),
      Effect.map((result) =>
        Option.match(result, {
          onSome: (value) => value,
          onNone: () =>
            ({
              stdout: "",
              stderr: "",
              exitCode: null,
              timedOut: true,
              stdoutTruncated: false,
              stderrTruncated: false,
            }) satisfies ProviderMaintenanceCommandResult,
        }),
      ),
    );
  },
);

function powershellEncodedArgs(script: string): ReadonlyArray<string> {
  return [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function trimNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function commandOutput(result: ProviderMaintenanceCommandResult): string | null {
  const output = trimNullable([result.stderr, result.stdout].filter(Boolean).join("\n\n"));
  if (!output) {
    return null;
  }
  return truncateText(output, UPDATE_OUTPUT_MAX_BYTES);
}

function commandStdout(result: ProviderMaintenanceCommandResult): string | null {
  return trimNullable(result.stdout);
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseWindowsClaudeProcessLocks(
  output: string | null,
): ReadonlyArray<WindowsClaudeProcessLock> {
  if (!output) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(output);
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.flatMap((record) => {
      if (record === null || typeof record !== "object") {
        return [];
      }
      const row = record as Record<string, unknown>;
      const pid = readNumber(row.ProcessId);
      if (pid === null || pid <= 0) {
        return [];
      }
      return [
        {
          pid,
          parentPid: readNumber(row.ParentProcessId),
          executablePath: readString(row.ExecutablePath),
          commandLine: readString(row.CommandLine),
        },
      ];
    });
  } catch {
    return [];
  }
}

function parseWindowsClaudeProcessStopResult(
  output: string | null,
): WindowsClaudeProcessStopResult | null {
  if (!output) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(output);
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    const row = parsed as Record<string, unknown>;
    const stoppedProcessCount = readNumber(row.StoppedProcessCount);
    const remainingProcessCount = readNumber(row.RemainingProcessCount);
    if (stoppedProcessCount === null || remainingProcessCount === null) {
      return null;
    }
    return {
      stoppedProcessCount: Math.max(0, Math.trunc(stoppedProcessCount)),
      remainingProcessCount: Math.max(0, Math.trunc(remainingProcessCount)),
    };
  } catch {
    return null;
  }
}

function providerDisplayName(provider: ProviderDriverKind): string {
  switch (provider) {
    case "claudeAgent":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    default:
      return provider;
  }
}

function formatProcessCount(count: number): string {
  return `${count} process${count === 1 ? "" : "es"}`;
}

function windowsClaudeProcessLockMessage(
  provider: ProviderDriverKind,
  processCount: number,
): string {
  const displayName = providerDisplayName(provider);
  const countText = processCount > 0 ? ` (${formatProcessCount(processCount)} found)` : "";
  return `${displayName} is still running${countText}, so Windows cannot replace its executable. Stop ${displayName} processes, close other ${displayName} windows, or end terminal ${displayName} sessions and try again.`;
}

function windowsClaudeProcessStopMessage(
  provider: ProviderDriverKind,
  result: WindowsClaudeProcessStopResult,
): string {
  const displayName = providerDisplayName(provider);
  if (result.remainingProcessCount > 0) {
    return `${displayName} still has ${formatProcessCount(result.remainingProcessCount)} running. Close remaining ${displayName} sessions and try again.`;
  }
  if (result.stoppedProcessCount === 0) {
    return `No running ${displayName} processes were found. Try the update again.`;
  }
  return `Stopped ${formatProcessCount(result.stoppedProcessCount)} running ${displayName}. Run the update again.`;
}

function isWindowsExecutableReplaceFailure(result: ProviderMaintenanceCommandResult): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    (output.includes("cannot create a file when that file already exists") &&
      output.includes(".exe")) ||
    output.includes(
      "the process cannot access the file because it is being used by another process",
    )
  );
}

/**
 * Install and update run the same command through the same machinery, so the
 * only thing that varies is what we tell the user we are doing.
 */
interface ProviderMaintenanceActionCopy {
  readonly running: string;
  readonly succeeded: string;
  readonly unverified: string;
  readonly incomplete: string;
  readonly timedOut: string;
  readonly failed: string;
  readonly unsupported: string;
  readonly exitCode: (exitCode: number) => string;
}

const PROVIDER_MAINTENANCE_ACTION_COPY: Record<
  ServerProviderMaintenanceAction,
  ProviderMaintenanceActionCopy
> = {
  update: {
    running: "Updating provider.",
    succeeded: "Provider updated.",
    unverified: "Update command completed, but Threadlines could not verify the provider version.",
    incomplete:
      "Update command completed, but Threadlines still detects an outdated provider version.",
    timedOut: "Update timed out.",
    failed: "Update command failed.",
    unsupported: "This provider does not support one-click updates.",
    exitCode: (exitCode) => `Update command exited with code ${exitCode}.`,
  },
  install: {
    running: "Installing provider.",
    succeeded: "Provider installed.",
    unverified: "Install command completed, but Threadlines could not verify the provider.",
    incomplete: "Install command completed, but Threadlines still cannot find the provider CLI.",
    timedOut: "Install timed out.",
    failed: "Install command failed.",
    unsupported: "Threadlines cannot install this provider for you.",
    exitCode: (exitCode) => `Install command exited with code ${exitCode}.`,
  },
};

/**
 * Did the command leave the provider in the state the user asked for? An
 * update has to move off the outdated version; an install has to produce a
 * CLI the probe can find.
 */
function isProviderMaintenanceIncomplete(
  action: ServerProviderMaintenanceAction,
  provider: ServerProvider,
): boolean {
  return action === "install" ? !provider.installed : isOutdatedProvider(provider);
}

function shouldPrepareSessionsForUpdate(input: {
  readonly provider: ProviderDriverKind;
  readonly update: ProviderMaintenanceCapabilities["update"];
}): boolean {
  return (
    process.platform === "win32" &&
    input.provider === "claudeAgent" &&
    input.update?.lockKey === "claude-native-verified-win32"
  );
}

function failureMessage(
  provider: ProviderDriverKind,
  result: ProviderMaintenanceCommandResult,
  action: ServerProviderMaintenanceAction = "update",
): string {
  const copy = PROVIDER_MAINTENANCE_ACTION_COPY[action];
  if (result.timedOut) {
    return copy.timedOut;
  }
  if (isWindowsExecutableReplaceFailure(result)) {
    return windowsClaudeProcessLockMessage(provider, 0);
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    return copy.exitCode(result.exitCode);
  }
  return copy.failed;
}

function isOutdatedProvider(provider: ServerProvider | undefined): boolean {
  return provider?.versionAdvisory?.status === "behind_latest";
}

function makeUpdateState(input: {
  readonly status: ServerProviderUpdateState["status"];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly output?: string | null;
}): ServerProviderUpdateState {
  return {
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    message: input.message,
    output: input.output ?? null,
  };
}

export const make = Effect.fn("ProviderMaintenanceRunner.make")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const runMaintenanceCommand = (
    command: string,
    args: ReadonlyArray<string>,
    environmentPatch?: Readonly<Record<string, string>>,
  ) =>
    runProviderMaintenanceCommandWithSpawner({
      spawner,
      command,
      args,
      ...(environmentPatch ? { environmentPatch } : {}),
    });
  const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
    makeAlreadyRunningError: () =>
      new ServerProviderUpdateError({
        provider: ProviderDriverKind.make("unknown"),
        reason: "Threadlines is already running a command for this provider.",
      }),
  });

  const verifyRefreshedProvider = (
    provider: ProviderDriverKind,
    maintenanceCapabilities: ProviderMaintenanceCapabilities,
    instanceId: ProviderInstanceId,
  ): Effect.Effect<VerifiedProviderRefresh> =>
    providerRegistry.getProviders.pipe(
      Effect.map((providers) =>
        providers
          .filter(
            (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
          )
          .map((candidate) => candidate.instanceId),
      ),
      Effect.flatMap((instanceIds) =>
        instanceIds.length === 0
          ? providerRegistry.refreshInstance(instanceId)
          : Effect.forEach(
              instanceIds,
              (instanceId) => providerRegistry.refreshInstance(instanceId),
              {
                concurrency: "unbounded",
                discard: true,
              },
            ).pipe(Effect.andThen(providerRegistry.getProviders)),
      ),
      Effect.flatMap((providers) => {
        const refreshedProviders = providers.filter(
          (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
        );
        if (refreshedProviders.length === 0) {
          return Effect.succeed<VerifiedProviderRefresh>({
            providers,
            verifiedProviders: [],
          });
        }
        return Effect.forEach(
          refreshedProviders,
          (refreshedProvider) =>
            enrichProviderSnapshotWithVersionAdvisory(
              refreshedProvider,
              maintenanceCapabilities,
            ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
          {
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.map(
            (verifiedProviders): VerifiedProviderRefresh => ({
              providers,
              verifiedProviders,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider post-update version verification failed", {
              provider,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as<VerifiedProviderRefresh>({
                providers,
                verifiedProviders: refreshedProviders,
              }),
            ),
          ),
        );
      }),
    );

  const checkWindowsClaudeProcessLocks = Effect.fn(
    "ProviderMaintenanceRunner.checkWindowsClaudeProcessLocks",
  )(function* (provider: ProviderDriverKind) {
    const result = yield* runMaintenanceCommand(
      POWERSHELL_EXECUTABLE,
      powershellEncodedArgs(WINDOWS_CLAUDE_PROCESS_QUERY_SCRIPT),
    );
    if (result.timedOut || result.exitCode !== 0) {
      yield* Effect.logWarning("Provider update preflight process query failed", {
        provider,
        message: failureMessage(provider, result),
        output: commandOutput(result),
      });
      return {
        status: "blocked",
        message:
          "Threadlines could not check whether Claude is still running before updating. Stop Claude processes or close Claude manually, then try again.",
        output: null,
      } satisfies ProviderUpdateSessionPreflight;
    }

    const output = commandStdout(result);
    const processLocks = parseWindowsClaudeProcessLocks(output);
    if (processLocks.length > 0) {
      return {
        status: "blocked",
        message: windowsClaudeProcessLockMessage(provider, processLocks.length),
        output,
      } satisfies ProviderUpdateSessionPreflight;
    }

    return {
      status: "ready",
      message: null,
      output: null,
    } satisfies ProviderUpdateSessionPreflight;
  });

  const stopWindowsClaudeProcesses = Effect.fn(
    "ProviderMaintenanceRunner.stopWindowsClaudeProcesses",
  )(function* (provider: ProviderDriverKind) {
    const result = yield* runMaintenanceCommand(
      POWERSHELL_EXECUTABLE,
      powershellEncodedArgs(WINDOWS_CLAUDE_PROCESS_STOP_SCRIPT),
    );
    if (result.timedOut || result.exitCode !== 0) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: "Threadlines could not stop Claude processes. Close Claude manually and try again.",
      });
    }

    const stopResult = parseWindowsClaudeProcessStopResult(commandStdout(result));
    if (!stopResult) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: "Threadlines could not read the Claude process stop result. Try the update again.",
      });
    }
    return stopResult;
  });

  const updateProvider: ProviderMaintenanceRunnerShape["updateProvider"] = Effect.fn(
    "ProviderMaintenanceRunner.updateProvider",
  )(function* (target) {
    const provider = typeof target === "string" ? target : target.provider;
    const instanceId =
      typeof target === "string"
        ? defaultInstanceIdForDriver(provider)
        : (target.instanceId ?? defaultInstanceIdForDriver(provider));
    const targetKey = `instance:${instanceId}`;
    const action: ServerProviderMaintenanceAction =
      typeof target === "string" ? "update" : (target.action ?? "update");
    const copy = PROVIDER_MAINTENANCE_ACTION_COPY[action];
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      instanceId,
      provider,
    );
    const update = action === "install" ? capabilities.install : capabilities.update;
    if (!update) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: copy.unsupported,
      });
    }

    const setUpdateState = (state: ServerProviderUpdateState | null) =>
      providerRegistry.setProviderMaintenanceActionState({
        instanceId,
        action,
        state,
      });
    const setQueuedState = setUpdateState(
      makeUpdateState({
        status: "queued",
        startedAt: null,
        finishedAt: null,
        message: "Waiting for another provider command to finish.",
      }),
    ).pipe(Effect.asVoid);

    const runProviderUpdate = Effect.fn("ProviderMaintenanceRunner.runProviderUpdate")(
      function* () {
        const finish = (state: ServerProviderUpdateState) =>
          setUpdateState(state).pipe(Effect.map((providers) => ({ providers })));
        const startedAtRef = yield* Ref.make<string | null>(null);

        const runCommandAndVerify = Effect.fn("ProviderMaintenanceRunner.runCommandAndVerify")(
          function* () {
            const startedAt = yield* nowIso;
            yield* Ref.set(startedAtRef, startedAt);
            yield* setUpdateState(
              makeUpdateState({
                status: "running",
                startedAt,
                finishedAt: null,
                message: copy.running,
              }),
            );

            const preflight = shouldPrepareSessionsForUpdate({ provider, update })
              ? yield* checkWindowsClaudeProcessLocks(provider)
              : ({
                  status: "ready",
                  message: null,
                  output: null,
                } satisfies ProviderUpdateSessionPreflight);
            if (preflight.status === "blocked") {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt: yield* nowIso,
                  message: preflight.message,
                  output: preflight.output,
                }),
              );
            }

            const result = yield* runMaintenanceCommand(
              update.executable,
              update.args,
              update.environmentPatch,
            );
            const finishedAt = yield* nowIso;
            if (result.timedOut || result.exitCode !== 0) {
              return yield* finish(
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt,
                  message: failureMessage(provider, result, action),
                  output: commandOutput(result),
                }),
              );
            }

            const { verifiedProviders } = yield* verifyRefreshedProvider(
              provider,
              capabilities,
              instanceId,
            );
            const couldNotVerify = verifiedProviders.length === 0;
            const isIncomplete =
              couldNotVerify ||
              verifiedProviders.some((verifiedProvider) =>
                isProviderMaintenanceIncomplete(action, verifiedProvider),
              );
            return yield* finish(
              makeUpdateState({
                status: isIncomplete ? "unchanged" : "succeeded",
                startedAt,
                finishedAt,
                message: couldNotVerify
                  ? copy.unverified
                  : isIncomplete
                    ? copy.incomplete
                    : copy.succeeded,
                output: commandOutput(result),
              }),
            );
          },
        );

        const recordFailedUpdate = Effect.fn("ProviderMaintenanceRunner.recordFailedUpdate")(
          function* (cause: Cause.Cause<unknown>) {
            const failure = Cause.squash(cause);
            const startedAt = yield* Ref.get(startedAtRef);
            return yield* finish(
              makeUpdateState({
                status: "failed",
                startedAt,
                finishedAt: yield* nowIso,
                message: failure instanceof Error ? failure.message : copy.failed,
                output: null,
              }),
            );
          },
        );

        return yield* runCommandAndVerify().pipe(Effect.catchCause(recordFailedUpdate));
      },
    );

    return yield* commandCoordinator
      .withCommandLock({
        targetKey,
        lockKey: update.lockKey,
        onQueued: setQueuedState,
        run: runProviderUpdate(),
      })
      .pipe(
        Effect.mapError((error) =>
          isServerProviderUpdateError(error)
            ? new ServerProviderUpdateError({
                provider,
                reason: error.reason,
              })
            : error,
        ),
      );
  });

  const resolveUpdateBlockers: ProviderMaintenanceRunnerShape["resolveUpdateBlockers"] = Effect.fn(
    "ProviderMaintenanceRunner.resolveUpdateBlockers",
  )(function* (target) {
    const provider = typeof target === "string" ? target : target.provider;
    const instanceId =
      typeof target === "string"
        ? defaultInstanceIdForDriver(provider)
        : (target.instanceId ?? defaultInstanceIdForDriver(provider));
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      instanceId,
      provider,
    );
    const update = capabilities.update;
    if (!update || !shouldPrepareSessionsForUpdate({ provider, update })) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: "Threadlines cannot automatically stop blockers for this provider update.",
      });
    }

    const setUpdateState = (state: ServerProviderUpdateState | null) =>
      providerRegistry.setProviderMaintenanceActionState({
        instanceId,
        action: "update",
        state,
      });
    const startedAt = yield* nowIso;
    yield* setUpdateState(
      makeUpdateState({
        status: "running",
        startedAt,
        finishedAt: null,
        message: "Stopping Claude processes that are blocking the update.",
      }),
    );

    const finish = Effect.fn("ProviderMaintenanceRunner.finishResolveUpdateBlockers")(function* (
      result: WindowsClaudeProcessStopResult,
    ) {
      const message = windowsClaudeProcessStopMessage(provider, result);
      const providers = yield* setUpdateState(
        makeUpdateState({
          status: result.remainingProcessCount > 0 ? "failed" : "unchanged",
          startedAt,
          finishedAt: yield* nowIso,
          message,
          output: null,
        }),
      );
      return {
        providers,
        stoppedProcessCount: result.stoppedProcessCount,
        remainingProcessCount: result.remainingProcessCount,
        message,
      } satisfies ServerProviderUpdateBlockerResolutionResult;
    });

    return yield* stopWindowsClaudeProcesses(provider).pipe(
      Effect.flatMap(finish),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const failure = Cause.squash(cause);
          const reason =
            failure instanceof ServerProviderUpdateError
              ? failure.reason
              : failure instanceof Error
                ? failure.message
                : "Threadlines could not stop provider update blockers.";
          yield* setUpdateState(
            makeUpdateState({
              status: "failed",
              startedAt,
              finishedAt: yield* nowIso,
              message: reason,
              output: null,
            }),
          );
          return yield* new ServerProviderUpdateError({
            provider,
            reason,
          });
        }),
      ),
    );
  });

  return ProviderMaintenanceRunner.of({
    updateProvider,
    resolveUpdateBlockers,
  });
});

export const layer = Layer.effect(ProviderMaintenanceRunner, make());

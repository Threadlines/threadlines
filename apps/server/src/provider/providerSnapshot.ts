import type {
  ProviderDriverKind,
  ModelCapabilities,
  RuntimeMode,
  ServerProvider,
  ServerProviderAccountUsage,
  ServerProviderAuth,
  ServerProviderDetection,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderModel,
  ServerProviderState,
  ServerProviderStatusReason,
} from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import { normalizeModelSlug } from "@threadlines/shared/model";
import { planCliSpawn } from "../cliSpawn.ts";
import { isWindowsCommandNotFound } from "../processRunner.ts";
import { createProviderVersionAdvisory } from "./providerMaintenance.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

export const DEFAULT_TIMEOUT_MS = 4_000;
// Codex app-server provider probes can be slow on first run, especially on Windows.
export const AUTH_PROBE_TIMEOUT_MS = 60_000;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export class ProviderCommandExecutionError extends Data.TaggedError(
  "ProviderCommandExecutionError",
)<{
  readonly message: string;
}> {}

export interface ProviderProbeResult {
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly statusReason?: ServerProviderStatusReason;
  /** Set when the CLI is there but cannot start; see `ServerProvider.runnable`. */
  readonly runnable?: false;
  readonly auth: ServerProviderAuth;
  readonly accountUsage?: ServerProviderAccountUsage;
  readonly message?: string;
  /**
   * Newest release the provider itself reports, for CLIs not published to
   * npm (Cursor's `agent about`, fx's GitHub releases). Lets the version
   * advisory offer an update without an npm lookup.
   */
  readonly latestVersion?: string | null;
}

export interface ServerProviderPresentation {
  readonly displayName: string;
  readonly badgeLabel?: string;
  /** Where the user manages this provider's subscription, for plan-gate CTAs. */
  readonly planUpgradeUrl?: string;
  readonly showInteractionModeToggle?: boolean;
  // Runtime modes this driver honors natively; absent means the legacy
  // three-mode set. See `ServerProvider.supportedRuntimeModes`.
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
}

export type ServerProviderDraft = Omit<ServerProvider, "instanceId" | "driver">;

export function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isCommandMissingCause(error: { readonly message: string }): boolean {
  const lower = error.message.toLowerCase();
  return lower.includes("enoent") || lower.includes("notfound");
}

export const spawnAndCollect = (binaryPath: string, command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    const result: CommandResult = { stdout, stderr, code: exitCode };
    if (isWindowsCommandNotFound(exitCode, stderr)) {
      return yield* new ProviderCommandExecutionError({ message: `spawn ${binaryPath} ENOENT` });
    }
    return result;
  }).pipe(Effect.scoped);

export function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

/** How long `<cli> --version` gets to answer when a check asks whether the CLI starts at all. */
const CLI_START_CHECK_TIMEOUT = Duration.seconds(10);

/** A CLI that says it does not know the flag did start; it is not broken. */
const USAGE_ERROR =
  /\b(?:unknown|unexpected|unrecognized|invalid) (?:option|argument|flag|command)\b|\busage:/iu;

/**
 * The line of a failed command's output that says what went wrong: the first
 * `Error:` line of a Node stack trace (npm's launcher throws one), else the
 * last line printed.
 */
function startFailureReason(output: string | undefined): string | undefined {
  const lines = (output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const errorLine = lines.find((line) => /^\w*Error: /.test(line));
  return errorLine ? errorLine.replace(/^\w*Error: /, "") : lines.at(-1);
}

/** Why a CLI cannot start, for a snapshot's `runnable: false`. */
export interface CliStartFailure {
  /** The CLI's own last word on it, when it printed one. */
  readonly reason: string | undefined;
}

/**
 * Reads a finished `--version` run: a non-zero exit means the CLI is there
 * and cannot start (an update that left a file out). Null when it ran, or
 * when it only complained about the flag.
 */
export function cliStartFailureFrom(result: CommandResult): CliStartFailure | null {
  if (result.code === 0 || USAGE_ERROR.test(`${result.stdout}\n${result.stderr}`)) {
    return null;
  }
  return { reason: startFailureReason(detailFromResult(result)) };
}

/** `message` with the CLI's own reason after it, when there is one. */
export function withStartFailureReason(message: string, failure: CliStartFailure): string {
  return failure.reason ? `${message} ${failure.reason}` : message;
}

/**
 * Why a CLI cannot start, asked with `<cli> --version` once its real check
 * has failed without saying why. Null when the CLI does run (it failed for
 * another reason, such as a config it rejects) or the question went
 * unanswered, so only a CLI known to be broken is called broken.
 */
export const readCliStartFailure = (input: {
  readonly binaryPath: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly cwd?: string | undefined;
}) => {
  const env = input.environment ?? process.env;
  const plan = planCliSpawn(input.binaryPath, ["--version"], env);
  return spawnAndCollect(
    input.binaryPath,
    ChildProcess.make(
      plan.command,
      [...plan.args],
      hideWindowsConsole({
        env,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...plan.options,
        forceKillAfter: "1 second",
      }),
    ),
  ).pipe(
    Effect.timeoutOption(CLI_START_CHECK_TIMEOUT),
    Effect.map((result) => (Option.isSome(result) ? cliStartFailureFrom(result.value) : null)),
    Effect.orElseSucceed(() => null),
  );
};

export function extractAuthBoolean(value: unknown): boolean | undefined {
  if (globalThis.Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

export function providerModelsFromSettings(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  provider: ProviderDriverKind,
  customModels: ReadonlyArray<string>,
  customModelCapabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  const resolvedBuiltInModels = [...builtInModels];
  const seen = new Set(resolvedBuiltInModels.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];

  for (const candidate of customModels) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    customEntries.push({
      slug: normalized,
      name: normalized,
      isCustom: true,
      capabilities: customModelCapabilities,
    });
  }

  return [...resolvedBuiltInModels, ...customEntries];
}

export function buildSelectOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly options:
    | ReadonlyArray<{ value: string; label: string; isDefault?: boolean | undefined }>
    | undefined;
  readonly description?: string;
}) {
  const options = (input.options ?? []).map((option) =>
    option.isDefault
      ? { id: option.value, label: option.label, isDefault: true }
      : { id: option.value, label: option.label },
  );
  const currentValue = options.find((option) => option.isDefault)?.id;
  return {
    id: input.id,
    label: input.label,
    type: "select" as const,
    options,
    ...(currentValue ? { currentValue } : {}),
    ...(input.description ? { description: input.description } : {}),
  };
}

export function buildBooleanOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly currentValue?: boolean;
  readonly description?: string;
}) {
  return {
    id: input.id,
    label: input.label,
    type: "boolean" as const,
    ...(input.description ? { description: input.description } : {}),
    ...(typeof input.currentValue === "boolean" ? { currentValue: input.currentValue } : {}),
  };
}

export function buildServerProvider(input: {
  driver?: ProviderDriverKind;
  presentation: ServerProviderPresentation;
  enabled: boolean;
  checkedAt: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelCatalogSource?: "live" | "fallback";
  slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  skills?: ReadonlyArray<ServerProviderSkill>;
  probe: ProviderProbeResult;
  /** What a filesystem-only look found; kept only while the instance is turned off. */
  detection?: ServerProviderDetection;
}): ServerProviderDraft {
  const versionAdvisory = input.driver
    ? createProviderVersionAdvisory({
        driver: input.driver,
        currentVersion: input.probe.version,
        ...(input.probe.latestVersion ? { latestVersion: input.probe.latestVersion } : {}),
        checkedAt: input.checkedAt,
      })
    : undefined;
  return {
    displayName: input.presentation.displayName,
    ...(input.presentation.badgeLabel ? { badgeLabel: input.presentation.badgeLabel } : {}),
    ...(input.presentation.planUpgradeUrl
      ? { planUpgradeUrl: input.presentation.planUpgradeUrl }
      : {}),
    ...(typeof input.presentation.showInteractionModeToggle === "boolean"
      ? { showInteractionModeToggle: input.presentation.showInteractionModeToggle }
      : {}),
    ...(input.presentation.supportedRuntimeModes
      ? { supportedRuntimeModes: input.presentation.supportedRuntimeModes }
      : {}),
    enabled: input.enabled,
    installed: input.probe.installed,
    version: input.probe.version,
    status: input.enabled ? input.probe.status : "disabled",
    ...(input.probe.statusReason ? { statusReason: input.probe.statusReason } : {}),
    ...(input.enabled && input.probe.runnable === false ? { runnable: false as const } : {}),
    auth: input.probe.auth,
    ...(input.probe.accountUsage ? { accountUsage: input.probe.accountUsage } : {}),
    checkedAt: input.checkedAt,
    ...(input.probe.message ? { message: input.probe.message } : {}),
    ...(input.modelCatalogSource ? { modelCatalogSource: input.modelCatalogSource } : {}),
    models: input.models,
    slashCommands: [...(input.slashCommands ?? [])],
    skills: [...(input.skills ?? [])],
    ...(versionAdvisory ? { versionAdvisory } : {}),
    ...(!input.enabled && input.detection ? { detection: input.detection } : {}),
  };
}

export const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> =>
  collectUint8StreamText({ stream }).pipe(Effect.map((collected) => collected.text));

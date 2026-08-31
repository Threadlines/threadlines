/**
 * CursorAcpSupport — the Cursor Agent (`agent acp`) descriptor for the
 * generic ACP driver.
 *
 * Cursor-specific pieces: the `agent about` health probe with its
 * lab-channel / version gate for the parameterized model picker, the
 * per-model option mapping (reasoning / context / fast / thinking), bracket
 * traits on model ids, and the `cursor/*` extension methods.
 *
 * Public Docs: https://cursor.com/docs/cli/acp#cursor-extension-methods
 *
 * @module provider/acp/CursorAcpSupport
 */
import * as NodeOs from "node:os";

import {
  CursorSettings,
  type ModelCapabilities,
  type ProviderOptionSelection,
  ProviderDriverKind,
  type ServerProviderAuth,
  type ServerProviderState,
} from "@threadlines/contracts";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import {
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "@threadlines/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { makeProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  isCommandMissingCause,
  spawnAndCollect,
  type CommandResult,
} from "../providerSnapshot.ts";
import type {
  AcpConfigUpdate,
  AcpModelOptionMapping,
  AcpProviderDescriptor,
  AcpProviderProbeOutcome,
} from "./AcpProviderDescriptor.ts";
import {
  EMPTY_ACP_MODEL_CAPABILITIES,
  flattenSessionConfigSelectOptions,
  type AcpSelectChoice,
} from "./AcpProviderModels.ts";
import { createModelCapabilities } from "@threadlines/shared/model";
import type { AcpSpawnInput } from "./AcpSessionRuntime.ts";
import {
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
} from "./CursorAcpExtension.ts";

const decodeCursorSettings = Schema.decodeSync(CursorSettings);

export const CURSOR_DRIVER_KIND = ProviderDriverKind.make("cursor");
const CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE = 2026_04_08;
/** Timeout for `agent about` — it's slower than a simple `--version` probe. */
const ABOUT_TIMEOUT_MS = 8_000;
const CURSOR_SHELL_INSTALL = {
  executable: "bash",
  args: ["-c", "curl https://cursor.com/install -fsS | bash"],
  lockKey: "cursor-agent",
  displayCommand: "curl https://cursor.com/install -fsS | bash",
} as const;

export const CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

type CursorSpawnSettings = Pick<CursorSettings, "apiEndpoint" | "binaryPath">;

export function buildCursorAcpSpawnInput(
  cursorSettings: CursorSpawnSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  return {
    command: cursorSettings?.binaryPath || "agent",
    args: [
      ...(cursorSettings?.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
      "acp",
    ],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

// ── Model option mapping ──────────────────────────────────────────────

function normalizeCursorReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

function getCursorConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

function isCursorEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

function findCursorEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isCursorEffortConfigOption(option),
  );
  return (
    candidates.find((option) => getCursorConfigOptionCategory(option) === "model_option") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => getCursorConfigOptionCategory(option) === "thought_level") ??
    candidates[0]
  );
}

function isCursorContextConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function isCursorFastConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "fast" || name === "fast" || name.includes("fast mode");
}

function isCursorThinkingConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "thinking" || name.includes("thinking");
}

function isBooleanLikeConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (option.type === "boolean") {
    return true;
  }
  if (option.type !== "select") {
    return false;
  }
  const values = new Set(
    flattenSessionConfigSelectOptions(option).map((entry) => entry.value.trim().toLowerCase()),
  );
  return values.has("true") && values.has("false");
}

function getBooleanCurrentValue(
  option: EffectAcpSchema.SessionConfigOption | undefined,
): boolean | undefined {
  if (!option) {
    return undefined;
  }
  if (option.type === "boolean") {
    return option.currentValue;
  }
  if (option.type !== "select") {
    return undefined;
  }
  const normalized = option.currentValue?.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return undefined;
}

function findModelConfigOptionByCategory(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  matcher: (option: EffectAcpSchema.SessionConfigOption) => boolean,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find((option) => option.category === "model_config" && matcher(option));
}

export function buildCursorCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_ACP_MODEL_CAPABILITIES;
  }

  const reasoningConfig = findCursorEffortConfigOption(configOptions);
  const reasoningEffortLevels =
    reasoningConfig?.type === "select"
      ? flattenSessionConfigSelectOptions(reasoningConfig).flatMap((entry) => {
          const normalizedValue = normalizeCursorReasoningValue(entry.value);
          if (!normalizedValue) {
            return [];
          }
          return [
            {
              value: normalizedValue,
              label: entry.name,
              ...(normalizeCursorReasoningValue(reasoningConfig.currentValue) === normalizedValue
                ? { isDefault: true }
                : {}),
            },
          ];
        })
      : [];

  const contextOption = findModelConfigOptionByCategory(configOptions, isCursorContextConfigOption);
  const contextWindowOptions =
    contextOption?.type === "select"
      ? flattenSessionConfigSelectOptions(contextOption).map((entry) =>
          contextOption.currentValue === entry.value
            ? { value: entry.value, label: entry.name, isDefault: true }
            : { value: entry.value, label: entry.name },
        )
      : [];

  const fastOption = findModelConfigOptionByCategory(configOptions, isCursorFastConfigOption);
  const thinkingOption = findModelConfigOptionByCategory(
    configOptions,
    isCursorThinkingConfigOption,
  );
  const fastCurrentValue = getBooleanCurrentValue(fastOption);
  const thinkingCurrentValue = getBooleanCurrentValue(thinkingOption);
  const optionDescriptors = [
    ...(reasoningEffortLevels.length > 0
      ? [
          buildSelectOptionDescriptor({
            id: "reasoning",
            label: reasoningConfig?.name?.trim() || "Reasoning",
            options: reasoningEffortLevels,
          }),
        ]
      : []),
    ...(contextWindowOptions.length > 0
      ? [
          buildSelectOptionDescriptor({
            id: "contextWindow",
            label: contextOption?.name?.trim() || "Context Window",
            options: contextWindowOptions,
          }),
        ]
      : []),
    ...(fastOption && isBooleanLikeConfigOption(fastOption)
      ? [
          buildBooleanOptionDescriptor({
            id: "fastMode",
            label: fastOption.name?.trim() || "Fast Mode",
            ...(typeof fastCurrentValue === "boolean" ? { currentValue: fastCurrentValue } : {}),
          }),
        ]
      : []),
    ...(thinkingOption && isBooleanLikeConfigOption(thinkingOption)
      ? [
          buildBooleanOptionDescriptor({
            id: "thinking",
            label: thinkingOption.name?.trim() || "Thinking",
            ...(typeof thinkingCurrentValue === "boolean"
              ? { currentValue: thinkingCurrentValue }
              : {}),
          }),
        ]
      : []),
  ];

  return createModelCapabilities({ optionDescriptors });
}

function normalizeCursorConfigOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

function findCursorSelectOptionValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  matcher: (option: AcpSelectChoice) => boolean,
): string | undefined {
  return flattenSessionConfigSelectOptions(configOption).find(matcher)?.value;
}

function findCursorBooleanConfigValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  requested: boolean,
): string | boolean | undefined {
  if (!configOption) {
    return undefined;
  }
  if (configOption.type === "boolean") {
    return requested;
  }
  return findCursorSelectOptionValue(
    configOption,
    (option) => normalizeCursorConfigOptionToken(option.value) === String(requested),
  );
}

/** Cursor model ids may carry bracket traits (`gpt-5.4[reasoning=high]`); ACP wants the base id. */
export function resolveCursorAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "default";
  return base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
}

export function resolveCursorAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<AcpConfigUpdate> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const updates: Array<AcpConfigUpdate> = [];

  const reasoningOption = findCursorEffortConfigOption(configOptions);
  const requestedReasoning = normalizeCursorReasoningValue(
    getProviderOptionStringSelectionValue(selections, "reasoning"),
  );
  if (reasoningOption && requestedReasoning) {
    const value = findCursorSelectOptionValue(reasoningOption, (option) => {
      const normalizedValue = normalizeCursorReasoningValue(option.value);
      const normalizedName = normalizeCursorReasoningValue(option.name);
      return normalizedValue === requestedReasoning || normalizedName === requestedReasoning;
    });
    if (value) {
      updates.push({ configId: reasoningOption.id, value });
    }
  }

  const contextOption = findModelConfigOptionByCategory(configOptions, isCursorContextConfigOption);
  const requestedContextWindow = getProviderOptionStringSelectionValue(selections, "contextWindow");
  if (contextOption && requestedContextWindow) {
    const value = findCursorSelectOptionValue(
      contextOption,
      (option) =>
        normalizeCursorConfigOptionToken(option.value) ===
          normalizeCursorConfigOptionToken(requestedContextWindow) ||
        normalizeCursorConfigOptionToken(option.name) ===
          normalizeCursorConfigOptionToken(requestedContextWindow),
    );
    if (value) {
      updates.push({ configId: contextOption.id, value });
    }
  }

  const fastOption = findModelConfigOptionByCategory(configOptions, isCursorFastConfigOption);
  const requestedFastMode = getProviderOptionBooleanSelectionValue(selections, "fastMode");
  if (fastOption && typeof requestedFastMode === "boolean") {
    const value = findCursorBooleanConfigValue(fastOption, requestedFastMode);
    if (value !== undefined) {
      updates.push({ configId: fastOption.id, value });
    }
  }

  const thinkingOption = findModelConfigOptionByCategory(
    configOptions,
    isCursorThinkingConfigOption,
  );
  const requestedThinking = getProviderOptionBooleanSelectionValue(selections, "thinking");
  if (thinkingOption && typeof requestedThinking === "boolean") {
    const value = findCursorBooleanConfigValue(thinkingOption, requestedThinking);
    if (value !== undefined) {
      updates.push({ configId: thinkingOption.id, value });
    }
  }

  return updates;
}

export const CURSOR_MODEL_OPTION_MAPPING: AcpModelOptionMapping = {
  capabilitiesFromConfigOptions: buildCursorCapabilitiesFromConfigOptions,
  configUpdatesFromSelections: resolveCursorAcpConfigUpdates,
};

// ── `agent about` probe ───────────────────────────────────────────────

/** Strip ANSI escape sequences so we can parse plain key-value lines. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

/**
 * Extract a value from `agent about` key-value output.
 * Lines look like: `CLI Version         2026.03.20-44cb435`
 */
function extractAboutField(plain: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}\\s{2,}(.+)$`, "mi");
  const match = regex.exec(plain);
  return match?.[1]?.trim();
}

export interface CursorAboutResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

interface CursorAboutJsonPayload {
  readonly cliVersion?: unknown;
  readonly subscriptionTier?: unknown;
  readonly userEmail?: unknown;
}

export function parseCursorVersionDate(version: string | null | undefined): number | undefined {
  const match = version?.trim().match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\b|-|$)/);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  return Number(`${year}${month}${day}`);
}

export function parseCursorCliConfigChannel(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "channel" in parsed &&
      typeof parsed.channel === "string"
    ) {
      const channel = parsed.channel.trim().toLowerCase();
      return channel.length > 0 ? channel : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function cursorSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  switch (normalized) {
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function cursorAuthMetadata(
  subscriptionType: string | undefined,
): Pick<ServerProviderAuth, "label" | "type"> | undefined {
  if (!subscriptionType) {
    return undefined;
  }
  const subscriptionLabel = cursorSubscriptionLabel(subscriptionType);
  return {
    type: subscriptionType,
    label: `Cursor ${subscriptionLabel ?? toTitleCaseWords(subscriptionType)} Subscription`,
  };
}

function parseCursorAboutJsonPayload(raw: string): CursorAboutJsonPayload | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as CursorAboutJsonPayload;
  } catch {
    return undefined;
  }
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isCursorAboutJsonFormatUnsupported(result: CommandResult): boolean {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    lowerOutput.includes("unknown option '--format'") ||
    lowerOutput.includes("unexpected argument '--format'") ||
    lowerOutput.includes("unrecognized option '--format'") ||
    lowerOutput.includes("unknown argument '--format'")
  );
}

const CURSOR_UNAUTHENTICATED_MESSAGE =
  "Cursor Agent is not authenticated. Run `agent login` and try again.";

function isLoggedOutEmail(userEmail: string): boolean {
  const lowerEmail = userEmail.toLowerCase();
  return (
    lowerEmail === "not logged in" ||
    lowerEmail.includes("login required") ||
    lowerEmail.includes("authentication required")
  );
}

/**
 * Parse the output of `agent about` (JSON when supported, plain text
 * otherwise) to extract version and authentication status in one probe.
 */
export function parseCursorAboutOutput(result: CommandResult): CursorAboutResult {
  const jsonPayload = parseCursorAboutJsonPayload(result.stdout);
  if (jsonPayload) {
    const version =
      typeof jsonPayload.cliVersion === "string" ? jsonPayload.cliVersion.trim() : null;
    const hasUserEmailField = hasOwn(jsonPayload, "userEmail");
    const userEmail =
      typeof jsonPayload.userEmail === "string" ? jsonPayload.userEmail.trim() : undefined;
    const subscriptionType =
      typeof jsonPayload.subscriptionTier === "string"
        ? jsonPayload.subscriptionTier.trim()
        : undefined;
    const authMetadata = cursorAuthMetadata(subscriptionType);

    if (hasUserEmailField && jsonPayload.userEmail == null) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: CURSOR_UNAUTHENTICATED_MESSAGE,
      };
    }

    if (!userEmail) {
      if (result.code === 0) {
        return { version, status: "ready", auth: { status: "unknown", ...authMetadata } };
      }
      return {
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Cursor Agent authentication status.",
      };
    }

    if (isLoggedOutEmail(userEmail)) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: CURSOR_UNAUTHENTICATED_MESSAGE,
      };
    }

    return {
      version,
      status: "ready",
      auth: { status: "authenticated", email: userEmail, ...authMetadata },
    };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = combined.toLowerCase();

  // If the command itself isn't recognised, we're on an old CLI version.
  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "The `agent about` command is unavailable in this version of the Cursor Agent CLI.",
    };
  }

  const plain = stripAnsi(combined);
  const version = extractAboutField(plain, "CLI Version") ?? null;
  const userEmail = extractAboutField(plain, "User Email");

  if (userEmail === undefined) {
    if (result.code === 0) {
      return { version, status: "ready", auth: { status: "unknown" } };
    }
    return {
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: "Could not verify Cursor Agent authentication status.",
    };
  }

  if (isLoggedOutEmail(userEmail)) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: CURSOR_UNAUTHENTICATED_MESSAGE,
    };
  }

  return { version, status: "ready", auth: { status: "authenticated", email: userEmail } };
}

export function getCursorParameterizedModelPickerUnsupportedMessage(input: {
  readonly version: string | null | undefined;
  readonly channel: string | null | undefined;
}): string | undefined {
  const reasons: Array<string> = [];
  const versionDate = parseCursorVersionDate(input.version);
  if (
    versionDate !== undefined &&
    versionDate < CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE
  ) {
    reasons.push(
      `Cursor Agent CLI version ${input.version} is too old for Cursor ACP parameterized model picker`,
    );
  }

  const normalizedChannel = input.channel?.trim().toLowerCase();
  if (
    normalizedChannel !== undefined &&
    normalizedChannel.length > 0 &&
    normalizedChannel !== "lab"
  ) {
    reasons.push(
      `Cursor Agent CLI channel is ${JSON.stringify(input.channel)}, but parameterized model picker is only available on the lab channel`,
    );
  }

  if (reasons.length === 0) {
    return undefined;
  }

  return `${reasons.join(". ")}. Run \`agent set-channel lab && agent update\` and use Cursor Agent CLI 2026.04.08 or newer.`;
}

const readCursorCliConfigChannel = Effect.fn("readCursorCliConfigChannel")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(NodeOs.homedir(), ".cursor", "cli-config.json");
  const raw = yield* fileSystem.readFileString(configPath).pipe(Effect.orElseSucceed(() => ""));
  return parseCursorCliConfigChannel(raw);
});

const runCursorCommand = (
  cursorSettings: CursorSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  spawnAndCollect(
    cursorSettings.binaryPath,
    ChildProcess.make(
      cursorSettings.binaryPath,
      [...args],
      hideWindowsConsole({ env: environment, shell: process.platform === "win32" }),
    ),
  );

const runCursorAboutCommand = (cursorSettings: CursorSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const jsonResult = yield* runCursorCommand(
      cursorSettings,
      ["about", "--format", "json"],
      environment,
    );
    if (!isCursorAboutJsonFormatUnsupported(jsonResult)) {
      return jsonResult;
    }
    return yield* runCursorCommand(cursorSettings, ["about"], environment);
  });

/** Single `agent about` probe: version + auth, then the lab-channel gate. */
export const probeCursor = Effect.fn("probeCursor")(function* (
  cursorSettings: CursorSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  AcpProviderProbeOutcome,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const aboutProbe = yield* runCursorAboutCommand(cursorSettings, environment).pipe(
    Effect.timeoutOption(ABOUT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(aboutProbe)) {
    const error = aboutProbe.failure;
    return {
      installed: !isCommandMissingCause(error),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: isCommandMissingCause(error)
        ? "Cursor Agent CLI (`agent`) is not installed or not on PATH."
        : `Failed to execute Cursor Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  if (Option.isNone(aboutProbe.success)) {
    return {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Cursor Agent CLI is installed but timed out while running `agent about`.",
    };
  }

  const parsed = parseCursorAboutOutput(aboutProbe.success.value);
  const channel = yield* readCursorCliConfigChannel();
  const unsupportedMessage = getCursorParameterizedModelPickerUnsupportedMessage({
    version: parsed.version,
    channel,
  });
  if (unsupportedMessage) {
    return {
      installed: true,
      version: parsed.version,
      status: "error",
      auth: parsed.auth,
      message:
        parsed.auth.status === "unauthenticated" && parsed.message
          ? `${unsupportedMessage} ${parsed.message}`
          : unsupportedMessage,
      skipModelDiscovery: true,
    };
  }

  return {
    installed: true,
    version: parsed.version,
    status: parsed.status,
    auth: parsed.auth,
    ...(parsed.message ? { message: parsed.message } : {}),
  };
});

// ── Descriptor ────────────────────────────────────────────────────────

export const CURSOR_ACP_DESCRIPTOR: AcpProviderDescriptor<CursorSettings> = {
  driverKind: CURSOR_DRIVER_KIND,
  presentation: {
    displayName: "Cursor",
    badgeLabel: "Early Access",
    planUpgradeUrl: "https://cursor.com/settings",
    showInteractionModeToggle: true,
  },
  settingsSchema: CursorSettings,
  defaultSettings: () => decodeCursorSettings({}),
  maintenance: makeProviderMaintenanceCapabilities({
    provider: CURSOR_DRIVER_KIND,
    packageName: null,
    updateExecutable: "agent",
    updateArgs: ["update"],
    updateLockKey: "cursor-agent",
  }),
  // https://cursor.com/docs/cli/installation
  install: {
    darwin: CURSOR_SHELL_INSTALL,
    linux: CURSOR_SHELL_INSTALL,
    win32: {
      executable: "powershell.exe",
      args: ["-NoProfile", "-Command", "irm 'https://cursor.com/install?win32=true' | iex"],
      lockKey: "cursor-agent",
      displayCommand: "irm 'https://cursor.com/install?win32=true' | iex",
    },
  },
  spawn: buildCursorAcpSpawnInput,
  authMethodId: "cursor_login",
  clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  notInstalledMessage: "Cursor Agent CLI (`agent`) is not installed or not on PATH.",
  probe: probeCursor,
  modelOptions: CURSOR_MODEL_OPTION_MAPPING,
  modelCapabilitiesVaryByModel: true,
  resolveModelId: resolveCursorAcpBaseModelId,
  extensions: {
    source: "acp.cursor.extension",
    register: (context) =>
      Effect.gen(function* () {
        yield* context.acp.handleExtRequest(
          "cursor/ask_question",
          CursorAskQuestionRequest,
          (params) =>
            Effect.gen(function* () {
              yield* context.logNative("cursor/ask_question", params);
              const answers = yield* context.requestUserInput({
                method: "cursor/ask_question",
                payload: params,
                questions: extractAskQuestions(params),
              });
              return { answers };
            }),
        );
        yield* context.acp.handleExtRequest(
          "cursor/create_plan",
          CursorCreatePlanRequest,
          (params) =>
            Effect.gen(function* () {
              yield* context.logNative("cursor/create_plan", params);
              yield* context.emitProposedPlan({
                method: "cursor/create_plan",
                payload: params,
                planMarkdown: extractPlanMarkdown(params),
              });
              return { accepted: true } as const;
            }),
        );
        yield* context.acp.handleExtNotification(
          "cursor/update_todos",
          CursorUpdateTodosRequest,
          (params) =>
            Effect.gen(function* () {
              yield* context.logNative("cursor/update_todos", params);
              yield* context.emitPlanUpdate({
                method: "cursor/update_todos",
                payload: params,
                plan: extractTodosAsPlan(params),
              });
            }),
        );
      }),
  },
};

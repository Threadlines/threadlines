import {
  type ClaudeSettings,
  LEGACY_RUNTIME_MODES,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  RUNTIME_MODES,
  type ServerProviderAccountUsage,
  type ServerProviderAuthCapabilities,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import { planCliSpawn } from "../../cliSpawn.ts";
import {
  createModelCapabilities,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@threadlines/shared/model";
import { compareSemverVersions } from "@threadlines/shared/semver";
import {
  query as claudeQuery,
  type SlashCommand as ClaudeSlashCommand,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { CLAUDE_CODE_OAUTH_TOKEN_ENV } from "./ClaudeUsage.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const PROVIDER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
  supportedRuntimeModes: RUNTIME_MODES,
} as const;
/**
 * Models that predate the auto permission mode classifier. Auto mode needs
 * Opus 4.6+ or Sonnet 4.6-class models; the adapter clamps these to
 * acceptEdits and the UI hides the Auto option for them.
 * https://code.claude.com/docs/en/permission-modes#eliminate-prompts-with-auto-mode
 */
const CLAUDE_AUTO_MODE_UNSUPPORTED_SLUGS: ReadonlySet<string> = new Set([
  "claude-opus-4-5",
  "claude-haiku-4-5",
]);

export function claudeModelSupportsAutoRuntimeMode(modelSlug: string | null | undefined): boolean {
  return modelSlug ? !CLAUDE_AUTO_MODE_UNSUPPORTED_SLUGS.has(modelSlug) : true;
}
const MINIMUM_CLAUDE_FABLE_5_VERSION = "2.1.170";
const MINIMUM_CLAUDE_SONNET_5_VERSION = "2.1.197";
const MINIMUM_CLAUDE_OPUS_4_8_VERSION = "2.1.154";
const MINIMUM_CLAUDE_OPUS_4_7_VERSION = "2.1.111";
const CLAUDE_FABLE_5_DESCRIPTION =
  "Included on subscriptions through Jun 22; usage credits may be required Jun 23.";
const CLAUDE_FAST_MODE_DESCRIPTION =
  "Faster responses, higher cost. Usage credits, not subscription usage.";

const CLAUDE_EFFORT_OPTIONS = {
  fable5: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "xhigh", label: "Extra High" },
    { value: "max", label: "Max" },
    { value: "ultracode", label: "Ultracode" },
  ],
  sonnet5: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "xhigh", label: "Extra High" },
    { value: "max", label: "Max" },
    { value: "ultracode", label: "Ultracode" },
  ],
  opus48: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "xhigh", label: "Extra High" },
    { value: "max", label: "Max" },
    { value: "ultracode", label: "Ultracode" },
  ],
  opus47: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High", isDefault: true },
    { value: "max", label: "Max" },
  ],
  opus46: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "max", label: "Max" },
  ],
  opus45: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "max", label: "Max" },
  ],
  sonnet46: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High", isDefault: true },
    { value: "max", label: "Max" },
  ],
} as const;

const BUILT_IN_MODEL_DEFINITIONS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    description: CLAUDE_FABLE_5_DESCRIPTION,
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: CLAUDE_EFFORT_OPTIONS.fable5,
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: CLAUDE_EFFORT_OPTIONS.sonnet5,
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: CLAUDE_EFFORT_OPTIONS.opus48,
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
          description: CLAUDE_FAST_MODE_DESCRIPTION,
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "1m", label: "1M", isDefault: true },
            { value: "200k", label: "200k" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: CLAUDE_EFFORT_OPTIONS.opus47,
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
          description: CLAUDE_FAST_MODE_DESCRIPTION,
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: CLAUDE_EFFORT_OPTIONS.opus46,
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
          description: CLAUDE_FAST_MODE_DESCRIPTION,
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: CLAUDE_EFFORT_OPTIONS.opus45,
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: CLAUDE_EFFORT_OPTIONS.sonnet46,
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildBooleanOptionDescriptor({
          id: "thinking",
          label: "Thinking",
        }),
      ],
    }),
  },
];

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = BUILT_IN_MODEL_DEFINITIONS.map(
  (model) =>
    claudeModelSupportsAutoRuntimeMode(model.slug)
      ? model
      : { ...model, supportedRuntimeModes: LEGACY_RUNTIME_MODES },
);

function supportsClaudeOpus48(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_4_8_VERSION) >= 0 : false;
}

function supportsClaudeFable5(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_FABLE_5_VERSION) >= 0 : false;
}

function supportsClaudeSonnet5(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_SONNET_5_VERSION) >= 0 : false;
}

function supportsClaudeOpus47(version: string | null | undefined): boolean {
  return version ? compareSemverVersions(version, MINIMUM_CLAUDE_OPUS_4_7_VERSION) >= 0 : false;
}

function getBuiltInClaudeModelsForVersion(
  version: string | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  return BUILT_IN_MODELS.filter((model) => {
    if (model.slug === "claude-fable-5") {
      return supportsClaudeFable5(version);
    }
    if (model.slug === "claude-sonnet-5") {
      return supportsClaudeSonnet5(version);
    }
    if (model.slug === "claude-opus-4-8") {
      return supportsClaudeOpus48(version);
    }
    if (model.slug === "claude-opus-4-7") {
      return supportsClaudeOpus47(version);
    }
    return true;
  });
}

function formatClaudeModelUpgradeMessage(input: {
  readonly version: string | null;
  readonly modelName: string;
  readonly minimumVersion: string;
}): string {
  const { version, modelName, minimumVersion } = input;
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code ${versionLabel} is too old for ${modelName}. Upgrade to v${minimumVersion} or newer to access it.`;
}

function formatClaudeUpgradeMessage(version: string | null): string | undefined {
  if (!supportsClaudeOpus47(version)) {
    return formatClaudeModelUpgradeMessage({
      version,
      modelName: "Claude Opus 4.7",
      minimumVersion: MINIMUM_CLAUDE_OPUS_4_7_VERSION,
    });
  }
  if (!supportsClaudeOpus48(version)) {
    return formatClaudeModelUpgradeMessage({
      version,
      modelName: "Claude Opus 4.8",
      minimumVersion: MINIMUM_CLAUDE_OPUS_4_8_VERSION,
    });
  }
  if (!supportsClaudeFable5(version)) {
    return formatClaudeModelUpgradeMessage({
      version,
      modelName: "Claude Fable 5",
      minimumVersion: MINIMUM_CLAUDE_FABLE_5_VERSION,
    });
  }
  if (!supportsClaudeSonnet5(version)) {
    return formatClaudeModelUpgradeMessage({
      version,
      modelName: "Claude Sonnet 5",
      minimumVersion: MINIMUM_CLAUDE_SONNET_5_VERSION,
    });
  }
  return undefined;
}

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_CLAUDE_MODEL_CAPABILITIES
  );
}

export function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");
  const value = getProviderOptionCurrentValue(effortDescriptor);
  return typeof value === "string" ? value : undefined;
}

/**
 * Normalize a resolved Claude effort value into one suitable for the Claude
 * CLI's `--effort` flag.
 *
 * `"ultracode"` is a Claude Code setting that pairs with `xhigh` effort.
 * Returns `undefined` when no flag should be passed.
 */
export function normalizeClaudeCliEffort(effort: string | null | undefined): string | undefined {
  if (!effort) {
    return undefined;
  }
  if (effort === "ultracode") {
    return "xhigh";
  }
  return effort;
}

export function isClaudeUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

export function resolveClaudeApiModelId(modelSelection: ModelSelection): string {
  const descriptors = getProviderOptionDescriptors({
    caps: getClaudeModelCapabilities(modelSelection.model),
    selections: modelSelection.options,
  });
  const contextWindowDescriptor = descriptors.find(
    (descriptor) => descriptor.id === "contextWindow",
  );
  switch (getProviderOptionCurrentValue(contextWindowDescriptor)) {
    case "1m":
      return `${modelSelection.model}[1m]`;
    default:
      return modelSelection.model;
  }
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  if (
    normalized === "oauthtoken" ||
    normalized === "claudecodeoauthtoken" ||
    normalized === "claudeoauthtoken"
  ) {
    return "longLivedOAuthToken";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
  readonly hasLongLivedOAuthToken: boolean;
}): { readonly type: string; readonly label: string } | undefined {
  const normalizedAuthMethod = normalizeClaudeAuthMethod(input.authMethod);
  if (normalizedAuthMethod === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (normalizedAuthMethod === "longLivedOAuthToken" || input.hasLongLivedOAuthToken) {
    return {
      type: "longLivedOAuthToken",
      label: "Chat-only token",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

export function claudeAuthCapabilities(input: {
  readonly isApiKeyAuth: boolean;
  readonly isLongLivedOAuthAuth: boolean;
  readonly hasAccountUsage: boolean;
}): ServerProviderAuthCapabilities {
  const chatDetail = input.isLongLivedOAuthAuth
    ? "Verified on the next chat."
    : "Sign-in found; verified on the next chat.";
  const usage = input.hasAccountUsage
    ? {
        status: "verified" as const,
        detail: "Usage verified.",
      }
    : {
        status: "unavailable" as const,
        detail: input.isApiKeyAuth
          ? "Subscription usage is unavailable with an API key."
          : input.isLongLivedOAuthAuth
            ? "Normal Claude sign-in required for usage."
            : "Refresh Claude sign-in to restore usage.",
      };
  return {
    chat: {
      status: "configured",
      detail: chatDetail,
    },
    usage,
  };
}

// ── SDK capability probe ────────────────────────────────────────────

const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    return yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // Never yield — we only need initialization data, not a conversation.
        // This prevents any prompt from reaching the Anthropic API.
        // oxlint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: {
          persistSession: false,
          pathToClaudeCodeExecutable: claudeSettings.binaryPath,
          abortController: abort,
          settingSources: ["user", "project", "local"],
          allowedTools: [],
          env: claudeEnvironment,
          stderr: () => {},
        },
      });
      const init = await q.initializationResult();
      const account = init.account as
        | {
            readonly email?: string;
            readonly subscriptionType?: string;
            readonly tokenSource?: string;
          }
        | undefined;
      return {
        email: account?.email,
        subscriptionType: account?.subscriptionType,
        tokenSource: account?.tokenSource,
        slashCommands: parseClaudeInitializationCommands(init.commands),
      } satisfies ClaudeCapabilitiesProbe;
    });
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnPlan = planCliSpawn(claudeSettings.binaryPath, args, claudeEnvironment);
  const command = ChildProcess.make(
    spawnPlan.command,
    [...spawnPlan.args],
    hideWindowsConsole({
      env: claudeEnvironment,
      ...spawnPlan.options,
    }),
  );
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export function parseClaudeAuthStatusEmail(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      readonly loggedIn?: unknown;
      readonly account?: { readonly email?: unknown } | null;
    };
    if (parsed.loggedIn === false) return undefined;
    return typeof parsed.account?.email === "string"
      ? nonEmptyProbeString(parsed.account.email)
      : undefined;
  } catch {
    return undefined;
  }
}

export const readClaudeNormalAuthEmail = Effect.fn("readClaudeNormalAuthEmail")(function* (
  claudeSettings: ClaudeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const normalAuthEnvironment = { ...environment };
  delete normalAuthEnvironment[CLAUDE_CODE_OAUTH_TOKEN_ENV];
  delete normalAuthEnvironment.ANTHROPIC_AUTH_TOKEN;
  delete normalAuthEnvironment.ANTHROPIC_API_KEY;

  const result = yield* runClaudeCommand(
    claudeSettings,
    ["auth", "status"],
    normalAuthEnvironment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(result) || Option.isNone(result.success)) return undefined;
  if (result.success.value.code !== 0) return undefined;
  return parseClaudeAuthStatusEmail(result.success.value.stdout);
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined>,
  environment: NodeJS.ProcessEnv = process.env,
  resolveAccountUsage?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ServerProviderAccountUsage | undefined>,
  resolveUsageAuthEmail?: (claudeSettings: ClaudeSettings) => Effect.Effect<string | undefined>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in Threadlines settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(claudeSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
          : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Claude Agent CLI is installed but failed to run. ${detail}`
          : "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const models = providerModelsFromSettings(
    getBuiltInClaudeModelsForVersion(parsedVersion),
    PROVIDER,
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );
  const upgradeMessage = formatClaudeUpgradeMessage(parsedVersion);

  const capabilities = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
    : undefined;
  const slashCommands = capabilities?.slashCommands ?? [];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  const authMetadata = claudeAuthMetadata({
    subscriptionType: capabilities.subscriptionType,
    authMethod: capabilities.tokenSource,
    hasLongLivedOAuthToken:
      typeof environment[CLAUDE_CODE_OAUTH_TOKEN_ENV] === "string" &&
      environment[CLAUDE_CODE_OAUTH_TOKEN_ENV]!.trim().length > 0,
  });
  const isApiKeyAuth = authMetadata?.type === "apiKey";
  const isLongLivedOAuthAuth = authMetadata?.type === "longLivedOAuthToken";
  // Subscription usage comes from the Claude Code OAuth credential, which
  // does not exist for API-key auth — skip the lookup entirely there.
  const accountUsage =
    resolveAccountUsage && !isApiKeyAuth
      ? yield* resolveAccountUsage(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
  const resolvedUsageEmail =
    resolveUsageAuthEmail && isLongLivedOAuthAuth
      ? yield* resolveUsageAuthEmail(claudeSettings).pipe(Effect.orElseSucceed(() => undefined))
      : undefined;
  const usageEmail =
    resolvedUsageEmail && resolvedUsageEmail !== capabilities.email
      ? resolvedUsageEmail
      : undefined;
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    slashCommands: dedupedSlashCommands,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
        ...(usageEmail ? { usageEmail } : {}),
        capabilities: claudeAuthCapabilities({
          isApiKeyAuth,
          isLongLivedOAuthAuth,
          hasAccountUsage: accountUsage !== undefined,
        }),
      },
      ...(accountUsage ? { accountUsage } : {}),
      ...(upgradeMessage ? { message: upgradeMessage } : {}),
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in Threadlines settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

export { probeClaudeCapabilities };

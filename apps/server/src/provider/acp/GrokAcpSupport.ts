/**
 * GrokAcpSupport — the Grok Build (`grok agent stdio`) descriptor for the
 * generic ACP driver.
 *
 * What is Grok's own here:
 * - the launch: the runtime mode goes on the command line, where it beats a
 *   repo's committed config; Grok's self-update and shared leader process
 *   stay off; inherited xAI API keys are dropped unless the instance bills
 *   by key, because a key in the environment silently bills per token;
 * - the status probe: one `initialize` reads the version, the model catalog
 *   and the sign-in, with no session (a session starts the user's MCP
 *   servers and leaves a session folder behind);
 * - xAI's extensions (questions, plan approval, background shells and
 *   subagents, the turns Grok starts itself), mapped in `GrokAcpExtension.ts`.
 *
 * @module provider/acp/GrokAcpSupport
 */
import {
  GrokSettings,
  ProviderDriverKind,
  type ServerProviderAccountUsage,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";

import { expandHomePath } from "../../pathExpansion.ts";
import { grokContinuationKey } from "../grok/GrokAccountFolder.ts";
import {
  detectGrokBinary,
  GROK_INSTALL,
  grokMaintenance,
  resolveGrokBinary,
} from "../grok/GrokBinary.ts";
import { makeProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import type {
  AcpLaunch,
  AcpModelOptionMapping,
  AcpProviderDescriptor,
  AcpProviderProbeOutcome,
} from "./AcpProviderDescriptor.ts";
import { GENERIC_ACP_MODEL_OPTION_MAPPING } from "./AcpProviderModels.ts";
import { makeAcpProviderRuntime } from "./AcpProviderRuntime.ts";
import type { AcpSpawnInput } from "./AcpSessionRuntime.ts";
import {
  emptyGrokBackgroundWork,
  GROK_MCP_ELICIT_REPLY,
  GROK_PLAN_CAPTURED_REPLY,
  GROK_SESSION_NOTIFICATION_METHODS,
  GrokAskUserQuestionRequest,
  grokAgentTurnPromptId,
  grokAskUserQuestionReply,
  grokBackgroundChange,
  GrokExitPlanModeRequest,
  grokForkedSessionId,
  grokOwnPromptOutcome,
  grokPlanMarkdown,
  GrokPromptComplete,
  grokPromptId,
  grokPromptPosition,
  GrokQueueChanged,
  grokRewound,
  GrokSessionNotification,
  grokTurnEndFromUpdate,
  grokUserInputQuestions,
  xaiMethods,
} from "./GrokAcpExtension.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

export const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

export const GROK_PRESENTATION = {
  displayName: "Grok",
  planUpgradeUrl: "https://grok.com/dashboard/billing",
  showInteractionModeToggle: true,
  // `grok agent` asks, runs its own classifier (auto), or always approves;
  // it has no auto-accept-edits.
  supportedRuntimeModes: ["approval-required", "auto", "full-access"],
} as const;

/** xAI's attribution tag for OAuth sign-ins started from Threadlines. */
const GROK_OAUTH_REFERRER = "threadlines";
/** How long the status probe's `initialize` may take (Grok scans its home on start). */
const GROK_PROBE_TIMEOUT = Duration.seconds(20);

/** Variables whose key bills per token, dropped unless the instance bills by key. */
const GROK_API_KEY_VARIABLES = ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"] as const;
/**
 * Variables that point Grok at another account's credentials: they win over
 * `GROK_HOME`, so an account folder must not inherit them.
 */
const GROK_ACCOUNT_OVERRIDE_VARIABLES = ["GROK_AUTH_PATH", "GROK_AUTH"] as const;

/**
 * The whole environment of a Grok process for an instance. Starts from the
 * server's plus the instance's variables (`environment`), then:
 * - its own folder when the instance has one (`GROK_HOME`, and nothing that
 *   would point back at the terminal's credentials);
 * - an API key only when the instance bills by key; otherwise inherited keys
 *   are removed and key sign-in is turned off;
 * - Grok's background updater off, so the binary never changes under a session;
 * - folder trust off: opening a project in Threadlines trusts it, as it does
 *   for Claude and Codex (Grok would otherwise ignore the repo's AGENTS.md,
 *   MCP servers and hooks for a GUI it can't ask).
 */
export function grokProcessEnvironment(
  settings: Pick<GrokSettings, "accountFolder" | "authMethod">,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...environment };
  const accountFolder = settings.accountFolder.trim();
  if (accountFolder) {
    env.GROK_HOME = expandHomePath(accountFolder);
    for (const name of GROK_ACCOUNT_OVERRIDE_VARIABLES) delete env[name];
  }
  if (settings.authMethod !== "api-key") {
    for (const name of GROK_API_KEY_VARIABLES) delete env[name];
    env.GROK_DISABLE_API_KEY_AUTH = "1";
  }
  env.GROK_DISABLE_AUTOUPDATER = "1";
  env.GROK_OAUTH2_REFERRER = GROK_OAUTH_REFERRER;
  env.GROK_FOLDER_TRUST = "0";
  return env;
}

/**
 * The command line for a launch. Top-level flags go before `agent` and agent
 * flags after it; the other order is a usage error. `--no-leader` keeps the
 * session out of a shared leader process a user's config can turn on.
 */
export function grokSpawnArgs(launch?: AcpLaunch): ReadonlyArray<string> {
  const top = ["--no-auto-update"];
  switch (launch?.runtimeMode) {
    case undefined:
      return [...top, "agent", "--no-leader", "stdio"];
    case "full-access":
      return [...top, "agent", "--no-leader", "--always-approve", "stdio"];
    case "auto":
      return [...top, "--permission-mode", "auto", "agent", "--no-leader", "stdio"];
    default:
      return [...top, "--permission-mode", "default", "agent", "--no-leader", "stdio"];
  }
}

export function buildGrokSpawnInput(
  settings: Pick<GrokSettings, "binaryPath" | "accountFolder" | "authMethod">,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  launch?: AcpLaunch,
): AcpSpawnInput {
  const env = grokProcessEnvironment(settings, environment);
  return {
    command: resolveGrokBinary(settings.binaryPath, env),
    args: [...grokSpawnArgs(launch)],
    cwd,
    env,
    inheritEnv: false,
  };
}

// ── Models ────────────────────────────────────────────────────────────

/** Grok's effort option; the picker knows reasoning by the shared id. */
const GROK_EFFORT_CONFIG_ID = "reasoning_effort";
const REASONING_OPTION_ID = "reasoningEffort";

/**
 * The generic mapping, with Grok's `reasoning_effort` shown as the
 * reasoning control (and sent back under Grok's id).
 */
export const GROK_MODEL_OPTION_MAPPING: AcpModelOptionMapping = {
  capabilitiesFromConfigOptions: (configOptions) => {
    const capabilities =
      GENERIC_ACP_MODEL_OPTION_MAPPING.capabilitiesFromConfigOptions(configOptions);
    return {
      ...capabilities,
      optionDescriptors: (capabilities.optionDescriptors ?? []).map((descriptor) =>
        descriptor.id === GROK_EFFORT_CONFIG_ID
          ? { ...descriptor, id: REASONING_OPTION_ID, label: "Reasoning" }
          : descriptor,
      ),
    };
  },
  configUpdatesFromSelections: (configOptions, selections) =>
    GENERIC_ACP_MODEL_OPTION_MAPPING.configUpdatesFromSelections(
      configOptions,
      selections?.map((selection) =>
        selection.id === REASONING_OPTION_ID
          ? { ...selection, id: GROK_EFFORT_CONFIG_ID }
          : selection,
      ),
    ),
};

const GrokReasoningEffort = Schema.Struct({
  value: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  default: Schema.optional(Schema.Boolean),
});

const GrokModel = Schema.Struct({
  modelId: Schema.String,
  name: Schema.optional(Schema.String),
  _meta: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        reasoningEfforts: Schema.optional(Schema.Array(GrokReasoningEffort)),
      }),
    ),
  ),
});

const GrokInitializeMeta = Schema.Struct({
  agentVersion: Schema.optional(Schema.String),
  defaultAuthMethodId: Schema.optional(Schema.NullOr(Schema.String)),
  modelState: Schema.optional(
    Schema.Struct({
      currentModelId: Schema.optional(Schema.String),
      availableModels: Schema.Array(GrokModel),
    }),
  ),
});

const GrokInitializeResult = Schema.Struct({
  _meta: Schema.optional(Schema.NullOr(GrokInitializeMeta)),
});
const decodeGrokInitializeResult = Schema.decodeUnknownOption(GrokInitializeResult);

const GrokAuthInfo = Schema.Struct({
  methodId: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
  userBlockedReason: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeGrokAuthInfo = Schema.decodeUnknownOption(GrokAuthInfo);

/**
 * The catalog Grok lists at `initialize`, each model with its own reasoning
 * levels, in the shape a session's options give (`GROK_MODEL_OPTION_MAPPING`).
 */
export function grokModelsFromModelState(
  modelState: (typeof GrokInitializeMeta.Type)["modelState"],
): ReadonlyArray<ServerProviderModel> {
  if (!modelState) return [];
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model) => {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    const efforts = (model._meta?.reasoningEfforts ?? []).flatMap((effort) => {
      const value = (effort.value ?? effort.id)?.trim();
      return value
        ? [
            {
              value,
              // `initialize` says "High Effort" where a session's options say "High".
              label: effort.label?.trim().replace(/\s+effort$/iu, "") || value,
              ...(effort.default === true ? { isDefault: true } : {}),
            },
          ]
        : [];
    });
    return [
      {
        slug,
        name: model.name?.trim() || slug,
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors:
            efforts.length > 0
              ? [
                  buildSelectOptionDescriptor({
                    id: REASONING_OPTION_ID,
                    label: "Reasoning",
                    options: efforts,
                  }),
                ]
              : [],
        }),
      } satisfies ServerProviderModel,
    ];
  });
}

// ── Usage ─────────────────────────────────────────────────────────────

const GrokBilling = Schema.Struct({
  config: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        creditUsagePercent: Schema.optional(Schema.NullOr(Schema.Number)),
        currentPeriod: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              type: Schema.optional(Schema.NullOr(Schema.String)),
              end: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
  subscription_tier: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeGrokBilling = Schema.decodeUnknownOption(GrokBilling);

const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

/**
 * The plan's usage from `_x.ai/billing`: one window, weekly or monthly, as a
 * percent of the plan's credits. No percent yet means nothing metered so far
 * (a new period), which reads as 0% rather than as unknown.
 */
export function grokAccountUsage(
  billing: unknown,
  checkedAt: string,
): ServerProviderAccountUsage | undefined {
  const decoded = decodeGrokBilling(billing);
  if (decoded._tag === "None") return undefined;
  const config = decoded.value.config;
  const period = config?.currentPeriod;
  if (!config || !period) return undefined;
  const usedPercent = Math.min(100, Math.max(0, Math.round(config.creditUsagePercent ?? 0)));
  const resetsAt = period.end ? Date.parse(period.end) : Number.NaN;
  const monthly = period.type?.toUpperCase().includes("MONTH") === true;
  const tier = decoded.value.subscription_tier?.trim();
  return {
    source: "grok-billing",
    checkedAt,
    primaryLimitId: "grok",
    limits: [
      {
        limitId: "grok",
        ...(tier ? { planType: tier } : {}),
        primary: {
          usedPercent,
          remainingPercent: 100 - usedPercent,
          ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
          windowDurationMins: monthly ? MONTH_MINS : WEEK_MINS,
          checkedAt,
        },
      },
    ],
  };
}

// ── Status probe ──────────────────────────────────────────────────────

const GROK_INITIALIZE_META = { clientType: "extension" } as const;

export const GROK_NOT_INSTALLED_MESSAGE = "Grok Build (`grok`) is not installed or not on PATH.";
export const GROK_SIGNED_OUT_MESSAGE = "Grok isn't signed in. Use Sign in.";

/**
 * One short Grok process in an empty folder: `initialize` for the version,
 * catalog and sign-in, then `_x.ai/auth/info` for the account. Never
 * `authenticate` (signed out, it opens a browser) or `session/new`.
 */
export const probeGrok = Effect.fn("probeGrok")(function* (
  settings: GrokSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  AcpProviderProbeOutcome,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = grokProcessEnvironment(settings, environment);
  if (detectGrokBinary(settings.binaryPath, env).status !== "found") {
    return {
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: GROK_NOT_INSTALLED_MESSAGE,
    };
  }
  const outcome = yield* Effect.gen(function* () {
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "threadlines-grok-probe-" });
    const acp = yield* makeAcpProviderRuntime(GROK_ACP_DESCRIPTOR, {
      settings,
      environment,
      childProcessSpawner: spawner,
      cwd,
      clientInfo: { name: "threadlines", version: "0.0.0" },
    });
    const initialize = yield* acp.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "threadlines", version: "0.0.0" },
      _meta: GROK_INITIALIZE_META,
    });
    const info = yield* acp.request("_x.ai/auth/info", {}).pipe(Effect.option);
    // The plan's meter, read through Grok so it sends its own headers and
    // renews the token. A key bills per token: there is no plan to meter.
    const billing =
      settings.authMethod === "api-key"
        ? undefined
        : yield* acp.request("_x.ai/billing", {}).pipe(Effect.option);
    return { initialize, info, billing };
  }).pipe(Effect.scoped, Effect.timeoutOption(GROK_PROBE_TIMEOUT), Effect.result);

  if (outcome._tag === "Failure") {
    return {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `Grok did not start: ${outcome.failure.message}`,
    };
  }
  if (outcome.success._tag === "None") {
    return {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Grok took too long to start. It will be checked again.",
    };
  }
  const { initialize, info, billing } = outcome.success.value;
  const meta = decodeGrokInitializeResult(initialize).pipe((decoded) =>
    decoded._tag === "Some" ? (decoded.value._meta ?? undefined) : undefined,
  );
  const account =
    info._tag === "Some"
      ? decodeGrokAuthInfo(info.value).pipe((decoded) =>
          decoded._tag === "Some" ? decoded.value : undefined,
        )
      : undefined;
  const methodId = account?.methodId ?? meta?.defaultAuthMethodId ?? undefined;
  const signedIn = methodId !== undefined && methodId !== null;
  const email = account?.email?.trim() || undefined;
  const auth: ServerProviderAuth = signedIn
    ? {
        status: "authenticated",
        ...(methodId === "xai.api_key"
          ? { type: "api_key", label: "xAI API key" }
          : { type: "subscription", label: "Grok subscription" }),
        ...(email ? { email } : {}),
      }
    : { status: "unauthenticated" };
  const blocked = account?.userBlockedReason?.trim();
  const accountUsage =
    signedIn && billing?._tag === "Some"
      ? grokAccountUsage(billing.value, DateTime.formatIso(yield* DateTime.now))
      : undefined;
  return {
    installed: true,
    version: meta?.agentVersion?.trim() || null,
    status: !signedIn || blocked ? "error" : "ready",
    auth,
    ...(blocked
      ? { message: `xAI has paused this account: ${blocked}` }
      : !signedIn
        ? { message: GROK_SIGNED_OUT_MESSAGE }
        : {}),
    models: grokModelsFromModelState(meta?.modelState),
    ...(accountUsage ? { accountUsage } : {}),
  };
});

// ── Descriptor ────────────────────────────────────────────────────────

export const GROK_ACP_DESCRIPTOR: AcpProviderDescriptor<GrokSettings> = {
  driverKind: GROK_DRIVER_KIND,
  presentation: GROK_PRESENTATION,
  settingsSchema: GrokSettings,
  defaultSettings: () => decodeGrokSettings({}),
  // Replaced on every status check by `resolveMaintenance`.
  maintenance: makeProviderMaintenanceCapabilities({
    provider: GROK_DRIVER_KIND,
    packageName: null,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: null,
  }),
  install: GROK_INSTALL,
  resolveMaintenance: (settings) =>
    Effect.sync(() =>
      grokMaintenance(settings.binaryPath, grokProcessEnvironment(settings, process.env)),
    ),
  // Looked up at each launch (PATH, then `~/.grok/bin`), so a one-click
  // install works without a restart.
  resolveBinaryOnHost: () => false,
  detect: ({ settings, environment }) =>
    Effect.sync(() =>
      detectGrokBinary(settings.binaryPath, grokProcessEnvironment(settings, environment)),
    ),
  spawn: buildGrokSpawnInput,
  initializeMeta: GROK_INITIALIZE_META,
  // A user's Ctrl+C: Grok then also stops waking for background work the
  // cancelled turn left behind, until the next real message.
  cancelMeta: { cancelTrigger: "ctrl_c" },
  promptMeta: (turnId) => {
    const promptId = grokPromptId(turnId);
    return { promptId, requestId: promptId };
  },
  agentTurns: true,
  continuationKey: (settings, environment) =>
    grokContinuationKey(settings.accountFolder, environment),
  sessionModeForTurn: (interactionMode) => (interactionMode === "plan" ? "plan" : "default"),
  // Grok's own rewind (`/rewind`) by its prompt numbering, the conversation
  // only: Threadlines restores the files. Without `force` Grok declines
  // (`success: false`, no error) where its picker would ask to confirm. A
  // fork copies the session up to a prompt, inclusive (Grok 1.0.52).
  conversationHistory: {
    promptPosition: ({ acp, sessionId, promptText, after }) =>
      acp
        .request("_x.ai/rewind/points", { sessionId })
        .pipe(Effect.map((points) => grokPromptPosition(points, promptText, after))),
    rewind: ({ acp, sessionId, position }) =>
      acp
        .request("_x.ai/rewind/execute", {
          sessionId,
          targetPromptIndex: position,
          mode: "conversation_only",
          force: true,
        })
        .pipe(
          Effect.flatMap((result) =>
            grokRewound(result)
              ? Effect.void
              : Effect.fail(
                  EffectAcpErrors.AcpRequestError.internalError(
                    "Grok didn't rewind the conversation.",
                  ),
                ),
          ),
        ),
    fork: ({ request, sessionId, sourceCwd, cwd, throughPosition }) =>
      request("_x.ai/session/fork", {
        sourceSessionId: sessionId,
        sourceCwd,
        newCwd: cwd,
        ...(throughPosition !== undefined ? { targetPromptIndex: throughPosition } : {}),
      }).pipe(
        Effect.flatMap((result) => {
          const forked = grokForkedSessionId(result);
          return forked
            ? Effect.succeed(forked)
            : Effect.fail(
                EffectAcpErrors.AcpRequestError.internalError("Grok didn't fork the conversation."),
              );
        }),
      ),
  },
  // Grok queues a mid-turn message into the running turn (`interject`, 1.0.14+).
  steer: ({ acp, sessionId, text, content }) =>
    acp
      .request("_x.ai/interject", {
        sessionId,
        text,
        ...(content.some((block) => block.type !== "text") ? { content } : {}),
      })
      .pipe(Effect.asVoid),
  // Every update carries the context fill so far; the window is the model's.
  contextUsage: {
    usedTokens: (notification) => {
      const total = notification._meta?.totalTokens;
      return typeof total === "number" && Number.isFinite(total) && total >= 0
        ? Math.round(total)
        : undefined;
    },
    windowTokens: (setup) => {
      const models = setup.models;
      const current = models?.availableModels.find(
        (model) => model.modelId === models.currentModelId,
      );
      const window = current?._meta?.totalContextTokens;
      return typeof window === "number" && window > 0 ? window : undefined;
    },
  },
  // Grok's only session-scoped "always" is the edit prompt's; its shell, monitor
  // and MCP `always-allow` save a grant for the whole project.
  isLastingPermissionOption: (option) =>
    option.kind === "allow_always" && option.optionId.trim() !== "allow-edits-session",
  // Edits carry ACP `diff` content with the full old and new text.
  diffEvidence: true,
  isolateTextGeneration: true,
  notInstalledMessage: GROK_NOT_INSTALLED_MESSAGE,
  probe: probeGrok,
  modelOptions: GROK_MODEL_OPTION_MAPPING,
  extensions: {
    source: "acp.grok.extension",
    register: (context) =>
      Effect.gen(function* () {
        let work = emptyGrokBackgroundWork();
        // Updates name their session; a subagent's own turns and tasks are its business.
        const isOwnSession = (sessionId: string) => {
          const own = context.sessionId();
          return own === undefined || own === sessionId;
        };
        const applyBackground = (
          method: string,
          payload: unknown,
          update: Readonly<Record<string, unknown>>,
        ) =>
          Effect.gen(function* () {
            const change = grokBackgroundChange(work, update);
            if (!change) return;
            work = change.work;
            for (const event of change.events) {
              yield* context.emitRuntimeEvent({ method, payload, event });
            }
          });

        for (const method of xaiMethods("ask_user_question")) {
          yield* context.acp.handleExtRequest(method, GrokAskUserQuestionRequest, (request) =>
            Effect.gen(function* () {
              yield* context.logNative(method, request);
              const answers = yield* context.requestUserInput({
                method,
                payload: request,
                questions: grokUserInputQuestions(request),
              });
              return grokAskUserQuestionReply(request, answers);
            }),
          );
        }
        for (const method of xaiMethods("exit_plan_mode")) {
          yield* context.acp.handleExtRequest(method, GrokExitPlanModeRequest, (request) =>
            Effect.gen(function* () {
              yield* context.logNative(method, request);
              yield* context.emitProposedPlan({
                method,
                payload: request,
                planMarkdown: grokPlanMarkdown(request),
              });
              return GROK_PLAN_CAPTURED_REPLY;
            }),
          );
        }
        for (const method of xaiMethods("mcp/elicit")) {
          yield* context.acp.handleExtRequest(method, Schema.Unknown, (request) =>
            context.logNative(method, request).pipe(Effect.as(GROK_MCP_ELICIT_REPLY)),
          );
        }
        for (const method of GROK_SESSION_NOTIFICATION_METHODS) {
          yield* context.acp.handleExtNotification(
            method,
            GrokSessionNotification,
            (notification) =>
              Effect.gen(function* () {
                if (!isOwnSession(notification.sessionId)) return;
                const end = grokTurnEndFromUpdate(notification);
                if (end?._tag === "OwnPrompt") {
                  yield* context.reportPromptOutcome(end.outcome);
                  return;
                }
                if (end?._tag === "AgentTurn") {
                  yield* context.endAgentTurn({
                    method,
                    payload: notification,
                    outcome: end.outcome,
                  });
                  return;
                }
                yield* applyBackground(method, notification, notification.update);
              }),
          );
        }
        for (const method of [
          ...xaiMethods("task_backgrounded"),
          ...xaiMethods("task_completed"),
        ]) {
          yield* context.acp.handleExtNotification(
            method,
            GrokSessionNotification,
            (notification) =>
              isOwnSession(notification.sessionId)
                ? applyBackground(method, notification, notification.update)
                : Effect.void,
          );
        }
        // `queue/changed` repeats whenever Grok's queue moves, naming the same
        // running prompt; each of its own turns begins once.
        let begunAgentPromptId: string | undefined;
        for (const method of xaiMethods("queue/changed")) {
          yield* context.acp.handleExtNotification(method, GrokQueueChanged, (notification) => {
            const running = isOwnSession(notification.sessionId)
              ? grokAgentTurnPromptId(notification)
              : undefined;
            if (running === undefined || running === begunAgentPromptId) return Effect.void;
            begunAgentPromptId = running;
            return context.beginAgentTurn({ method, payload: notification });
          });
        }
        for (const method of xaiMethods("session/prompt_complete")) {
          yield* context.acp.handleExtNotification(method, GrokPromptComplete, (notification) => {
            if (!isOwnSession(notification.sessionId)) return Effect.void;
            const outcome = grokOwnPromptOutcome(notification);
            return outcome ? context.reportPromptOutcome(outcome) : Effect.void;
          });
        }
      }),
  },
};

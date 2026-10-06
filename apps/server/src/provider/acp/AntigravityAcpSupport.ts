/**
 * AntigravityAcpSupport — the Google Antigravity descriptor for the generic
 * ACP driver, built per provider instance (each instance has its own
 * profile and shares the managed runtime).
 *
 * Antigravity runs as Google's own ACP server (`agy_acp_server`), which
 * Threadlines downloads and verifies itself (`antigravity/AntigravityRuntime`).
 * What differs from other ACP agents, from a recorded 1.3.0 session:
 *
 * - Sign-in prints a Google URL on stderr and listens on a 127.0.0.1 port
 *   for the redirect; outside a sign-in flow that line means "sign in again".
 * - Modes `default` / `auto_edit` / `yolo` map onto the runtime modes.
 * - Questions arrive as permission requests (`interaction_*` ids).
 * - Model names carry the effort ("Gemini 3.8 Flash (High)"); Threadlines
 *   lists each family once with a Reasoning option.
 * - `/plan <task>` writes a plan file into the profile and stops for review:
 *   that is plan mode.
 * - Edits carry exact ACP `diff` content, and the agent writes the files
 *   itself, so no client file system is offered.
 *
 * @module provider/acp/AntigravityAcpSupport
 */
import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { createInterface } from "node:readline";

import {
  AntigravitySettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@threadlines/contracts";
import {
  createModelCapabilities,
  getProviderOptionSelectionValue,
} from "@threadlines/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ANTIGRAVITY_RELEASE,
  antigravityLaunchArgs,
  type AntigravityPlatformRelease,
} from "../antigravity/AntigravityRelease.ts";
import {
  acquireAntigravityTempDir,
  recordAntigravityAgent,
  antigravityEnvironment,
  type AntigravityInstancePaths,
  type AntigravityModelChoice,
  prepareAntigravityProfile,
  readAntigravityCatalog,
  writeAntigravityCatalog,
} from "../antigravity/AntigravityProfile.ts";
import { holdLaunchGate, type LaunchGate } from "../managedRuntime/LaunchGate.ts";
import {
  antigravityCredentialEnvironment,
  antigravityCredentialFingerprint,
  antigravitySignInStatus,
  type AntigravitySignInConfig,
  readAntigravityGoogleSignIn,
  readAntigravitySignInCheck,
  resolveAntigravityAdc,
} from "../antigravity/AntigravitySignInMethod.ts";
import type { AntigravityRuntime } from "../antigravity/AntigravityRuntime.ts";
import { detectionAt } from "../providerDetection.ts";
import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandAction,
} from "../providerMaintenance.ts";
import type { AcpProviderDescriptor, AcpProviderProbeOutcome } from "./AcpProviderDescriptor.ts";
import {
  flattenSessionConfigSelectOptions,
  selectConfigOptionCurrentValue,
} from "./AcpProviderModels.ts";
import { findModelConfigOption } from "./AcpRuntimeModel.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

export const ANTIGRAVITY_DRIVER_KIND = ProviderDriverKind.make("antigravity");
const DISPLAY_NAME = "Antigravity";
/** Windows cold starts unpack the whole runtime first. */
const ANTIGRAVITY_DISCOVERY_TIMEOUT_MS = 90_000;
const VALIDATE_TIMEOUT_MS = 90_000;

export const ANTIGRAVITY_PRESENTATION = {
  displayName: DISPLAY_NAME,
  showInteractionModeToggle: true,
} as const;

// ── Sign-in URL ──────────────────────────────────────────────────────

const SIGN_IN_PREFIX = "Open the following link to authenticate the ACP server: ";

/**
 * The Google sign-in URL from an agent stderr line. Only Google's OAuth
 * endpoint with a loopback redirect counts, so a stray line cannot point a
 * client somewhere else.
 */
export function parseAntigravitySignInUrl(line: string): string | undefined {
  const start = line.indexOf(SIGN_IN_PREFIX);
  if (start === -1) return undefined;
  const raw = line.slice(start + SIGN_IN_PREFIX.length).trim();
  if (raw.length === 0 || raw.length > 16_384 || /\s/u.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth") {
      return undefined;
    }
    const redirect = url.searchParams.get("redirect_uri");
    if (!redirect || !/^http:\/\/127\.0\.0\.1:\d{4,5}\/$/u.test(redirect)) return undefined;
    if (!url.searchParams.get("state")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

// ── Models: one family per model, effort as an option ────────────────

const EFFORT_NAME = /^(.*\S)\s*\((High|Medium|Low|Minimal)\)$/iu;
const EFFORT_ORDER = ["high", "medium", "low", "minimal"];
export const ANTIGRAVITY_EFFORT_OPTION_ID = "effort";

export interface AntigravityModelFamily {
  readonly slug: string;
  readonly name: string;
  /** Agent model id per effort, in display order. */
  readonly variants: ReadonlyArray<{
    readonly effort: string;
    readonly label: string;
    readonly agentId: string;
  }>;
}

/**
 * Groups the agent's models by name: "Gemini 3.8 Flash (High)" and
 * "(Low)" become the family `gemini-3.8-flash`. Ids are not used to group:
 * "Gemini 3.1 Pro (High)" is `gemini-pro-agent`.
 */
export function foldAntigravityModels(
  choices: ReadonlyArray<AntigravityModelChoice>,
): ReadonlyArray<AntigravityModelFamily> {
  const families = new Map<
    string,
    { name: string; variants: AntigravityModelFamily["variants"][number][] }
  >();
  for (const choice of choices) {
    const match = EFFORT_NAME.exec(choice.name.trim());
    const familyName = match?.[1] ?? choice.name.trim();
    const effort = match?.[2]?.toLowerCase() ?? "";
    const slug = familyName.toLowerCase().replace(/\s+/gu, "-");
    const family = families.get(slug) ?? { name: familyName, variants: [] };
    if (!family.variants.some((variant) => variant.effort === effort)) {
      family.variants.push({ effort, label: match?.[2] ?? "", agentId: choice.value });
    }
    families.set(slug, family);
  }
  return Array.from(families, ([slug, family]) => ({
    slug,
    name: family.name,
    variants: [...family.variants].sort(
      (a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort),
    ),
  }));
}

function familyCapabilities(family: AntigravityModelFamily): ModelCapabilities {
  const efforts = family.variants.filter((variant) => variant.effort !== "");
  if (efforts.length < 2) return createModelCapabilities({ optionDescriptors: [] });
  const preferred = efforts[0]!.effort;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: ANTIGRAVITY_EFFORT_OPTION_ID,
        label: "Reasoning",
        type: "select",
        options: efforts.map((variant) =>
          variant.effort === preferred
            ? { id: variant.effort, label: variant.label, isDefault: true as const }
            : { id: variant.effort, label: variant.label },
        ),
        currentValue: preferred,
      },
    ],
  });
}

export function antigravityModelsFromChoices(
  choices: ReadonlyArray<AntigravityModelChoice>,
): ReadonlyArray<ServerProviderModel> {
  return foldAntigravityModels(choices).map((family) => ({
    slug: family.slug,
    name: family.name,
    isCustom: false,
    capabilities: familyCapabilities(family),
  }));
}

const modelChoices = (configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) =>
  flattenSessionConfigSelectOptions(findModelConfigOption(configOptions));

/**
 * The agent's model id for a family slug and the selected effort; agent ids
 * (custom models) pass through.
 */
export function resolveAntigravityModelId(
  model: string | null | undefined,
  context?: {
    readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
    readonly configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>;
  },
): string | undefined {
  const slug = model?.trim();
  if (!slug) return undefined;
  if (!context) return slug;
  const choices = modelChoices(context.configOptions);
  if (choices.some((choice) => choice.value === slug)) return slug;
  const family = foldAntigravityModels(choices).find((candidate) => candidate.slug === slug);
  if (!family || family.variants.length === 0) return slug;
  const requested = getProviderOptionSelectionValue(
    context.selections ?? [],
    ANTIGRAVITY_EFFORT_OPTION_ID,
  );
  const variant =
    family.variants.find((candidate) => candidate.effort === requested) ?? family.variants[0]!;
  return variant.agentId;
}

// ── Questions and approvals ──────────────────────────────────────────

/** `interaction_*` permission requests are questions: one option per answer. */
function antigravityQuestion(request: EffectAcpSchema.RequestPermissionRequest) {
  const toolCallId = request.toolCall.toolCallId;
  if (!toolCallId.startsWith("interaction_") || request.options.length === 0) return undefined;
  const question = request.toolCall.title?.trim() || "Antigravity has a question.";
  return {
    questions: [
      {
        id: toolCallId,
        header: DISPLAY_NAME,
        question,
        options: request.options.map((option) => ({
          label: option.name.trim() || option.optionId,
          description: option.name.trim() || option.optionId,
        })),
        multiSelect: false,
      },
    ],
    optionIdForAnswers: (answers: Readonly<Record<string, unknown>>) => {
      const raw = answers[toolCallId];
      const answer = (Array.isArray(raw) ? raw[0] : raw) as unknown;
      if (typeof answer !== "string") return undefined;
      const option =
        request.options.find((candidate) => candidate.optionId === answer) ??
        request.options.find(
          (candidate) => (candidate.name.trim() || candidate.optionId) === answer,
        );
      return option?.optionId;
    },
  };
}

function antigravityOptionWarning(option: EffectAcpSchema.PermissionOption): string | undefined {
  const meta = option._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const warning = (meta as Record<string, unknown>)["agy.security.warning"];
  if (typeof warning !== "object" || warning === null) return undefined;
  const { title, message } = warning as { title?: unknown; message?: unknown };
  const text = [title, message]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim().replace(/\.$/u, ""))
    .join(". ");
  return text.length > 0 ? `${text.slice(0, 500)}.` : undefined;
}

// ── Plan mode: `/plan` writes a plan file into the profile ───────────

function toolCallPaths(data: Record<string, unknown>): ReadonlyArray<string> {
  const paths: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim()) paths.push(value.trim());
  };
  if (Array.isArray(data.content)) {
    for (const entry of data.content) {
      if (typeof entry === "object" && entry !== null) push((entry as { path?: unknown }).path);
    }
  }
  if (Array.isArray(data.locations)) {
    for (const entry of data.locations) {
      if (typeof entry === "object" && entry !== null) push((entry as { path?: unknown }).path);
    }
  }
  const rawInput = data.rawInput;
  if (typeof rawInput === "object" && rawInput !== null) {
    push((rawInput as { file_path?: unknown }).file_path);
    push((rawInput as { TargetFile?: unknown }).TargetFile);
  }
  return paths;
}

const isInside = (path: string, dir: string) => {
  const target = resolvePath(path);
  const root = resolvePath(dir);
  return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
};

/** The agent's artifact store (plans, task lists): inside the profile, never the workspace. */
const brainDir = (profileDir: string) => join(profileDir, "antigravity-acp", "brain");

// ── Install check ────────────────────────────────────────────────────

/**
 * Proves an unpacked runtime is Google's Antigravity ACP server: one
 * `initialize` in a throwaway profile, then the process is stopped and
 * reaped before returning (Windows cannot move a dir with a running exe).
 */
export const validateAntigravityRuntime = (
  paths: { readonly executable: string; readonly harness: string },
  release: AntigravityPlatformRelease,
) =>
  Effect.tryPromise({
    try: async () => {
      const scratch = await fs.mkdtemp(join(tmpdir(), "agy-check-"));
      try {
        const env = antigravityEnvironment({
          base: process.env,
          profileDir: join(scratch, "profile"),
          tempDir: scratch,
          platform: process.platform,
        });
        const child = spawnChild(paths.executable, [...antigravityLaunchArgs(process.platform)], {
          cwd: scratch,
          env: { ...env, ANTIGRAVITY_HARNESS_PATH: paths.harness },
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        });
        // A process that never started (EACCES on a noexec mount) reports
        // `error` and no `exit`.
        const exited = new Promise<void>((done) => {
          child.once("exit", () => done());
          child.once("error", () => {
            if (child.pid === undefined) done();
          });
        });
        try {
          const response = await new Promise<EffectAcpSchema.InitializeResponse>((done, fail) => {
            const timer = setTimeout(
              () => fail(new Error("Antigravity did not answer in time.")),
              VALIDATE_TIMEOUT_MS,
            );
            child.once("error", (error) => {
              clearTimeout(timer);
              fail(error);
            });
            createInterface({ input: child.stdout }).on("line", (line) => {
              try {
                const message = JSON.parse(line) as { id?: unknown; result?: unknown };
                if (message.id === 1 && message.result) {
                  clearTimeout(timer);
                  done(message.result as EffectAcpSchema.InitializeResponse);
                }
              } catch {
                // Not a protocol line.
              }
            });
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                  protocolVersion: 1,
                  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                  clientInfo: { name: "threadlines", version: "0.0.0" },
                },
              })}\n`,
            );
          });
          const problems = [
            response.agentInfo?.name !== "antigravity-acp" &&
              "it is not the Antigravity ACP server",
            response.agentInfo?.version !== release.version &&
              `it reports version ${response.agentInfo?.version ?? "unknown"}, not ${release.version}`,
            !response.agentCapabilities?.sessionCapabilities?.resume && "it cannot resume sessions",
            !response.authMethods?.some((method) => method.id === "oauth-personal") &&
              "it offers no Google sign-in",
          ].filter((problem): problem is string => typeof problem === "string");
          if (problems.length > 0) {
            throw new Error(`The downloaded Antigravity failed its check: ${problems.join("; ")}.`);
          }
        } finally {
          child.stdin.end();
          const forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
          // Bounded even if SIGKILL is lost: an install must never hang here.
          let abandoned: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            exited,
            new Promise<void>((done) => {
              abandoned = setTimeout(done, 15_000);
            }),
          ]);
          clearTimeout(forced);
          clearTimeout(abandoned);
        }
      } finally {
        await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

// ── Descriptor ───────────────────────────────────────────────────────

const HARNESS_NAME = (platform: NodeJS.Platform) =>
  platform === "win32" ? "localharness_external.exe" : "localharness_external";

const MANUAL_ONLY: ProviderMaintenanceCapabilities = {
  provider: ANTIGRAVITY_DRIVER_KIND,
  packageName: null,
  update: null,
  install: null,
  manualUpdateCommand: null,
  advisoryMessage: null,
};

export interface AntigravityDescriptorInput {
  readonly paths: AntigravityInstancePaths;
  /** Undefined where Google publishes no runtime for this machine. */
  readonly runtime: AntigravityRuntime | undefined;
  readonly release: AntigravityPlatformRelease | undefined;
  /** While busy (signing in or out), no agent process starts; each one holds it while it runs. */
  readonly gate?: LaunchGate;
  /** The instance's sign-in method, project and key (fixed for an instance build). */
  readonly signIn: AntigravitySignInConfig;
}

export function makeAntigravityDescriptor(
  input: AntigravityDescriptorInput,
): AcpProviderDescriptor<AntigravitySettings> {
  const { paths, runtime, release, gate, signIn } = input;
  const platform = process.platform;
  const fingerprint = antigravityCredentialFingerprint(signIn);

  const runtimeAction = (verb: "Install" | "Update"): ProviderMaintenanceCommandAction | null =>
    runtime && release
      ? {
          command: `${verb} Antigravity ${release.version} (Threadlines downloads and checks it)`,
          executable: "threadlines",
          args: [],
          lockKey: "antigravity-runtime",
          run: runtime.install().pipe(
            Effect.as({ output: `Antigravity ${release.version} is installed.` }),
            Effect.mapError((error) => ({ message: error.message })),
          ),
        }
      : null;

  const spawnFailure = (cause: unknown) =>
    new EffectAcpErrors.AcpSpawnError({ command: "agy_acp_server", cause });

  return {
    driverKind: ANTIGRAVITY_DRIVER_KIND,
    presentation: ANTIGRAVITY_PRESENTATION,
    settingsSchema: AntigravitySettings,
    defaultSettings: () => decodeAntigravitySettings({}),
    maintenance: MANUAL_ONLY,
    resolveMaintenance: (settings) =>
      Effect.gen(function* () {
        if (settings.binaryPath.trim() || !runtime || !release) return MANUAL_ONLY;
        const installed = yield* runtime.installed;
        if (!installed) return { ...MANUAL_ONLY, install: runtimeAction("Install") };
        return installed.version === release.version
          ? MANUAL_ONLY
          : { ...MANUAL_ONLY, update: runtimeAction("Update") };
      }),
    spawn: (settings, cwd, environment) =>
      Effect.gen(function* () {
        // Checked and taken in one step, and held for the process's lifetime
        // (this runs in the runtime's scope), so a sign-in can wait it out.
        if (gate) {
          yield* holdLaunchGate(gate, () =>
            spawnFailure(
              new Error("Antigravity is signing in or out. Try again when that's done."),
            ),
          );
        }
        const custom = settings.binaryPath.trim();
        let executable: string;
        let harness: string;
        if (custom) {
          executable = custom;
          harness = join(dirname(custom), HARNESS_NAME(platform));
        } else {
          if (!runtime) {
            return yield* spawnFailure(
              new Error(`Google publishes no Antigravity for ${platform}.`),
            );
          }
          const leased = yield* runtime.acquire.pipe(Effect.mapError(spawnFailure));
          executable = leased.executable;
          harness = leased.harness;
        }
        yield* prepareAntigravityProfile(paths.profileDir);
        const tempDir = yield* acquireAntigravityTempDir(paths.tempRoot).pipe(
          Effect.mapError(spawnFailure),
        );
        return {
          command: executable,
          args: [...antigravityLaunchArgs(platform)],
          cwd,
          env: {
            ...antigravityEnvironment({
              base: environment ?? process.env,
              profileDir: paths.profileDir,
              tempDir,
              platform,
              credentials: antigravityCredentialEnvironment(signIn, environment ?? process.env),
            }),
            ANTIGRAVITY_HARNESS_PATH: harness,
          },
          inheritEnv: false,
          shell: false,
          onSpawned: (pid: number) => recordAntigravityAgent(tempDir, pid),
        };
      }),
    signInUrlFromStderr: parseAntigravitySignInUrl,
    // Key methods sign in from the environment with no browser; Google
    // accounts use the saved sign-in (a missing one prints a sign-in URL).
    ...(signIn.method === "gemini-api-key" || signIn.method === "agent-platform"
      ? { authMethodId: signIn.method }
      : {}),
    agentModeFor: ({ runtimeMode, interactionMode }) => {
      // `/plan` only writes a plan; nothing else should run unasked.
      if (interactionMode === "plan") return "default";
      switch (runtimeMode) {
        case "full-access":
          return "yolo";
        case "auto-accept-edits":
          return "auto_edit";
        default:
          return "default";
      }
    },
    classifyPermissionRequest: antigravityQuestion,
    permissionOptionWarning: antigravityOptionWarning,
    cancellationNotice: "The request was cancelled by the client.",
    planMode: {
      promptPrefix: "/plan ",
      isPlanFile: (toolCall) => {
        const filePaths = toolCallPaths(toolCall.data);
        return (
          filePaths.length > 0 &&
          filePaths.every((filePath) => isInside(filePath, brainDir(paths.profileDir)))
        );
      },
      planMarkdown: (toolCall) => {
        const content = toolCall.data.content;
        if (!Array.isArray(content)) return undefined;
        for (const entry of content) {
          if (typeof entry !== "object" || entry === null) continue;
          const { type, path, newText } = entry as {
            type?: unknown;
            path?: unknown;
            newText?: unknown;
          };
          if (
            type === "diff" &&
            typeof path === "string" &&
            path.endsWith("plan.md") &&
            typeof newText === "string"
          ) {
            return newText;
          }
        }
        return undefined;
      },
    },
    diffEvidence: true,
    isolateTextGeneration: true,
    onSessionConfigOptions: (_settings, configOptions) => {
      const choices = modelChoices(configOptions);
      if (choices.length === 0) return Effect.void;
      const currentValue = selectConfigOptionCurrentValue(findModelConfigOption(configOptions));
      return writeAntigravityCatalog(paths.profileDir, {
        choices,
        ...(currentValue ? { currentValue } : {}),
        fingerprint,
      });
    },
    notInstalledMessage: "Antigravity is not installed. Install it to use it in Threadlines.",
    // The same test the probe makes: a custom binary only has to exist; the
    // managed runtime is found when a complete copy is on disk. Both read the
    // filesystem only.
    detect: ({ settings }) =>
      Effect.gen(function* () {
        const custom = settings.binaryPath.trim();
        if (custom) return detectionAt(existsSync(custom) ? resolvePath(custom) : undefined);
        const installed = runtime ? yield* runtime.installed : undefined;
        return detectionAt(installed?.executable);
      }),
    probe: (settings, environment) =>
      Effect.gen(function* () {
        const custom = settings.binaryPath.trim();
        if (!custom && (!runtime || !release)) {
          return {
            installed: false,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: `Google does not publish Antigravity for this computer (${platform}, ${process.arch}).`,
          } satisfies AcpProviderProbeOutcome;
        }
        const installed = custom ? existsSync(custom) : (yield* runtime!.installed) !== undefined;
        const version = custom ? null : ((yield* runtime!.installed)?.version ?? null);
        if (!installed) {
          return {
            installed: false,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: custom
              ? `Antigravity was not found at ${custom}.`
              : "Antigravity is not installed. Install it to use it in Threadlines.",
          } satisfies AcpProviderProbeOutcome;
        }
        const latest = custom ? {} : { latestVersion: ANTIGRAVITY_RELEASE.version };
        const usesGoogleSignIn =
          signIn.method === "oauth-personal" || signIn.method === "oauth-business";
        const signInStatus = antigravitySignInStatus({
          config: signIn,
          signedIn: usesGoogleSignIn
            ? (yield* readAntigravityGoogleSignIn(paths.profileDir)) === signIn.method
            : false,
          check: yield* readAntigravitySignInCheck(paths.profileDir, fingerprint),
          adc:
            signIn.method === "agent-platform" && !signIn.key
              ? yield* resolveAntigravityAdc(environment, platform)
              : undefined,
        });
        if (signInStatus.auth.status !== "authenticated") {
          return {
            installed: true,
            version,
            ...signInStatus,
            skipModelDiscovery: true,
            ...latest,
          } satisfies AcpProviderProbeOutcome;
        }
        const catalog = yield* readAntigravityCatalog(paths.profileDir, {
          fingerprint,
          isGoogleAccount: signIn.method === "oauth-personal",
        });
        return {
          installed: true,
          version,
          ...signInStatus,
          ...latest,
          ...(catalog ? { models: antigravityModelsFromChoices(catalog.choices) } : {}),
        } satisfies AcpProviderProbeOutcome;
      }),
    modelDiscoveryTimeoutMs: ANTIGRAVITY_DISCOVERY_TIMEOUT_MS,
    enrichDiscoveredModels: (models) =>
      Effect.succeed(
        antigravityModelsFromChoices(
          models.map((model) => ({ value: model.slug, name: model.name })),
        ),
      ),
    modelCapabilitiesVaryByModel: false,
    resolveModelId: resolveAntigravityModelId,
  };
}

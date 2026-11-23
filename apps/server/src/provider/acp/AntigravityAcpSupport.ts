/**
 * AntigravityAcpSupport — the Google Antigravity descriptor for the generic
 * ACP driver, built per provider instance (each instance has its own
 * profile and shares the managed runtime).
 *
 * Antigravity runs as Google's Antigravity CLI in ACP mode (`agy acp`),
 * which Threadlines downloads and verifies itself
 * (`antigravity/AntigravityRuntime`), or a custom `agy` the user names.
 * Either must be at least `ANTIGRAVITY_MIN_VERSION`. What differs from other
 * ACP agents:
 *
 * - Sign-in happens outside ACP (`antigravity/AntigravityAuth`); a session
 *   without one is refused, and the status says so.
 * - Modes `default` / `accept-edits` / `auto` (where the session offers it)
 *   map onto the runtime modes; full access runs in `default` and
 *   Threadlines answers each request.
 * - Questions arrive as permission requests (`interaction_*` ids).
 * - The reasoning level is its own `thought_level` option, listed for the
 *   selected model only, so each model's levels are remembered as they are
 *   seen. Older agents folded it into the model name ("Gemini 3.8 Flash
 *   (High)"); that is still read as a fallback.
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
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
import { createInterface } from "node:readline";

import {
  AntigravitySettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProviderModel,
} from "@threadlines/contracts";
import {
  createModelCapabilities,
  getProviderOptionSelectionValue,
} from "@threadlines/shared/model";
import { compareSemverVersions } from "@threadlines/shared/semver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { withUsualCommandLookup } from "@threadlines/shared/windowsCommandLookup";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ANTIGRAVITY_MIN_VERSION,
  antigravityLaunchArgs,
  type AntigravityPlatformRelease,
} from "../antigravity/AntigravityRelease.ts";
import type { AntigravityReleaseSource } from "../antigravity/AntigravityReleaseSource.ts";
import { antigravityTurnBehavior } from "../antigravity/AntigravityTurns.ts";
import {
  acquireAntigravityTempDir,
  recordAntigravityAgent,
  antigravityEnvironment,
  type AntigravityCatalogCache,
  type AntigravityInstancePaths,
  type AntigravityModelChoice,
  type AntigravityThoughtLevels,
  prepareAntigravityProfile,
  readAntigravityAgentRefusal,
  readAntigravityCatalog,
  writeAntigravityAgentRefusal,
  writeAntigravityCatalog,
} from "../antigravity/AntigravityProfile.ts";
import { makeAntigravitySkillsLister } from "../antigravity/AntigravitySkills.ts";
import { antigravityUserHome } from "../antigravity/AntigravityUserConfig.ts";
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
import type {
  AntigravityInstalledRuntime,
  AntigravityRuntime,
} from "../antigravity/AntigravityRuntime.ts";
import {
  type AntigravityUsageReader,
  withAntigravityUsage,
} from "../antigravity/AntigravityUsage.ts";
import { detectionAt } from "../providerDetection.ts";
import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandAction,
} from "../providerMaintenance.ts";
import { THREADLINES_ACP_CLIENT_INFO } from "./acpClientInfo.ts";
import type { AcpProviderDescriptor, AcpProviderProbeOutcome } from "./AcpProviderDescriptor.ts";
import {
  flattenSessionConfigSelectOptions,
  selectConfigOptionCurrentValue,
} from "./AcpProviderModels.ts";
import { findModelConfigOption } from "./AcpRuntimeModel.ts";
import { ProviderSetupError } from "../Errors.ts";

const decodeAntigravitySettings = Schema.decodeSync(AntigravitySettings);

export const ANTIGRAVITY_DRIVER_KIND = ProviderDriverKind.make("antigravity");
const DISPLAY_NAME = "Antigravity";
/** Windows cold starts unpack the whole runtime first. */
const ANTIGRAVITY_DISCOVERY_TIMEOUT_MS = 90_000;
const VALIDATE_TIMEOUT_MS = 90_000;

export const ANTIGRAVITY_PRESENTATION = {
  displayName: DISPLAY_NAME,
  showInteractionModeToggle: true,
  // Auto runs the CLI's own `auto` where the session offers it, else
  // Auto-accept edits (`antigravityAgentMode`).
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
} as const;

/**
 * The agent's own mode for a thread's access level. Auto is the CLI's own
 * `auto` where the session offers it, else Auto-accept edits. Full access has
 * no CLI mode (the CLI refuses `yolo`): it runs in `default`, and Threadlines
 * answers each request itself, as the ACP core does for full access.
 */
export function antigravityAgentMode(
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode | undefined,
  availableModeIds: ReadonlyArray<string>,
): "default" | "accept-edits" | "auto" {
  // `/plan` only writes a plan; nothing else should run unasked.
  if (interactionMode === "plan") return "default";
  switch (runtimeMode) {
    case "full-access":
    case "approval-required":
      return "default";
    case "auto":
      return availableModeIds.includes("auto") ? "auto" : "accept-edits";
    case "auto-accept-edits":
      return "accept-edits";
  }
}

/**
 * Whether `version` is at least the minimum, by its numbers: `1.5.9+local`
 * is 1.5.9, and a prerelease of the minimum (`1.5.14-rc.1`) is below it.
 * Undefined when it isn't a version.
 */
export function meetsAntigravityMinimum(version: string): boolean | undefined {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/u.exec(
      value.trim(),
    );
    return match
      ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: !!match[4] }
      : undefined;
  };
  const got = parse(version);
  const floor = parse(ANTIGRAVITY_MIN_VERSION)!;
  if (!got) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const difference = got.core[index]! - floor.core[index]!;
    if (difference !== 0) return difference > 0;
  }
  return !got.prerelease;
}

/** Why an agent can't run sessions, by its `initialize` answer; undefined when it can. */
export function antigravityAgentProblem(
  response: Pick<EffectAcpSchema.InitializeResponse, "agentInfo">,
): string | undefined {
  const version = response.agentInfo?.version?.trim() ?? "";
  const meets = meetsAntigravityMinimum(version);
  if (meets === undefined) {
    return `This Antigravity doesn't say its version. Threadlines needs Google's Antigravity CLI ${ANTIGRAVITY_MIN_VERSION} or newer.`;
  }
  return meets
    ? undefined
    : `This Antigravity is ${version}. Threadlines needs ${ANTIGRAVITY_MIN_VERSION} or newer: update Google's Antigravity CLI (\`agy update\`), or clear the custom path to use the copy Threadlines installs.`;
}

/** A path to Google's old ACP server, which the CLI replaced. */
export const isLegacyAntigravityServerPath = (path: string) =>
  /^(agy_acp_server|localharness_external)(\.(par|exe))?$/iu.test(
    path.trim().split(/[\\/]/u).at(-1) ?? "",
  );

const LEGACY_PATH_MESSAGE =
  "This path is Google's old Antigravity server, which no longer works. Point it at Google's Antigravity CLI (`agy`), or clear it to use the copy Threadlines installs.";

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

/** The session's `thought_level` option: the selected model's reasoning levels. */
export function antigravityThoughtLevels(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): AntigravityThoughtLevels | undefined {
  const option = configOptions.find(
    (candidate) => candidate.category === "thought_level" && candidate.type === "select",
  );
  const options = flattenSessionConfigSelectOptions(option);
  if (!option || options.length === 0) return undefined;
  const currentValue = selectConfigOptionCurrentValue(option);
  return {
    configId: option.id,
    name: option.name.trim() || "Reasoning",
    options,
    ...(currentValue ? { currentValue } : {}),
  };
}

function thoughtLevelCapabilities(levels: AntigravityThoughtLevels | null): ModelCapabilities {
  if (!levels || levels.options.length < 2)
    return createModelCapabilities({ optionDescriptors: [] });
  const preferred = levels.currentValue ?? levels.options[0]!.value;
  return createModelCapabilities({
    optionDescriptors: [
      {
        // The session option's own id: the generic mapping sends a selection back to it.
        id: levels.configId,
        label: levels.name,
        type: "select",
        options: levels.options.map((option) =>
          option.value === preferred
            ? { id: option.value, label: option.name || option.value, isDefault: true as const }
            : { id: option.value, label: option.name || option.value },
        ),
        currentValue: preferred,
      },
    ],
  });
}

/**
 * The picker's models from a saved list. With reasoning levels as their own
 * option, each model shows the levels seen for it, or the current model's
 * until it has been seen; without them (older agents), models fold by name.
 */
export function antigravityModelsFromCatalog(
  catalog: Pick<AntigravityCatalogCache, "choices" | "currentValue" | "thoughtLevels">,
): ReadonlyArray<ServerProviderModel> {
  const levels = catalog.thoughtLevels ?? {};
  if (Object.keys(levels).length === 0) return antigravityModelsFromChoices(catalog.choices);
  const shared = (catalog.currentValue ? levels[catalog.currentValue] : undefined) ?? null;
  return catalog.choices.map((choice) => ({
    slug: choice.value,
    name: choice.name || choice.value,
    isCustom: false,
    capabilities: thoughtLevelCapabilities(
      choice.value in levels ? (levels[choice.value] ?? null) : shared,
    ),
  }));
}

/**
 * The saved list after a session reported `configOptions`: its models, and
 * the reasoning levels of the one selected, kept with what earlier sessions
 * saw of the others.
 */
export function nextAntigravityCatalog(
  previous: AntigravityCatalogCache | undefined,
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): Pick<AntigravityCatalogCache, "choices" | "currentValue" | "thoughtLevels"> | undefined {
  const choices: ReadonlyArray<AntigravityModelChoice> = modelChoices(configOptions);
  if (choices.length === 0) return undefined;
  const currentValue = selectConfigOptionCurrentValue(findModelConfigOption(configOptions));
  const listed = new Set(choices.map((choice) => choice.value));
  const thoughtLevels: Record<string, AntigravityThoughtLevels | null> = {};
  for (const [model, levels] of Object.entries(previous?.thoughtLevels ?? {})) {
    if (listed.has(model)) thoughtLevels[model] = levels;
  }
  const current = antigravityThoughtLevels(configOptions);
  // A model whose levels aren't an option of their own (older agents) records nothing.
  if (currentValue && (current || Object.keys(thoughtLevels).length > 0)) {
    thoughtLevels[currentValue] = current ?? null;
  }
  return {
    choices,
    ...(currentValue ? { currentValue } : {}),
    ...(Object.keys(thoughtLevels).length > 0 ? { thoughtLevels } : {}),
  };
}

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
 * Proves an unpacked executable is Google's Antigravity CLI at the release's
 * version: one `agy acp` `initialize` in a throwaway profile, then the
 * process is stopped and reaped before returning (Windows cannot move a dir
 * with a running exe).
 */
export const validateAntigravityRuntime = (
  paths: { readonly executable: string },
  release: AntigravityPlatformRelease,
) =>
  Effect.tryPromise({
    try: async () => {
      const scratch = await fs.mkdtemp(join(tmpdir(), "agy-check-"));
      try {
        const profileDir = join(scratch, "profile");
        await fs.mkdir(profileDir, { mode: 0o700 });
        const env = antigravityEnvironment({
          base: process.env,
          profileDir,
          tempDir: scratch,
          platform: process.platform,
        });
        const child = spawnChild(paths.executable, [...antigravityLaunchArgs(profileDir)], {
          cwd: scratch,
          env: withUsualCommandLookup(env),
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
                  clientInfo: THREADLINES_ACP_CLIENT_INFO,
                },
              })}\n`,
            );
          });
          const problems = [
            !/antigravity/iu.test(response.agentInfo?.name ?? "") &&
              "it is not Google's Antigravity",
            response.agentInfo?.version !== release.version &&
              `it reports version ${response.agentInfo?.version ?? "unknown"}, not ${release.version}`,
            !response.agentCapabilities?.sessionCapabilities?.resume && "it cannot resume sessions",
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
    catch: (cause) =>
      new ProviderSetupError({
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

// ── Descriptor ───────────────────────────────────────────────────────

const MANUAL_ONLY: ProviderMaintenanceCapabilities = {
  provider: ANTIGRAVITY_DRIVER_KIND,
  packageName: null,
  update: null,
  install: null,
  manualUpdateCommand: null,
  advisoryMessage: null,
};

const NOT_INSTALLED_MESSAGE = "Antigravity is not installed. Install it to use it in Threadlines.";
const UPDATE_NEEDED_MESSAGE =
  "Antigravity now runs on Google's Antigravity CLI. Update it to keep using it.";

/** Whether an installed copy can run sessions: Google's CLI at the minimum version or newer. */
const runsSessions = (installed: AntigravityInstalledRuntime) =>
  installed.kind === "cli" && meetsAntigravityMinimum(installed.version) === true;

export interface AntigravityDescriptorInput {
  readonly paths: AntigravityInstancePaths;
  /** Undefined where Google publishes no runtime for this machine. */
  readonly runtime: AntigravityRuntime | undefined;
  /** The release to install or update to; undefined where there is no runtime. */
  readonly releases: AntigravityReleaseSource | undefined;
  /** While busy (signing in or out), no agent process starts; each one holds it while it runs. */
  readonly gate?: LaunchGate;
  /** The instance's sign-in method, project and key (fixed for an instance build). */
  readonly signIn: AntigravitySignInConfig;
  /** The folder whose project skills the status lists (the server's, as for other agents). */
  readonly skillsCwd?: string;
  /** Plan limits and email for a Google sign-in; the status check shows its last reading. */
  readonly usage?: AntigravityUsageReader;
}

export function makeAntigravityDescriptor(
  input: AntigravityDescriptorInput,
): AcpProviderDescriptor<AntigravitySettings> {
  const { paths, runtime, releases, gate, signIn, usage } = input;
  const platform = process.platform;
  const listSkills = makeAntigravitySkillsLister();
  const userHomeFor = (environment: NodeJS.ProcessEnv | undefined) =>
    antigravityUserHome(platform, environment ?? process.env, homedir());
  const fingerprint = antigravityCredentialFingerprint(signIn);
  const isGoogleAccount = signIn.method === "oauth-personal";

  const runtimeAction = (
    runtime: AntigravityRuntime,
    verb: "Install" | "Update",
    offer: AntigravityPlatformRelease,
  ): ProviderMaintenanceCommandAction => ({
    command: `${verb} Antigravity ${offer.version} (Threadlines downloads and checks it)`,
    executable: "threadlines",
    args: [],
    lockKey: "antigravity-runtime",
    // Actions run one at a time (`lockKey`), so a button shown before
    // another install finished can't put an older version back. An install
    // from before the CLI is always replaced.
    run: Effect.gen(function* () {
      const installed = yield* runtime.installed;
      if (
        installed?.kind === "cli" &&
        compareSemverVersions(installed.version, offer.version) >= 0
      ) {
        return { output: `Antigravity ${installed.version} is already installed.` };
      }
      yield* runtime.install(offer);
      return { output: `Antigravity ${offer.version} is installed.` };
    }).pipe(Effect.mapError((error) => ({ message: error.message }))),
  });

  /**
   * What the next agent is, to tag the saved model list
   * (`readAntigravityCatalog`) and a refusal: the managed version, or for a
   * custom binary its path, size and change time, so replacing the file
   * lists models afresh.
   */
  const agentTag = (settings: AntigravitySettings) => {
    const custom = settings.binaryPath.trim();
    if (custom) {
      return Effect.promise(() =>
        fs.stat(custom).then(
          (stat) => `custom:${resolvePath(custom)}:${stat.size}:${Math.trunc(stat.mtimeMs)}`,
          () => undefined,
        ),
      );
    }
    return runtime
      ? runtime.installed.pipe(Effect.map((installed) => installed?.version))
      : Effect.succeed(undefined);
  };

  const readCatalog = (agentVersion: string | undefined) =>
    readAntigravityCatalog(paths.profileDir, { fingerprint, isGoogleAccount, agentVersion });

  const spawnFailure = (cause: unknown) =>
    new EffectAcpErrors.AcpSpawnError({ command: "agy acp", cause });

  return {
    driverKind: ANTIGRAVITY_DRIVER_KIND,
    presentation: ANTIGRAVITY_PRESENTATION,
    settingsSchema: AntigravitySettings,
    defaultSettings: () => decodeAntigravitySettings({}),
    maintenance: MANUAL_ONLY,
    resolveMaintenance: (settings) =>
      Effect.gen(function* () {
        if (settings.binaryPath.trim() || !runtime || !releases) return MANUAL_ONLY;
        const installed = yield* runtime.installed;
        const offer = yield* releases.newest;
        if (!installed)
          return { ...MANUAL_ONLY, install: runtimeAction(runtime, "Install", offer) };
        // Never back: a newer copy stays when only an older release is offered.
        return installed.kind === "legacy" ||
          compareSemverVersions(installed.version, offer.version) < 0
          ? { ...MANUAL_ONLY, update: runtimeAction(runtime, "Update", offer) }
          : MANUAL_ONLY;
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
        if (custom) {
          if (isLegacyAntigravityServerPath(custom)) {
            return yield* spawnFailure(new Error(LEGACY_PATH_MESSAGE));
          }
          executable = custom;
        } else {
          if (!runtime) {
            return yield* spawnFailure(
              new Error(`Google publishes no Antigravity for ${platform}.`),
            );
          }
          const leased = yield* runtime.acquire.pipe(Effect.mapError(spawnFailure));
          if (!runsSessions(leased)) {
            return yield* spawnFailure(new Error(UPDATE_NEEDED_MESSAGE));
          }
          executable = leased.executable;
        }
        yield* prepareAntigravityProfile(paths.profileDir, {
          userHome: userHomeFor(environment),
          platform,
        });
        const tempDir = yield* acquireAntigravityTempDir(paths.tempRoot).pipe(
          Effect.mapError(spawnFailure),
        );
        return {
          command: executable,
          args: [...antigravityLaunchArgs(paths.profileDir)],
          cwd,
          env: antigravityEnvironment({
            base: environment ?? process.env,
            profileDir: paths.profileDir,
            tempDir,
            platform,
            credentials: antigravityCredentialEnvironment(signIn, environment ?? process.env),
          }),
          inheritEnv: false,
          shell: false,
          onSpawned: (pid: number) => recordAntigravityAgent(tempDir, pid),
        };
      }),
    // A custom `agy` too old to run is refused before a session opens, and
    // the row says so until that file changes.
    verifyAgent: (settings, response) =>
      Effect.gen(function* () {
        const problem = antigravityAgentProblem(response);
        if (settings.binaryPath.trim()) {
          const tag = yield* agentTag(settings);
          if (tag) yield* writeAntigravityAgentRefusal(paths.profileDir, { tag, problem });
        }
        if (problem) {
          return yield* Effect.fail(EffectAcpErrors.AcpRequestError.invalidParams(problem));
        }
      }),
    signInUrlFromStderr: parseAntigravitySignInUrl,
    // Key methods sign in from the environment with no browser; Google
    // accounts use the profile's saved sign-in.
    ...(signIn.method === "gemini-api-key" || signIn.method === "agent-platform"
      ? { authMethodId: signIn.method }
      : {}),
    agentModeFor: ({ runtimeMode, interactionMode, availableModeIds }) =>
      antigravityAgentMode(runtimeMode, interactionMode, availableModeIds),
    classifyPermissionRequest: antigravityQuestion,
    permissionOptionWarning: antigravityOptionWarning,
    cancellationNotice: "The request was cancelled by the client.",
    // Work that outlives a prompt, steering, hidden failures, turn tokens.
    ...antigravityTurnBehavior<AntigravitySettings>(paths.profileDir),
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
    onSessionConfigOptions: (settings, configOptions) =>
      Effect.gen(function* () {
        const agentVersion = yield* agentTag(settings);
        const next = nextAntigravityCatalog(yield* readCatalog(agentVersion), configOptions);
        if (!next) return;
        yield* writeAntigravityCatalog(paths.profileDir, {
          ...next,
          fingerprint,
          ...(agentVersion ? { agentVersion } : {}),
        });
      }),
    notInstalledMessage: NOT_INSTALLED_MESSAGE,
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
        if (!custom && (!runtime || !releases)) {
          return {
            installed: false,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: `Google does not publish Antigravity for this computer (${platform}, ${process.arch}).`,
          } satisfies AcpProviderProbeOutcome;
        }
        if (custom && isLegacyAntigravityServerPath(custom)) {
          return {
            installed: true,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: LEGACY_PATH_MESSAGE,
            skipModelDiscovery: true,
          } satisfies AcpProviderProbeOutcome;
        }
        const managed = custom ? undefined : yield* runtime!.installed;
        if (custom ? !existsSync(custom) : managed === undefined) {
          return {
            installed: false,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: custom ? `Antigravity was not found at ${custom}.` : NOT_INSTALLED_MESSAGE,
          } satisfies AcpProviderProbeOutcome;
        }
        const version = managed?.version ?? null;
        const tag = yield* agentTag(settings);
        const latest = custom ? {} : { latestVersion: (yield* releases!.newest).version };
        const refusal =
          custom && tag ? yield* readAntigravityAgentRefusal(paths.profileDir, tag) : undefined;
        if (refusal) {
          return {
            installed: true,
            version: null,
            status: "error",
            auth: { status: "unknown" },
            message: refusal,
            skipModelDiscovery: true,
          } satisfies AcpProviderProbeOutcome;
        }
        if (managed && !runsSessions(managed)) {
          return {
            installed: true,
            version,
            status: "error",
            auth: { status: "unknown" },
            message: UPDATE_NEEDED_MESSAGE,
            skipModelDiscovery: true,
            ...latest,
          } satisfies AcpProviderProbeOutcome;
        }
        const usesGoogleSignIn =
          signIn.method === "oauth-personal" || signIn.method === "oauth-business";
        const google = usesGoogleSignIn
          ? yield* readAntigravityGoogleSignIn(paths.profileDir)
          : undefined;
        const signInStatus = antigravitySignInStatus({
          config: signIn,
          signedIn: google?.method === signIn.method,
          legacySignIn: google?.legacyOnly === true,
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
        const catalog = yield* readCatalog(tag);
        const outcome = {
          installed: true,
          version,
          ...signInStatus,
          ...latest,
          ...(catalog ? { models: antigravityModelsFromCatalog(catalog) } : {}),
        } satisfies AcpProviderProbeOutcome;
        return usage ? withAntigravityUsage(outcome, yield* usage.status) : outcome;
      }),
    // What the agent would see: the profile is brought up to date first, as
    // a start would, and global skills are read through it.
    listSkills: (_settings, environment) =>
      prepareAntigravityProfile(paths.profileDir, {
        userHome: userHomeFor(environment),
        platform,
      }).pipe(
        Effect.andThen(
          listSkills({ cwd: input.skillsCwd ?? process.cwd(), profileDir: paths.profileDir }),
        ),
      ),
    modelDiscoveryTimeoutMs: ANTIGRAVITY_DISCOVERY_TIMEOUT_MS,
    // Discovery mirrors the selected model's options (its reasoning levels)
    // onto every model; the next status check reads each model's own from
    // the saved list. Older agents name the level in the model: fold those.
    enrichDiscoveredModels: (models) =>
      Effect.succeed(
        models.some((model) => EFFORT_NAME.test(model.name.trim()))
          ? antigravityModelsFromChoices(
              models.map((model) => ({ value: model.slug, name: model.name })),
            )
          : models,
      ),
    modelCapabilitiesVaryByModel: false,
    resolveModelId: resolveAntigravityModelId,
  };
}

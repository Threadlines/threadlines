/**
 * AntigravityProfile — where one Antigravity provider instance keeps its
 * state, and the environment its agent processes run with.
 *
 * Each instance gets its own profile (`agy acp --gemini-dir`: sign-in,
 * conversations, settings) under Threadlines' state dir, isolated from the
 * user's own `~/.gemini`, and a temp root its processes unpack into. Every
 * process gets a private `run-*` dir that is removed when the process ends,
 * and the instance's temp root is swept on start for dirs whose owner is
 * gone.
 *
 * @module provider/antigravity/AntigravityProfile
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveCommandPath } from "@threadlines/shared/shell";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { ProviderSetupError } from "../Errors.ts";
import { ANTIGRAVITY_APP_DATA_DIR } from "./AntigravityRelease.ts";
import { shareAntigravityUserConfig } from "./AntigravityUserConfig.ts";

export interface AntigravityInstancePaths {
  /** `GEMINI_HOME` for this instance. */
  readonly profileDir: string;
  /** Parent of the per-process temp dirs. Kept short: Windows MAX_PATH. */
  readonly tempRoot: string;
}

const hashInstanceId = (instanceId: string) =>
  createHash("sha256").update(instanceId).digest("hex");

export function antigravityInstancePaths(
  stateDir: string,
  instanceId: string,
): AntigravityInstancePaths {
  const hash = hashInstanceId(instanceId);
  return {
    profileDir: join(stateDir, "providers", "antigravity", hash.slice(0, 16)),
    tempRoot: join(stateDir, "agy-tmp", hash.slice(0, 12)),
  };
}

/** The Threadlines data folder a profile from `antigravityInstancePaths` sits in. */
export const antigravityStateDirOf = (profileDir: string) => resolve(profileDir, "..", "..", "..");

/** The agent's own state dir inside the profile. */
export const antigravityAgentDir = (profileDir: string) =>
  join(profileDir, ANTIGRAVITY_APP_DATA_DIR);

/**
 * Where the CLI keeps a Google sign-in when it uses file storage (see
 * `antigravityEnvironment`): `{ token: { access_token, refresh_token, expiry } }`.
 */
export const antigravityTokenPath = (profileDir: string) =>
  join(antigravityAgentDir(profileDir), "antigravity-oauth-token");

/** Where Google's old ACP server kept its sign-in. The CLI doesn't read it. */
export const antigravityLegacyTokenPath = (profileDir: string) =>
  join(antigravityAgentDir(profileDir), "acp_token.json");

/** Credentials and project settings that would steer the agent away from this profile. */
const STRIPPED_ENV_KEY =
  /^(GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|AGY_|ANTIGRAVITY_)|^(BROWSER|PYTHONUNBUFFERED|PYTHONHOME|PYTHONPATH)$/iu;

/**
 * What the CLI takes for a session over SSH. It then keeps a Google sign-in
 * in the profile's own file instead of the one OS keyring entry every
 * profile (and the user's own terminal `agy`) shares, and signs in with
 * `agy acp --login`, which prints a link and reads back a code.
 */
const SSH_CONNECTION_STAND_IN = "127.0.0.1 0 127.0.0.1 0";

/**
 * A `BROWSER` that opens nothing: the agent prints its sign-in URL, and the
 * Threadlines client (which may be another machine) opens it. Python splits
 * `BROWSER` on the path separator, so the value must not contain one.
 */
function noopBrowser(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") return "cmd.exe /d /c exit 0 %s";
  return resolveCommandPath("true", { platform, env }) ?? "/usr/bin/true";
}

/**
 * The complete environment for an Antigravity process: the server's own,
 * minus ambient Google credentials, plus the sign-in method's own
 * credentials (`AntigravitySignInMethod`), the profile, file-based sign-in
 * storage (no shared OS keyring entry), no self-update, and the process's
 * temp dir.
 */
export function antigravityEnvironment(input: {
  readonly base: NodeJS.ProcessEnv;
  readonly profileDir: string;
  readonly tempDir: string;
  readonly platform: NodeJS.Platform;
  readonly credentials?: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.base)) {
    if (value !== undefined && !STRIPPED_ENV_KEY.test(key)) env[key] = value;
  }
  Object.assign(env, input.credentials);
  env.GEMINI_HOME = input.profileDir;
  env.AGY_ACP_FORCE_FILE_STORAGE = "1";
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "1";
  env.SSH_CONNECTION = input.base.SSH_CONNECTION?.trim() || SSH_CONNECTION_STAND_IN;
  env.BROWSER = noopBrowser(input.platform, input.base);
  if (input.platform === "win32") {
    env.TEMP = input.tempDir;
    env.TMP = input.tempDir;
  } else {
    env.TMPDIR = input.tempDir;
  }
  return env;
}

const OWNER_FILE = ".owner";
const AGENT_FILE = ".agent";

/** Writes a pid marker whole or not at all: a sweep never reads a cut-off number. */
async function writePidMarker(path: string, pid: number): Promise<void> {
  const temp = `${path}.${randomBytes(4).toString("hex")}`;
  await fs.writeFile(temp, String(pid));
  await fs.rename(temp, path);
}

/**
 * A private temp dir for one agent process, removed when the scope closes.
 * The owner file names this server's pid and, once it starts, the agent file
 * names the agent's (`recordAntigravityAgent`): a sweep leaves the dir alone
 * while either lives.
 */
export const acquireAntigravityTempDir = (tempRoot: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const dir = join(tempRoot, `run-${randomBytes(4).toString("hex")}`);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        await writePidMarker(join(dir, OWNER_FILE), process.pid);
        return dir;
      },
      catch: (cause) =>
        new ProviderSetupError({
          detail: `Could not create Antigravity's temp dir: ${String(cause)}`,
          cause,
        }),
    }),
    (dir) =>
      Effect.promise(() =>
        fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined),
      ),
  ) satisfies Effect.Effect<string, Error, Scope.Scope>;

/** Names the agent process using `tempDir`, for sweeps after this server is gone. */
export const recordAntigravityAgent = (tempDir: string, pid: number) =>
  Effect.promise(() => writePidMarker(join(tempDir, AGENT_FILE), pid).catch(() => undefined));

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid a marker names; a missing or unreadable one names none. */
const readPid = (path: string) =>
  fs.readFile(path, "utf8").then(
    (raw) => {
      const pid = Number(raw.trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    },
    () => undefined,
  );

/**
 * A dir with no agent recorded comes from a server that died while starting
 * one. That agent lost its server too and exits; a day without changes to the
 * dir leaves no doubt.
 */
const NO_AGENT_QUIET_MS = 24 * 60 * 60 * 1000;

/**
 * Removes temp dirs left by processes whose server is gone (a crash, a
 * force quit). A dir stays while its server or its agent lives (an agent can
 * outlive a crashed server for a moment, an onefile build still unpacking).
 * A dir whose agent never got recorded (the server died while starting it)
 * goes once it has been quiet for a day.
 */
export const sweepAntigravityTempRoot = (tempRoot: string) =>
  Effect.promise(async () => {
    const entries = await fs.readdir(tempRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("run-")) continue;
      const dir = join(tempRoot, entry.name);
      const owner = await readPid(join(dir, OWNER_FILE));
      if (owner !== undefined && isPidAlive(owner)) continue;
      const agent = await readPid(join(dir, AGENT_FILE));
      if (agent !== undefined && isPidAlive(agent)) continue;
      if (agent === undefined) {
        const stat = await fs.lstat(dir).catch(() => undefined);
        if (!stat || Date.now() - stat.mtimeMs < NO_AGENT_QUIET_MS) continue;
      }
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  });

/** Whether a file holds a JSON object with something in it (an interrupted write leaves less). */
const holdsJsonObject = async (path: string) => {
  const raw = await fs.readFile(path, "utf8").catch(() => "");
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
};

/** What the profile holds of a Google sign-in: the CLI's, the old server's, or neither. */
export const readAntigravitySavedSignIn = (profileDir: string) =>
  Effect.promise(async () => ({
    cli: await holdsJsonObject(antigravityTokenPath(profileDir)),
    legacy: await holdsJsonObject(antigravityLegacyTokenPath(profileDir)),
  }));

export interface AntigravityModelChoice {
  readonly value: string;
  readonly name: string;
}

/** A model's reasoning levels, as the session's `thought_level` option lists them. */
export interface AntigravityThoughtLevels {
  /** The session option's id, which a selection is sent back to. */
  readonly configId: string;
  readonly name: string;
  readonly options: ReadonlyArray<AntigravityModelChoice>;
  readonly currentValue?: string;
}

export interface AntigravityCatalogCache {
  readonly choices: ReadonlyArray<AntigravityModelChoice>;
  readonly currentValue?: string;
  /**
   * Each model's reasoning levels, by model id, as seen when it was the
   * session's model (the agent lists them for that model only); null when
   * it had none. Models not seen yet are missing.
   */
  readonly thoughtLevels?: Readonly<Record<string, AntigravityThoughtLevels | null>>;
  /** The sign-in it was listed for (`antigravityCredentialFingerprint`). */
  readonly fingerprint?: string;
  /** The managed runtime version that listed it; absent for a custom binary. */
  readonly agentVersion?: string;
}

const catalogPath = (profileDir: string) => join(profileDir, "threadlines-models.json");

const modelChoicesOf = (raw: unknown): ReadonlyArray<AntigravityModelChoice> =>
  Array.isArray(raw)
    ? raw.filter(
        (choice): choice is AntigravityModelChoice =>
          typeof choice?.value === "string" && typeof choice?.name === "string",
      )
    : [];

/** The saved reasoning levels of listed models; anything malformed is left out. */
function thoughtLevelsOf(
  raw: unknown,
  choices: ReadonlyArray<AntigravityModelChoice>,
): Record<string, AntigravityThoughtLevels | null> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const levels: Record<string, AntigravityThoughtLevels | null> = {};
  for (const choice of choices) {
    const entry = (raw as Record<string, unknown>)[choice.value];
    if (entry === null) {
      levels[choice.value] = null;
      continue;
    }
    if (typeof entry !== "object" || entry === undefined) continue;
    const { configId, name, options, currentValue } = entry as Partial<AntigravityThoughtLevels>;
    const parsedOptions = modelChoicesOf(options);
    if (typeof configId !== "string" || typeof name !== "string" || parsedOptions.length === 0) {
      continue;
    }
    levels[choice.value] = {
      configId,
      name,
      options: parsedOptions,
      ...(typeof currentValue === "string" ? { currentValue } : {}),
    };
  }
  return Object.keys(levels).length > 0 ? levels : undefined;
}

/**
 * The model list from the last session, so status checks need not start the
 * agent. A list from another sign-in (method, project or key) doesn't count:
 * what a sign-in may use differs. Lists saved before sign-in methods existed
 * count for a Google account. A list from another agent version doesn't count
 * either: each release names its own models, so an update lists them afresh.
 */
export const readAntigravityCatalog = (
  profileDir: string,
  sign: {
    readonly fingerprint: string;
    readonly isGoogleAccount: boolean;
    readonly agentVersion: string | undefined;
  },
) =>
  Effect.promise(async (): Promise<AntigravityCatalogCache | undefined> => {
    const raw = await fs.readFile(catalogPath(profileDir), "utf8").catch(() => undefined);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<AntigravityCatalogCache>;
      const matches =
        parsed.fingerprint === undefined
          ? sign.isGoogleAccount
          : parsed.fingerprint === sign.fingerprint;
      if (!matches || parsed.agentVersion !== sign.agentVersion) return undefined;
      const choices = modelChoicesOf(parsed.choices);
      const thoughtLevels = thoughtLevelsOf(parsed.thoughtLevels, choices);
      return choices.length > 0
        ? {
            choices,
            ...(typeof parsed.currentValue === "string"
              ? { currentValue: parsed.currentValue }
              : {}),
            ...(thoughtLevels ? { thoughtLevels } : {}),
            fingerprint: sign.fingerprint,
            ...(sign.agentVersion ? { agentVersion: sign.agentVersion } : {}),
          }
        : undefined;
    } catch {
      return undefined;
    }
  });

export const writeAntigravityCatalog = (profileDir: string, catalog: AntigravityCatalogCache) =>
  Effect.tryPromise(async () => {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const target = catalogPath(profileDir);
    const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temp, JSON.stringify(catalog));
    await fs.rename(temp, target);
  }).pipe(Effect.ignore);

/**
 * Creates the profile dirs the agent expects, private to the user, and
 * brings in the user's own global rules and skills from `~/.gemini`
 * (`AntigravityUserConfig`). Runs before every agent start.
 */
export const prepareAntigravityProfile = (
  profileDir: string,
  user: { readonly userHome: string; readonly platform: NodeJS.Platform },
) =>
  Effect.promise(() =>
    fs.mkdir(antigravityAgentDir(profileDir), { recursive: true, mode: 0o700 }),
  ).pipe(
    Effect.andThen(
      shareAntigravityUserConfig({
        profileDir,
        userHome: user.userHome,
        platform: user.platform,
        threadlinesDir: antigravityStateDirOf(profileDir),
      }),
    ),
  );

const agentRefusalPath = (profileDir: string) => join(profileDir, "threadlines-agent-check.json");

/**
 * Records why a custom `agy` was refused (or that it wasn't), for the status
 * to show without starting it again. `tag` names the file as it was then.
 */
export const writeAntigravityAgentRefusal = (
  profileDir: string,
  check: { readonly tag: string; readonly problem: string | undefined },
) =>
  Effect.tryPromise(async () => {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const target = agentRefusalPath(profileDir);
    const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temp, JSON.stringify(check));
    await fs.rename(temp, target);
  }).pipe(Effect.ignore);

/** Why the custom `agy` `tag` names was refused, if it was. */
export const readAntigravityAgentRefusal = (profileDir: string, tag: string) =>
  Effect.promise(async () => {
    const raw = await fs.readFile(agentRefusalPath(profileDir), "utf8").catch(() => undefined);
    try {
      const parsed =
        raw === undefined ? undefined : (JSON.parse(raw) as { tag?: unknown; problem?: unknown });
      return parsed?.tag === tag && typeof parsed.problem === "string" ? parsed.problem : undefined;
    } catch {
      return undefined;
    }
  });

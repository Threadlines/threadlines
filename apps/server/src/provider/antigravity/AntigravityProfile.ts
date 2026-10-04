/**
 * AntigravityProfile — where one Antigravity provider instance keeps its
 * state, and the environment its agent processes run with.
 *
 * Each instance gets its own `GEMINI_HOME` (credentials, conversations,
 * settings) under Threadlines' state dir, isolated from the user's own
 * `~/.gemini`, and a temp root its processes unpack into. Antigravity's
 * Windows build is a PyInstaller one-file exe that unpacks ~1 GB per launch
 * into `TEMP` and can leave it behind; every process therefore gets a private
 * `run-*` dir that is removed when the process ends, and the instance's temp
 * root is swept on start for dirs whose owner is gone.
 *
 * @module provider/antigravity/AntigravityProfile
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { resolveCommandPath } from "@threadlines/shared/shell";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

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

/** The agent's own state dir inside the profile. */
export const antigravityAgentDir = (profileDir: string) => join(profileDir, "antigravity-acp");

/** Written by the agent after a successful Google sign-in (file storage). */
export const antigravityTokenPath = (profileDir: string) =>
  join(antigravityAgentDir(profileDir), "acp_token.json");

/** Credentials and project settings that would steer the agent away from this profile. */
const STRIPPED_ENV_KEY =
  /^(GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|AGY_|ANTIGRAVITY_)|^(BROWSER|PYTHONUNBUFFERED|PYTHONHOME|PYTHONPATH)$/iu;

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
 * minus ambient Google credentials and Python settings, plus the profile,
 * file-based credential storage (no shared OS keychain entry) and the
 * process's temp dir.
 */
export function antigravityEnvironment(input: {
  readonly base: NodeJS.ProcessEnv;
  readonly profileDir: string;
  readonly tempDir: string;
  readonly platform: NodeJS.Platform;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.base)) {
    if (value !== undefined && !STRIPPED_ENV_KEY.test(key)) env[key] = value;
  }
  env.GEMINI_HOME = input.profileDir;
  env.AGY_ACP_FORCE_FILE_STORAGE = "1";
  env.PYTHONUNBUFFERED = "1";
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
      catch: (cause) => new Error(`Could not create Antigravity's temp dir: ${String(cause)}`),
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

/** Whether the profile holds the agent's Google credentials. */
export const hasAntigravityCredentials = (profileDir: string) =>
  existsSync(antigravityTokenPath(profileDir));

export interface AntigravityModelChoice {
  readonly value: string;
  readonly name: string;
}

export interface AntigravityCatalogCache {
  readonly choices: ReadonlyArray<AntigravityModelChoice>;
  readonly currentValue?: string;
}

const catalogPath = (profileDir: string) => join(profileDir, "threadlines-models.json");

/** The model list from the last session, so status checks need not start the agent. */
export const readAntigravityCatalog = (profileDir: string) =>
  Effect.promise(async (): Promise<AntigravityCatalogCache | undefined> => {
    const raw = await fs.readFile(catalogPath(profileDir), "utf8").catch(() => undefined);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<AntigravityCatalogCache>;
      const choices = Array.isArray(parsed.choices)
        ? parsed.choices.filter(
            (choice): choice is AntigravityModelChoice =>
              typeof choice?.value === "string" && typeof choice?.name === "string",
          )
        : [];
      return choices.length > 0
        ? {
            choices,
            ...(typeof parsed.currentValue === "string"
              ? { currentValue: parsed.currentValue }
              : {}),
          }
        : undefined;
    } catch {
      return undefined;
    }
  });

export const writeAntigravityCatalog = (profileDir: string, catalog: AntigravityCatalogCache) =>
  Effect.promise(async () => {
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const target = catalogPath(profileDir);
    const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temp, JSON.stringify(catalog));
    await fs.rename(temp, target);
  }).pipe(Effect.ignore);

/** Creates the profile dirs the agent expects, private to the user. */
export const prepareAntigravityProfile = (profileDir: string) =>
  Effect.promise(() =>
    fs.mkdir(antigravityAgentDir(profileDir), { recursive: true, mode: 0o700 }),
  ).pipe(Effect.asVoid);

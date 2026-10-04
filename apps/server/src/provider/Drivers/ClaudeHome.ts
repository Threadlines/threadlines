import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

/** The `HOME` Claude runs with: the instance's `homePath`, else the server's. */
export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export type ClaudeFolderConfig = Pick<ClaudeSettings, "homePath" | "accountFolder">;

/**
 * The folder Claude would use without an account folder: `CLAUDE_CONFIG_DIR`
 * from the instance's environment (or the server's), else `<HOME>/.claude`.
 * An account folder shares its config and history with this one.
 */
export const resolveClaudeMainConfigDir = Effect.fn("resolveClaudeMainConfigDir")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  // Environment values are not shell-expanded, so a literal `~` stays literal.
  const configured = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (configured.length > 0) return path.resolve(configured);
  return path.join(yield* resolveClaudeHomePath(config), ".claude");
});

/** The folder this instance's Claude reads and writes: its account folder, else the main one. */
export const resolveClaudeConfigDir = Effect.fn("resolveClaudeConfigDir")(function* (
  config: ClaudeFolderConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const accountFolder = config.accountFolder.trim();
  if (accountFolder.length > 0) return path.resolve(expandHomePath(accountFolder));
  return yield* resolveClaudeMainConfigDir(config, environment);
});

/**
 * Credentials Claude reads before its own sign-in. An account's sign-in must
 * be the one it uses, so account instances never inherit these from the
 * server; set on the instance itself they still apply.
 */
export const CLAUDE_AMBIENT_CREDENTIAL_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/**
 * Overrides where Claude keeps its login, independent of `CLAUDE_CONFIG_DIR`;
 * an inherited empty value would point every account at the terminal's
 * keychain item.
 */
const CLAUDE_SECURE_STORAGE_ENV = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

/**
 * The server environment an instance starts from, before its own variables
 * are layered on. Account instances drop inherited credentials and the
 * secure-storage override; other instances inherit everything, as before.
 */
export function claudeInstanceBaseEnvironment(
  config: Pick<ClaudeSettings, "accountFolder">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (config.accountFolder.trim().length === 0) return baseEnv;
  const environment: NodeJS.ProcessEnv = { ...baseEnv };
  for (const name of CLAUDE_AMBIENT_CREDENTIAL_ENV_NAMES) delete environment[name];
  delete environment[CLAUDE_SECURE_STORAGE_ENV];
  return environment;
}

/** Subagent limits configured in provider settings, forwarded to the Claude
 *  CLI as environment variables. Blank settings leave the CLI defaults. */
const CLAUDE_SUBAGENT_LIMIT_ENVS = [
  ["maxConcurrentSubagents", "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"],
  ["maxSubagentsPerSession", "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"],
  ["maxSubagentSpawnDepth", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"],
] as const;

const CLAUDE_RESUME_INTERRUPTED_TURN_ENV = "CLAUDE_CODE_RESUME_INTERRUPTED_TURN";

export type ClaudeEnvironmentConfig = ClaudeFolderConfig &
  Partial<Pick<ClaudeSettings, (typeof CLAUDE_SUBAGENT_LIMIT_ENVS)[number][0]>>;

/** Settings hold limits as free-form text; only a positive integer becomes
 *  an environment variable, anything else falls back to the CLI default. */
function normalizeClaudeSubagentLimit(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : undefined;
}

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: ClaudeEnvironmentConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const environment: NodeJS.ProcessEnv = { ...baseEnv };
  // Adapters retain this environment across turns. Read the driver's refreshed
  // PATH at spawn time so a newly installed CLI works without rebuilding it.
  if (process.platform === "win32") {
    for (const key of Object.keys(environment)) {
      if (key.toUpperCase() === "PATH") delete environment[key];
    }
  }
  Object.defineProperty(environment, "PATH", {
    enumerable: true,
    configurable: true,
    get: () =>
      process.platform === "win32" ? (baseEnv.PATH ?? baseEnv.Path ?? baseEnv.path) : baseEnv.PATH,
  });
  // The CLI re-runs a turn it considers interrupted when the session is
  // resumed. The orchestration core already records that turn as
  // interrupted, and a silent re-run would land its output (and repeat its
  // tool calls) under the next turn, so resumes must never start a turn on
  // their own. An explicit value in the base environment wins.
  if (environment[CLAUDE_RESUME_INTERRUPTED_TURN_ENV] === undefined) {
    environment[CLAUDE_RESUME_INTERRUPTED_TURN_ENV] = "0";
  }
  for (const [settingKey, envName] of CLAUDE_SUBAGENT_LIMIT_ENVS) {
    const limit = normalizeClaudeSubagentLimit(config[settingKey]);
    if (limit !== undefined) {
      environment[envName] = limit;
    }
  }
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    environment.HOME = yield* resolveClaudeHomePath(config);
  }
  if (config.accountFolder.trim().length > 0) {
    // `HOME` stays the user's: the agent's own commands keep their git, SSH
    // and GitHub settings, and only Claude's folder (and login) moves.
    environment.CLAUDE_CONFIG_DIR = yield* resolveClaudeConfigDir(config, environment);
    delete environment[CLAUDE_SECURE_STORAGE_ENV];
  }
  return environment;
});

/**
 * Instances with the same key read the same conversation history, so a thread
 * can move between them with native resume. An account folder whose
 * `projects` links to the main folder shares the main folder's key. The
 * default `<HOME>/.claude` keeps its historical `claude:home:` form so
 * existing threads stay switchable.
 */
export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: ClaudeFolderConfig,
    environment: NodeJS.ProcessEnv = process.env,
    options: { readonly sharesMainHistory: boolean } = { sharesMainHistory: true },
  ): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    const historyDir = options.sharesMainHistory
      ? yield* resolveClaudeMainConfigDir(config, environment)
      : yield* resolveClaudeConfigDir(config, environment);
    return historyDir === path.join(resolvedHomePath, ".claude")
      ? `claude:home:${resolvedHomePath}`
      : `claude:config:${historyDir}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath"> & ClaudeFolderConfig,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    const configDir = yield* resolveClaudeConfigDir(config, environment);
    return `${config.binaryPath}\0${resolvedHomePath}\0${configDir}`;
  },
);

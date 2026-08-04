import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

/** Subagent limits configured in provider settings, forwarded to the Claude
 *  CLI as environment variables. Blank settings leave the CLI defaults. */
const CLAUDE_SUBAGENT_LIMIT_ENVS = [
  ["maxConcurrentSubagents", "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"],
  ["maxSubagentsPerSession", "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION"],
  ["maxSubagentSpawnDepth", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"],
] as const;

const CLAUDE_RESUME_INTERRUPTED_TURN_ENV = "CLAUDE_CODE_RESUME_INTERRUPTED_TURN";

export type ClaudeEnvironmentConfig = Pick<ClaudeSettings, "homePath"> &
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
  return environment;
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}`;
  },
);

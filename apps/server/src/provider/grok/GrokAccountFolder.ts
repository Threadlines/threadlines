// @effect-diagnostics nodeBuiltinImport:off
/**
 * GrokAccountFolder — a second Grok account's `GROK_HOME`, laid over the main
 * Grok folder (`~/.grok`).
 *
 * The account keeps its sign-in to itself (`auth.json`, and the credentials
 * MCP servers gave it) and links the user's setup and conversations back to
 * the main folder: settings, skills, agents, hooks, rules, plugins, memory
 * and `sessions`, so a thread moves between the two and Grok resumes it. Its
 * team's managed config, logs and update cache stay its own. An allowlist,
 * as for Claude: a file a future Grok starts keeping there is safer private.
 * The names come from Grok Build 1.0.45-1.0.60's own docs.
 *
 * @module provider/grok/GrokAccountFolder
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { expandHomePath } from "../../pathExpansion.ts";
import { materializeAccountOverlay } from "../accountOverlay.ts";

const SHARED_DIRECTORIES = [
  // Conversations (resume) and the worktrees Grok made for them.
  "sessions",
  "worktrees",
  // Instructions and extensions.
  "skills",
  "agents",
  "personas",
  "workflows",
  "rules",
  "plugins",
  "hooks",
  "memory",
  "memory-v2",
] as const;

const SHARED_FILES = [
  "AGENTS.md",
  "config.toml",
  "pager.toml",
  "sandbox.toml",
  "settings.json",
  "lsp.json",
  "statusline.sh",
  "hooks-paths",
  "trusted_folders.toml",
] as const;

const PRIVATE_FILES = ["auth.json", "mcp_credentials.json"] as const;

/** The Grok folder an instance uses without an account folder: `GROK_HOME`, else `~/.grok`. */
export function grokMainHome(environment: NodeJS.ProcessEnv): string {
  const fromEnvironment = environment.GROK_HOME?.trim();
  return fromEnvironment ? resolve(expandHomePath(fromEnvironment)) : join(homedir(), ".grok");
}

export const materializeGrokAccountFolder = (input: {
  readonly mainDir: string;
  readonly accountDir: string;
}) =>
  materializeAccountOverlay({
    agent: "Grok",
    mainDir: input.mainDir,
    accountDir: input.accountDir,
    sharedDirectories: SHARED_DIRECTORIES,
    sharedFiles: SHARED_FILES,
    privateFiles: PRIVATE_FILES,
    historyEntry: "sessions",
  });

/**
 * Threads resume natively between instances that keep one conversation
 * store: the key is the real `sessions` folder, so an account (or an API-key
 * profile) whose `sessions` links to another folder's shares its key.
 */
export function grokContinuationKey(accountFolder: string, environment: NodeJS.ProcessEnv): string {
  const folder = expandHomePath(accountFolder.trim());
  const home = folder ? resolve(folder) : grokMainHome(environment);
  const real = (target: string) => {
    try {
      return realpathSync(target);
    } catch {
      return undefined;
    }
  };
  // No `sessions` yet: the folder Grok will make it in, by its real path, so
  // a linked GROK_HOME keys the same before and after the first chat.
  const sessions = real(join(home, "sessions")) ?? join(real(home) ?? home, "sessions");
  return `grok:sessions:${sessions}`;
}

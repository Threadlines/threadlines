/**
 * ClaudeAccountFolder — a second Claude account's `CLAUDE_CONFIG_DIR`, laid
 * over the main Claude folder.
 *
 * The account keeps its login and account state to itself
 * (`.credentials.json`, `.claude.json` with `oauthAccount`, org policy,
 * caches) and links an allowlist of entries back to the main folder: the
 * user's instructions and extensions, and the conversation state that resume
 * and revert read. An allowlist rather than a denylist because Claude keeps
 * account state beside config, and a file it starts writing in a future
 * version is safer private than shared. The names come from the folders
 * Claude Code 2.1.289 reads from its config folder.
 *
 * The overlay itself (`materializeAccountOverlay`) never moves or overwrites
 * anything real.
 *
 * @module provider/Drivers/ClaudeAccountFolder
 */
import { materializeAccountOverlay } from "../accountOverlay.ts";

const SHARED_DIRECTORIES = [
  // Conversation state: resume, checkpoints (revert), todos, plans, uploads.
  "projects",
  "file-history",
  "todos",
  "tasks",
  "plans",
  "shell-snapshots",
  "session-env",
  "uploads",
  // Instructions and extensions.
  "rules",
  "skills",
  "agents",
  "commands",
  "output-styles",
  "plugins",
  "workflows",
  "themes",
  "agent-memory",
  "memory",
] as const;

const SHARED_FILES = ["CLAUDE.md", "settings.json", "keybindings.json", "history.jsonl"] as const;

/** Must be the account's own: a link here would share or leak a login. */
const PRIVATE_FILES = [".credentials.json", ".claude.json"] as const;

export interface ClaudeAccountFolderResult {
  /** `projects` links to the main folder, so threads resume across the two. */
  readonly sharesMainHistory: boolean;
}

export const materializeClaudeAccountFolder = (input: {
  readonly mainDir: string;
  readonly accountDir: string;
  readonly platform?: NodeJS.Platform;
}) =>
  materializeAccountOverlay({
    agent: "Claude",
    mainDir: input.mainDir,
    accountDir: input.accountDir,
    sharedDirectories: SHARED_DIRECTORIES,
    sharedFiles: SHARED_FILES,
    privateFiles: PRIVATE_FILES,
    historyEntry: "projects",
    ...(input.platform ? { platform: input.platform } : {}),
  });

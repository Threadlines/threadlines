/**
 * Provider auth commands and the credentials they produce.
 *
 * One source of truth for:
 *   - the sign-in / token commands Threadlines runs for a provider instance
 *     (server spawns the argv form in a PTY; the web shows the display form
 *     under "Prefer your own terminal?"),
 *   - the `CLAUDE_CODE_OAUTH_TOKEN` environment entry a `claude setup-token`
 *     run produces, which both the server (auto-capture) and the web (manual
 *     paste fallback) write into the instance's environment.
 *
 * @module providerAuthCommands
 */
import type { ProviderInstanceEnvironmentVariable } from "@threadlines/contracts";

import { bashWord, wslCommand } from "./wsl.ts";

export const CODEX_DRIVER_KIND = "codex";
export const CLAUDE_DRIVER_KIND = "claudeAgent";
export const CURSOR_DRIVER_KIND = "cursor";
export const FX_DRIVER_KIND = "fx";
export const OPENCODE_DRIVER_KIND = "opencode";
export const ANTIGRAVITY_DRIVER_KIND = "antigravity";

/**
 * Drivers whose sign-in runs in the browser, inside the agent itself, with no
 * terminal command (Antigravity's Google sign-in). They also sign out.
 */
export const BROWSER_SIGN_IN_DRIVERS: ReadonlySet<string> = new Set([ANTIGRAVITY_DRIVER_KIND]);

/** What a browser sign-in is called where a command would be shown. */
export const BROWSER_SIGN_IN_LABEL = "Sign in with Google";

export const CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * Credential env vars Claude reads *before* the long-lived OAuth token.
 * Cleared when the user asks for normal sign-in, and never forwarded into
 * an auth PTY (a stale token there makes `claude auth login` a no-op).
 */
export const CLAUDE_CREDENTIAL_OVERRIDE_ENV_NAMES = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

/** Long-lived Claude OAuth token as printed by `claude setup-token`. */
export const CLAUDE_OAUTH_TOKEN_PATTERN = /sk-ant-oat01-[A-Za-z0-9_-]+/;

/**
 * Which auth flow to run for an instance. `login` resolves to the driver's
 * interactive sign-in; `claude-setup-token` mints a long-lived headless token;
 * `logout` signs out (browser sign-in drivers only, run by the instance).
 */
export type ProviderAuthFlow = "login" | "claude-setup-token" | "logout";

export interface ProviderAuthCommandInput {
  readonly driver: string;
  readonly flow: ProviderAuthFlow;
  readonly binaryPath: string;
  readonly homePath: string;
  readonly shadowHomePath?: string;
  /** Claude's `CLAUDE_CONFIG_DIR`, or the folder holding OpenCode's database. */
  readonly accountFolder?: string;
  /** Host platform; fx has no Windows build and signs in through WSL there. */
  readonly platform?: string;
}

export interface ProviderAuthCommand {
  /** Executable to spawn directly in the PTY (no intermediate shell). */
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  /** Env assignments layered on top of the inherited process environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Shell-quoted rendering shown to the user for the copy fallback. */
  readonly display: string;
}

function shellWord(value: string): string {
  if (/^[A-Za-z0-9_./~:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderDisplayCommand(input: {
  readonly file: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}): string {
  const assignments = Object.entries(input.env).map(
    ([name, value]) => `${name}=${shellWord(value)}`,
  );
  return [...assignments, shellWord(input.file), ...input.args.map(shellWord)].join(" ");
}

/**
 * Where a Claude instance's login lives: `HOME` for a `homePath`, and
 * `CLAUDE_CONFIG_DIR` for an account folder (which keeps `HOME` intact).
 */
export function claudeAuthEnvironment(input: {
  readonly homePath: string;
  readonly accountFolder?: string | undefined;
}): Readonly<Record<string, string>> {
  const homePath = input.homePath.trim();
  const accountFolder = input.accountFolder?.trim() ?? "";
  return {
    ...(homePath ? { HOME: homePath } : {}),
    ...(accountFolder ? { CLAUDE_CONFIG_DIR: accountFolder } : {}),
  };
}

/** `folder` without trailing slashes or backslashes. A loop, not a regex: a regex backtracks on long runs of them. */
function withoutTrailingSeparators(folder: string): string {
  let end = folder.length;
  while (end > 0 && (folder[end - 1] === "/" || folder[end - 1] === "\\")) end -= 1;
  return folder.slice(0, end);
}

/**
 * OpenCode keeps its sign-ins (and sessions) in one database; an account
 * folder gives the instance its own.
 */
export function openCodeAccountEnvironment(input: {
  readonly accountFolder?: string | undefined;
  readonly platform?: string | undefined;
}): Readonly<Record<string, string>> {
  const accountFolder = withoutTrailingSeparators(input.accountFolder?.trim() ?? "");
  if (!accountFolder) return {};
  // Clients building the copyable command may not know the server's platform;
  // a Windows folder says so itself.
  const windows =
    input.platform === "win32" || (input.platform === undefined && accountFolder.includes("\\"));
  const separator = windows ? "\\" : "/";
  return { OPENCODE_DB: `${accountFolder}${separator}opencode.db` };
}

export function buildClaudeSetupTokenCommand(input: {
  readonly binaryPath: string;
  readonly homePath: string;
  readonly accountFolder?: string | undefined;
}): string {
  const binaryPath = input.binaryPath.trim() || "claude";
  return renderDisplayCommand({
    file: binaryPath,
    args: ["setup-token"],
    env: claudeAuthEnvironment(input),
  });
}

export function buildClaudeAuthLoginCommand(input: {
  readonly binaryPath: string;
  readonly homePath: string;
  readonly accountFolder?: string | undefined;
}): string {
  const binaryPath = input.binaryPath.trim() || "claude";
  return renderDisplayCommand({
    file: binaryPath,
    args: ["auth", "login"],
    env: claudeAuthEnvironment(input),
  });
}

export function buildCodexLoginCommand(input: {
  readonly binaryPath: string;
  readonly homePath: string;
  readonly shadowHomePath: string;
}): string {
  const binaryPath = input.binaryPath.trim() || "codex";
  const authHomePath = input.shadowHomePath.trim() || input.homePath.trim();
  const command = `${shellWord(binaryPath)} login`;
  return authHomePath ? `CODEX_HOME=${shellWord(authHomePath)} ${command}` : command;
}

/** `agent login` — Cursor's browser sign-in. */
export function buildCursorLoginCommand(input: { readonly binaryPath: string }): string {
  return `${shellWord(input.binaryPath.trim() || "agent")} login`;
}

/** `fx login` — Vercel AI Gateway sign-in (device/browser flow). */
export function buildFxLoginCommand(input: { readonly binaryPath: string }): string {
  return `${shellWord(input.binaryPath.trim() || "fx")} login`;
}

const OPENCODE_LOGIN_ARGS = ["auth", "login", "--standalone"] as const;

/**
 * `opencode auth login --standalone` — connects a model provider account to
 * OpenCode. `--standalone` signs in through a private server instead of
 * starting OpenCode's shared background service, which would outlive the
 * sign-in.
 */
export function buildOpenCodeLoginCommand(input: {
  readonly binaryPath: string;
  readonly accountFolder?: string | undefined;
  readonly platform?: string | undefined;
}): string {
  return renderDisplayCommand({
    file: input.binaryPath.trim() || "opencode",
    args: [...OPENCODE_LOGIN_ARGS],
    env: openCodeAccountEnvironment(input),
  });
}

/**
 * Resolve the executable, argv, and env overrides for one auth flow.
 * Returns `null` when the driver/flow pair has no supported command
 * (e.g. `claude-setup-token` on Codex, or an unknown fork driver).
 */
export function buildProviderAuthCommand(
  input: ProviderAuthCommandInput,
): ProviderAuthCommand | null {
  const binaryPath = input.binaryPath.trim();
  const homePath = input.homePath.trim();
  const shadowHomePath = input.shadowHomePath?.trim() ?? "";

  if (input.driver === CODEX_DRIVER_KIND) {
    if (input.flow !== "login") return null;
    const authHomePath = shadowHomePath || homePath;
    const env = authHomePath ? { CODEX_HOME: authHomePath } : {};
    const file = binaryPath || "codex";
    return {
      file,
      args: ["login"],
      env,
      display: renderDisplayCommand({ file, args: ["login"], env }),
    };
  }

  if (input.driver === CLAUDE_DRIVER_KIND) {
    const env = claudeAuthEnvironment({ homePath, accountFolder: input.accountFolder });
    const file = binaryPath || "claude";
    const args = input.flow === "claude-setup-token" ? ["setup-token"] : ["auth", "login"];
    return {
      file,
      args,
      env,
      display: renderDisplayCommand({ file, args, env }),
    };
  }

  // ACP providers sign in with their own CLI and keep credentials in the
  // user's home; nothing to override in the environment.
  if (input.driver === CURSOR_DRIVER_KIND || input.driver === FX_DRIVER_KIND) {
    if (input.flow !== "login") return null;
    const binary = binaryPath || (input.driver === CURSOR_DRIVER_KIND ? "agent" : "fx");
    if (input.driver === FX_DRIVER_KIND && input.platform === "win32") {
      const command = wslCommand(binary, ["login"]);
      return {
        file: command.file,
        args: command.args,
        env: {},
        display: `wsl -- ${bashWord(binary)} login`,
      };
    }
    return {
      file: binary,
      args: ["login"],
      env: {},
      display: renderDisplayCommand({ file: binary, args: ["login"], env: {} }),
    };
  }

  // OpenCode keeps model-provider credentials in its own store; the user
  // picks which provider to connect in the interactive prompt.
  if (input.driver === OPENCODE_DRIVER_KIND) {
    if (input.flow !== "login") return null;
    const file = binaryPath || "opencode";
    const args = [...OPENCODE_LOGIN_ARGS];
    const env = openCodeAccountEnvironment(input);
    return { file, args, env, display: renderDisplayCommand({ file, args, env }) };
  }

  return null;
}

/**
 * The command that signs an extra account out before its folder is deleted,
 * so no login is left behind outside it (Claude's macOS keychain item, a
 * Codex keyring entry). `null` where deleting the folder is the sign-out.
 */
export function buildProviderSignOutCommand(input: {
  readonly driver: string;
  readonly binaryPath: string;
  readonly homePath: string;
  readonly shadowHomePath?: string | undefined;
  readonly accountFolder?: string | undefined;
}): Omit<ProviderAuthCommand, "display"> | null {
  const binaryPath = input.binaryPath.trim();
  if (input.driver === CODEX_DRIVER_KIND) {
    const authHomePath = input.shadowHomePath?.trim() || input.homePath.trim();
    return {
      file: binaryPath || "codex",
      args: ["logout"],
      env: authHomePath ? { CODEX_HOME: authHomePath } : {},
    };
  }
  if (input.driver === CLAUDE_DRIVER_KIND) {
    return {
      file: binaryPath || "claude",
      args: ["auth", "logout"],
      env: claudeAuthEnvironment(input),
    };
  }
  return null;
}

export interface ClaudeLongLivedOAuthTokenState {
  readonly configured: boolean;
  readonly redacted: boolean;
  readonly value: string;
}

export function deriveClaudeLongLivedOAuthTokenState(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ClaudeLongLivedOAuthTokenState {
  const variable = environment.find((entry) => entry.name === CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV);
  if (!variable) {
    return { configured: false, redacted: false, value: "" };
  }
  const redacted = variable.valueRedacted === true;
  const value = redacted ? "" : variable.value;
  return {
    configured: redacted || value.trim().length > 0,
    redacted,
    value,
  };
}

export function sanitizeClaudeLongLivedOAuthTokenInput(value: string): string {
  const trimmed = value.trim();
  // Accept pastes of the whole `export CLAUDE_CODE_OAUTH_TOKEN=<token>` line.
  // Parsed without a regex: the obvious `\s*=\s*(.+)$` pattern is
  // polynomially backtracking on adversarial whitespace (CodeQL
  // js/polynomial-redos).
  let token = trimmed;
  const markerIndex = trimmed.lastIndexOf(CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV);
  const precededOk =
    markerIndex === 0 || (markerIndex > 0 && /\s/.test(trimmed[markerIndex - 1] ?? ""));
  if (markerIndex !== -1 && precededOk) {
    const rest = trimmed.slice(markerIndex + CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV.length);
    const equalsIndex = rest.indexOf("=");
    if (equalsIndex !== -1 && rest.slice(0, equalsIndex).trim().length === 0) {
      token = rest.slice(equalsIndex + 1).trim();
    }
  }
  return token
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\[nr]/g, "")
    .replace(/\s+/g, "");
}

export function upsertClaudeLongLivedOAuthTokenEnvironment(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  token: string,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  const trimmed = sanitizeClaudeLongLivedOAuthTokenInput(token);
  const nextEnvironment: ProviderInstanceEnvironmentVariable[] = [];
  let inserted = false;

  for (const variable of environment) {
    if (variable.name !== CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV) {
      nextEnvironment.push(variable);
      continue;
    }
    if (trimmed.length === 0 || inserted) {
      continue;
    }
    nextEnvironment.push({
      name: CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV,
      value: trimmed,
      sensitive: true,
      valueRedacted: false,
    });
    inserted = true;
  }

  if (trimmed.length > 0 && !inserted) {
    nextEnvironment.push({
      name: CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV,
      value: trimmed,
      sensitive: true,
      valueRedacted: false,
    });
  }

  return nextEnvironment;
}

export function removeClaudeLongLivedOAuthTokenEnvironment(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  return environment.filter((variable) => variable.name !== CLAUDE_LONG_LIVED_OAUTH_TOKEN_ENV);
}

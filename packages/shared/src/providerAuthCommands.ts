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

export const CODEX_DRIVER_KIND = "codex";
export const CLAUDE_DRIVER_KIND = "claudeAgent";

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
 * interactive sign-in; `claude-setup-token` mints a long-lived headless token.
 */
export type ProviderAuthFlow = "login" | "claude-setup-token";

export interface ProviderAuthCommandInput {
  readonly driver: string;
  readonly flow: ProviderAuthFlow;
  readonly binaryPath: string;
  readonly homePath: string;
  readonly shadowHomePath?: string;
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

export function buildClaudeSetupTokenCommand(input: {
  readonly binaryPath: string;
  readonly homePath: string;
}): string {
  const binaryPath = input.binaryPath.trim() || "claude";
  const homePath = input.homePath.trim();
  const command = `${shellWord(binaryPath)} setup-token`;
  return homePath ? `HOME=${shellWord(homePath)} ${command}` : command;
}

export function buildClaudeAuthLoginCommand(input: {
  readonly binaryPath: string;
  readonly homePath: string;
}): string {
  const binaryPath = input.binaryPath.trim() || "claude";
  const homePath = input.homePath.trim();
  const command = `${shellWord(binaryPath)} auth login`;
  return homePath ? `HOME=${shellWord(homePath)} ${command}` : command;
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
    const env = homePath ? { HOME: homePath } : {};
    const file = binaryPath || "claude";
    const args = input.flow === "claude-setup-token" ? ["setup-token"] : ["auth", "login"];
    return {
      file,
      args,
      env,
      display: renderDisplayCommand({ file, args, env }),
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
  const assignmentMatch = trimmed.match(/(?:^|\s)CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.+)$/u);
  const token = assignmentMatch?.[1]?.trim() ?? trimmed;
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

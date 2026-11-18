/**
 * The rules and words of agents' requests for keys
 * (docs/design/secret-requests.md): which names, files and values a use can
 * take, how an env file line is written, how a path is quoted for the shell,
 * and what the agent and the card say. Pure, so the server's checks and the
 * card agree. Nothing here keeps a value.
 */
import type {
  MessageId,
  OrchestrationSecretRequest,
  SecretRequestUse,
} from "@threadlines/contracts";

/** The most requests one agent may make in one turn. */
export const MAX_SECRET_REQUESTS_PER_TURN = 5;
/** The most cards waiting on one thread at once. */
export const MAX_WAITING_SECRET_REQUESTS = 5;
/** The longest reason an agent may give. */
export const MAX_SECRET_REASON_LENGTH = 200;
/** The longest value an env file line takes, in characters. */
export const MAX_ENV_SECRET_LENGTH = 8_192;
/** The largest value a `commands` file takes, in UTF-8 bytes. */
export const MAX_COMMANDS_SECRET_BYTES = 64 * 1024;
/** How long a `commands` file lives. */
export const COMMANDS_SECRET_TTL_MS = 24 * 60 * 60 * 1000;

/** A variable name: what the env line and the agent's note call the key. */
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Prefixes frameworks ship to the browser bundle: never a place for a secret. */
const BROWSER_EXPOSED_PREFIXES = [
  "VITE_",
  "NEXT_PUBLIC_",
  "NUXT_PUBLIC_",
  "PUBLIC_",
  "REACT_APP_",
  "EXPO_PUBLIC_",
  "GATSBY_",
] as const;

const TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist", ".defaults"] as const;

/** Why a name can't hold a key, or null. */
export function secretNameProblem(name: string): string | null {
  if (!SECRET_NAME_PATTERN.test(name)) {
    return "The name must be a variable name: letters, digits and underscores, not starting with a digit, at most 64 characters.";
  }
  const upper = name.toUpperCase();
  if (BROWSER_EXPOSED_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
    return "That name is sent to browsers by the framework, so it can't hold a secret.";
  }
  return null;
}

/** Why a reason can't go on the card, or null. */
export function secretReasonProblem(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return "Say why you need the key.";
  if (trimmed.length > MAX_SECRET_REASON_LENGTH) {
    return `Keep the reason to ${MAX_SECRET_REASON_LENGTH} characters.`;
  }
  return null;
}

/** The last segment of a relative path, either separator. */
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Why an env file path can't take a key, as far as its text says, or null.
 * The server then checks the real path, the file kind and git.
 */
export function envFilePathProblem(path: string): string | null {
  if (path.length === 0 || path.includes("\0")) return "Name an env file, like .env.local.";
  if (/^([\\/]|[A-Za-z]:)/.test(path)) {
    return "Give the env file's path relative to this thread's folder, like .env.local.";
  }
  const segments = path.split(/[\\/]/);
  if (segments.some((segment) => segment === "..")) {
    return "The env file must be inside this thread's folder.";
  }
  const name = baseName(path);
  const isEnv = name === ".env" || (name.startsWith(".env.") && name.length > ".env.".length);
  if (!isEnv && name !== ".dev.vars") {
    return "The file must be .env, .env.<something> or .dev.vars.";
  }
  if (TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    return `${name} is a template that is usually committed, so it can't hold a key. Use .env.local.`;
  }
  return null;
}

/** Why a use can't be asked for, from its text alone, or null. */
export function secretUseProblem(use: SecretRequestUse): string | null {
  return use.kind === "env_file" ? envFilePathProblem(use.path) : null;
}

// ---------------------------------------------------------------------------
// Values.

const BARE_ENV_VALUE = /^[A-Za-z0-9_\-./:+=@%,~]+$/;

/** A value a use takes, as written; or why it can't, for under the card's field. */
export type SecretValueCheck =
  | { readonly ok: true; readonly written: string }
  | { readonly ok: false; readonly detail: string };

const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

/**
 * Checks a typed value against its use. `written` is what lands: the env line's
 * right-hand side, or the `commands` file's content. Never trims.
 */
export function checkSecretValue(use: SecretRequestUse, value: string): SecretValueCheck {
  if (value.length === 0) return { ok: false, detail: "Type or paste the key first." };
  if (use.kind === "env_file") {
    if (value.length > MAX_ENV_SECRET_LENGTH) {
      return {
        ok: false,
        detail: `An env file line takes at most ${MAX_ENV_SECRET_LENGTH} characters.`,
      };
    }
    if (/[\r\n]/.test(value) || value.includes("'")) {
      return {
        ok: false,
        detail:
          "An env file can't hold this value as typed. Ask the agent to request it for its commands instead.",
      };
    }
    return { ok: true, written: BARE_ENV_VALUE.test(value) ? value : `'${value}'` };
  }
  const multiline = use.multiline === true;
  if (!multiline && /[\r\n]/.test(value)) {
    return {
      ok: false,
      detail: "This key has a line break. Remove it, or ask the agent to request a multi-line key.",
    };
  }
  const written = multiline ? value.replace(/\r\n?/g, "\n") : value;
  if (utf8Bytes(written) > MAX_COMMANDS_SECRET_BYTES) {
    return { ok: false, detail: "A key for commands can be at most 64 KB." };
  }
  return { ok: true, written };
}

/**
 * The field starts or ends with whitespace: the card offers to remove it,
 * never does it itself. A multi-line key's closing line breaks are its own
 * (a pasted PEM ends with one), so only spaces and tabs before them count.
 */
export const hasEdgeWhitespace = (value: string, multiline = false): boolean =>
  value.length > 0 && (multiline ? /^\s|[ \t](?:\r?\n)*$/ : /^\s|\s$/).test(value);

/** What Remove spaces leaves: the edges trimmed, a multi-line key's closing line breaks kept. */
export const withoutEdgeWhitespace = (value: string, multiline = false): string =>
  multiline ? value.replace(/^\s+/, "").replace(/[ \t]+((?:\r?\n)*)$/, "$1") : value.trim();

// ---------------------------------------------------------------------------
// Env files.

/** Where a name stands in an env file's text, or why Threadlines can't edit it safely. */
export type EnvFileScan =
  | { readonly ok: true; readonly line: number | null }
  | { readonly ok: false; readonly detail: string };

const ASSIGNMENT = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

/** Where `quote` closes in `text` from `start`, skipping `\\x` inside double quotes; -1 if it doesn't. */
function closingIndex(text: string, quote: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    if (quote === '"' && text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index;
  }
  return -1;
}

/** The quote a value opens and leaves open on its line, or null. */
function openQuote(rest: string): string | null {
  const value = rest.trimStart();
  const quote = value[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  return closingIndex(value, quote, 1) === -1 ? quote : null;
}

const splitLines = (text: string) => text.split(/\r?\n/);

/**
 * Finds the one line assigning `name`, skipping the inside of other values'
 * multi-line quotes. Refuses a name assigned twice, a name whose own value
 * spans lines, and a quote that never closes.
 */
export function scanEnvFile(text: string, name: string, path: string): EnvFileScan {
  const lines = splitLines(text);
  let open: string | null = null;
  let found: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (open !== null) {
      if (closingIndex(line, open, 0) !== -1) open = null;
      continue;
    }
    const match = ASSIGNMENT.exec(line);
    if (match === null) continue;
    const quote = openQuote(match[4] ?? "");
    if (match[3] === name) {
      if (found !== null) {
        return {
          ok: false,
          detail: `${path} sets ${name} more than once, so Threadlines can't tell which to replace. Leave one, then ask again.`,
        };
      }
      if (quote !== null) {
        return {
          ok: false,
          detail: `${name} in ${path} spans more than one line, so Threadlines can't replace it safely. Ask for it as a key for commands.`,
        };
      }
      found = index;
    }
    open = quote;
  }
  if (open !== null) {
    return {
      ok: false,
      detail: `${path} has a quote that never closes, so Threadlines can't edit it safely.`,
    };
  }
  return { ok: true, line: found };
}

/**
 * The env file's new text with `name` set to `written` (from checkSecretValue):
 * its one line replaced in place, keeping `export`, or a line appended. Keeps
 * the file's line endings.
 */
export function writeEnvLine(
  text: string,
  name: string,
  written: string,
  path: string,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly detail: string } {
  const scan = scanEnvFile(text, name, path);
  if (!scan.ok) return scan;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (scan.line === null) {
    const prefix = text.length === 0 || text.endsWith("\n") ? text : `${text}${eol}`;
    return { ok: true, text: `${prefix}${name}=${written}${eol}` };
  }
  const lines = text.split("\n");
  const original = lines[scan.line] ?? "";
  const carriage = original.endsWith("\r") ? "\r" : "";
  const match = ASSIGNMENT.exec(original.replace(/\r$/, ""));
  const indent = match?.[1] ?? "";
  const exported = match?.[2] ?? "";
  lines[scan.line] = `${indent}${exported}${name}=${written}${carriage}`;
  return { ok: true, text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Shell quoting.

/** A path quoted for a POSIX shell: always single quotes, so `$`, spaces and quotes stay literal. */
export const posixShellQuote = (path: string): string => `'${path.replaceAll("'", `'\\''`)}'`;

/** A path quoted for PowerShell. */
export const powerShellQuote = (path: string): string => `'${path.replaceAll("'", "''")}'`;

// ---------------------------------------------------------------------------
// The message that tells the asking agent, and the notes.

const SECRET_ANSWER_MESSAGE_PREFIX = "secret-answer:";

/** The message that tells the agent how its request ended: one per request. */
export const secretAnswerMessageId = (requestId: string): MessageId =>
  `${SECRET_ANSWER_MESSAGE_PREFIX}${requestId}` as MessageId;

/** The request a secret-answer message is about, or null for any other message. */
export function secretRequestIdOfAnswerMessage(messageId: string): string | null {
  if (!messageId.startsWith(SECRET_ANSWER_MESSAGE_PREFIX)) return null;
  const rest = messageId.slice(SECRET_ANSWER_MESSAGE_PREFIX.length);
  return rest.length > 0 ? rest : null;
}

/** Where the use puts the key, said for the agent. */
const useLabel = (use: SecretRequestUse) =>
  use.kind === "env_file" ? use.path : "a private file for your commands";

/** The agent's message for a saved `env_file` key. */
export const savedEnvFileMessage = (name: string, path: string): string =>
  `I saved ${name} to ${path}. Its value is not in this conversation. Don't read the file into the chat or print it.`;

/** The agent's message for a saved `commands` key: where it is and how to use it. */
export function savedCommandsMessage(input: {
  readonly name: string;
  readonly filePath: string;
  readonly expiresAt: string;
  readonly multiline: boolean;
  readonly windows: boolean;
}): string {
  const posix = posixShellQuote(input.filePath);
  const usage = input.multiline
    ? `Pass the file's path to the tool that needs it: ${posix}. Don't read it into a variable.`
    : [
        `Read it inside a command, like "$(cat ${posix})".`,
        input.windows
          ? `In PowerShell: (Get-Content -Raw ${powerShellQuote(input.filePath)}).`
          : undefined,
        "Never print it, and don't pass -v or -x to a command that uses it.",
      ]
        .filter((part): part is string => part !== undefined)
        .join(" ");
  return [
    `I saved ${input.name} for your commands in a private file. Its value is not in this conversation.`,
    usage,
    `It is removed at ${input.expiresAt}. If it is gone when you need it, ask again.`,
  ].join(" ");
}

const FAILED_SECRET_MESSAGE_START = "I tried to save ";

/** The agent's message when the save failed. */
export const failedSecretMessage = (name: string, detail: string): string =>
  `${FAILED_SECRET_MESSAGE_START}${name}, but nothing was saved. ${detail} Ask again if you still need it.`;

/** Whether a secret-answer message says the save failed: for a row whose request is long gone. */
export const isFailedSecretMessage = (text: string): boolean =>
  text.startsWith(FAILED_SECRET_MESSAGE_START);

/** The note for a settled request the agent wasn't messaged about, or null when it needn't hear. */
export function secretRequestNote(request: OrchestrationSecretRequest): string | null {
  const detail = request.detail !== undefined ? ` ${request.detail}` : "";
  switch (request.status) {
    case "declined":
      return `The user said no to your request for ${request.name}. Don't ask again or in chat. Say what is blocked and go on without it.`;
    case "cancelled":
      return `Your request for ${request.name} was cancelled before the user answered.${detail} The user did not say no; ask again if you still need it.`;
    case "uncertain":
      return (
        request.detail ??
        `Threadlines stopped while saving ${request.name}. Ask again if you need it.`
      );
    case "failed":
      return `Saving ${request.name} to ${useLabel(request.use)} failed.${detail}`;
    case "saved":
      return `The user saved ${request.name} to ${useLabel(request.use)}.`;
    case "replaced":
    case "waiting":
    case "claimed":
      return null;
  }
}

// ---------------------------------------------------------------------------
// The card's own lines: Threadlines says where the value goes, never the agent.

/** What the card says happens to the value, from the checked request. */
export function secretDestinationLines(
  request: Pick<OrchestrationSecretRequest, "name" | "use" | "replaces">,
  where: { readonly computerLabel: string; readonly removedAtLabel: string },
): { readonly replaces: string | null; readonly destination: string } {
  if (request.use.kind === "env_file") {
    return {
      replaces: request.replaces
        ? `Replaces the ${request.name} already in ${request.use.path}.`
        : null,
      destination: `Saved as ${request.name} in ${request.use.path}, in this thread's folder on ${where.computerLabel}. It stays out of the chat. The agent can read that file.`,
    };
  }
  return {
    replaces: null,
    destination: `Kept in a private file on ${where.computerLabel} until ${where.removedAtLabel}. It stays out of the chat. The agent can read it.`,
  };
}

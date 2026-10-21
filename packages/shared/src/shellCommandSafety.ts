/**
 * Decides how a chat button may hand a shell command to the user's terminal.
 *
 * Agents suggest commands in code blocks and through the `ask_user_to_run`
 * tool. A code block counts when it is fenced as the terminal's shell, or when
 * it names no shell but calls a known program in a way both shells read the
 * same. A command with no caution may run with one click; anything that
 * deletes, overwrites, publishes, reveals secrets, runs downloaded code, needs
 * filling in or spans lines only goes into the terminal for the user to press
 * Enter; a command with hidden characters never reaches the terminal at all.
 *
 * The command is read the way a shell reads it (quotes, pipes, `$(...)`,
 * redirects, heredocs), so `echo "rm -rf /"` is an echo, not a delete. This is
 * a speed bump with plain-English reasons, not a guarantee: a harmful command
 * can match no rule. Clients use it to pick the button; the server re-checks
 * every run against it.
 */

export type ShellDialect = "posix" | "powershell";

export type ShellCommandCautionKind =
  | "erases-disks"
  | "freezes"
  | "runs-downloaded-code"
  | "sends-secrets"
  | "destroys-data"
  | "deletes-files"
  | "discards-changes"
  | "rewrites-remote"
  | "deletes-git-history"
  | "admin"
  | "reveals-secrets"
  | "changes-permissions"
  | "changes-system"
  | "stops-processes"
  | "overwrites-files"
  | "publishes"
  | "placeholder"
  | "unreadable"
  | "multi-line";

export interface ShellCommandCaution {
  readonly kind: ShellCommandCautionKind;
  /** One short sentence for the user, e.g. "Throws away uncommitted changes." */
  readonly label: string;
  /** Warnings explain a risk; notes only explain why Enter is left to the user. */
  readonly tone: "warning" | "note";
}

export interface ShellCommandBlock {
  readonly kind: "hidden-characters" | "too-long";
  readonly label: string;
}

export type ShellCommandAction = "run" | "insert";

export interface ShellCommandAssessment {
  /** Set when the command may not go to a terminal at all. */
  readonly blocked: ShellCommandBlock | null;
  /** `run`: one click runs it. `insert`: it waits in the terminal for Enter. */
  readonly action: ShellCommandAction;
  /** Most serious first. */
  readonly cautions: ReadonlyArray<ShellCommandCaution>;
  readonly lineCount: number;
}

export interface PreparedShellCommand extends ShellCommandAssessment {
  /** What goes to the terminal: prompts, comment lines and blank lines removed. */
  readonly text: string;
}

export const MAX_SHELL_COMMAND_LENGTH = 8_000;
export const MAX_SHELL_COMMAND_LINES = 50;

const POSIX_FENCES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "ksh",
  "console",
  "shellsession",
  "shell-session",
  "sh-session",
  "bash-session",
  "terminal",
]);
const POWERSHELL_FENCES: ReadonlySet<string> = new Set(["powershell", "pwsh", "ps1", "ps", "posh"]);
/** Fences that show a session (prompt plus output) rather than a script. */
const SESSION_FENCES: ReadonlySet<string> = new Set([
  "console",
  "shellsession",
  "shell-session",
  "sh-session",
  "bash-session",
  "terminal",
]);

/** Fences that name no language; agents often put a command in one. */
const UNNAMED_FENCES: ReadonlySet<string> = new Set(["", "text", "txt", "plaintext", "plain"]);

const PROMPTS: Readonly<Record<ShellDialect, RegExp>> = {
  posix: /^\s*\$ /,
  powershell: /^\s*PS(?:\s[^>]*)?>\s/,
};
const ANY_PROMPT = /^\s*(?:\$ |PS(?:\s[^>]*)?>\s)/;

/** The dialect a code fence's language names, or null when it isn't a shell. */
export function shellDialectOfFence(language: string | null | undefined): ShellDialect | null {
  const normalized = language?.trim().toLowerCase() ?? "";
  if (POSIX_FENCES.has(normalized)) return "posix";
  if (POWERSHELL_FENCES.has(normalized)) return "powershell";
  return null;
}

// ---------------------------------------------------------------------------
// Commands both shells read the same way.
// ---------------------------------------------------------------------------

/**
 * Programs that take the same arguments from a POSIX shell and from
 * PowerShell. Shell built-ins and the names PowerShell gives its own cmdlets
 * (`ls`, `rm`, `cat`, `curl`, `cd`) are left out, because there the two
 * shells run different things.
 */
const PORTABLE_PROGRAMS: ReadonlySet<string> = new Set([
  "git",
  "gh",
  "glab",
  "node",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
  "deno",
  "corepack",
  "vp",
  "tsc",
  "tsx",
  "vite",
  "vitest",
  "turbo",
  "nx",
  "python",
  "python3",
  "py",
  "pip",
  "pip3",
  "pipx",
  "uv",
  "uvx",
  "poetry",
  "pytest",
  "ruff",
  "cargo",
  "rustup",
  "go",
  "dotnet",
  "mvn",
  "gradle",
  "composer",
  "php",
  "ruby",
  "gem",
  "bundle",
  "rails",
  "mix",
  "flutter",
  "dart",
  "docker",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "aws",
  "az",
  "gcloud",
  "firebase",
  "vercel",
  "netlify",
  "wrangler",
  "supabase",
  "fly",
  "flyctl",
  "heroku",
  "claude",
  "codex",
  "code",
  "cursor",
]);

/** A plain word: can't start with `@` (PowerShell splatting) or hold `=`. */
const PORTABLE_PLAIN = /^[\w./:+][\w./:+@-]*$/;
/**
 * An option: no `.` or `:` (PowerShell splits `-Dfoo.bar` and reads
 * `-name:value`), and not a bare `--`, which PowerShell drops before a
 * `.ps1` shim like npm's sees it. `--name=value` keeps its `=`: split there,
 * it still reads as `--name value`.
 */
const PORTABLE_OPTION = /^-(?!-$)[\w+=/@-]*$/;
/**
 * A quoted string: only letters, digits, spaces and `./:+=@#,-`, never
 * starting with `-` (PowerShell still reads `'--%'`), never empty (Windows
 * PowerShell drops an empty argument).
 */
const PORTABLE_QUOTED = /^(?:'(?!-)[\w ./:+=@#,-]+'|"(?!-)[\w ./:+=@#,'-]+")$/;

/**
 * An argument both shells pass on unchanged. On Windows many of these
 * programs start through a `.cmd` launcher, so cmd.exe reads the arguments
 * too: no word may hold anything it acts on (`&|<>^%()!`). PowerShell quotes a
 * string for the launcher only when it holds a space, and a launcher reading
 * its arguments one by one splits an unquoted word at `=` and `,`.
 */
function isPortableWord(word: string): boolean {
  if (PORTABLE_PLAIN.test(word) || PORTABLE_OPTION.test(word)) return true;
  return PORTABLE_QUOTED.test(word) && (word.includes(" ") || !/[=,]/.test(word));
}

/**
 * Whether a command means the same in a POSIX shell and in PowerShell: each
 * line calls a known program with plain arguments, and nothing on it is
 * syntax (pipes, `&&`, redirects, variables, globs, escapes) either shell
 * reads its own way. Only printable ASCII, since PowerShell also reads curly
 * quotes and long dashes as syntax.
 */
function isPortableCommand(text: string): boolean {
  if (!/^[\x20-\x7e\n]*$/.test(text)) return false;
  return text.split("\n").every((line) => {
    // A word, then the spaces after it or the end of the line: a quote glued
    // to a word, or one left open, stops the scan.
    const token = /('[^']*'|"[^"]*"|[^\s'"]+)(?: +|$)/y;
    const trimmed = line.trim();
    const words: string[] = [];
    while (token.lastIndex < trimmed.length) {
      const match = token.exec(trimmed);
      if (match === null) return false;
      words.push(match[1]!);
    }
    return words.length > 0 && PORTABLE_PROGRAMS.has(words[0]!) && words.every(isPortableWord);
  });
}

// ---------------------------------------------------------------------------
// Hidden characters: anything that can make what runs differ from what shows.
// ---------------------------------------------------------------------------

function isHiddenCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a) return false;
  if (codePoint < 0x20 || codePoint === 0x7f) return true; // C0 controls, DEL (incl. ESC, CR)
  if (codePoint >= 0x80 && codePoint <= 0x9f) return true; // C1 controls
  if (codePoint === 0x00ad || codePoint === 0x061c || codePoint === 0x180e) return true;
  if (codePoint >= 0x200b && codePoint <= 0x200f) return true; // zero-width, LRM, RLM
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true; // bidi embeddings, overrides
  if (codePoint >= 0x2060 && codePoint <= 0x206f) return true; // word joiner, bidi isolates
  if (codePoint === 0xfeff) return true; // BOM / zero-width no-break space
  if (codePoint >= 0xfff9 && codePoint <= 0xfffb) return true; // interlinear annotations
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return true; // tag characters
  return false;
}

/** `U+202E`-style names of the hidden characters in the text, deduplicated. */
export function findHiddenCharacters(text: string): string[] {
  const found = new Set<string>();
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (isHiddenCodePoint(codePoint)) {
      found.add(`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Lexer: simple commands, pipelines, redirects, substitutions, line starts.
// ---------------------------------------------------------------------------

interface Redirect {
  readonly op: string;
  readonly target: string;
}

interface SimpleCommand {
  readonly words: string[];
  readonly redirects: Redirect[];
  /** Index of the pipeline this command belongs to. */
  readonly pipeline: number;
  /** Its position in that pipeline (0 = first stage). */
  readonly stage: number;
}

interface LexResult {
  readonly commands: SimpleCommand[];
  /** Inner text of `$(...)`, backticks, `<(...)` and `>(...)`, in order. */
  readonly substitutions: string[];
  readonly heredocBodies: string[];
  readonly unterminated: boolean;
  /** Per line: whether a `#` there would start a comment (top level, not in a heredoc). */
  readonly lineStartsTopLevel: boolean[];
}

const REDIRECT_OPS = [
  ">>|",
  "&>>",
  "<<<",
  "<<-",
  ">>",
  ">|",
  "&>",
  ">&",
  "<&",
  "<<",
  "<>",
  ">",
  "<",
];

/** Index just past the `)` closing a `$(`/`<(` group starting at `start` (after the paren). */
function findClosingParen(text: string, start: number): number | null {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function findClosingBacktick(text: string, start: number): number | null {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "`") return index + 1;
  }
  return null;
}

function findClosingBrace(text: string, start: number): number | null {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function lexShell(text: string, dialect: ShellDialect): LexResult {
  const commands: SimpleCommand[] = [];
  const substitutions: string[] = [];
  const heredocBodies: string[] = [];
  const lineStartsTopLevel: boolean[] = [true];
  let unterminated = false;

  let words: string[] = [];
  let redirects: Redirect[] = [];
  let word = "";
  let inWord = false;
  let pendingRedirect: string | null = null;
  let pipeline = 0;
  let stage = 0;
  const pendingHeredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
  // PowerShell escapes with a backtick; POSIX uses it for substitution.
  const escapeChar = dialect === "powershell" ? "`" : "\\";

  const finishWord = () => {
    if (!inWord) return;
    if (pendingRedirect !== null) {
      if (pendingRedirect === "<<" || pendingRedirect === "<<-") {
        pendingHeredocs.push({
          delimiter: word.replace(/["']/g, ""),
          stripTabs: pendingRedirect === "<<-",
        });
      }
      redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else if (!(words.length === 0 && word === "!")) {
      words.push(word);
    }
    word = "";
    inWord = false;
  };
  const finishCommand = (next: "pipe" | "list") => {
    finishWord();
    if (words.length > 0 || redirects.length > 0) {
      commands.push({ words, redirects, pipeline, stage });
    }
    words = [];
    redirects = [];
    pendingRedirect = null;
    if (next === "pipe") {
      stage += 1;
    } else {
      pipeline += 1;
      stage = 0;
    }
  };
  /** Lines that start inside a quote, substitution or continuation hold no comments. */
  const continueLinesIn = (segment: string) => {
    for (const char of segment) {
      if (char === "\n") lineStartsTopLevel.push(false);
    }
  };
  const addSubstitution = (start: number, closeIndex: number | null, innerStart: number) => {
    if (closeIndex === null) {
      unterminated = true;
      substitutions.push(text.slice(innerStart));
      continueLinesIn(text.slice(innerStart));
      return text.length;
    }
    substitutions.push(text.slice(innerStart, closeIndex - 1));
    continueLinesIn(text.slice(start, closeIndex));
    word += text.slice(start, closeIndex);
    inWord = true;
    return closeIndex;
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index]!;

    // Comments: `#` at the start of a word runs to the end of the line.
    if (char === "#" && !inWord) {
      const lineEnd = text.indexOf("\n", index);
      index = lineEnd === -1 ? text.length : lineEnd;
      continue;
    }

    if (char === escapeChar) {
      const next = text[index + 1];
      if (next === "\n") {
        // A line continuation: the next line belongs to this command.
        lineStartsTopLevel.push(false);
        index += 2;
        continue;
      }
      if (next !== undefined) {
        word += next;
        inWord = true;
      }
      index += 2;
      continue;
    }

    if (char === "'") {
      const close = text.indexOf("'", index + 1);
      if (close === -1) {
        unterminated = true;
        word += text.slice(index + 1);
        inWord = true;
        index = text.length;
        continue;
      }
      const quoted = text.slice(index + 1, close);
      continueLinesIn(quoted);
      word += quoted;
      inWord = true;
      index = close + 1;
      continue;
    }

    if (char === '"') {
      let cursor = index + 1;
      let closed = false;
      inWord = true;
      while (cursor < text.length) {
        const inner = text[cursor]!;
        if (inner === escapeChar) {
          const next = text[cursor + 1];
          if (next === "\n") lineStartsTopLevel.push(false);
          if (next !== undefined) word += next;
          cursor += 2;
          continue;
        }
        if (inner === '"') {
          closed = true;
          cursor += 1;
          break;
        }
        if (inner === "$" && text[cursor + 1] === "(") {
          cursor = addSubstitution(cursor, findClosingParen(text, cursor + 2), cursor + 2);
          continue;
        }
        if (inner === "`" && dialect === "posix") {
          cursor = addSubstitution(cursor, findClosingBacktick(text, cursor + 1), cursor + 1);
          continue;
        }
        if (inner === "\n") lineStartsTopLevel.push(false);
        word += inner;
        cursor += 1;
      }
      if (!closed) unterminated = true;
      index = cursor;
      continue;
    }

    if (char === "$" && text[index + 1] === "(") {
      index = addSubstitution(index, findClosingParen(text, index + 2), index + 2);
      continue;
    }
    if (char === "$" && text[index + 1] === "{") {
      const close = findClosingBrace(text, index + 2);
      if (close === null) {
        unterminated = true;
        continueLinesIn(text.slice(index));
        index = text.length;
        continue;
      }
      continueLinesIn(text.slice(index, close));
      word += text.slice(index, close);
      inWord = true;
      index = close;
      continue;
    }
    if (char === "`" && dialect === "posix") {
      index = addSubstitution(index, findClosingBacktick(text, index + 1), index + 1);
      continue;
    }
    if ((char === "<" || char === ">") && text[index + 1] === "(" && !inWord) {
      index = addSubstitution(index, findClosingParen(text, index + 2), index + 2);
      continue;
    }

    if (char === "\n") {
      finishCommand("list");
      index += 1;
      // Heredoc bodies follow the line that opened them.
      while (pendingHeredocs.length > 0) {
        const heredoc = pendingHeredocs.shift()!;
        const bodyLines: string[] = [];
        let closed = false;
        while (index < text.length) {
          const lineEnd = text.indexOf("\n", index);
          const line = text.slice(index, lineEnd === -1 ? text.length : lineEnd);
          index = lineEnd === -1 ? text.length : lineEnd + 1;
          lineStartsTopLevel.push(false);
          const compared = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
          if (compared === heredoc.delimiter) {
            closed = true;
            break;
          }
          bodyLines.push(line);
        }
        if (!closed) unterminated = true;
        heredocBodies.push(bodyLines.join("\n"));
      }
      if (index <= text.length) lineStartsTopLevel.push(true);
      continue;
    }

    if (char === " " || char === "\t") {
      finishWord();
      index += 1;
      continue;
    }

    // Groups and script blocks: `{ cmd; }`, PowerShell's `ForEach-Object { … }`.
    if (
      (char === "{" || char === "}") &&
      !inWord &&
      (dialect === "powershell" || /^[\s;]?$/.test(text[index + 1] ?? ""))
    ) {
      finishCommand("list");
      index += 1;
      continue;
    }
    if (char === "}" && dialect === "powershell") {
      finishCommand("list");
      index += 1;
      continue;
    }

    if (char === ";" || char === "(" || char === ")") {
      finishCommand("list");
      index += 1;
      continue;
    }
    if (char === "&" && text[index + 1] === "&") {
      finishCommand("list");
      index += 2;
      continue;
    }
    if (char === "|" && text[index + 1] === "|") {
      finishCommand("list");
      index += 2;
      continue;
    }
    if (char === "|") {
      finishCommand("pipe");
      index += text[index + 1] === "&" ? 2 : 1;
      continue;
    }

    // Redirects: an optional fd number glued to the operator, then a target.
    const fdMatch = !inWord || /^\d+$/.test(word) ? /^\d*/.exec(text.slice(index))![0] : "";
    const afterFd = index + fdMatch.length;
    const op = REDIRECT_OPS.find((candidate) => text.startsWith(candidate, afterFd));
    if (
      op !== undefined &&
      (fdMatch.length > 0 || char === "<" || char === ">" || char === "&") &&
      !(op === "&>" && inWord && fdMatch.length === 0)
    ) {
      if (inWord && /^\d+$/.test(word)) {
        word = "";
        inWord = false;
      } else {
        finishWord();
      }
      if (op === ">&" || op === "<&") {
        // `2>&1` duplicates a descriptor; anything else is a file.
        const target = /^[0-9-]+/.exec(text.slice(afterFd + op.length))?.[0];
        if (target !== undefined) {
          index = afterFd + op.length + target.length;
          continue;
        }
      }
      pendingRedirect = op;
      index = afterFd + op.length;
      continue;
    }

    if (char === "&") {
      // A trailing `&` puts the command in the background.
      finishCommand("list");
      index += 1;
      continue;
    }

    word += char;
    inWord = true;
    index += 1;
  }
  finishCommand("list");
  if (pendingHeredocs.length > 0) unterminated = true;

  return { commands, substitutions, heredocBodies, unterminated, lineStartsTopLevel };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const CAUTION_ORDER: ReadonlyArray<ShellCommandCautionKind> = [
  "erases-disks",
  "freezes",
  "runs-downloaded-code",
  "sends-secrets",
  "destroys-data",
  "deletes-files",
  "discards-changes",
  "rewrites-remote",
  "deletes-git-history",
  "admin",
  "reveals-secrets",
  "changes-permissions",
  "changes-system",
  "stops-processes",
  "overwrites-files",
  "publishes",
  "placeholder",
  "unreadable",
  "multi-line",
];

const NOTE_KINDS: ReadonlySet<ShellCommandCautionKind> = new Set([
  "placeholder",
  "unreadable",
  "multi-line",
]);

/** Reserved words that precede the command they introduce. */
const SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
]);

/** Commands that run the rest of their words as a command. */
const PASS_THROUGH_WRAPPERS: ReadonlySet<string> = new Set([
  "builtin",
  "caffeinate",
  "command",
  "env",
  "exec",
  "nice",
  "nohup",
  "time",
  "timeout",
  "xargs",
  "npx",
  "bunx",
  "pnpx",
]);
const ADMIN_WRAPPERS: ReadonlySet<string> = new Set(["sudo", "doas", "pkexec", "gsudo", "runas"]);
/** Wrapper options that take a value, so the value isn't read as the command. */
const WRAPPER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-u",
  "-g",
  "-p",
  "-C",
  "-D",
  "-h",
  "-r",
  "-t",
  "-U",
  "-T",
  "-n",
  "-I",
  "-L",
  "-P",
  "-d",
  "-s",
  "-E",
  "-a",
  "-S",
  "--user",
  "--group",
  "--prompt",
  "--chdir",
]);

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const POWERSHELLS: ReadonlySet<string> = new Set(["pwsh", "powershell"]);
const INTERPRETERS: ReadonlySet<string> = new Set([
  ...SHELLS,
  ...POWERSHELLS,
  "python",
  "python2",
  "python3",
  "node",
  "deno",
  "bun",
  "perl",
  "ruby",
  "php",
  "osascript",
  "iex",
  "invoke-expression",
  "source",
  ".",
  "eval",
]);
const FETCHERS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "iwr",
  "invoke-webrequest",
  "irm",
  "invoke-restmethod",
  "http",
  "https",
  "xh",
  "aria2c",
]);
const DECODERS: ReadonlySet<string> = new Set(["base64", "xxd", "openssl", "gunzip", "zcat"]);
const NETWORK_SENDERS: ReadonlySet<string> = new Set([
  ...FETCHERS,
  "scp",
  "sftp",
  "ftp",
  "rsync",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "telnet",
]);
const PRINTERS: ReadonlySet<string> = new Set([
  "echo",
  "printf",
  "print",
  "write-host",
  "write-output",
]);
const FILE_READERS: ReadonlySet<string> = new Set([
  "cat",
  "bat",
  "less",
  "more",
  "head",
  "tail",
  "type",
  "gc",
  "get-content",
  "strings",
  "xxd",
  "base64",
]);
const DATABASE_CLIENTS: ReadonlySet<string> = new Set([
  "psql",
  "mysql",
  "mariadb",
  "sqlite3",
  "sqlcmd",
  "mongosh",
  "mongo",
  "duckdb",
  "clickhouse",
  "clickhouse-client",
  "cockroach",
  "turso",
]);

const SENSITIVE_PATH =
  /(?:^|[/\\@:=])(?:\.ssh(?:[/\\]|$)|id_(?:rsa|dsa|ecdsa|ed25519)\b|\.aws(?:[/\\]|$)|\.kube[/\\]config|\.docker[/\\]config\.json|\.gnupg(?:[/\\]|$)|\.npmrc$|\.netrc$|\.pypirc$|\.pgpass$|\.git-credentials$|credentials(?:\.json)?$|\.env(?:\.(?!example|sample|template|dist)[\w.-]+)?$|[\w.-]+\.(?:pem|key|p12|pfx)$|keychain)/i;
const SENSITIVE_VARIABLE =
  /\$(?:\{|env:)?[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Za-z0-9_]*\}?/i;
const SQL_DESTRUCTIVE =
  /\b(?:drop\s+(?:database|schema|table|index|view|user|role|collection)\b|truncate\s+(?:table\s+)?["'`\w]|delete\s+from\s+[\w."'`]+\s*;?\s*$|dropDatabase\s*\()/im;
const PLACEHOLDER =
  /<[A-Za-z][\w.-]*>|\bYOUR_[A-Z0-9_]+\b|\{\{\s*[\w.-]+\s*\}\}|\[(?:your|my)[ _-][^\]\n]+\]/;
/** Where writing loses nothing: the null device and the terminal's own streams. */
const HARMLESS_TARGET = /^(?:\/dev\/(?:null|stdout|stderr|tty)|\$null|nul)$/i;
const FORK_BOMB = /([\w:.]+)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*\1\s*&/;

function commandBasename(word: string): string {
  const base = word.replace(/\\/g, "/").split("/").pop() ?? word;
  return base.replace(/\.(?:exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function hasFlag(args: ReadonlyArray<string>, ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

/** `-rf` contains `r`: short flags bundled in one word. */
function hasShortFlag(args: ReadonlyArray<string>, letter: string): boolean {
  return args.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.includes(letter));
}

interface Finder {
  add(kind: ShellCommandCautionKind, label: string): void;
}

/** `git` subcommand and its arguments, after global options such as `-C path`. */
function gitInvocation(args: ReadonlyArray<string>): { sub: string; rest: string[] } | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return { sub: arg.toLowerCase(), rest: args.slice(index + 1) };
  }
  return null;
}

function checkGit(args: ReadonlyArray<string>, find: Finder): void {
  const invocation = gitInvocation(args);
  if (!invocation) return;
  const { sub, rest } = invocation;
  const discard = () => find.add("discards-changes", "Throws away uncommitted changes.");
  switch (sub) {
    case "reset":
      if (hasFlag(rest, "--hard", "--merge")) discard();
      return;
    case "clean":
      if (!hasFlag(rest, "-n", "--dry-run") && !hasShortFlag(rest, "n")) discard();
      return;
    case "checkout":
      if (
        hasFlag(rest, "--", ".", "-f", "--force", "--ours", "--theirs", "-p", "--patch") ||
        hasShortFlag(rest, "f")
      ) {
        discard();
      }
      return;
    case "restore": {
      const staged = hasFlag(rest, "--staged", "-S");
      const worktree = hasFlag(rest, "--worktree", "-W");
      if (!staged || worktree) discard();
      return;
    }
    case "switch":
      if (hasFlag(rest, "-f", "--force", "--discard-changes")) discard();
      return;
    case "stash":
      if (rest[0] === "drop" || rest[0] === "clear") {
        find.add("discards-changes", "Deletes saved changes from the stash.");
      }
      return;
    case "rm":
      if (!hasFlag(rest, "--cached")) find.add("deletes-files", "Deletes files.");
      return;
    case "branch":
      if (
        hasFlag(rest, "-D") ||
        ((hasFlag(rest, "-d", "--delete") || hasShortFlag(rest, "d")) &&
          hasFlag(rest, "-f", "--force"))
      ) {
        find.add("deletes-git-history", "Deletes a branch.");
      }
      return;
    case "tag":
      if (hasFlag(rest, "-d", "--delete")) find.add("deletes-git-history", "Deletes a tag.");
      return;
    case "push": {
      const forced =
        hasFlag(
          rest,
          "-f",
          "--force",
          "--force-with-lease",
          "--force-if-includes",
          "--mirror",
          "--delete",
          "-d",
          "--prune",
        ) ||
        rest.some((arg) => arg.startsWith("--force-with-lease=")) ||
        rest.some((arg) => !arg.startsWith("-") && (arg.startsWith("+") || arg.startsWith(":")));
      if (forced) {
        find.add("rewrites-remote", "Changes or deletes history on the remote.");
      } else {
        find.add("publishes", "Pushes your commits to the remote.");
      }
      return;
    }
    case "reflog":
      if (rest[0] === "expire" || rest[0] === "delete") {
        find.add("deletes-git-history", "Deletes history git keeps for recovery.");
      }
      return;
    case "gc":
      if (rest.some((arg) => arg.startsWith("--prune"))) {
        find.add("deletes-git-history", "Deletes history git keeps for recovery.");
      }
      return;
    case "filter-branch":
    case "filter-repo":
      find.add("deletes-git-history", "Rewrites the whole history of the repository.");
      return;
    case "update-ref":
      if (hasFlag(rest, "-d")) find.add("deletes-git-history", "Deletes a branch or ref.");
      return;
    case "worktree":
      if (rest[0] === "remove" || rest[0] === "prune") {
        find.add("deletes-files", "Deletes a worktree folder.");
      }
      return;
    default:
      return;
  }
}

const GH_WRITE_ACTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  pr: new Set(["create", "merge", "close", "reopen", "comment", "review", "edit", "ready", "lock"]),
  issue: new Set(["create", "close", "reopen", "comment", "edit", "delete", "transfer", "lock"]),
  release: new Set(["create", "delete", "edit", "upload", "delete-asset"]),
  repo: new Set(["create", "rename", "archive", "edit", "unarchive", "set-default"]),
  workflow: new Set(["run", "enable", "disable"]),
  run: new Set(["cancel", "rerun", "delete"]),
  secret: new Set(["set", "delete", "remove"]),
  variable: new Set(["set", "delete"]),
  label: new Set(["create", "delete", "edit", "clone"]),
  gist: new Set(["create", "delete", "edit"]),
  cache: new Set(["delete"]),
};

function checkGh(args: ReadonlyArray<string>, find: Finder): void {
  const [group, action] = args.filter((arg) => !arg.startsWith("-"));
  if (group === "auth" && action === "token") {
    find.add("reveals-secrets", "Shows a secret, like a token or password.");
    return;
  }
  if (group === "auth" && action === "status" && hasFlag(args, "--show-token", "-t")) {
    find.add("reveals-secrets", "Shows a secret, like a token or password.");
    return;
  }
  if (group === "repo" && action === "delete") {
    find.add("destroys-data", "Deletes a GitHub repository.");
    return;
  }
  if (group === "api") {
    const methodIndex = args.findIndex((arg) => arg === "-X" || arg === "--method");
    const method = methodIndex >= 0 ? args[methodIndex + 1]?.toUpperCase() : undefined;
    const writes =
      (method !== undefined && method !== "GET") ||
      hasFlag(args, "-f", "-F", "--field", "--raw-field", "--input");
    if (writes) find.add("publishes", "Changes things on GitHub.");
    return;
  }
  if (group !== undefined && action !== undefined && GH_WRITE_ACTIONS[group]?.has(action)) {
    find.add("publishes", "Changes things on GitHub.");
  }
}

function checkCommand(
  name: string,
  args: ReadonlyArray<string>,
  redirects: ReadonlyArray<Redirect>,
  find: Finder,
): void {
  const lowerArgs = args.map((arg) => arg.toLowerCase());
  const deleteFiles = () => find.add("deletes-files", "Deletes files.");

  for (const redirect of redirects) {
    if (
      (redirect.op === ">" || redirect.op === ">|" || redirect.op === "&>") &&
      !HARMLESS_TARGET.test(redirect.target)
    ) {
      find.add("overwrites-files", "Overwrites a file.");
    }
  }

  switch (name) {
    case "rm":
    case "rmdir":
    case "unlink":
    case "shred":
    case "srm":
    case "del":
    case "erase":
    case "rd":
    case "remove-item":
    case "ri":
    case "rimraf":
      deleteFiles();
      return;
    case "find":
      if (
        hasFlag(lowerArgs, "-delete") ||
        lowerArgs.some(
          (arg, index) =>
            (arg === "-exec" || arg === "-execdir" || arg === "-ok") &&
            ["rm", "shred", "unlink"].includes(commandBasename(args[index + 1] ?? "")),
        )
      ) {
        deleteFiles();
      }
      return;
    case "rsync":
      if (lowerArgs.some((arg) => arg.startsWith("--delete") || arg === "--remove-source-files")) {
        deleteFiles();
      }
      break;
    case "cp":
    case "mv":
    case "copy-item":
    case "move-item":
    case "cpi":
    case "mi":
      if (!hasFlag(args, "-n", "--no-clobber", "-i", "--interactive") && !hasShortFlag(args, "n")) {
        find.add("overwrites-files", "Can replace existing files.");
      }
      return;
    case "ln":
      if (hasFlag(args, "-f", "--force") || hasShortFlag(args, "f")) {
        find.add("overwrites-files", "Can replace existing files.");
      }
      return;
    case "tee":
      if (
        !hasFlag(args, "-a", "--append") &&
        args.some((arg) => !arg.startsWith("-") && !HARMLESS_TARGET.test(arg))
      ) {
        find.add("overwrites-files", "Overwrites a file.");
      }
      return;
    case "truncate":
    case "clear-content":
    case "set-content":
    case "out-file":
      find.add("overwrites-files", "Overwrites a file.");
      return;
    case "sed":
    case "perl":
      if (args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith("--in-place"))) {
        find.add("overwrites-files", "Edits files in place.");
      }
      break;
    case "git":
      checkGit(args, find);
      return;
    case "gh":
      checkGh(args, find);
      return;
    case "su":
      find.add("admin", "Runs as administrator.");
      return;
    case "start-process":
      if (lowerArgs.includes("runas")) find.add("admin", "Runs as administrator.");
      return;
    case "dd":
      if (lowerArgs.some((arg) => arg.startsWith("of=/dev/") || arg.startsWith("of=\\\\.\\"))) {
        find.add("erases-disks", "Can erase a disk.");
      } else if (lowerArgs.some((arg) => arg.startsWith("of="))) {
        find.add("overwrites-files", "Overwrites a file.");
      }
      return;
    case "fdisk":
    case "sfdisk":
    case "gdisk":
    case "parted":
    case "wipefs":
    case "diskpart":
    case "format-volume":
    case "clear-disk":
    case "initialize-disk":
      find.add("erases-disks", "Can erase a disk.");
      return;
    case "format":
      if (args.some((arg) => /^[A-Za-z]:$/.test(arg)))
        find.add("erases-disks", "Can erase a disk.");
      return;
    case "diskutil":
      if (
        lowerArgs.some((arg) =>
          /^(?:erase\w*|zerodisk|randomdisk|secureerase|partitiondisk|reformat|deletecontainer|deletevolume)$/.test(
            arg,
          ),
        )
      ) {
        find.add("erases-disks", "Can erase a disk.");
      }
      return;
    case "chmod":
    case "chown":
    case "chgrp":
    case "setfacl":
      if (
        hasFlag(args, "-R", "--recursive") ||
        hasShortFlag(args, "R") ||
        (name === "chmod" && args.some((arg) => /^(?:0?777|a\+rwx|o\+w)$/.test(arg)))
      ) {
        find.add("changes-permissions", "Changes who can read or change files.");
      }
      return;
    case "icacls":
    case "takeown":
      find.add("changes-permissions", "Changes who can read or change files.");
      return;
    case "kill":
    case "killall":
    case "pkill":
    case "taskkill":
    case "stop-process":
    case "spps":
    case "xkill":
      find.add("stops-processes", "Stops running programs.");
      return;
    case "shutdown":
    case "reboot":
    case "halt":
    case "poweroff":
    case "restart-computer":
    case "stop-computer":
    case "csrutil":
    case "spctl":
    case "nvram":
    case "bcdedit":
    case "set-executionpolicy":
    case "networksetup":
    case "pmset":
      find.add("changes-system", "Changes system settings or services.");
      return;
    case "systemctl":
    case "launchctl":
    case "service":
      if (
        lowerArgs.some((arg) =>
          /^(?:stop|disable|mask|restart|kill|poweroff|reboot|unload|remove|bootout|halt)$/.test(
            arg,
          ),
        )
      ) {
        find.add("changes-system", "Changes system settings or services.");
      }
      return;
    case "crontab":
      if (hasFlag(args, "-r")) find.add("changes-system", "Deletes your scheduled jobs.");
      return;
    case "defaults":
      if (lowerArgs[0] === "delete")
        find.add("changes-system", "Changes system settings or services.");
      return;
    case "reg":
      if (["delete", "add", "import"].includes(lowerArgs[0] ?? "")) {
        find.add("changes-system", "Changes system settings or services.");
      }
      return;
    case "sysctl":
      if (hasFlag(args, "-w")) find.add("changes-system", "Changes system settings or services.");
      return;
    case "scutil":
      if (hasFlag(args, "--set"))
        find.add("changes-system", "Changes system settings or services.");
      return;
    case "xattr":
      if (
        hasFlag(args, "-d", "-c", "-cr", "-rc", "-dr", "-rd") &&
        args.some(
          (arg) => /quarantine/i.test(arg) || arg === "-c" || arg === "-cr" || arg === "-rc",
        )
      ) {
        find.add("changes-system", "Turns off a macOS safety check for downloaded apps.");
      }
      return;
    case "tmutil":
      if (lowerArgs[0] === "delete") find.add("destroys-data", "Deletes backups.");
      return;
    case "dropdb":
    case "dropuser":
      find.add("destroys-data", "Deletes a database or its data.");
      return;
    case "redis-cli":
      if (lowerArgs.some((arg) => arg === "flushall" || arg === "flushdb")) {
        find.add("destroys-data", "Deletes a database or its data.");
      }
      return;
    case "docker":
    case "podman": {
      const [first, second] = lowerArgs.filter((arg) => !arg.startsWith("-"));
      if (
        second === "prune" ||
        first === "rm" ||
        first === "rmi" ||
        ((first === "volume" ||
          first === "container" ||
          first === "image" ||
          first === "network") &&
          (second === "rm" || second === "remove")) ||
        (first === "compose" && second === "down" && hasFlag(lowerArgs, "-v", "--volumes", "--rmi"))
      ) {
        find.add("destroys-data", "Deletes Docker containers, images or data.");
      } else if (first === "push") {
        find.add("publishes", "Publishes or deploys something.");
      }
      return;
    }
    case "kubectl":
      if (lowerArgs.includes("delete")) find.add("destroys-data", "Deletes cloud resources.");
      return;
    case "helm":
      if (lowerArgs[0] === "uninstall" || lowerArgs[0] === "delete") {
        find.add("destroys-data", "Deletes cloud resources.");
      } else if (lowerArgs[0] === "push") {
        find.add("publishes", "Publishes or deploys something.");
      }
      return;
    case "terraform":
    case "tofu":
    case "pulumi":
      if (lowerArgs.includes("destroy") || hasFlag(lowerArgs, "-destroy")) {
        find.add("destroys-data", "Deletes cloud resources.");
      } else if (lowerArgs.includes("apply") || lowerArgs.includes("up")) {
        find.add("publishes", "Changes cloud resources.");
      }
      return;
    case "supabase":
      if (lowerArgs.includes("reset")) {
        find.add("destroys-data", "Deletes a database or its data.");
      } else if (
        lowerArgs.includes("deploy") ||
        (lowerArgs.includes("push") && lowerArgs.includes("db"))
      ) {
        find.add("publishes", "Publishes or deploys something.");
      }
      return;
    case "prisma":
      if (
        (lowerArgs.includes("migrate") && lowerArgs.includes("reset")) ||
        hasFlag(lowerArgs, "--force-reset", "--accept-data-loss")
      ) {
        find.add("destroys-data", "Deletes a database or its data.");
      }
      return;
    case "rails":
    case "rake":
      if (lowerArgs.some((arg) => /^db:(?:drop|reset|purge|schema:load)$/.test(arg))) {
        find.add("destroys-data", "Deletes a database or its data.");
      }
      return;
    case "php":
      if (
        lowerArgs[0] === "artisan" &&
        /^(?:migrate:fresh|migrate:reset|migrate:refresh|db:wipe)$/.test(lowerArgs[1] ?? "")
      ) {
        find.add("destroys-data", "Deletes a database or its data.");
      }
      break;
    case "aws":
    case "gcloud":
    case "az":
    case "gsutil":
      if (
        lowerArgs.some(
          (arg) => arg === "rm" || arg === "rb" || arg === "delete" || arg.startsWith("delete-"),
        )
      ) {
        find.add("destroys-data", "Deletes cloud resources.");
      } else if (lowerArgs.includes("deploy")) {
        find.add("publishes", "Publishes or deploys something.");
      } else if (
        (name === "gcloud" && lowerArgs.includes("print-access-token")) ||
        (name === "gcloud" && lowerArgs.includes("print-identity-token")) ||
        (name === "az" && lowerArgs.includes("get-access-token")) ||
        (name === "aws" && lowerArgs.includes("get-session-token")) ||
        (name === "aws" && lowerArgs[0] === "configure" && lowerArgs[1] === "get")
      ) {
        find.add("reveals-secrets", "Shows a secret, like a token or password.");
      }
      return;
    case "firebase":
      if (
        lowerArgs.some((arg) => /^(?:firestore:delete|database:remove|projects:delete)$/.test(arg))
      ) {
        find.add("destroys-data", "Deletes cloud resources.");
      } else if (lowerArgs.includes("deploy")) {
        find.add("publishes", "Publishes or deploys something.");
      }
      return;
    case "heroku":
      if (lowerArgs.some((arg) => /^(?:apps:destroy|pg:reset|destroy)$/.test(arg))) {
        find.add("destroys-data", "Deletes cloud resources.");
      } else if (lowerArgs.includes("auth:token")) {
        find.add("reveals-secrets", "Shows a secret, like a token or password.");
      }
      return;
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      if (lowerArgs.some((arg) => /^(?:publish|unpublish|deprecate|dist-tag)$/.test(arg))) {
        find.add("publishes", "Publishes or deploys something.");
      } else if (lowerArgs[0] === "token") {
        find.add("reveals-secrets", "Shows a secret, like a token or password.");
      }
      return;
    case "cargo":
    case "gem":
    case "twine":
    case "poetry":
    case "uv":
    case "vsce":
    case "ovsx":
      if (lowerArgs.some((arg) => /^(?:publish|push|upload|yank)$/.test(arg))) {
        find.add("publishes", "Publishes or deploys something.");
      }
      return;
    case "dotnet":
      if (lowerArgs.includes("nuget") && lowerArgs.includes("push")) {
        find.add("publishes", "Publishes or deploys something.");
      }
      return;
    case "vercel":
    case "netlify":
      if (hasFlag(lowerArgs, "--prod", "--production")) {
        find.add("publishes", "Publishes or deploys something.");
      } else if (lowerArgs.includes("remove") || lowerArgs.includes("rm")) {
        find.add("destroys-data", "Deletes cloud resources.");
      }
      return;
    case "wrangler":
    case "fly":
    case "flyctl":
    case "serverless":
    case "sls":
    case "railway":
    case "amplify":
      if (lowerArgs.some((arg) => /^(?:deploy|publish|up)$/.test(arg))) {
        find.add("publishes", "Publishes or deploys something.");
      } else if (lowerArgs.includes("destroy")) {
        find.add("destroys-data", "Deletes cloud resources.");
      } else if (lowerArgs.includes("secret") && lowerArgs.includes("put")) {
        find.add("publishes", "Publishes or deploys something.");
      }
      return;
    case "printenv":
    case "env":
      // `env` reaches here only with no command after it: it prints the environment.
      find.add("reveals-secrets", "Shows a secret, like a token or password.");
      return;
    case "security":
      if (
        /^find-(?:generic|internet)-password$/.test(lowerArgs[0] ?? "") ||
        lowerArgs[0] === "dump-keychain"
      ) {
        find.add("reveals-secrets", "Reads your saved passwords.");
      }
      return;
    case "op":
      if (lowerArgs[0] === "read" || (lowerArgs[0] === "item" && lowerArgs[1] === "get")) {
        find.add("reveals-secrets", "Reads your saved passwords.");
      }
      return;
    default:
      break;
  }

  if (DATABASE_CLIENTS.has(name) && args.some((arg) => SQL_DESTRUCTIVE.test(arg))) {
    find.add("destroys-data", "Deletes a database or its data.");
  }
  if (FILE_READERS.has(name) && args.some((arg) => SENSITIVE_PATH.test(arg))) {
    find.add("reveals-secrets", "Shows a secret, like a token or password.");
  }
  if (PRINTERS.has(name) && args.some((arg) => SENSITIVE_VARIABLE.test(arg))) {
    find.add("reveals-secrets", "Shows a secret, like a token or password.");
  }
  if (
    (name === "get-childitem" || name === "gci" || name === "dir" || name === "ls") &&
    lowerArgs.some((arg) => arg === "env:" || arg === "env:\\")
  ) {
    find.add("reveals-secrets", "Shows a secret, like a token or password.");
  }
  if (NETWORK_SENDERS.has(name) && args.some((arg) => SENSITIVE_PATH.test(arg))) {
    find.add("sends-secrets", "Sends private keys or secrets over the network.");
  }
}

/** Strips assignments and wrappers; says whether one of them was `sudo`-like. */
function unwrapCommand(words: ReadonlyArray<string>): {
  name: string | null;
  args: string[];
  admin: boolean;
  inline: string | null;
} {
  let index = 0;
  let admin = false;
  // A wrapper with nothing after it is the command itself: `env` alone prints
  // the environment.
  let lastWrapper: string | null = null;
  while (index < words.length) {
    const word = words[index]!;
    if (isAssignment(word)) {
      index += 1;
      continue;
    }
    // `if …; then rm …; fi`, `while …; do rm …; done`: the command follows
    // the keyword.
    if (SHELL_KEYWORDS.has(word)) {
      index += 1;
      continue;
    }
    const name = commandBasename(word);
    if (name === "&") {
      index += 1;
      continue;
    }
    if (ADMIN_WRAPPERS.has(name) || PASS_THROUGH_WRAPPERS.has(name)) {
      if (ADMIN_WRAPPERS.has(name)) admin = true;
      lastWrapper = name;
      index += 1;
      while (index < words.length) {
        const option = words[index]!;
        if (isAssignment(option) && (name === "env" || name === "sudo")) {
          index += 1;
          continue;
        }
        if (!option.startsWith("-")) {
          // `timeout 5 cmd`, `nice -n 5 cmd`: a bare number is the wrapper's.
          if (name === "timeout" && /^\d/.test(option)) {
            index += 1;
            continue;
          }
          break;
        }
        index += WRAPPER_VALUE_OPTIONS.has(option) ? 2 : 1;
      }
      continue;
    }
    if ((name === "pnpm" || name === "yarn") && words[index + 1] === "dlx") {
      index += 2;
      continue;
    }
    const args = words.slice(index + 1);
    // `bash -c "…"`, `pwsh -Command "…"`, `eval "…"`: the string is a command too.
    let inline: string | null = null;
    if (SHELLS.has(name) || POWERSHELLS.has(name) || name === "cmd") {
      const inlineFlag = SHELLS.has(name)
        ? /^-[a-z]*c$/
        : POWERSHELLS.has(name)
          ? /^-(?:c|command)$/i
          : /^\/[ck]$/i;
      const flagIndex = args.findIndex((arg) => inlineFlag.test(arg));
      if (flagIndex >= 0) inline = args.slice(flagIndex + 1).join(" ");
    } else if (name === "eval" || name === "iex" || name === "invoke-expression") {
      inline = args.join(" ");
    } else if (name === "su") {
      const flagIndex = args.indexOf("-c");
      if (flagIndex >= 0) inline = args[flagIndex + 1] ?? null;
    }
    return { name, args, admin, inline };
  }
  return { name: lastWrapper, args: [], admin, inline: null };
}

function textMentionsFetcher(text: string, dialect: ShellDialect): boolean {
  const lexed = lexShell(text, dialect);
  if (lexed.commands.some((command) => FETCHERS.has(unwrapCommand(command.words).name ?? ""))) {
    return true;
  }
  return lexed.substitutions.some((inner) => textMentionsFetcher(inner, dialect));
}

function analyze(text: string, dialect: ShellDialect, find: Finder, depth: number): LexResult {
  const lexed = lexShell(text, dialect);
  if (depth > 4) return lexed;

  const stagesByPipeline = new Map<number, Array<{ name: string | null; args: string[] }>>();
  for (const command of lexed.commands) {
    const { name, args, admin, inline } = unwrapCommand(command.words);
    if (admin) find.add("admin", "Runs as administrator.");
    const stages = stagesByPipeline.get(command.pipeline) ?? [];
    stages.push({ name, args });
    stagesByPipeline.set(command.pipeline, stages);
    if (name === null) {
      checkCommand("", [], command.redirects, find);
      continue;
    }
    checkCommand(name, args, command.redirects, find);
    if (
      POWERSHELLS.has(name) &&
      args.some((arg) => /^-(?:e|ec|en|enc|encodedcommand)$/i.test(arg))
    ) {
      find.add("runs-downloaded-code", "Runs hidden code.");
    }
    if (inline !== null && inline.length > 0) {
      if (INTERPRETERS.has(name) && textMentionsFetcher(inline, dialect)) {
        find.add("runs-downloaded-code", "Runs code straight from the internet.");
      }
      analyze(inline, POWERSHELLS.has(name) ? "powershell" : dialect, find, depth + 1);
    }
    // `bash <(curl …)`, `sh -c "$(curl …)"`, `source <(wget …)`.
    if (
      INTERPRETERS.has(name) &&
      command.words.some((word) => /\$\(|`|<\(/.test(word)) &&
      lexed.substitutions.some((inner) => textMentionsFetcher(inner, dialect))
    ) {
      find.add("runs-downloaded-code", "Runs code straight from the internet.");
    }
  }

  // Pipelines: `curl … | sh`, `base64 -d … | bash`, `cat .env | curl …`.
  for (const stages of stagesByPipeline.values()) {
    for (let index = 1; index < stages.length; index += 1) {
      const stage = stages[index]!;
      if (stage.name === null) continue;
      const earlier = stages.slice(0, index);
      const runsInput =
        INTERPRETERS.has(stage.name) &&
        (stage.args.length === 0 ||
          stage.args.every((arg) => arg.startsWith("-")) ||
          stage.name === "iex" ||
          stage.name === "invoke-expression");
      if (runsInput && earlier.some((entry) => FETCHERS.has(entry.name ?? ""))) {
        find.add("runs-downloaded-code", "Runs code straight from the internet.");
      } else if (runsInput && earlier.some((entry) => DECODERS.has(entry.name ?? ""))) {
        find.add("runs-downloaded-code", "Runs hidden code.");
      }
      if (
        NETWORK_SENDERS.has(stage.name) &&
        earlier.some(
          (entry) =>
            entry.name === "printenv" ||
            (entry.name === "env" && entry.args.length === 0) ||
            (FILE_READERS.has(entry.name ?? "") &&
              entry.args.some((arg) => SENSITIVE_PATH.test(arg))),
        )
      ) {
        find.add("sends-secrets", "Sends private keys or secrets over the network.");
      }
    }
    const first = stages[0];
    if (first?.name === "env" && first.args.length === 0) {
      find.add("reveals-secrets", "Shows a secret, like a token or password.");
    }
  }

  // Commands inside substitutions run too.
  for (const inner of lexed.substitutions) {
    analyze(inner, dialect, find, depth + 1);
  }
  // Heredocs fed to a database client or a shell are code as well.
  if (lexed.heredocBodies.length > 0) {
    const names = new Set(lexed.commands.map((command) => unwrapCommand(command.words).name));
    for (const body of lexed.heredocBodies) {
      if (
        [...names].some((name) => name !== null && DATABASE_CLIENTS.has(name)) &&
        SQL_DESTRUCTIVE.test(body)
      ) {
        find.add("destroys-data", "Deletes a database or its data.");
      }
      if ([...names].some((name) => name !== null && (SHELLS.has(name) || POWERSHELLS.has(name)))) {
        analyze(body, dialect, find, depth + 1);
      }
    }
  }
  return lexed;
}

/** Reads a command and decides whether one click may run it. */
export function assessShellCommand(text: string, dialect: ShellDialect): ShellCommandAssessment {
  const lineCount = text.length === 0 ? 0 : text.split("\n").length;
  const hidden = findHiddenCharacters(text);
  if (hidden.length > 0) {
    return {
      blocked: {
        kind: "hidden-characters",
        label: `Has hidden characters (${hidden.slice(0, 3).join(", ")}), so it can't go to the terminal.`,
      },
      action: "insert",
      cautions: [],
      lineCount,
    };
  }
  if (text.length > MAX_SHELL_COMMAND_LENGTH || lineCount > MAX_SHELL_COMMAND_LINES) {
    return {
      blocked: { kind: "too-long", label: "Too long to put in the terminal." },
      action: "insert",
      cautions: [],
      lineCount,
    };
  }

  const found = new Map<ShellCommandCautionKind, string>();
  const find: Finder = {
    add(kind, label) {
      if (!found.has(kind)) found.set(kind, label);
    },
  };
  const lexed = analyze(text, dialect, find, 0);
  if (FORK_BOMB.test(text)) find.add("freezes", "Could freeze your computer.");
  const placeholder = PLACEHOLDER.exec(text)?.[0];
  if (placeholder !== undefined) find.add("placeholder", `Fill in ${placeholder} first.`);
  if (lexed.unterminated) find.add("unreadable", "Couldn't read this command fully.");
  if (lineCount > 1) find.add("multi-line", "More than one line.");

  const cautions = CAUTION_ORDER.filter((kind) => found.has(kind)).map((kind) => ({
    kind,
    label: found.get(kind)!,
    tone: NOTE_KINDS.has(kind) ? ("note" as const) : ("warning" as const),
  }));
  return {
    blocked: null,
    action: cautions.length === 0 ? "run" : "insert",
    cautions,
    lineCount,
  };
}

/**
 * Turns a code block into the command a button would send to a terminal that
 * speaks `terminal`, or null when the block isn't a command to run there. A
 * block fenced as that shell counts as written. A block that names no
 * language, or the other shell, counts only when it means the same in both
 * (isPortableCommand), so a title or a path in a bare block gets no button.
 * A prompt on every line is removed, and so are comment lines and blank lines
 * the shell would skip; a session that mixes prompts with output is skipped.
 */
export function prepareShellCommand(
  code: string,
  language: string | null | undefined,
  terminal: ShellDialect,
): PreparedShellCommand | null {
  const fence = language?.trim().toLowerCase() ?? "";
  const written = shellDialectOfFence(fence);
  if (written === null && !UNNAMED_FENCES.has(fence)) return null;
  let lines = code.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");

  const prompt = written === null ? ANY_PROMPT : PROMPTS[written];
  const filled = lines.filter((line) => line.trim().length > 0);
  if (filled.length === 0) return null;
  const prompted = filled.filter((line) => prompt.test(line));
  if (prompted.length === filled.length) {
    lines = lines.map((line) => line.replace(prompt, ""));
  } else if (prompted.length > 0) {
    return null;
  } else if (SESSION_FENCES.has(fence)) {
    // A session block with no prompt is output, not a command.
    return null;
  }

  const lexed = lexShell(lines.join("\n"), written ?? terminal);
  const kept: string[] = [];
  lines.forEach((line, index) => {
    if (lexed.lineStartsTopLevel[index] !== true) {
      kept.push(line);
      return;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0 || (trimmed.startsWith("#") && !trimmed.startsWith("#!"))) return;
    kept.push(line.trimEnd());
  });
  const text = kept.join("\n").trim();
  if (text.length === 0) return null;
  if (written !== terminal && !isPortableCommand(text)) return null;

  return { ...assessShellCommand(text, terminal), text };
}

/**
 * A fence opening a code block, inside any mix of block quotes and list
 * items (`- > ```sh` too): how many quote markers its lines carry, how far
 * its content is indented, the fence itself and its language.
 */
function parseFenceOpening(
  line: string,
): { quotes: number; indent: number; fence: string; language: string } | null {
  let rest = line;
  let quotes = 0;
  let indent = 0;
  for (;;) {
    const quote = /^ {0,3}> ?/.exec(rest);
    if (quote) {
      quotes += 1;
      indent = 0;
      rest = rest.slice(quote[0].length);
      continue;
    }
    // A list marker counts only right before the fence or a quote.
    const item = /^ *(?:[-*+]|\d{1,9}[.)]) +/.exec(rest);
    if (item && /^(?:`{3,}|~{3,}|>)/.test(rest.slice(item[0].length))) {
      indent += item[0].length;
      rest = rest.slice(item[0].length);
      continue;
    }
    break;
  }
  const open = /^( *)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(rest);
  if (!open) return null;
  return { quotes, indent: indent + open[1]!.length, fence: open[2]!, language: open[3]! };
}

/**
 * The commands a reply's code blocks would send to a `terminal` shell, as
 * prepareShellCommand makes them: what the server compares a code block's Run
 * against, so it only ever runs a block the reply shows. Reads fences at any
 * indent, in lists and in block quotes.
 */
export function shellCommandsInMarkdown(
  markdown: string,
  terminal: ShellDialect,
): PreparedShellCommand[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const found: PreparedShellCommand[] = [];
  let index = 0;
  while (index < lines.length) {
    const open = parseFenceOpening(lines[index]!);
    if (open === null) {
      index += 1;
      continue;
    }
    const { quotes, indent, fence, language } = open;
    const body: string[] = [];
    index += 1;
    while (index < lines.length) {
      let line = lines[index]!;
      for (let quote = 0; quote < quotes; quote += 1) {
        line = line.replace(/^ *> ?/, "");
      }
      const close = /^ *(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) {
        break;
      }
      body.push(line.replace(new RegExp(`^ {0,${indent}}`), ""));
      index += 1;
    }
    index += 1;
    const prepared = prepareShellCommand(body.join("\n"), language, terminal);
    if (prepared !== null) found.push(prepared);
  }
  return found;
}

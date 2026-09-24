/**
 * Reads a shell command the way a person would: split into statements, drop
 * the setup (cd, env, echo), and say what is left does to the machine. Checks
 * (tests, typecheck, lint) are recognized so their results can be reported.
 */
import type { ActivityTallyMark } from "./activitySteps";
import {
  capitalize,
  countWord,
  joinWords,
  looksLikePath,
  lowerFirst,
  pathBasename,
  phrase,
  searchPhrase,
  truncate,
  urlLabel,
  type Phrase,
} from "./activityWording";

// ---------------------------------------------------------------------------
// Shell commands: split into statements, drop the setup (cd, env, echo), and
// classify what is left by what it does to the machine.
// ---------------------------------------------------------------------------

export type CheckKind = "test" | "typecheck" | "lint" | "format" | "build" | "check";

type ShellIntent =
  | { readonly kind: "read"; readonly target: string | null }
  | { readonly kind: "search"; readonly query: string | null }
  | { readonly kind: "list"; readonly target: string | null }
  | { readonly kind: "git"; readonly phrase: Phrase }
  | { readonly kind: "github"; readonly phrase: Phrase }
  | { readonly kind: "env" }
  | { readonly kind: "fetch"; readonly host: string | null }
  | { readonly kind: "check"; readonly check: CheckKind; readonly writes: boolean }
  | { readonly kind: "change"; readonly phrase: Phrase; readonly weight: number };

export interface ShellCommandAnalysis {
  /** True when every statement only looks at the machine. */
  readonly routine: boolean;
  readonly tallies: ReadonlyArray<ActivityTallyMark>;
  /** Verification the command ran, in order, when it ran any. */
  readonly checks: ReadonlyArray<CheckKind>;
  /** Whether a format check rewrote files rather than only checking them. */
  readonly formatWrites: boolean;
  /** Wording read off the command, for providers that do not label it. */
  readonly phrase: Phrase;
  /** The statement that decided a check, for recognizing reruns. */
  readonly checkStatement: string | null;
}

/** Splits a command line at `&&`, `||`, `;` and newlines outside quotes. */
export function splitShellStatements(command: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      statements.push(trimmed);
    }
    current = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += command[index + 1] ?? "";
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "\n") {
      push();
      continue;
    }
    if ((char === "&" || char === "|") && command[index + 1] === char) {
      push();
      index += 1;
      continue;
    }
    current += char;
  }
  push();
  return statements;
}

function firstPipelineStage(statement: string): string {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "|") {
      return statement.slice(0, index).trim();
    }
  }
  return statement.trim();
}

function tokenizeShell(stage: string): string[] {
  const tokens: string[] = [];
  for (const match of stage.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/gu)) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token !== undefined) {
      tokens.push(token);
    }
  }
  return tokens;
}

/** `> file` or `>> file`, but not the harmless `2>&1`, `2>/dev/null`, `>$null`. */
function redirectsToFile(stage: string): boolean {
  const unquoted = stage.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/gu, '""');
  for (const match of unquoted.matchAll(/(\d?)>{1,2}\s*([^\s&|;]+)/gu)) {
    const target = match[2] ?? "";
    if (/^(?:&\d|\/dev\/null|\$null|nul)$/iu.test(target)) {
      continue;
    }
    return true;
  }
  return false;
}

function commandName(token: string): string {
  return pathBasename(token.replace(/^&\s*/u, ""))
    .replace(/\.(?:exe|cmd|bat|ps1)$/iu, "")
    .toLowerCase();
}

const NEUTRAL_COMMANDS: ReadonlySet<string> = new Set([
  ":",
  "cd",
  "chcp",
  "clear",
  "cls",
  "echo",
  "export",
  "false",
  "pop-location",
  "popd",
  "printf",
  "push-location",
  "pushd",
  "set",
  "set-location",
  "setlocal",
  "sl",
  "sleep",
  "source",
  "start-sleep",
  "true",
  "unset",
  "write-host",
  "write-output",
]);

const WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
  "command",
  "env",
  "nice",
  "nohup",
  "sudo",
  "time",
]);

const READ_COMMANDS: ReadonlySet<string> = new Set([
  "awk",
  "bat",
  "cat",
  "gc",
  "get-content",
  "head",
  "jq",
  "less",
  "more",
  "nl",
  "sed",
  "tail",
  "type",
  "wc",
]);

const SEARCH_COMMANDS: ReadonlySet<string> = new Set([
  "ack",
  "ag",
  "egrep",
  "fgrep",
  "findstr",
  "grep",
  "rg",
  "select-string",
  "sls",
]);

const LIST_COMMANDS: ReadonlySet<string> = new Set([
  "dir",
  "fd",
  "find",
  "gci",
  "get-childitem",
  "ls",
  "tree",
]);

const ENV_COMMANDS: ReadonlySet<string> = new Set([
  "date",
  "df",
  "du",
  "get-ciminstance",
  "get-command",
  "get-counter",
  "get-wmiobject",
  "get-date",
  "get-item",
  "get-itemproperty",
  "get-location",
  "get-netconnectionprofile",
  "get-nettcpconnection",
  "get-process",
  "get-service",
  "hostname",
  "lsof",
  "netstat",
  "nvidia-smi",
  "ps",
  "printenv",
  "pwd",
  "resolve-path",
  "systeminfo",
  "tasklist",
  "test-netconnection",
  "test-path",
  "uname",
  "whereis",
  "where",
  "which",
  "whoami",
]);

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);

const SCRIPT_RUNNERS: Readonly<Record<string, string>> = {
  bash: "a shell script",
  bun: "a script",
  deno: "a script",
  node: "a Node script",
  perl: "a Perl script",
  php: "a PHP script",
  powershell: "a PowerShell script",
  pwsh: "a PowerShell script",
  py: "a Python script",
  python: "a Python script",
  python3: "a Python script",
  ruby: "a Ruby script",
  sh: "a shell script",
  "ts-node": "a script",
  tsx: "a script",
  zsh: "a shell script",
};

const SCRIPT_FILE_PATTERN = /\.(?:[cm]?js|[cm]?ts|tsx|py|rb|pl|php|ps1|sh|bash)$/iu;

/** Flags whose value is the next token, per tool, so it is not read as a
 *  subcommand, script name, or search pattern. */
const FLAGS_WITH_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  pnpm: new Set(["--filter", "-F", "-C", "--dir", "--workspace", "--reporter"]),
  npm: new Set(["-w", "--workspace", "--prefix", "-C"]),
  yarn: new Set(["--cwd"]),
  bun: new Set(["--cwd", "--filter"]),
  vp: new Set(["--filter", "-F", "-C", "--dir"]),
  rg: new Set([
    "-g",
    "--glob",
    "-t",
    "--type",
    "-T",
    "--type-not",
    "-m",
    "--max-count",
    "-A",
    "-B",
    "-C",
    "--context",
    "-M",
    "--max-columns",
    "-j",
    "--threads",
    "--sort",
    "--sortr",
    "--iglob",
    "-E",
    "--encoding",
  ]),
  grep: new Set(["-m", "--max-count", "-A", "-B", "-C", "--include", "--exclude"]),
  git: new Set(["-C", "-c", "--git-dir", "--work-tree"]),
  gh: new Set(["-R", "--repo", "--json", "-q", "--jq", "-t", "--template", "-L", "--limit"]),
};

function positionalArgs(tool: string, args: ReadonlyArray<string>): string[] {
  const withValues = FLAGS_WITH_VALUES[tool];
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("-") && arg.length > 1) {
      if (withValues?.has(arg)) {
        index += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

function flagValue(args: ReadonlyArray<string>, ...names: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    for (const name of names) {
      if (arg.toLowerCase() === name.toLowerCase()) {
        return args[index + 1] ?? null;
      }
      if (arg.toLowerCase().startsWith(`${name.toLowerCase()}=`)) {
        return arg.slice(name.length + 1);
      }
    }
  }
  return null;
}

function hasFlag(args: ReadonlyArray<string>, ...names: string[]): boolean {
  return args.some((arg) => names.some((name) => arg.toLowerCase() === name.toLowerCase()));
}

function firstPathArg(args: ReadonlyArray<string>): string | null {
  const explicit = flagValue(args, "-Path", "-LiteralPath", "-FilePath");
  if (explicit) {
    return explicit;
  }
  for (const arg of args) {
    if (!arg.startsWith("-") && looksLikePath(arg)) {
      return arg;
    }
  }
  return null;
}

/** The file a read or list names: a path-looking argument, else the last
 *  plain one (`head -n 50 README`). */
function namedTarget(args: ReadonlyArray<string>): string | null {
  const path = firstPathArg(args);
  if (path) {
    return path;
  }
  const plain = args.filter((arg) => !arg.startsWith("-") && !/^\d+$/u.test(arg));
  return plain.at(-1) ?? null;
}

function targetName(args: ReadonlyArray<string>, fallback: string): string {
  const path = firstPathArg(args) ?? args.find((arg) => !arg.startsWith("-")) ?? null;
  return path ? truncate(pathBasename(path), 48) : fallback;
}

const CHECK_WORDS: Readonly<Record<CheckKind, string>> = {
  test: "tests",
  typecheck: "typecheck",
  lint: "lint",
  format: "format",
  build: "build",
  check: "checks",
};

function checkForScript(script: string): CheckKind | null {
  const name = script.toLowerCase();
  const base = name.includes("#") ? name.slice(name.lastIndexOf("#") + 1) : name;
  const head = base.split(":")[0] ?? base;
  if (head === "test" || head === "tests" || head === "vitest" || head === "jest") return "test";
  if (["typecheck", "type-check", "check-types", "tsc", "types"].includes(head)) {
    return "typecheck";
  }
  if (head === "lint" || head === "eslint" || head === "oxlint") return "lint";
  if (head === "fmt" || head === "format" || head === "prettier") return "format";
  if (head === "build") return "build";
  if (head === "check" || head === "ci" || head === "verify") return "check";
  return null;
}

function checkForTool(name: string, args: ReadonlyArray<string>): CheckKind | null {
  const sub = args.find((arg) => !arg.startsWith("-"))?.toLowerCase() ?? "";
  switch (name) {
    case "vitest":
    case "jest":
    case "mocha":
    case "ava":
    case "pytest":
      return "test";
    case "playwright":
      return sub === "test" ? "test" : null;
    case "tsc":
      return hasFlag(args, "-b", "--build") ? "build" : "typecheck";
    case "vue-tsc":
    case "svelte-check":
    case "mypy":
    case "pyright":
      return "typecheck";
    case "eslint":
    case "oxlint":
    case "stylelint":
    case "golangci-lint":
    case "rubocop":
    case "ruff":
      return name === "ruff" && sub === "format" ? "format" : "lint";
    case "prettier":
    case "oxfmt":
    case "black":
    case "gofmt":
    case "rustfmt":
      return "format";
    case "biome":
      return sub === "format" ? "format" : sub === "lint" || sub === "check" ? "lint" : null;
    case "cargo":
      return sub === "test"
        ? "test"
        : sub === "check"
          ? "typecheck"
          : sub === "clippy"
            ? "lint"
            : sub === "build"
              ? "build"
              : sub === "fmt"
                ? "format"
                : null;
    case "go":
      return sub === "test" ? "test" : sub === "build" ? "build" : sub === "vet" ? "lint" : null;
    case "dotnet":
      return sub === "test"
        ? "test"
        : sub === "build"
          ? "build"
          : sub === "format"
            ? "format"
            : null;
    case "make":
    case "just":
    case "turbo":
    case "nx":
      return checkForScript(positionalArgs(name, args).find((arg) => arg !== "run") ?? "");
    default:
      return null;
  }
}

/** Package-manager and task-runner invocations, down to the script or tool
 *  they actually run. */
function unwrapRunner(
  name: string,
  args: ReadonlyArray<string>,
): { readonly name: string; readonly args: ReadonlyArray<string> } | { readonly script: string } {
  if (name === "npx" || name === "bunx") {
    const [tool, ...rest] = args.filter((arg, index) => index > 0 || !arg.startsWith("-"));
    return tool ? { name: commandName(tool), args: rest } : { script: "" };
  }
  const positional = positionalArgs(name, args);
  const [first, second] = positional;
  if (!first) {
    return { script: "" };
  }
  if (first === "exec" || first === "dlx" || (name === "vp" && first === "exec")) {
    const index = args.indexOf(first);
    const rest = args
      .slice(index + 1)
      .filter((arg, position) => position > 0 || !arg.startsWith("-"));
    const [tool, ...toolArgs] = rest;
    return tool ? { name: commandName(tool), args: toolArgs } : { script: "" };
  }
  if (first === "run" || first === "run-script") {
    return { script: second ?? "" };
  }
  return { script: first };
}

function packageManagerIntent(name: string, args: ReadonlyArray<string>): ShellIntent | null {
  const unwrapped = unwrapRunner(name, args);
  if ("name" in unwrapped) {
    return classifyTokens(unwrapped.name, unwrapped.args);
  }
  const script = unwrapped.script;
  const lower = script.toLowerCase();
  const check = checkForScript(lower);
  if (check) {
    return { kind: "check", check, writes: check === "format" && !hasFlag(args, "--check") };
  }
  if (["install", "i", "ci", ""].includes(lower)) {
    return {
      kind: "change",
      phrase: phrase("Installed dependencies", "Installing dependencies"),
      weight: 2,
    };
  }
  const packages = positionalArgs(name, args).slice(1);
  const named = packages.length > 0 ? joinWords(packages.slice(0, 2)) : "packages";
  if (["add", "install"].includes(lower)) {
    return { kind: "change", phrase: phrase(`Added ${named}`, `Adding ${named}`), weight: 2 };
  }
  if (["remove", "rm", "uninstall", "un"].includes(lower)) {
    return { kind: "change", phrase: phrase(`Removed ${named}`, `Removing ${named}`), weight: 2 };
  }
  if (["update", "up", "upgrade"].includes(lower)) {
    return {
      kind: "change",
      phrase: phrase("Updated dependencies", "Updating dependencies"),
      weight: 2,
    };
  }
  if (["dev", "start", "serve", "preview"].includes(lower)) {
    return {
      kind: "change",
      phrase: phrase("Started the dev server", "Starting the dev server"),
      weight: 2,
    };
  }
  if (["-v", "--version", "why", "list", "ls", "outdated", "view", "info"].includes(lower)) {
    return { kind: "env" };
  }
  const shown = truncate(script, 40);
  return { kind: "change", phrase: phrase(`Ran ${shown}`, `Running ${shown}`), weight: 1 };
}

function vpIntent(args: ReadonlyArray<string>): ShellIntent | null {
  const positional = positionalArgs("vp", args);
  const [first, second] = positional;
  if (first === "exec") {
    return packageManagerIntent("pnpm", args);
  }
  const script = first === "run" ? (second ?? "") : (first ?? "");
  const check = checkForScript(script);
  if (check) {
    return { kind: "check", check, writes: check === "format" && !hasFlag(args, "--check") };
  }
  const shown = truncate(script || "vp", 40);
  return { kind: "change", phrase: phrase(`Ran ${shown}`, `Running ${shown}`), weight: 1 };
}

function commitMessage(args: ReadonlyArray<string>): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-m" || arg === "--message" || /^-[a-z]*m$/u.test(arg)) {
      const message = args[index + 1];
      if (message && !message.startsWith("$(")) {
        return truncate(message.split(/\r?\n/u)[0] ?? message, 60);
      }
      return null;
    }
    if (arg.startsWith("--message=")) {
      return truncate(arg.slice("--message=".length), 60);
    }
  }
  return null;
}

function gitIntent(args: ReadonlyArray<string>): ShellIntent {
  const positional = positionalArgs("git", args);
  const sub = positional[0]?.toLowerCase() ?? "";
  const rest = positional.slice(1);
  const subArgs = args.slice(args.indexOf(positional[0] ?? "") + 1);
  const target = rest[0] ? truncate(rest[0], 40) : null;
  const look = (past: string, live: string): ShellIntent => ({
    kind: "git",
    phrase: phrase(past, live),
  });
  const change = (past: string, live: string, weight: number): ShellIntent => ({
    kind: "change",
    phrase: phrase(past, live),
    weight,
  });
  switch (sub) {
    case "status":
      return look("Checked git status", "Checking git status");
    case "log":
    case "shortlog":
    case "reflog":
    case "rev-list":
    case "whatchanged":
      return look("Checked git history", "Checking git history");
    case "diff":
      return look("Checked the diff", "Checking the diff");
    case "show":
      return look("Looked at a commit", "Looking at a commit");
    case "blame":
      return look(
        `Checked who changed ${target ? pathBasename(target) : "a file"}`,
        `Checking who changed ${target ? pathBasename(target) : "a file"}`,
      );
    case "grep":
      return { kind: "search", query: rest[0] ?? null };
    case "rev-parse":
    case "ls-files":
    case "ls-tree":
    case "describe":
    case "merge-base":
    case "cat-file":
    case "name-rev":
    case "for-each-ref":
    case "check-ignore":
    case "count-objects":
    case "--version":
      return look("Checked git", "Checking git");
    case "branch":
      if (hasFlag(subArgs, "-d", "-D", "--delete")) {
        return change(`Deleted branch ${target ?? ""}`.trim(), "Deleting a branch", 3);
      }
      if (hasFlag(subArgs, "-m", "-M", "--move")) {
        return change("Renamed a branch", "Renaming a branch", 2);
      }
      return rest.length > 0 && !hasFlag(subArgs, "--list", "-l", "--contains", "--merged")
        ? change(`Created branch ${target}`, `Creating branch ${target}`, 2)
        : look("Checked branches", "Checking branches");
    case "remote":
      return rest.length === 0 || rest[0] === "get-url" || rest[0] === "show"
        ? look("Checked git remotes", "Checking git remotes")
        : change("Changed git remotes", "Changing git remotes", 2);
    case "stash": {
      const action = rest[0]?.toLowerCase() ?? "push";
      if (action === "list" || action === "show") {
        return look("Checked stashed changes", "Checking stashed changes");
      }
      if (action === "pop" || action === "apply") {
        return change("Restored stashed changes", "Restoring stashed changes", 2);
      }
      if (action === "drop" || action === "clear") {
        return change("Dropped stashed changes", "Dropping stashed changes", 2);
      }
      return change("Stashed changes", "Stashing changes", 2);
    }
    case "tag":
      return rest.length === 0 || hasFlag(subArgs, "-l", "--list")
        ? look("Checked tags", "Checking tags")
        : change(`Tagged ${target}`, `Tagging ${target}`, 2);
    case "worktree":
      return rest[0] === "list"
        ? look("Checked worktrees", "Checking worktrees")
        : rest[0] === "add"
          ? change("Created a worktree", "Creating a worktree", 2)
          : rest[0] === "remove"
            ? change("Removed a worktree", "Removing a worktree", 2)
            : change("Changed worktrees", "Changing worktrees", 2);
    case "config":
      return hasFlag(subArgs, "--get", "--list", "-l", "--get-all") || rest.length <= 1
        ? look("Checked git settings", "Checking git settings")
        : change("Changed git settings", "Changing git settings", 1);
    case "add":
      return change("Staged changes", "Staging changes", 1);
    case "commit": {
      const message = commitMessage(subArgs);
      return message
        ? change(`Committed "${message}"`, "Committing", 3)
        : change("Committed changes", "Committing", 3);
    }
    case "push": {
      const branch = rest[1] && rest[1] !== "HEAD" ? truncate(rest[1], 40) : null;
      return change(branch ? `Pushed ${branch}` : "Pushed changes", "Pushing", 4);
    }
    case "pull":
      return change("Pulled changes", "Pulling changes", 2);
    case "fetch":
      // Only remote-tracking refs move; nothing the reader works with changes.
      return look("Fetched from the remote", "Fetching from the remote");
    case "checkout":
    case "switch": {
      const created = flagValue(subArgs, "-b", "-B", "-c", "-C");
      if (created) {
        return change(`Created branch ${truncate(created, 40)}`, "Creating a branch", 2);
      }
      if (subArgs.includes("--") || (target && /\.[A-Za-z0-9]{1,8}$/u.test(target))) {
        const file = subArgs[subArgs.indexOf("--") + 1] ?? target ?? "files";
        return change(`Restored ${pathBasename(file)}`, `Restoring ${pathBasename(file)}`, 2);
      }
      return change(`Switched to ${target ?? "a branch"}`, "Switching branches", 2);
    }
    case "restore":
      return change(
        `Restored ${target ? pathBasename(target) : "files"}`,
        `Restoring ${target ? pathBasename(target) : "files"}`,
        2,
      );
    case "merge":
      return hasFlag(subArgs, "--abort")
        ? change("Stopped the merge", "Stopping the merge", 2)
        : change(`Merged ${target ?? "a branch"}`, "Merging", 3);
    case "rebase":
      return hasFlag(subArgs, "--abort")
        ? change("Stopped the rebase", "Stopping the rebase", 2)
        : hasFlag(subArgs, "--continue")
          ? change("Continued the rebase", "Continuing the rebase", 2)
          : change(`Rebased onto ${target ?? "a branch"}`, "Rebasing", 3);
    case "reset":
      return hasFlag(subArgs, "--hard")
        ? change(`Reset to ${target ?? "HEAD"}`, "Resetting", 4)
        : change("Unstaged changes", "Unstaging changes", 1);
    case "cherry-pick":
      return change(`Cherry-picked ${target ?? "a commit"}`, "Cherry-picking", 3);
    case "revert":
      return change(`Reverted ${target ?? "a commit"}`, "Reverting", 3);
    case "rm":
      return change(
        `Removed ${target ? pathBasename(target) : "files"} from git`,
        "Removing files from git",
        2,
      );
    case "mv":
      return change("Moved files in git", "Moving files in git", 2);
    case "clean":
      return change("Removed untracked files", "Removing untracked files", 3);
    case "clone":
      return change(
        `Cloned ${target ? pathBasename(target).replace(/\.git$/u, "") : "a repo"}`,
        "Cloning",
        2,
      );
    case "init":
      return change("Created a git repo", "Creating a git repo", 2);
    case "apply":
    case "am":
      return change("Applied a patch", "Applying a patch", 2);
    default:
      return change(
        `Ran git ${truncate(sub || "command", 24)}`,
        `Running git ${truncate(sub || "command", 24)}`,
        1,
      );
  }
}

function githubIntent(args: ReadonlyArray<string>): ShellIntent {
  const positional = positionalArgs("gh", args);
  const group = positional[0]?.toLowerCase() ?? "";
  const action = positional[1]?.toLowerCase() ?? "";
  const number = positional
    .slice(2)
    .find((arg) => /^#?\d+$/u.test(arg))
    ?.replace(/^#/u, "");
  const pr = number ? `PR #${number}` : "a pull request";
  const issue = number ? `issue #${number}` : "an issue";
  const look = (past: string, live: string): ShellIntent => ({
    kind: "github",
    phrase: phrase(past, live),
  });
  const change = (past: string, live: string, weight: number): ShellIntent => ({
    kind: "change",
    phrase: phrase(past, live),
    weight,
  });
  if (group === "pr") {
    switch (action) {
      case "view":
        return look(`Looked up ${pr}`, `Looking up ${pr}`);
      case "list":
        return look("Listed pull requests", "Listing pull requests");
      case "status":
        return look("Checked pull request status", "Checking pull request status");
      case "checks":
        return look(`Checked CI for ${pr}`, `Checking CI for ${pr}`);
      case "diff":
        return look(`Read the diff of ${pr}`, `Reading the diff of ${pr}`);
      case "create":
        return change("Opened a pull request", "Opening a pull request", 5);
      case "merge":
        return change(`Merged ${pr}`, `Merging ${pr}`, 5);
      case "close":
        return change(`Closed ${pr}`, `Closing ${pr}`, 4);
      case "reopen":
        return change(`Reopened ${pr}`, `Reopening ${pr}`, 4);
      case "comment":
        return change(`Commented on ${pr}`, `Commenting on ${pr}`, 3);
      case "review":
        return change(`Reviewed ${pr}`, `Reviewing ${pr}`, 3);
      case "edit":
        return change(`Edited ${pr}`, `Editing ${pr}`, 3);
      case "ready":
        return change(`Marked ${pr} ready for review`, `Marking ${pr} ready`, 3);
      case "checkout":
        return change(`Checked out ${pr}`, `Checking out ${pr}`, 2);
    }
  }
  if (group === "issue") {
    switch (action) {
      case "view":
        return look(`Looked up ${issue}`, `Looking up ${issue}`);
      case "list":
        return look("Listed issues", "Listing issues");
      case "create":
        return change("Opened an issue", "Opening an issue", 4);
      case "comment":
        return change(`Commented on ${issue}`, `Commenting on ${issue}`, 3);
      case "close":
        return change(`Closed ${issue}`, `Closing ${issue}`, 3);
      case "edit":
        return change(`Edited ${issue}`, `Editing ${issue}`, 3);
    }
  }
  if (group === "run") {
    const run = positional[2] ? `CI run ${truncate(positional[2], 16)}` : "a CI run";
    switch (action) {
      case "view":
        return look(`Checked ${run}`, `Checking ${run}`);
      case "list":
        return look("Listed CI runs", "Listing CI runs");
      case "watch":
        return look(`Watched ${run}`, `Watching ${run}`);
      case "rerun":
        return change(`Reran ${run}`, `Rerunning ${run}`, 3);
      case "cancel":
        return change(`Cancelled ${run}`, `Cancelling ${run}`, 3);
    }
  }
  if (group === "api") {
    const method = flagValue(args, "-X", "--method")?.toUpperCase() ?? "GET";
    const sendsFields = hasFlag(args, "-f", "-F", "--field", "--raw-field", "--input");
    return method === "GET" && !sendsFields
      ? look("Called the GitHub API", "Calling the GitHub API")
      : change("Changed something through the GitHub API", "Calling the GitHub API", 3);
  }
  if (group === "search") {
    return look("Searched GitHub", "Searching GitHub");
  }
  if (group === "auth" && action === "status") {
    return look("Checked GitHub sign-in", "Checking GitHub sign-in");
  }
  if (["view", "list", "status"].includes(action)) {
    return look("Checked GitHub", "Checking GitHub");
  }
  if (group === "workflow" && action === "run") {
    return change("Started a workflow", "Starting a workflow", 3);
  }
  if (group === "release" && action === "create") {
    return change("Published a release", "Publishing a release", 4);
  }
  const shown = truncate([group, action].filter(Boolean).join(" ") || "command", 30);
  return change(`Ran gh ${shown}`, `Running gh ${shown}`, 2);
}

function requestIntent(name: string, args: ReadonlyArray<string>): ShellIntent {
  const url = args.find((arg) => /^https?:\/\//iu.test(arg)) ?? flagValue(args, "-Uri");
  const host = url ? urlLabel(url) : null;
  const method =
    flagValue(args, "-X", "--request", "-Method")?.toUpperCase() ??
    (hasFlag(args, "-d", "--data", "--data-raw", "--data-binary", "-F", "--form", "-T", "-Body")
      ? "POST"
      : "GET");
  if (method === "GET" || method === "HEAD") {
    return { kind: "fetch", host };
  }
  const where = host ?? "a server";
  return {
    kind: "change",
    phrase: phrase(`Sent a request to ${where}`, `Sending a request to ${where}`),
    weight: 2,
  };
}

function scriptIntent(name: string, args: ReadonlyArray<string>): ShellIntent | null {
  const lowerArgs = new Set(args.map((arg) => arg.toLowerCase()));
  if (lowerArgs.has("-v") || lowerArgs.has("--version") || lowerArgs.has("-version")) {
    return { kind: "env" };
  }
  if (name.startsWith("python") || name === "py") {
    const module = flagValue(args, "-m");
    if (module) {
      const check = checkForTool(module.toLowerCase(), args.slice(args.indexOf(module) + 1));
      if (check) {
        return { kind: "check", check, writes: false };
      }
      return {
        kind: "change",
        phrase: phrase(`Ran ${truncate(module, 30)}`, `Running ${truncate(module, 30)}`),
        weight: 1,
      };
    }
  }
  if (
    ["node", "bun", "deno", "tsx", "ts-node"].includes(name) &&
    (lowerArgs.has("--test") || args.some((arg) => /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(arg)))
  ) {
    return { kind: "check", check: "test", writes: false };
  }
  if (name === "bun" && args[0] === "test") {
    return { kind: "check", check: "test", writes: false };
  }
  if (name === "bun" && args[0] !== undefined && !SCRIPT_FILE_PATTERN.test(args[0])) {
    return packageManagerIntent("bun", args);
  }
  const script = args.find((arg) => !arg.startsWith("-") && SCRIPT_FILE_PATTERN.test(arg));
  if (script) {
    const file = truncate(pathBasename(script), 40);
    return { kind: "change", phrase: phrase(`Ran ${file}`, `Running ${file}`), weight: 1 };
  }
  const inline = SCRIPT_RUNNERS[name] ?? "a script";
  return { kind: "change", phrase: phrase(`Ran ${inline}`, `Running ${inline}`), weight: 1 };
}

function fileOpIntent(name: string, args: ReadonlyArray<string>): ShellIntent | null {
  const target = targetName(args, "files");
  const change = (past: string, live: string, weight = 2): ShellIntent => ({
    kind: "change",
    phrase: phrase(past, live),
    weight,
  });
  switch (name) {
    case "rm":
    case "del":
    case "erase":
    case "remove-item":
    case "ri":
    case "rmdir":
    case "rd":
      return change(`Deleted ${target}`, `Deleting ${target}`);
    case "mkdir":
    case "md":
      return change(`Created folder ${target}`, `Creating folder ${target}`, 1);
    case "new-item":
    case "ni":
      return /^directory$/iu.test(flagValue(args, "-ItemType", "-Type") ?? "")
        ? change(`Created folder ${target}`, `Creating folder ${target}`, 1)
        : change(`Created ${target}`, `Creating ${target}`);
    case "touch":
      return change(`Created ${target}`, `Creating ${target}`);
    case "cp":
    case "copy":
    case "copy-item":
    case "cpi":
    case "robocopy":
    case "xcopy":
      return change(`Copied ${target}`, `Copying ${target}`);
    case "mv":
    case "move":
    case "move-item":
    case "mi":
    case "ren":
    case "rename":
    case "rename-item":
      return change(`Moved ${target}`, `Moving ${target}`);
    case "set-content":
    case "sc":
    case "out-file":
    case "add-content":
    case "ac":
    case "tee":
      return change(`Wrote ${target}`, `Writing ${target}`);
    case "chmod":
    case "chown":
    case "icacls":
      return change("Changed file permissions", "Changing file permissions", 1);
    case "unzip":
    case "expand-archive":
      return change("Unpacked an archive", "Unpacking an archive", 1);
    case "zip":
    case "compress-archive":
      return change("Packed an archive", "Packing an archive", 1);
    case "stop-process":
    case "kill":
    case "taskkill":
    case "pkill":
    case "killall":
      return change("Stopped a process", "Stopping a process");
    case "start-process":
    case "start":
      return change(`Started ${target}`, `Starting ${target}`);
    default:
      return null;
  }
}

function classifyTokens(name: string, args: ReadonlyArray<string>): ShellIntent | null {
  if (NEUTRAL_COMMANDS.has(name)) {
    return null;
  }
  if (WRAPPER_COMMANDS.has(name)) {
    const [inner, ...rest] = args.filter((arg, index) => index > 0 || !arg.startsWith("-"));
    return inner ? classifyTokens(commandName(inner), rest) : null;
  }
  if (name === "timeout" || name === "gtimeout") {
    const [, inner, ...rest] = positionalArgs(name, args);
    return inner ? classifyTokens(commandName(inner), rest) : null;
  }
  if (name === "git") {
    return gitIntent(args);
  }
  if (name === "gh") {
    return githubIntent(args);
  }
  if (name === "vp") {
    return vpIntent(args);
  }
  if (PACKAGE_MANAGERS.has(name) || name === "npx" || name === "bunx") {
    if (name === "bun" && (args[0] === "test" || SCRIPT_FILE_PATTERN.test(args[0] ?? ""))) {
      return scriptIntent(name, args);
    }
    return packageManagerIntent(name, args);
  }
  const check = checkForTool(name, args);
  if (check) {
    return {
      kind: "check",
      check,
      writes: check === "format" && !hasFlag(args, "--check", "-l", "--list-different"),
    };
  }
  if (name === "sed" && args.some((arg) => /^-[a-z]*i/u.test(arg) || arg === "--in-place")) {
    // The script comes first and the file last: `sed -i 's/a/b/' src/app.ts`.
    const last = args.findLast((arg) => !arg.startsWith("-"));
    const file = last ? truncate(pathBasename(last), 48) : "a file";
    return { kind: "change", phrase: phrase(`Edited ${file}`, `Editing ${file}`), weight: 2 };
  }
  if (READ_COMMANDS.has(name)) {
    return { kind: "read", target: namedTarget(args) };
  }
  if (name === "rg" && hasFlag(args, "--files")) {
    return { kind: "list", target: firstPathArg(args) };
  }
  if (SEARCH_COMMANDS.has(name)) {
    const explicit = flagValue(args, "-e", "--regexp", "-Pattern");
    const positional =
      name === "findstr"
        ? args.filter((arg) => !arg.startsWith("/") && !arg.startsWith("-"))
        : positionalArgs(name === "grep" ? "grep" : "rg", args);
    return { kind: "search", query: explicit ?? positional[0] ?? null };
  }
  if (LIST_COMMANDS.has(name)) {
    if (name === "find" && hasFlag(args, "-delete", "-exec", "-execdir")) {
      return {
        kind: "change",
        phrase: phrase("Changed files with find", "Changing files with find"),
        weight: 2,
      };
    }
    if ((name === "gci" || name === "get-childitem") && /^env:/iu.test(args[0] ?? "")) {
      return { kind: "env" };
    }
    return { kind: "list", target: namedTarget(args) };
  }
  if (ENV_COMMANDS.has(name)) {
    return { kind: "env" };
  }
  if (["curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm"].includes(name)) {
    return requestIntent(name, args);
  }
  if (name in SCRIPT_RUNNERS) {
    if ((name === "pwsh" || name === "powershell") && hasFlag(args, "-command", "-c")) {
      const inner = flagValue(args, "-Command", "-c");
      return inner ? summarizeStatements(splitShellStatements(inner)) : null;
    }
    if ((name === "bash" || name === "sh" || name === "zsh") && hasFlag(args, "-c", "-lc")) {
      const inner = flagValue(args, "-c", "-lc");
      return inner ? summarizeStatements(splitShellStatements(inner)) : null;
    }
    return scriptIntent(name, args);
  }
  const fileOp = fileOpIntent(name, args);
  if (fileOp) {
    return fileOp;
  }
  if (name === "docker" || name === "kubectl") {
    const sub = args.find((arg) => !arg.startsWith("-")) ?? "";
    if (["ps", "images", "logs", "inspect", "get", "describe", "version"].includes(sub)) {
      return { kind: "env" };
    }
  }
  const first = args.find((arg) => !arg.startsWith("-"));
  const shownArg = first
    ? ` ${truncate(looksLikePath(first) ? pathBasename(first) : first, 32)}`
    : "";
  const shown = `${truncate(name, 32)}${shownArg}`;
  return { kind: "change", phrase: phrase(`Ran ${shown}`, `Running ${shown}`), weight: 1 };
}

function classifyStatement(statement: string): ShellIntent | null {
  const stage = firstPipelineStage(statement);
  // PowerShell assigns command output to variables (`$r = gh run view ...`);
  // what runs is the right-hand side. Assigning a literal is setup.
  const assignment = /^\$[\w:.]+\s*=\s*(.*)$/su.exec(stage);
  if (assignment) {
    const value = (assignment[1] ?? "").trim();
    return /^[A-Za-z]/u.test(value) && !/^\$?(?:true|false|null)$/iu.test(value)
      ? classifyStatement(value)
      : null;
  }
  const tokens = tokenizeShell(stage);
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[0]!)) {
    tokens.shift();
  }
  if (tokens[0] === "&" || tokens[0] === ".") {
    tokens.shift();
  }
  const [head, ...args] = tokens;
  if (!head || head.startsWith("[") || head.startsWith("#") || head.startsWith("(")) {
    return null;
  }
  const intent = classifyTokens(commandName(head), args);
  if (intent && redirectsToFile(stage) && intent.kind !== "change" && intent.kind !== "check") {
    return {
      kind: "change",
      phrase: phrase("Wrote output to a file", "Writing output to a file"),
      weight: 1,
    };
  }
  return intent;
}

function intentPhrase(intent: ShellIntent): Phrase {
  switch (intent.kind) {
    case "read": {
      const file = intent.target ? truncate(pathBasename(intent.target), 48) : null;
      return file
        ? phrase(`Read ${file}`, `Reading ${file}`)
        : phrase("Read a file", "Reading a file");
    }
    case "search":
      return searchPhrase(intent.query);
    case "list": {
      const folder = intent.target ? truncate(pathBasename(intent.target), 48) : null;
      return folder
        ? phrase(`Listed ${folder}`, `Listing ${folder}`)
        : phrase("Listed files", "Listing files");
    }
    case "git":
    case "github":
    case "change":
      return intent.phrase;
    case "env":
      return phrase("Checked the environment", "Checking the environment");
    case "fetch":
      return intent.host
        ? phrase(`Fetched ${intent.host}`, `Fetching ${intent.host}`)
        : phrase("Fetched a page", "Fetching a page");
    case "check":
      return phrase(`Ran ${CHECK_WORDS[intent.check]}`, `Running ${CHECK_WORDS[intent.check]}`);
  }
}

/** One intent standing for several statements (a nested `-Command` body). */
function summarizeStatements(statements: ReadonlyArray<string>): ShellIntent | null {
  const intents = statements
    .map(classifyStatement)
    .filter((intent): intent is ShellIntent => intent !== null);
  const check = intents.find((intent) => intent.kind === "check");
  if (check) return check;
  const changes = intents.filter(
    (intent): intent is Extract<ShellIntent, { kind: "change" }> => intent.kind === "change",
  );
  if (changes.length > 0) {
    return changes.reduce((best, next) => (next.weight >= best.weight ? next : best));
  }
  return intents[0] ?? null;
}

function tallyForIntent(intent: ShellIntent): ActivityTallyMark | null {
  switch (intent.kind) {
    case "read":
      return {
        tally: "read",
        subject: intent.target ? pathBasename(intent.target) : undefined,
      };
    case "search":
      return { tally: "search" };
    case "list":
      return { tally: "list" };
    case "git":
      return { tally: "git" };
    case "github":
      return { tally: "github" };
    case "fetch":
      return { tally: "fetch" };
    default:
      return null;
  }
}

/** What a shell command does, statement by statement. */
export function analyzeShellCommand(command: string): ShellCommandAnalysis {
  const statements = splitShellStatements(command);
  const classified = statements
    .map((statement) => ({ statement, intent: classifyStatement(statement) }))
    .filter((item): item is { statement: string; intent: ShellIntent } => item.intent !== null);
  const intents = classified.map((item) => item.intent);
  const checks: CheckKind[] = [];
  let formatWrites = false;
  let checkStatement: string | null = null;
  for (const { statement, intent } of classified) {
    if (intent.kind !== "check") continue;
    if (!checks.includes(intent.check)) checks.push(intent.check);
    formatWrites ||= intent.writes;
    checkStatement ??= statement;
  }
  const changes = intents.filter(
    (intent): intent is Extract<ShellIntent, { kind: "change" }> => intent.kind === "change",
  );
  const routine = checks.length === 0 && changes.length === 0;
  const tallies = routine
    ? intents.map(tallyForIntent).filter((mark): mark is ActivityTallyMark => mark !== null)
    : [];

  let commandPhrase: Phrase;
  if (checks.length > 0) {
    const words = checks.map((check) => CHECK_WORDS[check]);
    commandPhrase = phrase(`Ran ${joinWords(words)}`, checkLiveLabel(checks));
  } else if (changes.length > 0) {
    const main = changes.reduce((best, next) => (next.weight >= best.weight ? next : best));
    const others = changes.length - 1;
    commandPhrase =
      others > 0
        ? phrase(`${main.phrase.past} and ${countWord(others, "more step")}`, main.phrase.live)
        : main.phrase;
  } else if (intents.length === 0) {
    commandPhrase = phrase("Checked the environment", "Checking the environment");
  } else {
    const phrases = intents.map(intentPhrase);
    const shown = phrases.slice(0, 2);
    const hidden = phrases.length - shown.length;
    const past = joinWords([
      ...shown.map((item, index) => (index === 0 ? item.past : lowerFirst(item.past))),
      ...(hidden > 0 ? [countWord(hidden, "more step")] : []),
    ]);
    commandPhrase = phrase(past, shown[0]!.live);
  }

  return {
    routine,
    tallies,
    checks,
    formatWrites,
    phrase: commandPhrase,
    checkStatement,
  };
}

function checkLiveLabel(checks: ReadonlyArray<CheckKind>): string {
  if (checks.length === 1) {
    switch (checks[0]) {
      case "test":
        return "Running tests";
      case "typecheck":
        return "Typechecking";
      case "lint":
        return "Linting";
      case "format":
        return "Formatting code";
      case "build":
        return "Building";
      default:
        return "Running checks";
    }
  }
  return `Running ${joinWords(checks.map((check) => CHECK_WORDS[check]))}`;
}

// ---------------------------------------------------------------------------
// Check results
// ---------------------------------------------------------------------------

// Built from the escape character so the pattern itself holds no control code.
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "gu");

function outputLines(output: string | undefined): string[] {
  if (!output) return [];
  return (
    output
      .replace(ANSI_PATTERN, "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      // A backgrounded command's own output is only the notice that it went to
      // the background; its real output never reaches the tool result.
      .filter(
        (line) =>
          line.length > 0 && line !== "..." && !/running in background with id/iu.test(line),
      )
  );
}

interface TestCounts {
  readonly failed: number | null;
  readonly passed: number | null;
  readonly total: number | null;
}

function parseTestCounts(lines: ReadonlyArray<string>): TestCounts | null {
  for (const line of [...lines].toReversed()) {
    const vitest = /^Tests\s+(.*?)\s*\((\d+)\)$/u.exec(line);
    if (vitest) {
      const body = vitest[1] ?? "";
      return {
        failed: Number(/(\d+) failed/u.exec(body)?.[1] ?? 0),
        passed: Number(/(\d+) passed/u.exec(body)?.[1] ?? 0),
        total: Number(vitest[2]),
      };
    }
    const jest = /^Tests:\s+(.*?)(\d+) total/u.exec(line);
    if (jest) {
      const body = jest[1] ?? "";
      return {
        failed: Number(/(\d+) failed/u.exec(body)?.[1] ?? 0),
        passed: Number(/(\d+) passed/u.exec(body)?.[1] ?? 0),
        total: Number(jest[2]),
      };
    }
    const pytest = /^=+\s*(.*?\b(?:passed|failed)\b.*?)\s+in\s+[\d.]+s/u.exec(line);
    if (pytest) {
      const body = pytest[1] ?? "";
      const failed = Number(/(\d+) failed/u.exec(body)?.[1] ?? 0);
      const passed = Number(/(\d+) passed/u.exec(body)?.[1] ?? 0);
      return { failed, passed, total: failed + passed };
    }
    const cargo = /^test result: \w+\. (\d+) passed; (\d+) failed/u.exec(line);
    if (cargo) {
      const passed = Number(cargo[1]);
      const failed = Number(cargo[2]);
      return { failed, passed, total: passed + failed };
    }
  }
  return null;
}

function countMatch(lines: ReadonlyArray<string>, pattern: RegExp): number | null {
  for (const line of [...lines].toReversed()) {
    const match = pattern.exec(line);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  return null;
}

/** "refreshes status after a merge: expected 'open' to be 'merged'" — the
 *  failing test and why, else the first line that reads like an error. */
export function firstFailureLine(output: string | undefined): string | null {
  const lines = outputLines(output);
  if (lines.length === 0) {
    return null;
  }
  const isSummary = (line: string) =>
    /^(?:Test Files|Tests|Tests:|Test Suites:|Snapshots:|Time:|Duration|Start at)\b/u.test(line) ||
    /^=+.*\bin\s+[\d.]+s\s*=*$/u.test(line);
  const failLine = lines.find((line) => /^(?:FAIL|×|✗|✕)\s/u.test(line));
  const testName = failLine?.includes(" > ") ? failLine.split(" > ").at(-1)?.trim() : null;
  const errorLine = lines.find(
    (line) =>
      /\b(?:AssertionError|TypeError|ReferenceError|SyntaxError|Error):\s/u.test(line) ||
      /\berror TS\d+:/u.test(line) ||
      /^error(?:\[[^\]]+\])?:\s/u.test(line),
  );
  const message = errorLine?.replace(/^.*?\b(?:AssertionError|Error):\s*/u, "").trim() ?? null;
  const combined = testName && message ? `${testName}: ${message}` : (message ?? testName ?? null);
  const fallback = lines.find((line) => !isSummary(line)) ?? null;
  const chosen = combined ?? fallback;
  return chosen ? truncate(chosen, 160) : null;
}

export function checkResultLabel(
  checks: ReadonlyArray<CheckKind>,
  failed: boolean,
  output: string | undefined,
  formatWrites: boolean,
): string {
  const lines = outputLines(output);
  if (checks.length === 1) {
    const [check] = checks;
    if (check === "test") {
      const counts = parseTestCounts(lines);
      if (failed) {
        if (counts?.failed && counts.total) {
          return `${counts.failed.toLocaleString()} of ${countWord(counts.total, "test")} failed`;
        }
        return counts?.failed ? `${countWord(counts.failed, "test")} failed` : "Tests failed";
      }
      return counts?.passed ? `${countWord(counts.passed, "test")} passed` : "Tests passed";
    }
    if (check === "typecheck") {
      if (!failed) return "Typecheck passed";
      const errors =
        countMatch(lines, /Found (\d+) errors?/u) ??
        (lines.filter((line) => /\berror TS\d+:/u.test(line)).length || null);
      return errors ? `Typecheck found ${countWord(errors, "error")}` : "Typecheck failed";
    }
    if (check === "lint") {
      if (!failed) return "Lint passed";
      const problems =
        countMatch(lines, /(\d+) problems?/u) ??
        countMatch(lines, /Found \d+ warnings? and (\d+) errors?/u);
      return problems ? `Lint found ${countWord(problems, "problem")}` : "Lint failed";
    }
    if (check === "format") {
      if (failed) return formatWrites ? "Formatting failed" : "Formatting check failed";
      return formatWrites ? "Formatted code" : "Formatting check passed";
    }
    if (check === "build") {
      return failed ? "Build failed" : "Build passed";
    }
    return failed ? "Checks failed" : "Checks passed";
  }
  const words = checks.map((check) => CHECK_WORDS[check]);
  return failed
    ? `${capitalize(joinWords(words, "or"))} failed`
    : `${capitalize(joinWords(words))} passed`;
}

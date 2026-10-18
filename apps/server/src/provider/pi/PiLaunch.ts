/**
 * How a `pi --mode rpc` process is launched for each kind of work: its flags,
 * the user's own extra flags, and its environment. The table is pure, so it
 * is tested on its own (docs/providers/pi-plan.md, "Process and protocol").
 *
 * Unlike Muse Code, a Pi process's flags never encode the access level or
 * plan mode: the Threadlines extension reads them from its environment at
 * launch and takes live changes through its `/threadlines-mode` command. Only
 * the session flags differ between a thread's processes.
 *
 * @module provider/pi/PiLaunch
 */
import type { ProviderInstanceEnvironment, RuntimeMode } from "@threadlines/contracts";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

/** How to run Pi: the program and the arguments before Pi's own. */
export interface PiLauncher {
  /** `pi`, the user's binary, or Node for the copy Threadlines installs. */
  readonly command: string;
  /** For a managed install, the path of Pi's `cli.js`. */
  readonly prefixArgs: ReadonlyArray<string>;
}

/** No Pi to run: not installed, too old, or Threadlines' copy can't start. */
export class PiLaunchUnavailable extends Data.TaggedError("PiLaunchUnavailable")<{
  /** Plain language, safe to show a user. */
  readonly message: string;
}> {}

/**
 * How to run Pi for one process. Run it in the process's scope: Threadlines'
 * own copy stays leased until the scope closes, so an update never replaces
 * files a running Pi has loaded.
 */
export type PiLaunch = Effect.Effect<PiLauncher, PiLaunchUnavailable, Scope.Scope>;

/** Which conversation a process opens. */
export type PiSessionTarget =
  /** A new session in the process's folder. */
  | { readonly kind: "new" }
  /** An existing session file, in the folder its header names. */
  | { readonly kind: "resume"; readonly sessionFile: string }
  /** A copy of an existing session, in the process's own folder. */
  | { readonly kind: "fork"; readonly sessionFile: string }
  /** Nothing written to disk. */
  | { readonly kind: "none" };

export type PiProcessSpec =
  /** A thread's conversation, with the Threadlines extension. */
  | {
      readonly purpose: "chat";
      readonly session: Exclude<PiSessionTarget, { readonly kind: "none" }>;
      readonly launchArgs: ReadonlyArray<string>;
      readonly extensionPath: string;
      /** Threadlines' standing instructions, as a file (never inline text: see below). */
      readonly instructionsPath: string | undefined;
    }
  /** Models, commands and state, with the user's extensions so their providers count. */
  | { readonly purpose: "discovery"; readonly launchArgs: ReadonlyArray<string> }
  /** Copies a session into another folder: no extensions, no tools, no model needed. */
  | { readonly purpose: "fork"; readonly sessionFile: string }
  /** Titles and commit messages: nothing written, no tools, the user's extensions on. */
  | { readonly purpose: "utility"; readonly launchArgs: ReadonlyArray<string> };

function sessionFlags(session: PiSessionTarget): ReadonlyArray<string> {
  switch (session.kind) {
    case "new":
      return [];
    case "resume":
      return ["--session", session.sessionFile];
    case "fork":
      return ["--fork", session.sessionFile];
    case "none":
      return ["--no-session"];
  }
}

/**
 * Everything after the program. Instructions go in as a file path: on Windows
 * a `pi.cmd` launcher runs under cmd.exe, which mangles long multi-line text.
 */
export function piProcessArgs(launcher: PiLauncher, spec: PiProcessSpec): Array<string> {
  const base = [...launcher.prefixArgs, "--mode", "rpc"];
  switch (spec.purpose) {
    case "chat":
      return [
        ...base,
        ...spec.launchArgs,
        ...sessionFlags(spec.session),
        "--extension",
        spec.extensionPath,
        ...(spec.instructionsPath ? ["--append-system-prompt", spec.instructionsPath] : []),
      ];
    case "discovery":
      return [...base, ...spec.launchArgs, "--no-session"];
    case "fork":
      return [...base, "--no-extensions", "--no-tools", "--fork", spec.sessionFile];
    case "utility":
      // A tools list would override `--no-tools`: these processes run no tools at all.
      return [...base, ...withoutToolSelection(spec.launchArgs), "--no-session", "--no-tools"];
  }
}

// ── The user's extra flags ───────────────────────────────────────────

/** Pi's flags that choose tools, and whether each takes a value. */
const TOOL_SELECTION_FLAGS: ReadonlyMap<string, boolean> = new Map([
  ["--tools", true],
  ["-t", true],
  ["--exclude-tools", true],
  ["-xt", true],
  ["--no-builtin-tools", false],
  ["-nbt", false],
]);

/** The user's flags without the ones that choose tools. */
function withoutToolSelection(args: ReadonlyArray<string>): Array<string> {
  const kept: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    const [flag] = word.split("=", 1) as [string];
    const takesValue = TOOL_SELECTION_FLAGS.get(flag);
    if (takesValue === undefined) {
      kept.push(word);
      continue;
    }
    if (takesValue && !word.includes("=")) index += 1;
  }
  return kept;
}

/** Pi flags that take a value (the next word), so it is not read as a prompt. */
const FLAGS_WITH_VALUE = new Set([
  "--provider",
  "--model",
  "--models",
  "--thinking",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme",
  "--use-theme",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--tui-mode",
]);

/** Flags Threadlines owns, or that would break an RPC session. */
const REFUSED_FLAGS: ReadonlyMap<string, string> = new Map([
  ["--mode", "Threadlines runs Pi in RPC mode itself."],
  ["--session", "Threadlines picks the session."],
  ["--session-id", "Threadlines picks the session."],
  ["--session-dir", "Threadlines reads sessions from Pi's own folder."],
  ["--fork", "Threadlines picks the session."],
  ["--continue", "Threadlines picks the session."],
  ["-c", "Threadlines picks the session."],
  ["--resume", "Threadlines picks the session."],
  ["-r", "Threadlines picks the session."],
  ["--no-session", "Threadlines keeps every conversation."],
  ["--print", "Threadlines runs Pi in RPC mode itself."],
  ["-p", "Threadlines runs Pi in RPC mode itself."],
  ["--export", "Threadlines runs Pi in RPC mode itself."],
  ["--list-models", "Threadlines runs Pi in RPC mode itself."],
  ["--version", "Threadlines runs Pi in RPC mode itself."],
  ["--help", "Threadlines runs Pi in RPC mode itself."],
  ["-h", "Threadlines runs Pi in RPC mode itself."],
  ["--api-key", "Put the key in an environment variable instead, so it isn't on the command line."],
  ["--approve", "Threadlines never trusts a project for you; trust it in Pi itself."],
  ["-a", "Threadlines never trusts a project for you; trust it in Pi itself."],
]);

/** Splits flags like a shell would for plain words and quotes; no expansion. */
function splitWords(text: string): Array<string> | undefined {
  const words: Array<string> = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let inWord = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
      continue;
    }
    current += char;
    inWord = true;
  }
  if (quote) return undefined;
  if (inWord) words.push(current);
  return words;
}

/**
 * The instance's extra flags, checked: Threadlines' own flags, a prompt, and
 * `--provider` without `--model` (which Pi 1.0+ refuses at startup) are
 * reported, never silently dropped.
 */
export function parsePiLaunchArgs(
  raw: string,
): { readonly args: ReadonlyArray<string> } | { readonly error: string } {
  const words = splitWords(raw.trim());
  if (!words) return { error: "Launch arguments have an unclosed quote." };
  let sawProvider = false;
  let sawModel = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    const [flag] = word.split("=", 1) as [string];
    const refused = REFUSED_FLAGS.get(flag);
    if (refused) return { error: `Launch arguments can't include ${flag}: ${refused}` };
    if (!word.startsWith("-")) {
      return { error: `Launch arguments can't include a prompt ("${word}").` };
    }
    if (flag === "--provider") sawProvider = true;
    if (flag === "--model" || flag === "--models") sawModel = true;
    if (FLAGS_WITH_VALUE.has(flag) && !word.includes("=")) index += 1;
  }
  if (sawProvider && !sawModel) {
    return { error: "Launch arguments with --provider also need --model." };
  }
  return { args: words };
}

// ── Environment ──────────────────────────────────────────────────────

/** Every extension setting's prefix: inherited ones are always dropped. */
const PI_EXTENSION_ENV_PREFIX = "THREADLINES_PI_";

/** Read by the Threadlines extension at load (see `PiExtensionSource`). */
export const PI_EXTENSION_ENV = {
  access: "THREADLINES_PI_ACCESS",
  plan: "THREADLINES_PI_PLAN",
  toolServers: "THREADLINES_PI_TOOL_SERVERS",
  /**
   * The path of the file holding the tool token and the per-process nonce
   * (see `PiSecrets`), never the secrets themselves.
   */
  secretsFile: "THREADLINES_PI_SECRETS_FILE",
} as const;

/** The access levels the extension knows. `auto` is never offered for Pi. */
export type PiAccessLevel = Exclude<RuntimeMode, "auto">;

export function piAccessLevel(runtimeMode: RuntimeMode): PiAccessLevel {
  // Pi has no classifier: a thread that asks for auto gets approvals.
  return runtimeMode === "auto" ? "approval-required" : runtimeMode;
}

export interface PiToolServer {
  /** The name tools are registered under: `mcp__<name>__<tool>`. */
  readonly name: string;
  readonly url: string;
}

/**
 * A process's whole environment: the server's, the instance's own variables
 * on top, and the extension's settings. Inherited Threadlines variables are
 * dropped first, so a Threadlines running inside Pi never leaks its own.
 */
export function piProcessEnvironment(input: {
  readonly instanceEnvironment: ProviderInstanceEnvironment | undefined;
  readonly baseEnv?: NodeJS.ProcessEnv;
  /** Only for chat processes. */
  readonly extension?: {
    readonly access: PiAccessLevel;
    readonly plan: boolean;
    readonly toolServers: ReadonlyArray<PiToolServer>;
    readonly secretsFile: string;
  };
}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(input.baseEnv ?? process.env)) {
    if (!name.startsWith(PI_EXTENSION_ENV_PREFIX)) base[name] = value;
  }
  const env: NodeJS.ProcessEnv = {
    ...mergeProviderInstanceEnvironment(input.instanceEnvironment, base),
    // Threadlines offers updates itself; Pi's own check is a network call per start.
    PI_SKIP_VERSION_CHECK: "1",
  };
  if (input.extension) {
    env[PI_EXTENSION_ENV.access] = input.extension.access;
    env[PI_EXTENSION_ENV.plan] = input.extension.plan ? "1" : "0";
    env[PI_EXTENSION_ENV.toolServers] = JSON.stringify(input.extension.toolServers);
    env[PI_EXTENSION_ENV.secretsFile] = input.extension.secretsFile;
  }
  return env;
}

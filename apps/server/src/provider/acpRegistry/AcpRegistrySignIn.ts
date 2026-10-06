// @effect-diagnostics nodeBuiltinImport:off - compares paths inside an agent's install folder
/**
 * AcpRegistrySignIn — how each sign-in method a community agent advertises
 * can be run from Threadlines, decided from the agent's own `initialize`
 * answer and what is installed.
 *
 * An agent says how it signs in in one of four forms (see
 * `docs/providers/community-agents-live-record.md` for what the listed
 * agents send):
 * - `agent` (or untyped): it signs in itself on `authenticate`;
 * - `terminal`: its own program, run in a terminal with the method's
 *   arguments;
 * - the older `_meta["terminal-auth"]`: a whole command line;
 * - `env_var`: it reads a key from the environment.
 *
 * Only code the user installed is ever run: a command line that names
 * anything else (`npm install -g …`, another CLI) is refused and the method
 * shown as one the agent handles itself.
 *
 * @module provider/acpRegistry/AcpRegistrySignIn
 */
import * as NodePath from "node:path";

import type { AcpRegistrySignInMethod } from "@threadlines/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

const LEGACY_TERMINAL_AUTH_KEY = "terminal-auth";
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 1024;
const MAX_ENV_ENTRIES = 64;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A command line for the sign-in terminal. Never run through a shell. */
export interface AcpRegistrySignInCommand {
  readonly program: string;
  readonly args: ReadonlyArray<string>;
  /** On top of the agent's usual environment. */
  readonly env: Readonly<Record<string, string>>;
}

export interface AcpRegistrySignInPlan {
  /** What clients are told about the method. */
  readonly method: AcpRegistrySignInMethod;
  /** `terminal` methods: what to run. */
  readonly command?: AcpRegistrySignInCommand;
}

/** The parts of an installed agent that sign-in planning reads. */
export interface AcpRegistrySignInInstall {
  /** The agent's installed files. Only programs inside it may be run. */
  readonly payloadDir: string;
  /** How the agent itself is launched: the program, and what precedes its own arguments. */
  readonly launch: { readonly program: string; readonly prefixArgs: ReadonlyArray<string> };
  /** npm agents: the Node.js they run on. */
  readonly nodeProgram: string | null;
}

export interface AcpRegistrySignInInput {
  readonly authMethods: ReadonlyArray<EffectAcpSchema.AuthMethod>;
  readonly install: AcpRegistrySignInInstall;
  /** Whether `path` is a regular file (not a link). */
  readonly isFile: (path: string) => boolean;
  /**
   * Where `path` really leads once every link on the way is followed, or
   * undefined when it leads nowhere. Default: the path as written.
   */
  readonly realPath?: (path: string) => string | undefined;
  /** Whether an agent may set this environment variable (the registry's filter). */
  readonly allowsEnvName: (name: string) => boolean;
  readonly platform?: NodeJS.Platform;
}

const bounded = (value: string | null | undefined, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const stringArray = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) &&
  value.length <= MAX_ARGS &&
  value.every((item) => typeof item === "string" && item.length <= MAX_ARG_LENGTH)
    ? (value as ReadonlyArray<string>)
    : undefined;

function filteredEnv(
  value: unknown,
  allowsEnvName: (name: string) => boolean,
): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null) return {};
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value).slice(0, MAX_ENV_ENTRIES)) {
    if (typeof entry !== "string" || entry.length > 4096) continue;
    if (!ENV_NAME_PATTERN.test(name) || !allowsEnvName(name)) continue;
    env[name] = entry;
  }
  return env;
}

/** Whether `path` is inside `dir` (and not `dir` itself), by its text. */
function isInside(path: string, dir: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const relative = pathApi.relative(dir, path);
  return relative !== "" && !relative.startsWith("..") && !pathApi.isAbsolute(relative);
}

const isNodeRunner = (program: string, platform: NodeJS.Platform) => {
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const base = pathApi.basename(program).toLowerCase();
  return base === "node" || base === "node.exe";
};

/**
 * The older form's command line, if it only runs what the user installed:
 * a file inside the agent's folder, or Node with such a file as its first
 * argument (run on the agent's own Node, wherever the agent said Node was).
 */
function legacyCommand(
  meta: unknown,
  input: AcpRegistrySignInInput,
  platform: NodeJS.Platform,
): AcpRegistrySignInCommand | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const { command, args: rawArgs, env } = meta as Record<string, unknown>;
  const args = rawArgs === undefined ? [] : stringArray(rawArgs);
  if (typeof command !== "string" || command.length > MAX_ARG_LENGTH || args === undefined) {
    return undefined;
  }
  const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const { payloadDir } = input.install;
  const realPath = input.realPath ?? ((path: string) => path);
  const realPayloadDir = realPath(payloadDir) ?? payloadDir;
  /**
   * The file as Threadlines names it, when `path` is one of the agent's
   * installed files. Judged by where the path really leads: an agent names
   * its files by their real path, and the folder Threadlines knows may be
   * reached through a link (macOS `/tmp`, a home folder that is one). A
   * link that leads out of the install is not one of its files.
   */
  const installedFile = (path: string): string | undefined => {
    if (!pathApi.isAbsolute(path)) return undefined;
    const real = realPath(pathApi.normalize(path));
    if (real === undefined || !isInside(real, realPayloadDir, platform)) return undefined;
    return input.isFile(real)
      ? pathApi.join(payloadDir, pathApi.relative(realPayloadDir, real))
      : undefined;
  };
  const environment = filteredEnv(env, input.allowsEnvName);
  const program = installedFile(command);
  if (program !== undefined) return { program, args, env: environment };
  const [script, ...rest] = args;
  const installedScript =
    isNodeRunner(command, platform) && input.install.nodeProgram !== null && script !== undefined
      ? installedFile(script)
      : undefined;
  if (installedScript !== undefined && input.install.nodeProgram !== null) {
    return {
      program: input.install.nodeProgram,
      args: [installedScript, ...rest],
      env: environment,
    };
  }
  return undefined;
}

/**
 * One plan per advertised method, in the agent's order. The first that
 * isn't `unsupported` is the agent's default.
 */
export function planAcpRegistrySignIn(
  input: AcpRegistrySignInInput,
): ReadonlyArray<AcpRegistrySignInPlan> {
  const platform = input.platform ?? process.platform;
  return input.authMethods.slice(0, 16).map((authMethod): AcpRegistrySignInPlan => {
    const describe = (
      kind: AcpRegistrySignInMethod["kind"],
      envVars: ReadonlyArray<string> = [],
    ): AcpRegistrySignInMethod => ({
      id: bounded(authMethod.id, 128),
      name: bounded(authMethod.name, 160) || bounded(authMethod.id, 128),
      description: bounded(authMethod.description, 1024) || null,
      kind,
      envVars,
    });
    if ("type" in authMethod && authMethod.type === "env_var") {
      return {
        method: describe(
          "envVar",
          authMethod.vars
            .map((variable) => variable.name)
            .filter((name) => ENV_NAME_PATTERN.test(name) && name.length <= 128)
            .slice(0, 16),
        ),
      };
    }
    const legacyMeta = authMethod._meta?.[LEGACY_TERMINAL_AUTH_KEY];
    const legacy =
      legacyMeta === undefined ? undefined : legacyCommand(legacyMeta, input, platform);
    // Where an agent sends both forms, the older one spells out the whole line.
    if (legacy) return { method: describe("terminal"), command: legacy };
    if ("type" in authMethod && authMethod.type === "terminal") {
      const args = stringArray(authMethod.args ?? []);
      if (args === undefined) return { method: describe("unsupported") };
      return {
        method: describe("terminal"),
        // The method's arguments stand in for the registry's, not after them:
        // what the registry's guide says, and what the agents that use this
        // form mean.
        command: {
          program: input.install.launch.program,
          args: [...input.install.launch.prefixArgs, ...args],
          env: filteredEnv(authMethod.env, input.allowsEnvName),
        },
      };
    }
    // A command line that was refused: the agent signs in its own way.
    if (legacyMeta !== undefined) return { method: describe("unsupported") };
    return { method: describe("agent") };
  });
}

/** The method to use when the user hasn't picked one: their pick if still offered, else the first usable. */
export function selectAcpRegistrySignIn(
  plans: ReadonlyArray<AcpRegistrySignInPlan>,
  pickedId: string,
): AcpRegistrySignInPlan | undefined {
  const usable = plans.filter(
    (plan) => plan.method.kind === "agent" || plan.method.kind === "terminal",
  );
  return usable.find((plan) => plan.method.id === pickedId) ?? usable[0];
}

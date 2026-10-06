// @effect-diagnostics nodeBuiltinImport:off - joins PATH entries
/**
 * AcpRegistryLaunch — the command line and environment a community agent's
 * process starts with, from what was installed.
 *
 * @module provider/acpRegistry/AcpRegistryLaunch
 */
import * as NodePath from "node:path";

/** What an argument may hold when a launch has to go through `cmd.exe`. */
const SHELL_SAFE_ARGUMENT = /^[A-Za-z0-9_./:=@,+-]*$/u;

export interface AcpRegistryLaunchInput {
  /** How the installed agent starts (see the installer's `launch`). */
  readonly launch: {
    readonly program: string;
    readonly prefixArgs: ReadonlyArray<string>;
    readonly needsShell: boolean;
  };
  /** The agent's own arguments: the registry's, or a sign-in method's in their place. */
  readonly args: ReadonlyArray<string>;
  /** The registry's environment for the agent, already filtered. */
  readonly recipeEnv: Readonly<Record<string, string>>;
  /** The server's environment with the instance's own variables applied. */
  readonly environment: NodeJS.ProcessEnv;
  /** Names of the instance's own variables: they win over the registry's. */
  readonly instanceVariableNames: ReadonlySet<string>;
  /** npm agents: the folder of the Node.js they run on, put first on `PATH`. */
  readonly nodeBinDir: string | null;
  /** Extra variables for this launch (a sign-in method's), under the instance's own. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly platform?: NodeJS.Platform;
}

export type AcpRegistryLaunchPlan =
  | {
      readonly ok: true;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: NodeJS.ProcessEnv;
      readonly shell: boolean;
    }
  /** `reason` is plain language, safe to show. */
  | { readonly ok: false; readonly reason: string };

/**
 * Environment: the server's, then the registry's, then the instance's own
 * variables (the user's settings win). `HOME` is whatever the server has, so
 * an agent already signed in through its own CLI stays signed in.
 *
 * No shell, with one exception: a non-JavaScript npm bin on Windows is a
 * `.cmd` file, which only `cmd.exe` can start. That is allowed only when
 * every argument is plain enough that `cmd.exe` cannot read anything into
 * it; otherwise the launch is refused.
 */
export function planAcpRegistryLaunch(input: AcpRegistryLaunchInput): AcpRegistryLaunchPlan {
  const platform = input.platform ?? process.platform;
  const delimiter = platform === "win32" ? NodePath.win32.delimiter : NodePath.posix.delimiter;
  const fromRegistry = (source: Readonly<Record<string, string>>) =>
    Object.fromEntries(
      Object.entries(source).filter(([name]) => !input.instanceVariableNames.has(name)),
    );
  const env: NodeJS.ProcessEnv = {
    ...input.environment,
    ...fromRegistry(input.recipeEnv),
    ...fromRegistry(input.extraEnv ?? {}),
  };
  if (input.nodeBinDir !== null) {
    // Windows spells it `Path`; keep whichever the environment has.
    const pathName = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    env[pathName] = [input.nodeBinDir, env[pathName] ?? ""].filter(Boolean).join(delimiter);
  }
  const args = [...input.launch.prefixArgs, ...input.args];
  if (!input.launch.needsShell) {
    return { ok: true, command: input.launch.program, args, env, shell: false };
  }
  const unsafe = args.find((argument) => !SHELL_SAFE_ARGUMENT.test(argument));
  if (unsafe !== undefined || /["%]/u.test(input.launch.program)) {
    return {
      ok: false,
      reason:
        "This agent can only be started through the Windows command prompt, and one of its arguments can't be passed through it safely.",
    };
  }
  return { ok: true, command: `"${input.launch.program}"`, args, env, shell: true };
}

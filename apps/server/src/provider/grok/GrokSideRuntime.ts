/**
 * GrokSideRuntime — a Grok agent locked down for a room's side answer or
 * review (docs/design/rooms-slice-2.md), built from Grok's own pieces:
 *
 * - Its kernel sandbox, `--sandbox read-only` (Seatbelt), blocks every write
 *   outside Grok's home and the temp folders, for the file tools and every
 *   command alike. macOS only: Linux's Landlock leaves a file's mode,
 *   timestamps and (before kernel 6.2) length writable. Grok carries on unsandboxed when
 *   the kernel refuses the profile, so `verifyStarted` reads Grok's own
 *   record of its start and refuses unless the profile was enforced, and
 *   unless no folder it may write overlaps the checkout.
 * - A throwaway `GROK_HOME`: none of the user's settings, hooks, plugins, MCP
 *   servers, skills, rules or memory. Its shell doesn't run the user's login
 *   profile (`.zshrc` and the like). The other harnesses' settings (Claude,
 *   Cursor, Codex) are not scanned, team settings are never fetched, and a
 *   machine with an administrator's Grok policy is refused, since that
 *   policy's hooks can't be turned off.
 * - Folder trust forced on, so the checkout's own instructions, hooks and MCP
 *   servers stay unloaded. Grok trusts the home folder and the disk root
 *   whatever the gate says, so a checkout there is refused.
 * - A copy of the sign-in without its refresh token: the copy can never renew,
 *   rotate or break the user's own sign-in. A sign-in close to expiring is
 *   first renewed the normal way (`renewSignIn`).
 *
 * The generic ACP core adds the rest: only the room's read tools, every
 * approval and question declined, no mode changes, a fresh start.
 *
 * @module provider/grok/GrokSideRuntime
 */
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as EffectAcpErrors from "effect-acp/errors";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { AcpSideRuntime } from "../acp/AcpProviderDescriptor.ts";
import type { AcpSpawnInput } from "../acp/AcpSessionRuntime.ts";
import { deleteEnvVars, setEnvVar } from "../ProviderInstanceEnvironment.ts";
import { driverAnswersOnTheSide } from "../sideAnswerDrivers.ts";
import { makeSideRuntimeHome, removeSideRuntimeHome } from "../sideRuntimeHome.ts";

/**
 * Long enough for any side answer: a room request gives up well before. A
 * sign-in with less left is renewed first, since the copy can't renew itself.
 */
const MIN_SIGN_IN_LIFETIME_MS = 40 * 60_000;

/** Grok's sandbox profile for a side runtime: read everywhere, write nowhere but its home and temp. */
const SIDE_SANDBOX_PROFILE = "read-only";

/**
 * The command line: the sandbox; Grok's default permission mode, so every
 * step that needs approval comes to Threadlines (which allows it once, inside
 * the sandbox: Grok ends its turn on a declined step); no subagents, no plan
 * mode, never the shared leader. Top-level flags go before `agent`.
 */
export const GROK_SIDE_RUNTIME_ARGS: ReadonlyArray<string> = [
  "--no-auto-update",
  "--sandbox",
  SIDE_SANDBOX_PROFILE,
  "--permission-mode",
  "default",
  "--no-subagents",
  "--no-plan",
  "agent",
  "--no-leader",
  "stdio",
];

/**
 * Variables that would bring something of the user's back in: another
 * sign-in or its path, a deployment key (team settings), a config overlay, a
 * custom agent (its prompt and hooks), and our own trust-off switch.
 */
const REMOVED_VARIABLES = [
  "GROK_AUTH_PATH",
  "GROK_AUTH",
  "GROK_DEPLOYMENT_KEY",
  "GROK_CONFIG",
  "GROK_CONFIG_PATH",
  "GROK_AGENT",
  "GROK_FOLDER_TRUST",
] as const;

/** Grok's discovery of other harnesses' settings, every cell that has a variable. */
const COMPAT_VARIABLES = [
  "GROK_CLAUDE_AGENTS_ENABLED",
  "GROK_CLAUDE_HOOKS_ENABLED",
  "GROK_CLAUDE_MCPS_ENABLED",
  "GROK_CLAUDE_RULES_ENABLED",
  "GROK_CLAUDE_SKILLS_ENABLED",
  "GROK_CURSOR_AGENTS_ENABLED",
  "GROK_CURSOR_HOOKS_ENABLED",
  "GROK_CURSOR_MCPS_ENABLED",
  "GROK_CURSOR_RULES_ENABLED",
  "GROK_CURSOR_SKILLS_ENABLED",
] as const;

/**
 * The side runtime's config: every harness-compatibility cell off, Codex's
 * too (those have no variable), and a shell that doesn't run the user's login
 * profile. Everything else is Grok's default in an empty home.
 */
export const GROK_SIDE_RUNTIME_CONFIG = [
  "[compat.claude]",
  "skills = false",
  "rules = false",
  "agents = false",
  "mcps = false",
  "hooks = false",
  "sessions = false",
  "",
  "[compat.cursor]",
  "skills = false",
  "rules = false",
  "agents = false",
  "mcps = false",
  "hooks = false",
  "sessions = false",
  "",
  "[compat.codex]",
  "skills = false",
  "hooks = false",
  "sessions = false",
  "",
  "[toolset.bash]",
  "login_shell_capture = false",
  "",
].join("\n");

/** The side runtime's environment: the instance's, then locked down around `home`. */
export function grokSideRuntimeEnvironment(
  base: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  deleteEnvVars(env, REMOVED_VARIABLES, platform);
  for (const name of COMPAT_VARIABLES) setEnvVar(env, name, "0", platform);
  setEnvVar(env, "GROK_HOME", home, platform);
  // Grok may write its temp folder; a user's TMPDIR could sit in the checkout.
  setEnvVar(env, "TMPDIR", path.join(home, "tmp"), platform);
  setEnvVar(env, "GROK_SANDBOX", SIDE_SANDBOX_PROFILE, platform);
  setEnvVar(env, "GROK_FOLDER_TRUST", "1", platform);
  setEnvVar(env, "GROK_MANAGED_CONFIG", "0", platform);
  setEnvVar(env, "GROK_DISABLE_EXPERIMENTS", "1", platform);
  setEnvVar(env, "GROK_MEMORY", "0", platform);
  setEnvVar(env, "GROK_SUBAGENTS", "0", platform);
  setEnvVar(env, "GROK_WORKFLOWS", "0", platform);
  setEnvVar(env, "GROK_GOAL", "0", platform);
  return env;
}

type SignInStore = Readonly<Record<string, unknown>>;

/**
 * The sign-in to copy: every entry of the user's `auth.json` without its
 * refresh token, and how long the soonest-expiring one has left.
 */
export function strippedGrokSignIn(
  store: SignInStore,
  nowMs: number,
): { readonly store: SignInStore; readonly shortestMs: number } | undefined {
  const entries = Object.entries(store).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1]),
  );
  if (entries.length === 0) return undefined;
  let shortestMs = Number.POSITIVE_INFINITY;
  const stripped: Record<string, unknown> = {};
  for (const [scope, entry] of entries) {
    const { refresh_token: _dropped, ...rest } = entry;
    stripped[scope] = rest;
    const expiresAt = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
    shortestMs = Math.min(shortestMs, Number.isNaN(expiresAt) ? 0 : expiresAt - nowMs);
  }
  return { store: stripped, shortestMs };
}

const isWithin = (child: string, parent: string) => {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** A writable folder that holds the checkout or lies inside it, if any. */
export function writableOverlap(
  checkout: string,
  writable: ReadonlyArray<string>,
): string | undefined {
  return writable.find((folder) => isWithin(checkout, folder) || isWithin(folder, checkout));
}

const realOrSelf = (target: string) => fs.realpath(target).catch(() => target);

/**
 * Why Grok's record of its start (`sessions/sandbox-events.jsonl`) does not
 * show the side runtime locked down, or undefined when it does. `writable`
 * resolves a folder the way the checkout was resolved.
 */
export async function sandboxRecordProblem(
  record: string | undefined,
  checkout: string,
  resolve: (folder: string) => Promise<string> = realOrSelf,
): Promise<string | undefined> {
  if (record === undefined) return "Grok left no record of its sandbox.";
  const events = record
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line): Array<Record<string, unknown>> => {
      try {
        const parsed: unknown = JSON.parse(line);
        return typeof parsed === "object" && parsed !== null
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
  if (events.some((event) => event.event_type === "ApplyFailed" || event.enforced === false)) {
    return "Grok's sandbox could not be applied on this computer.";
  }
  const applied = events.find(
    (event) =>
      event.event_type === "ProfileApplied" &&
      event.enforced === true &&
      event.profile === SIDE_SANDBOX_PROFILE,
  );
  if (applied === undefined) return "Grok did not apply its read-only sandbox.";
  const listed = Array.isArray(applied.read_write_paths) ? applied.read_write_paths : [];
  const writable = await Promise.all(
    listed.filter((entry): entry is string => typeof entry === "string").map(resolve),
  );
  const overlap = writableOverlap(checkout, writable);
  return overlap === undefined
    ? undefined
    : `Grok's sandbox could write to ${overlap}, which overlaps this checkout.`;
}

/** An administrator's Grok policy, whose hooks a side runtime can't turn off. */
const MACHINE_POLICY_FILES = (platform: NodeJS.Platform, user: string) => [
  "/etc/grok/managed_config.toml",
  "/etc/grok/requirements.toml",
  ...(platform === "darwin"
    ? [
        "/Library/Managed Preferences/ai.x.grok.plist",
        `/Library/Managed Preferences/${user}/ai.x.grok.plist`,
      ]
    : []),
];

const exists = (target: string) =>
  fs.lstat(target).then(
    () => true,
    () => false,
  );

const refuse = (detail: string) =>
  Effect.fail(
    EffectAcpErrors.AcpRequestError.internalError(`Grok can't answer on the side: ${detail}`),
  );

const attempt = <A>(detail: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      EffectAcpErrors.AcpRequestError.internalError(
        `Grok can't answer on the side: ${detail} (${String(cause)})`,
      ),
  });

export interface GrokSideRuntimeInput {
  /** The thread's checkout. */
  readonly cwd: string;
  /** The instance's own Grok environment (`grokProcessEnvironment`). */
  readonly baseEnvironment: NodeJS.ProcessEnv;
  /** The Grok binary, resolved in that environment. */
  readonly command: string;
  readonly billsByKey: boolean;
  /** The user's `auth.json`, the one their own Grok reads. */
  readonly signInPath: string;
  /** Renews the user's sign-in through their own Grok; errors are the caller's to ignore. */
  readonly renewSignIn: Effect.Effect<void>;
  readonly platform?: NodeJS.Platform;
}

export const prepareGrokSideRuntime = (
  input: GrokSideRuntimeInput,
): Effect.Effect<AcpSideRuntime, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const platform = input.platform ?? process.platform;
    if (!driverAnswersOnTheSide("grok", platform)) {
      return yield* refuse("its sandbox keeps a checkout read-only on macOS only.");
    }
    const checkout = yield* attempt("the checkout could not be read", () => fs.realpath(input.cwd));
    const userHome = yield* Effect.promise(() => realOrSelf(os.homedir()));
    if (checkout === userHome || checkout === path.parse(checkout).root) {
      return yield* refuse("Grok trusts a checkout at the home folder or the disk root.");
    }
    const user = os.userInfo().username;
    for (const policy of MACHINE_POLICY_FILES(platform, user)) {
      if (yield* Effect.promise(() => exists(policy))) {
        return yield* refuse(`this computer has a Grok policy (${policy}) whose hooks always run.`);
      }
    }
    if (!input.billsByKey && input.baseEnvironment.GROK_AUTH !== undefined) {
      return yield* refuse("its sign-in comes from GROK_AUTH, which a side answer can't borrow.");
    }

    const home = yield* Effect.acquireRelease(
      makeSideRuntimeHome("grok").pipe(
        Effect.mapError((error) => EffectAcpErrors.AcpRequestError.internalError(error.message)),
      ),
      (made) => removeSideRuntimeHome(made),
    );
    const tmp = path.join(home, "tmp");
    yield* attempt("its temp folder could not be made", () => fs.mkdir(tmp, { mode: 0o700 }));

    // The folders Grok's profile may write that we know before it starts.
    const knownWritable = yield* Effect.promise(() =>
      Promise.all(
        [
          home,
          tmp,
          "/tmp",
          "/var/tmp",
          os.tmpdir(),
          ...(platform === "darwin" ? ["/private/var/folders"] : []),
        ].map(realOrSelf),
      ),
    );
    const overlap = writableOverlap(checkout, knownWritable);
    if (overlap !== undefined) {
      return yield* refuse(`the checkout overlaps ${overlap}, which its sandbox lets it write.`);
    }

    if (!input.billsByKey) {
      const readSignIn = () =>
        fs
          .readFile(input.signInPath, "utf8")
          .then((text) => {
            const parsed: unknown = JSON.parse(text);
            return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
              ? strippedGrokSignIn(parsed as SignInStore, Date.now())
              : undefined;
          })
          .catch(() => undefined);
      let signIn = yield* Effect.promise(readSignIn);
      if (signIn !== undefined && signIn.shortestMs < MIN_SIGN_IN_LIFETIME_MS) {
        yield* input.renewSignIn;
        signIn = yield* Effect.promise(readSignIn);
      }
      if (signIn === undefined) {
        return yield* refuse("Grok isn't signed in.");
      }
      if (signIn.shortestMs < MIN_SIGN_IN_LIFETIME_MS) {
        return yield* refuse("Grok's sign-in expires soon and could not be renewed.");
      }
      const store = signIn.store;
      yield* attempt("its sign-in could not be copied", () =>
        fs.writeFile(path.join(home, "auth.json"), JSON.stringify(store), {
          mode: 0o600,
          flag: "wx",
        }),
      );
    }
    yield* attempt("its config could not be written", () =>
      fs.writeFile(path.join(home, "config.toml"), GROK_SIDE_RUNTIME_CONFIG, { flag: "wx" }),
    );

    const spawn: AcpSpawnInput = {
      command: input.command,
      args: [...GROK_SIDE_RUNTIME_ARGS],
      cwd: checkout,
      env: grokSideRuntimeEnvironment(input.baseEnvironment, home),
      inheritEnv: false,
    };
    const verifyStarted = Effect.gen(function* () {
      const record = yield* Effect.promise(() =>
        fs
          .readFile(path.join(home, "sessions", "sandbox-events.jsonl"), "utf8")
          .catch(() => undefined),
      );
      const problem = yield* Effect.promise(() => sandboxRecordProblem(record, checkout));
      if (problem !== undefined) return yield* refuse(problem);
    });
    // Grok ends its whole turn on a declined step, so steps are allowed once
    // and the verified sandbox is what refuses a write.
    return { spawn, verifyStarted, approvals: "approve-once" } satisfies AcpSideRuntime;
  });

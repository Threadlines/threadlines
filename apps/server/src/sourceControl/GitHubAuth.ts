import { SourceControlProviderError, type GitHubAuthState } from "@threadlines/contracts";
import { hideWindowsConsole } from "@threadlines/shared/childProcess";
import { isCommandAvailable } from "@threadlines/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { planCliSpawn } from "../cliSpawn.ts";
import { THREADLINES_GITHUB_CLI_ENV } from "./GitHubCliEnvironment.ts";

const DEVICE_URL = "https://github.com/login/device";
const AUTH_OUTPUT_LIMIT = 8_192;

export interface GitHubAuthShape {
  readonly getState: Effect.Effect<GitHubAuthState>;
  readonly start: Effect.Effect<GitHubAuthState, SourceControlProviderError>;
  readonly cancel: Effect.Effect<void>;
  readonly configureGit: Effect.Effect<void, SourceControlProviderError>;
}

export class GitHubAuth extends Context.Service<GitHubAuth, GitHubAuthShape>()(
  "threadlines/source-control/GitHubAuth",
) {}

interface GitHubAuthOptions {
  readonly commandAvailable?: (command: string) => boolean;
  readonly environment?: () => NodeJS.ProcessEnv;
}

const authError = (detail: string) =>
  new SourceControlProviderError({ provider: "github", operation: "signIn", detail });

const authState = (status: GitHubAuthState["status"], message: string | null): GitHubAuthState => ({
  status,
  verificationUrl: null,
  userCode: null,
  message,
});

/** The server owns the sign-in process, so reconnecting clients can resume its device prompt. */
export const make = Effect.fn("makeGitHubAuth")(function* (options: GitHubAuthOptions = {}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const state = yield* Ref.make(authState("idle", null));
  const lock = yield* Semaphore.make(1);
  const commandAvailable = options.commandAvailable ?? isCommandAvailable;
  const environment = options.environment ?? (() => process.env);
  let activeFiber: Fiber.Fiber<void> | null = null;

  const runCommand = Effect.fn("GitHubAuth.runCommand")(function* (
    args: ReadonlyArray<string>,
    onStderr?: (chunk: string) => Effect.Effect<void>,
  ) {
    const env = {
      ...environment(),
      ...THREADLINES_GITHUB_CLI_ENV,
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    };
    const plan = planCliSpawn("gh", args, env);
    const child = yield* spawner.spawn(
      ChildProcess.make(
        plan.command,
        [...plan.args],
        hideWindowsConsole({
          ...plan.options,
          env,
          extendEnv: false,
          stdin: "ignore",
          forceKillAfter: "5 seconds",
        }),
      ),
    );
    yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
    const [, , exitCode] = yield* Effect.all(
      [
        Stream.runDrain(child.stdout),
        child.stderr.pipe(Stream.decodeText(), Stream.runForEach(onStderr ?? (() => Effect.void))),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return Number(exitCode);
  });

  const setupGit = runCommand(["auth", "setup-git", "--hostname", "github.com"]).pipe(
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.flatMap((exitCode) =>
      exitCode === 0 ? Effect.void : Effect.fail(new Error("GitHub Git credential setup failed.")),
    ),
    Effect.mapError(
      () =>
        new SourceControlProviderError({
          provider: "github",
          operation: "configureGit",
          detail:
            "Git is installed, but GitHub could not configure Git access. Run `gh auth setup-git --hostname github.com` to use your GitHub account for Git.",
        }),
    ),
  );

  const verifyCredential = runCommand(["api", "--hostname", "github.com", "user", "--silent"]).pipe(
    Effect.scoped,
    Effect.timeout("30 seconds"),
  );

  const run = Effect.gen(function* () {
    let output = "";
    const exitCode = yield* runCommand(
      ["auth", "login", "--hostname", "github.com", "--web"],
      (chunk) =>
        Effect.gen(function* () {
          output = `${output}${chunk}`.slice(-AUTH_OUTPUT_LIMIT);
          const userCode = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/i.exec(output)?.[1];
          if (userCode) {
            yield* Ref.update(state, (current) =>
              current.status === "running"
                ? {
                    ...current,
                    userCode: userCode.toUpperCase(),
                    verificationUrl: DEVICE_URL,
                    message: "Enter this code on GitHub to finish signing in.",
                  }
                : current,
            );
          }
        }),
    ).pipe(Effect.scoped);
    if (exitCode !== 0) {
      return yield* authError(
        "GitHub sign-in did not finish. Try again and complete the browser step.",
      );
    }

    // Check the active credential directly, without printing account data or tokens.
    const verified = yield* verifyCredential;
    if (verified !== 0) {
      return yield* authError(
        "GitHub could not verify the sign-in. Check your connection and try again.",
      );
    }
    let message = "Signed in to GitHub.";
    if (commandAvailable("git")) {
      const configured = yield* setupGit.pipe(Effect.result);
      if (configured._tag === "Failure") {
        message =
          "Signed in to GitHub. Run `gh auth setup-git` to enable Git access with this account.";
      }
    }
    yield* Ref.update(state, (current) =>
      current.status === "running" ? authState("succeeded", message) : current,
    );
  }).pipe(
    Effect.timeoutOption("15 minutes"),
    Effect.flatMap((result) =>
      Option.isNone(result)
        ? Effect.fail(authError("GitHub sign-in timed out. Start again to get a new code."))
        : Effect.void,
    ),
    Effect.catch((error) =>
      Ref.update(state, (current) =>
        current.status === "running"
          ? authState(
              "failed",
              error instanceof SourceControlProviderError
                ? error.detail
                : "GitHub sign-in could not run. Check that GitHub CLI is installed and try again.",
            )
          : current,
      ),
    ),
  );

  return GitHubAuth.of({
    getState: Ref.get(state),
    // Git may be installed after GitHub sign-in, including across server restarts.
    configureGit: Effect.gen(function* () {
      if (!commandAvailable("git") || !commandAvailable("gh")) return;
      const verified = yield* verifyCredential.pipe(Effect.catch(() => Effect.succeed(-1)));
      if (verified === 0) yield* setupGit;
    }),
    start: Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (current.status === "running") return current;
      const env = environment();
      if (env.GH_TOKEN || env.GITHUB_TOKEN) {
        return yield* authError(
          "GitHub credentials are set through GH_TOKEN or GITHUB_TOKEN on this server. Update those credentials, or remove the override and restart Threadlines before signing in here.",
        );
      }
      if (!commandAvailable("gh")) {
        return yield* authError("Install GitHub CLI before signing in.");
      }
      const next = authState("running", "Starting GitHub sign-in...");
      yield* Ref.set(state, next);
      activeFiber = yield* run.pipe(Effect.interruptible, Effect.forkIn(scope));
      return next;
    }).pipe(lock.withPermits(1), Effect.uninterruptible),
    cancel: Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (current.status !== "running") return;
      yield* Ref.set(state, authState("cancelled", "GitHub sign-in cancelled."));
      if (activeFiber) {
        yield* Fiber.interrupt(activeFiber);
        activeFiber = null;
      }
    }).pipe(lock.withPermits(1), Effect.uninterruptible),
  });
});

export const layer = Layer.effect(GitHubAuth, make());

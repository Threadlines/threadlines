// @effect-diagnostics nodeBuiltinImport:off - runs `agy acp --login` and talks to it over its pipes
/**
 * AntigravityAuth — sign-in and sign-out for one Antigravity instance, per
 * its sign-in method.
 *
 * Google account and Gemini Enterprise sign in with the CLI's own
 * `agy acp --login`, run in the instance's profile: it prints a Google link,
 * Google ends on an antigravity.google page that shows a code, and the CLI
 * reads that code back on its input. The link opens on the device that
 * started sign-in (a phone, another computer, this one), and the code is
 * asked for in the same panel, tied to this run; Threadlines checks it and
 * hands it to the waiting process only. The sign-in is kept in the
 * profile's own file (`antigravityEnvironment`), so extra accounts don't
 * share one, and success is a real session opening on it afterwards.
 *
 * Sign-out removes that file and nothing else: no agent is asked to log
 * out, so the OS keyring and the user's own terminal `agy` are never
 * touched.
 *
 * The key methods have nothing to sign in to: "login" checks what can be
 * checked without spending (Google accepting a Gemini API key; Vertex AI's
 * project and Google Cloud sign-in) and records the verdict for the status.
 * They don't stop running sessions.
 *
 * Google sign-in and sign-out close the instance first: no new agent
 * process starts, its sessions stop (they hold the old credentials in
 * memory), and the flow waits for every other process of the instance to
 * end before it touches the profile.
 *
 * @module provider/antigravity/AntigravityAuth
 */
import { type ChildProcessWithoutNullStreams, spawn as spawnChild } from "node:child_process";
import { createInterface } from "node:readline";

import type { AntigravitySettings, ProviderAuthQuestionKind } from "@threadlines/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import { THREADLINES_ACP_CLIENT_INFO } from "../acp/acpClientInfo.ts";
import type { AcpProviderDescriptor } from "../acp/AcpProviderDescriptor.ts";
import { makeAcpProviderRuntime } from "../acp/AcpProviderRuntime.ts";
import { type LaunchGate, withLaunchGateClosed } from "../managedRuntime/LaunchGate.ts";
import type { ProviderInstanceAuthFlows } from "../ProviderDriver.ts";
import {
  antigravityCredentialFingerprint,
  antigravityMissingSetup,
  type AntigravitySignInConfig,
  checkGeminiApiKey,
  removeAntigravityGoogleSignIn,
  resolveAntigravityAdc,
  writeAntigravityGoogleSignIn,
  writeAntigravityProfileSettings,
  writeAntigravitySignInCheck,
} from "./AntigravitySignInMethod.ts";
import { ProviderSetupError } from "../Errors.ts";

/** How long the CLI may take to print its link: Windows cold starts unpack first. */
const LINK_TIMEOUT = Duration.seconds(90);
/** How long the user has to sign in and paste the code. */
const CODE_TIMEOUT = Duration.minutes(10);
/** How long the CLI may take to trade the code for a sign-in. */
const FINISH_TIMEOUT = Duration.minutes(2);
/** Opening a session on the new sign-in. */
const VERIFY_TIMEOUT = Duration.minutes(2);
const SIGN_OUT_TIMEOUT = Duration.seconds(90);
/** Wrong codes accepted before sign-in gives up. */
const CODE_ATTEMPTS = 5;
/** Lines of the CLI's output kept to explain a failure. */
const OUTPUT_TAIL_LINES = 40;
const MAX_URL_LENGTH = 16_384;

/** Where `agy acp --login` sends Google: a page that shows the code to paste back. */
export const ANTIGRAVITY_CODE_REDIRECT_URI = "https://antigravity.google/oauth-callback";

const failure = (message: string) => ({ message });

export interface AntigravityCodeSignInLink {
  readonly url: string;
  readonly state: string;
}

/**
 * The Google link `agy acp --login` prints, if `line` is one: Google's
 * OAuth page, a code request, one state, and Antigravity's code page as the
 * redirect. Anything else is not a link Threadlines opens.
 */
export function parseAntigravityCodeSignInLink(
  line: string,
): AntigravityCodeSignInLink | undefined {
  const raw = line.trim();
  if (!raw.startsWith("https://accounts.google.com/")) return undefined;
  if (raw.length > MAX_URL_LENGTH || /\s/u.test(raw)) return undefined;
  const url = URL.parse(raw);
  if (
    url === null ||
    url.origin !== "https://accounts.google.com" ||
    url.pathname !== "/o/oauth2/auth" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    url.searchParams.get("redirect_uri") !== ANTIGRAVITY_CODE_REDIRECT_URI ||
    url.searchParams.getAll("response_type").length !== 1 ||
    url.searchParams.get("response_type") !== "code" ||
    url.searchParams.getAll("state").length !== 1
  ) {
    return undefined;
  }
  const state = url.searchParams.get("state") ?? "";
  if (state.length === 0 || state.length > 512) return undefined;
  return { url: url.toString(), state };
}

/**
 * What to hand `agy acp --login` for a pasted answer: the code the
 * Antigravity page shows, or that page's whole address when it belongs to
 * this sign-in. Undefined for anything else, a line break included, so a
 * paste can never feed the CLI a second line.
 */
export function antigravityLoginResponse(
  link: AntigravityCodeSignInLink,
  pasted: string,
): string | undefined {
  const value = pasted.trim();
  if (/^[\w./~-]{1,2048}$/u.test(value)) return value;
  if (value.length > MAX_URL_LENGTH || /\s/u.test(value)) return undefined;
  const url = URL.parse(value);
  if (
    url === null ||
    `${url.origin}${url.pathname}` !== ANTIGRAVITY_CODE_REDIRECT_URI ||
    url.username !== "" ||
    url.password !== "" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== link.state ||
    url.searchParams.getAll("code").length !== 1 ||
    !url.searchParams.get("code")
  ) {
    return undefined;
  }
  return value;
}

const VERIFICATION_HOST = "https://accounts.google.com";
const VERIFICATION_PATHS = new Set(["/v3/signin/continue", "/signin/continue"]);

/** A Google account verification page named in `text`, if it is one on Google's own sign-in host. */
export function antigravityVerificationUrl(text: string): string | undefined {
  for (const match of text.matchAll(/https:\/\/accounts\.google\.com\/[^\s"'<>\\]+/gu)) {
    const url = URL.parse(match[0]);
    if (
      url !== null &&
      url.origin === VERIFICATION_HOST &&
      VERIFICATION_PATHS.has(url.pathname) &&
      url.username === "" &&
      url.password === "" &&
      !Array.from(match[0]).some(
        (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
      )
    ) {
      return url.toString();
    }
  }
  return undefined;
}

/** The words a failed Google sign-in shows, from what the CLI or Google said. */
export function antigravitySignInErrorMessage(text: string): string {
  if (/VALIDATION_REQUIRED|verify your account/iu.test(text)) {
    const url = antigravityVerificationUrl(text);
    return url
      ? `Google needs you to verify this account before Antigravity can use it. Verify it at ${url}, then sign in again.`
      : "Google needs you to verify this account before Antigravity can use it. Sign in to Google in your browser to verify it, then sign in again.";
  }
  if (/SUBSCRIPTION_REQUIRED/u.test(text)) {
    return "This Google account can't use Antigravity yet: it needs an eligible plan.";
  }
  if (/access_denied|invalid_grant|denied access|cancelled|onboarding_failed/iu.test(text)) {
    return "Google didn't accept the sign-in. Start again, approve it in your browser, and paste the newest code.";
  }
  if (
    /AF_INET6|enforce_kernel_ipv6_support|network is unreachable|no such host|i\/o timeout|connection refused|dial tcp|TLS handshake|deadline exceeded/iu.test(
      text,
    )
  ) {
    return "Antigravity couldn't reach Google. Check this computer's network connection. Broken IPv6 is a common cause.";
  }
  return "Antigravity couldn't finish signing in with Google. Try again.";
}

/** A sign-in step that failed, with the words for the user. */
class SignInFailed extends Data.TaggedError("AntigravitySignInFailed")<{
  readonly message: string;
}> {}

const signInFailed = (message: string) => new SignInFailed({ message });

export function makeAntigravityAuthFlows(input: {
  /** A descriptor that ignores the gate: the flow's own process must start. */
  readonly descriptor: AcpProviderDescriptor<AntigravitySettings>;
  readonly settings: AntigravitySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly profileDir: string;
  readonly gate: LaunchGate;
  /** Stops every session of the instance. */
  readonly stopSessions: Effect.Effect<void>;
  readonly signIn: AntigravitySignInConfig;
  readonly httpClient: HttpClient.HttpClient;
}): ProviderInstanceAuthFlows {
  const { signIn: method } = input;
  const googleMethod =
    method.method === "oauth-personal" || method.method === "oauth-business"
      ? method.method
      : undefined;
  const enterprise = method.method === "oauth-business";

  // The instance closed and every process of it gone, for as long as
  // `effect` runs.
  const closed = <A, E>(emit: (line: string) => Effect.Effect<void>, effect: Effect.Effect<A, E>) =>
    withLaunchGateClosed(
      input.gate,
      {
        whenAlreadyClosed: () => failure("Antigravity is already signing in or out."),
        whenStillHeld: () =>
          failure("Antigravity is still busy with other work. Try again in a moment."),
        stop: input.stopSessions,
        onWaiting: emit("Waiting for Antigravity to finish its current work…"),
      },
      effect,
    );

  /** `agy acp --login` in the instance's profile, its link, and what it printed. */
  const startLogin = Effect.gen(function* () {
    const planned = input.descriptor.spawn(input.settings, input.profileDir, input.environment);
    const launch = Effect.isEffect(planned) ? yield* planned : planned;
    // Without a display the CLI only prints its link, never opening a
    // browser on the computer that runs Threadlines.
    const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...env } = launch.env ?? {};
    const output: Array<string> = [];
    const link = yield* Deferred.make<AntigravityCodeSignInLink, SignInFailed>();
    const exited = yield* Deferred.make<number | null>();
    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: (): ChildProcessWithoutNullStreams =>
          spawnChild(launch.command, [...launch.args, "--login"], {
            cwd: input.profileDir,
            env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }),
        catch: () =>
          signInFailed("Antigravity didn't start. Check that it's installed, then try again."),
      }),
      // Our own child, by the handle we spawned it with.
      (process) => Effect.sync(() => (process.exitCode === null ? process.kill() : undefined)),
    );
    if (child.pid !== undefined && launch.onSpawned) yield* launch.onSpawned(child.pid);
    const remember = (line: string) => {
      output.push(line.slice(0, 2_000));
      if (output.length > OUTPUT_TAIL_LINES) output.shift();
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      remember(line);
      const parsed = parseAntigravityCodeSignInLink(line);
      if (parsed) Deferred.doneUnsafe(link, Effect.succeed(parsed));
    });
    createInterface({ input: child.stderr }).on("line", remember);
    child.once("error", () =>
      Deferred.doneUnsafe(
        link,
        Effect.fail(
          signInFailed("Antigravity didn't start. Check that it's installed, then try again."),
        ),
      ),
    );
    child.once("close", (code) => {
      Deferred.doneUnsafe(exited, Effect.succeed(code));
      Deferred.doneUnsafe(
        link,
        Effect.fail(
          signInFailed(
            output.length > 0
              ? antigravitySignInErrorMessage(output.join("\n"))
              : "Antigravity didn't start. Check that it's installed, then try again.",
          ),
        ),
      );
    });
    return { child, link, exited, output };
  });

  const askForCode = (
    ask: (question: {
      readonly kind: ProviderAuthQuestionKind;
      readonly message: string;
      readonly placeholder?: string;
    }) => Effect.Effect<string | null>,
    link: AntigravityCodeSignInLink,
  ) =>
    Effect.gen(function* () {
      let message = enterprise
        ? "Sign in with your work Google account in the page that opened, then paste the code the Antigravity page shows."
        : "Sign in with Google in the page that opened, then paste the code the Antigravity page shows.";
      for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
        const answer = yield* ask({ kind: "text", message, placeholder: "Code" });
        if (answer === null) return yield* Effect.fail(signInFailed("Sign-in was cancelled."));
        const response = antigravityLoginResponse(link, answer);
        if (response !== undefined) return response;
        message =
          "That isn't a code from the Antigravity page. Paste the code it shows, or the page's whole address.";
      }
      return yield* Effect.fail(
        signInFailed("Too many codes that didn't fit. Start sign-in again."),
      );
    });

  const signInWithGoogle = (
    googleMethod: "oauth-personal" | "oauth-business",
    emit: (line: string) => Effect.Effect<void>,
    ask: Parameters<typeof askForCode>[0],
    requestPage: (request: {
      readonly url: string;
      readonly message: string | null;
    }) => Effect.Effect<boolean>,
  ) =>
    Effect.gen(function* () {
      // Nothing of the instance runs now: the CLI reads the method and
      // project from the profile when it starts.
      yield* writeAntigravityProfileSettings(input.profileDir, method).pipe(
        Effect.mapError((error) => signInFailed(error.message)),
      );
      yield* emit("Starting Antigravity…");
      const login = yield* startLogin;
      const link = yield* Deferred.await(login.link).pipe(
        Effect.timeoutOrElse({
          duration: LINK_TIMEOUT,
          orElse: () =>
            Effect.fail(
              signInFailed(
                login.output.length > 0
                  ? antigravitySignInErrorMessage(login.output.join("\n"))
                  : "Antigravity didn't start within 90 seconds. Try again.",
              ),
            ),
        }),
      );
      // The link on its own line: clients open it from the output.
      yield* emit(link.url);
      // A CLI that gives up after printing its link (a network error) ends
      // the wait for a code rather than leaving the user to sign in for nothing.
      const exitedEarly = Deferred.await(login.exited).pipe(
        Effect.flatMap(() =>
          Effect.fail(signInFailed(antigravitySignInErrorMessage(login.output.join("\n")))),
        ),
      );
      const response = yield* Effect.raceFirst(askForCode(ask, link), exitedEarly).pipe(
        Effect.timeoutOrElse({
          duration: CODE_TIMEOUT,
          orElse: () =>
            Effect.fail(signInFailed("Sign-in timed out waiting for the code. Try again.")),
        }),
      );
      login.child.stdin.end(`${response}\n`);
      yield* emit("Got the code. Finishing sign-in…");
      const exitCode = yield* Deferred.await(login.exited).pipe(
        Effect.timeoutOrElse({
          duration: FINISH_TIMEOUT,
          orElse: () => Effect.fail(signInFailed("Google didn't answer in time. Try again.")),
        }),
      );
      if (exitCode !== 0) {
        return yield* Effect.fail(
          signInFailed(antigravitySignInErrorMessage(login.output.join("\n"))),
        );
      }
      // A session opening on the new sign-in is the proof, and lists the
      // account's models for the status. Only then is it recorded as this
      // method's sign-in: one Google refuses a session (no plan, unverified)
      // stays signed out.
      yield* emit("Checking the sign-in…");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const acp = yield* makeAcpProviderRuntime(input.descriptor, {
            settings: input.settings,
            environment: input.environment,
            childProcessSpawner: input.childProcessSpawner,
            cwd: input.profileDir,
            clientInfo: THREADLINES_ACP_CLIENT_INFO,
          });
          yield* acp.start();
        }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: VERIFY_TIMEOUT,
          orElse: () =>
            Effect.fail(
              signInFailed("Antigravity signed in but didn't open a session. Try again."),
            ),
        }),
        Effect.mapError((error) =>
          error instanceof SignInFailed
            ? error
            : signInFailed(antigravitySignInErrorMessage(String(error))),
        ),
      );
      yield* writeAntigravityGoogleSignIn(input.profileDir, googleMethod);
      yield* emit("Signed in.");
    }).pipe(
      Effect.scoped,
      // Google's verification page is offered as a page to open (a button on
      // a phone too), not only named in the error.
      Effect.tapError((error) => {
        const url = antigravityVerificationUrl(error.message);
        return url
          ? requestPage({ url, message: "Verify your Google account, then sign in again." })
          : Effect.void;
      }),
      Effect.mapError((error) =>
        failure(error instanceof SignInFailed ? error.message : "Sign-in failed. Try again."),
      ),
    );

  const signOut = (emit: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      yield* emit("Signing out of Antigravity…");
      yield* removeAntigravityGoogleSignIn(input.profileDir);
      yield* emit("Signed out.");
    }).pipe(
      Effect.timeoutOrElse({
        duration: SIGN_OUT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ProviderSetupError({ detail: "Antigravity did not finish signing out." }),
          ),
      }),
      Effect.mapError((error) => failure(error.message || "Sign-out failed.")),
    );

  const recordCheck = (accepted: boolean, message?: string) =>
    Effect.gen(function* () {
      yield* writeAntigravitySignInCheck(input.profileDir, {
        fingerprint: antigravityCredentialFingerprint(method),
        accepted,
        ...(message ? { message } : {}),
        checkedAt: DateTime.formatIso(yield* DateTime.now),
      });
    });

  /** A Gemini API key: Google's free model list says whether it knows the key. */
  const checkKey = (emit: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      yield* emit("Checking the key with Google…");
      const result = yield* checkGeminiApiKey(method.key).pipe(
        Effect.provideService(HttpClient.HttpClient, input.httpClient),
      );
      if (result.verdict === "unreachable") return yield* Effect.fail(failure(result.message));
      if (result.verdict === "rejected") {
        yield* recordCheck(false, result.message);
        return yield* Effect.fail(failure(`Google didn't accept this key: ${result.message}`));
      }
      yield* recordCheck(true);
      yield* emit("Google accepted this key.");
    });

  /** Vertex AI: a key is only tested by a request; without one, the Google Cloud sign-in must be there. */
  const checkVertex = (emit: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      if (method.key) {
        yield* emit("Vertex AI will use this key. Your first request tests it.");
        return;
      }
      const adc = yield* resolveAntigravityAdc(input.environment, process.platform);
      if (adc.status === "found") {
        yield* emit(`Found the Google Cloud sign-in at ${adc.path}. Your first request tests it.`);
        return;
      }
      return yield* Effect.fail(
        failure(
          adc.status === "unreadable"
            ? `The Google Cloud credentials at ${adc.path} can't be read. Fix the file or run \`gcloud auth application-default login\` on the computer that runs Threadlines.`
            : "No Google Cloud sign-in on the computer that runs Threadlines. Run `gcloud auth application-default login` there, then check again.",
        ),
      );
    });

  const missing = antigravityMissingSetup(method);
  const missingMessage =
    missing === "key"
      ? "Add a Gemini API key first."
      : enterprise
        ? "Add your Google Cloud project and location first."
        : "Add your Google Cloud project and location, or a Vertex AI key, first.";

  return {
    flows: googleMethod ? ["login", "logout"] : ["login"],
    describe: (flow) => {
      if (flow === "logout") return "Sign out of Google";
      switch (method.method) {
        case "oauth-business":
          return "Sign in with Gemini Enterprise";
        case "gemini-api-key":
          return "Check the Gemini API key";
        case "agent-platform":
          return "Check Vertex AI";
        default:
          return "Sign in with Google";
      }
    },
    run: ({ flow, report: emit, ask, requestPage }) => {
      if (flow !== "login" && !(flow === "logout" && googleMethod)) {
        return Effect.fail(failure("Antigravity has no such sign-in flow."));
      }
      if (flow === "login" && missing) return Effect.fail(failure(missingMessage));
      // Checks touch neither the profile nor the agent: sessions keep running.
      if (method.method === "gemini-api-key") return checkKey(emit);
      if (method.method === "agent-platform") return checkVertex(emit);
      if (!googleMethod) return Effect.fail(failure("Antigravity has no such sign-in flow."));
      return closed(
        emit,
        flow === "logout" ? signOut(emit) : signInWithGoogle(googleMethod, emit, ask, requestPage),
      );
    },
    // The code from the Antigravity page is asked for in the panel; there is
    // no browser address to replay.
    completeRedirect: () =>
      Effect.fail(
        failure("Antigravity signs in with the code its page shows. Paste that code instead."),
      ),
  };
}

/**
 * AntigravityAuth — sign-in and sign-out for one Antigravity instance, per
 * its sign-in method.
 *
 * Google account and Gemini Enterprise sign in inside the agent's own
 * process (below). The key methods have nothing to sign in to: "login"
 * checks what can be checked without spending (Google accepting a Gemini
 * API key; Vertex AI's project and Google Cloud sign-in) and records the
 * verdict for the status. They don't stop running sessions.
 *
 * Sign-in: the agent prints a Google URL and listens on a 127.0.0.1 port of
 * the machine it runs on for the browser's redirect. A client on the same
 * machine just opens the URL; a client elsewhere (a phone, another
 * computer) ends on an unreachable 127.0.0.1 page and pastes its address
 * back, which is checked against this sign-in and replayed once from here.
 * Success is the agent's own `authenticate` and `session/new` returning,
 * never the replay alone.
 *
 * Both flows close the instance first: no new agent process starts, its
 * sessions stop (they hold the old credentials in memory), and the flow waits
 * for every other process of the instance (a session still starting, a title
 * being written) to end before it touches the profile.
 *
 * @module provider/antigravity/AntigravityAuth
 */

import type { AntigravitySettings } from "@threadlines/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

import type { AcpProviderDescriptor } from "../acp/AcpProviderDescriptor.ts";
import { makeAcpProviderRuntime } from "../acp/AcpProviderRuntime.ts";
import { type LaunchGate, withLaunchGateClosed } from "../managedRuntime/LaunchGate.ts";
import type { ProviderInstanceAuthFlows } from "../ProviderDriver.ts";
import type { LoopbackRedirect } from "@threadlines/shared/signInRedirect";
import { checkLoopbackRedirect, replayLoopbackRedirect } from "../auth/loopbackRedirect.ts";
import {
  antigravityCredentialFingerprint,
  antigravityMissingSetup,
  type AntigravitySignInConfig,
  checkGeminiApiKey,
  resolveAntigravityAdc,
  writeAntigravityProfileSettings,
  writeAntigravitySignInCheck,
} from "./AntigravitySignInMethod.ts";
import { ProviderSetupError } from "../Errors.ts";

const SIGN_IN_TIMEOUT = Duration.minutes(5);
const SIGN_OUT_TIMEOUT = Duration.seconds(90);

interface PendingSignIn {
  readonly redirect: URL;
  readonly state: string;
  consumed: boolean;
}

const failure = (message: string) => ({ message });

function friendlySignInError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/SUBSCRIPTION_REQUIRED/u.test(text)) {
    return "This Google account can't use Antigravity yet: it needs an eligible plan.";
  }
  if (/access_denied|cancelled|onboarding_failed|did not complete/iu.test(text)) {
    return "Sign-in didn't finish. Try again and approve the request in your browser.";
  }
  return text || "Sign-in failed.";
}

/**
 * The pasted address, if it is this sign-in's redirect (see
 * `checkLoopbackRedirect`), with Google as the issuer when one is named.
 * Otherwise the reason, worded for the user.
 */
export function checkAntigravityRedirect(raw: string, pending: LoopbackRedirect): URL | string {
  return checkLoopbackRedirect(raw, pending, {
    issuer: { url: "https://accounts.google.com", name: "Google" },
  });
}

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
  const googleSignIn = method.method === "oauth-personal" || method.method === "oauth-business";
  const enterprise = method.method === "oauth-business";
  let pending: PendingSignIn | undefined;
  let report: ((line: string) => Effect.Effect<void>) | undefined;

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
      effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending = undefined;
            report = undefined;
          }),
        ),
      ),
    );

  const runtime = (options: {
    readonly onSignInUrl?: (url: string) => Effect.Effect<void>;
    readonly authMethodId?: string;
  }) =>
    makeAcpProviderRuntime(input.descriptor, {
      settings: input.settings,
      environment: input.environment,
      childProcessSpawner: input.childProcessSpawner,
      cwd: input.profileDir,
      clientInfo: { name: "threadlines", version: "0.0.0" },
      ...options,
    });

  const signIn = (emit: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      // Nothing of the instance runs now: the agent reads the method and
      // project from the profile when it starts.
      yield* writeAntigravityProfileSettings(input.profileDir, method);
      const acp = yield* runtime({
        authMethodId: method.method,
        onSignInUrl: (url) =>
          Effect.gen(function* () {
            const parsed = new URL(url);
            const redirect = parsed.searchParams.get("redirect_uri");
            const state = parsed.searchParams.get("state");
            if (!redirect || !state) return;
            pending = { redirect: new URL(redirect), state, consumed: false };
            // The URL on its own line: clients open it from the output. The
            // line after it is what their one-line status shows.
            yield* emit(url);
            yield* emit(
              enterprise
                ? "Finish signing in with your work Google account in your browser."
                : "Finish signing in with Google in your browser.",
            );
          }),
      });
      yield* emit("Starting Antigravity…");
      // initialize, authenticate (waits for the browser), then session/new
      // proves the credentials work.
      yield* acp.start().pipe(
        Effect.timeoutOrElse({
          duration: SIGN_IN_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new ProviderSetupError({ detail: "Sign-in timed out after 5 minutes. Try again." }),
            ),
        }),
      );
      yield* emit("Signed in.");
    }).pipe(
      Effect.scoped,
      Effect.mapError((error) => failure(friendlySignInError(error))),
    );

  const signOut = (emit: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const acp = yield* runtime({});
      yield* emit("Signing out of Antigravity…");
      yield* acp.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "threadlines", version: "0.0.0" },
      });
      yield* acp.request("logout", {});
      yield* emit("Signed out.");
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: SIGN_OUT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ProviderSetupError({ detail: "Antigravity did not finish signing out." }),
          ),
      }),
      Effect.mapError((error) =>
        failure(error instanceof Error ? error.message : "Sign-out failed."),
      ),
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
    flows: googleSignIn ? ["login", "logout"] : ["login"],
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
    run: ({ flow, report: emit }) => {
      if (flow !== "login" && !(flow === "logout" && googleSignIn)) {
        return Effect.fail(failure("Antigravity has no such sign-in flow."));
      }
      if (flow === "login" && missing) return Effect.fail(failure(missingMessage));
      // Checks touch neither the profile nor the agent: sessions keep running.
      if (method.method === "gemini-api-key") return checkKey(emit);
      if (method.method === "agent-platform") return checkVertex(emit);
      return closed(
        emit,
        Effect.gen(function* () {
          report = emit;
          if (flow === "logout") return yield* signOut(emit);
          return yield* signIn(emit);
        }),
      );
    },
    completeRedirect: (raw) =>
      Effect.gen(function* () {
        const current = pending;
        if (!current) {
          return yield* Effect.fail(
            failure("No sign-in is waiting for a browser address. Start sign-in first."),
          );
        }
        if (current.consumed) {
          return yield* Effect.fail(failure("This sign-in already received its address."));
        }
        const checked = checkAntigravityRedirect(raw, current);
        if (typeof checked === "string") return yield* Effect.fail(failure(checked));
        const url = checked;
        current.consumed = true;
        const status = yield* Effect.tryPromise({
          try: () => replayLoopbackRedirect(url),
          catch: () => failure("The sign-in stopped listening. Start sign-in again."),
        });
        if (status < 200 || status >= 300) {
          return yield* Effect.fail(failure("Antigravity didn't accept that address."));
        }
        if (report) yield* report("Got the address; finishing sign-in…");
      }),
  };
}

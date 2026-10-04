/**
 * AntigravityAuth — Google sign-in and sign-out for one Antigravity
 * instance, run inside the agent's own process.
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
import { request as httpRequest } from "node:http";

import type { AntigravitySettings } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type { AcpProviderDescriptor } from "../acp/AcpProviderDescriptor.ts";
import { makeAcpProviderRuntime } from "../acp/AcpProviderRuntime.ts";
import type { ProviderInstanceAuthFlows } from "../ProviderDriver.ts";

const SIGN_IN_TIMEOUT = Duration.minutes(5);
const SIGN_OUT_TIMEOUT = Duration.seconds(90);
const REDIRECT_REPLAY_TIMEOUT_MS = 10_000;
const DRAIN_TIMEOUT_MS = 45_000;
const DRAIN_POLL = Duration.millis(250);

/**
 * Shared by an instance's agent processes and its auth flows. Every process
 * holds the gate while it runs; a sign-in or sign-out closes it (`busy`) and
 * waits for the holds to reach zero.
 */
export interface AntigravityAuthGate {
  busy: boolean;
  holds: number;
}

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

/** One GET to the agent's loopback listener: no proxy, no redirects. */
function replayRedirect(url: URL): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: "GET", agent: false, timeout: REDIRECT_REPLAY_TIMEOUT_MS },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("timeout", () => request.destroy(new Error("The sign-in did not answer.")));
    request.on("error", reject);
    request.end();
  });
}

/**
 * The pasted address, if it is this sign-in's redirect: the same loopback
 * origin and path as the pending `redirect_uri`, its exact `state`, one
 * `code` or `error`, and Google as the issuer when one is named. Otherwise
 * the reason, worded for the user.
 */
export function checkAntigravityRedirect(
  raw: string,
  pending: { readonly redirect: URL; readonly state: string },
): URL | string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "That isn't a web address.";
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== pending.redirect.port ||
    url.pathname !== pending.redirect.pathname
  ) {
    return `That address isn't this sign-in's. Paste the full address your browser shows after you approve, starting with ${pending.redirect.origin}.`;
  }
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== pending.state) {
    return "That address belongs to a different sign-in attempt.";
  }
  const codes = url.searchParams.getAll("code");
  const errors = url.searchParams.getAll("error");
  if (codes.length + errors.length !== 1) return "That address has no sign-in result in it.";
  const issuer = url.searchParams.get("iss");
  if (issuer !== null && issuer !== "https://accounts.google.com") {
    return "That address didn't come from Google.";
  }
  return url;
}

export function makeAntigravityAuthFlows(input: {
  /** A descriptor that ignores the gate: the flow's own process must start. */
  readonly descriptor: AcpProviderDescriptor<AntigravitySettings>;
  readonly settings: AntigravitySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly profileDir: string;
  readonly gate: AntigravityAuthGate;
  /** Stops every session of the instance. */
  readonly stopSessions: Effect.Effect<void>;
}): ProviderInstanceAuthFlows {
  let pending: PendingSignIn | undefined;
  let report: ((line: string) => Effect.Effect<void>) | undefined;

  // Sessions stop again on every poll: one that was still starting when the
  // gate closed only becomes stoppable once it has registered.
  const drain = (emit: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const deadline = Date.now() + DRAIN_TIMEOUT_MS;
      let told = false;
      while (true) {
        yield* input.stopSessions;
        if (input.gate.holds <= 0) return;
        if (Date.now() >= deadline) {
          return yield* Effect.fail(
            failure("Antigravity is still busy with other work. Try again in a moment."),
          );
        }
        if (!told) {
          told = true;
          yield* emit("Waiting for Antigravity to finish its current work…");
        }
        yield* Effect.sleep(DRAIN_POLL);
      }
    });

  const closed = <A, E>(emit: (line: string) => Effect.Effect<void>, effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (input.gate.busy) {
          return Effect.fail(failure("Antigravity is already signing in or out."));
        }
        input.gate.busy = true;
        return Effect.void;
      }),
      () => drain(emit).pipe(Effect.andThen(effect)),
      () =>
        Effect.sync(() => {
          input.gate.busy = false;
          pending = undefined;
          report = undefined;
        }),
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
      const acp = yield* runtime({
        authMethodId: "oauth-personal",
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
            yield* emit("Finish signing in with Google in your browser.");
          }),
      });
      yield* emit("Starting Antigravity…");
      // initialize, authenticate (waits for the browser), then session/new
      // proves the credentials work.
      yield* acp.start().pipe(
        Effect.timeoutOrElse({
          duration: SIGN_IN_TIMEOUT,
          orElse: () => Effect.fail(new Error("Sign-in timed out after 5 minutes. Try again.")),
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
        orElse: () => Effect.fail(new Error("Antigravity did not finish signing out.")),
      }),
      Effect.mapError((error) =>
        failure(error instanceof Error ? error.message : "Sign-out failed."),
      ),
    );

  return {
    flows: ["login", "logout"],
    describe: (flow) => (flow === "logout" ? "Sign out of Google" : "Sign in with Google"),
    run: ({ flow, report: emit }) =>
      closed(
        emit,
        Effect.gen(function* () {
          report = emit;
          if (flow === "logout") return yield* signOut(emit);
          if (flow === "login") return yield* signIn(emit);
          return yield* Effect.fail(failure("Antigravity has no such sign-in flow."));
        }),
      ),
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
          try: () => replayRedirect(url),
          catch: () => failure("The sign-in stopped listening. Start sign-in again."),
        });
        if (status < 200 || status >= 300) {
          return yield* Effect.fail(failure("Antigravity didn't accept that address."));
        }
        if (report) yield* report("Got the address; finishing sign-in…");
      }),
  };
}

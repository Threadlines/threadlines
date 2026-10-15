/**
 * GrokAuth — sign-in and sign-out for one Grok instance, run inside a Grok
 * process of its own over ACP, with no terminal.
 *
 * Sign-in is Grok's own: `authenticate grok.com` runs the whole login and
 * returns when it is done, while `_x.ai/auth/get_url` hands over the page to
 * open. The device flow is asked for, so the page works from any device
 * (a phone, another computer): Grok's loopback flow needs the browser to end
 * on the machine Grok runs on. xAI can force the loopback flow remotely; its
 * page then ends on an unreachable `127.0.0.1` address, which the user pastes
 * back (`_x.ai/auth/submit_code`). Grok opens a browser on its own machine in
 * either flow; nothing turns that off on macOS or Windows.
 *
 * Grok's sessions re-read `auth.json` when it changes, so neither flow stops
 * them. Sign-out is offered only for an instance with its own Grok folder: the
 * default folder holds the terminal's sign-in too.
 *
 * An instance billed by API key has nothing to sign in to; "login" asks
 * xAI whether it accepts the key, then that Grok is set to use it.
 *
 * @module provider/grok/GrokAuth
 */
import type { GrokSettings } from "@threadlines/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type { AcpProviderDescriptor } from "../acp/AcpProviderDescriptor.ts";
import { makeAcpProviderRuntime } from "../acp/AcpProviderRuntime.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { checkApiKeyWithModelList } from "../apiKeyCheck.ts";
import type { ProviderInstanceAuthFlows } from "../ProviderDriver.ts";

const SIGN_IN_TIMEOUT = Duration.minutes(10);
const SIGN_OUT_TIMEOUT = Duration.seconds(30);
/** Grok's own login request number; `_x.ai/auth/cancel` names it. */
const REQUEST_SEQ = 1;
const PAGE_URL_RETRY = Duration.millis(250);
/** About 30 seconds of asking for the page before waiting on the login alone. */
const PAGE_URL_ATTEMPTS = 120;

const failure = (message: string) => ({ message });

const GrokAuthUrl = Schema.Struct({
  auth_url: Schema.optional(Schema.NullOr(Schema.String)),
  mode: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeGrokAuthUrl = Schema.decodeUnknownOption(GrokAuthUrl);

const GrokAuthInfo = Schema.Struct({
  methodId: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeGrokAuthInfo = Schema.decodeUnknownOption(GrokAuthInfo);

const GrokInitializeDefaultMethod = Schema.Struct({
  _meta: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ defaultAuthMethodId: Schema.optional(Schema.NullOr(Schema.String)) }),
    ),
  ),
});
const decodeDefaultMethod = Schema.decodeUnknownOption(GrokInitializeDefaultMethod);

/** xAI's free model list, which answers only a key it knows. */
export const XAI_MODELS_URL = "https://api.x.ai/v1/models";

function xaiErrorMessage(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const message = (body as { readonly error?: unknown }).error;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 300) : undefined;
}

/** Asks xAI whether it accepts an API key (see `checkApiKeyWithModelList`). */
export const checkXaiApiKey = (key: string, url: string = XAI_MODELS_URL) =>
  checkApiKeyWithModelList({
    vendor: "xAI",
    url,
    headers: { authorization: `Bearer ${key}` },
    errorMessage: xaiErrorMessage,
  });

function friendlySignInError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/cancel/iu.test(text)) return "Sign-in was cancelled.";
  if (/denied|expired/iu.test(text)) {
    return "Sign-in didn't finish. Try again and approve it in your browser.";
  }
  // Grok's login gives up on the first failed call to xAI, which is also how
  // a code nobody approved in time ends.
  if (/error sending request|connect|timed out|dns/iu.test(text)) {
    return "Grok couldn't finish signing in with xAI. Try again, and approve the page within 10 minutes.";
  }
  return text || "Sign-in failed.";
}

export function makeGrokAuthFlows(input: {
  readonly descriptor: AcpProviderDescriptor<GrokSettings>;
  readonly settings: GrokSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly httpClient: HttpClient.HttpClient;
}): ProviderInstanceAuthFlows {
  const apiKey = input.settings.authMethod === "api-key";
  const ownFolder = input.settings.accountFolder.trim().length > 0;
  /** The sign-in waiting on a pasted address (loopback flow only). */
  let pendingLoopback: AcpSessionRuntimeShape | undefined;
  let report: ((line: string) => Effect.Effect<void>) | undefined;

  const grokProcess = (environment: NodeJS.ProcessEnv) =>
    Effect.gen(function* () {
      const cwd = yield* input.fileSystem.makeTempDirectoryScoped({
        prefix: "threadlines-grok-auth-",
      });
      const acp = yield* makeAcpProviderRuntime(input.descriptor, {
        settings: input.settings,
        environment,
        childProcessSpawner: input.childProcessSpawner,
        cwd,
        clientInfo: { name: "threadlines", version: "0.0.0" },
      });
      const initialized = yield* acp.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "threadlines", version: "0.0.0" },
        ...(input.descriptor.initializeMeta ? { _meta: input.descriptor.initializeMeta } : {}),
      });
      return { acp, initialized };
    });

  const signIn = (emit: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      yield* emit("Starting Grok…");
      const { acp } = yield* grokProcess({
        ...input.environment,
        // The page works from any device, not only the one Grok runs on.
        GROK_LOGIN_DEVICE_FLOW: "1",
      });
      const login = yield* acp
        .request("authenticate", { methodId: "grok.com", _meta: { request_seq: REQUEST_SEQ } })
        .pipe(Effect.forkScoped);
      // `get_url` waits for the page once a login is running, but answers
      // empty at once when asked before the login has started (or after it
      // ended): ask again until there is a page or the login is over.
      const pageUrl = Effect.gen(function* () {
        for (let attempt = 0; attempt < PAGE_URL_ATTEMPTS; attempt += 1) {
          const page = yield* acp.request("_x.ai/auth/get_url", {}).pipe(Effect.option);
          const decoded = page._tag === "Some" ? decodeGrokAuthUrl(page.value) : undefined;
          if (decoded?._tag === "Some" && decoded.value.auth_url) return decoded.value;
          if (login.pollUnsafe() !== undefined) return undefined;
          yield* Effect.sleep(PAGE_URL_RETRY);
        }
        return undefined;
      });
      const page = yield* pageUrl;
      if (page?.auth_url) {
        // The URL on its own line: clients open it from the output. The line
        // after it is what their one-line status shows.
        yield* emit(page.auth_url);
        if (page.mode === "loopback") {
          pendingLoopback = acp;
          yield* emit(
            "Finish signing in in your browser. On another device, paste the address the page ends on.",
          );
        } else {
          yield* emit("Approve the sign-in on that page. The code is already filled in.");
        }
      }
      yield* Fiber.join(login).pipe(
        Effect.timeoutOrElse({
          duration: SIGN_IN_TIMEOUT,
          orElse: () => Effect.fail(new Error("Sign-in timed out after 10 minutes. Try again.")),
        }),
        // Stopped from the panel: Grok drops the login it was waiting on.
        Effect.onInterrupt(() =>
          acp.request("_x.ai/auth/cancel", { request_seq: REQUEST_SEQ }).pipe(Effect.ignore),
        ),
      );
      const info = yield* acp.request("_x.ai/auth/info", {}).pipe(Effect.option);
      const email =
        info._tag === "Some"
          ? decodeGrokAuthInfo(info.value).pipe((decoded) =>
              decoded._tag === "Some" ? decoded.value.email?.trim() : undefined,
            )
          : undefined;
      yield* emit(email ? `Signed in as ${email}.` : "Signed in.");
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          pendingLoopback = undefined;
        }),
      ),
      Effect.mapError((error) => failure(friendlySignInError(error))),
    );

  const signOut = (emit: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      yield* emit("Signing out of Grok…");
      const { acp } = yield* grokProcess(input.environment);
      yield* acp.request("_x.ai/auth/logout", {});
      yield* emit("Signed out.");
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: SIGN_OUT_TIMEOUT,
        orElse: () => Effect.fail(new Error("Grok did not finish signing out.")),
      }),
      Effect.mapError((error) =>
        failure(error instanceof Error ? error.message : "Sign-out failed."),
      ),
    );

  /**
   * xAI's answer for the key, then Grok's own pick: a Grok that would sign in
   * some other way (a stored sign-in wins over a key) is no use to the key.
   */
  const checkKey = (emit: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      const key = input.environment.XAI_API_KEY?.trim();
      if (!key) return yield* Effect.fail(new Error("Add an xAI API key first."));
      yield* emit("Checking the key with xAI…");
      const verdict = yield* checkXaiApiKey(key).pipe(
        Effect.provideService(HttpClient.HttpClient, input.httpClient),
      );
      if (verdict.verdict === "unreachable") return yield* Effect.fail(new Error(verdict.message));
      if (verdict.verdict === "rejected") {
        return yield* Effect.fail(new Error(`xAI didn't accept this key: ${verdict.message}`));
      }
      const { initialized } = yield* grokProcess(input.environment);
      const decoded = decodeDefaultMethod(initialized);
      const method =
        decoded._tag === "Some"
          ? (decoded.value._meta?.defaultAuthMethodId ?? undefined)
          : undefined;
      if (method !== "xai.api_key") {
        return yield* Effect.fail(
          new Error(
            "xAI accepted this key, but Grok uses the sign-in saved in its folder instead.",
          ),
        );
      }
      yield* emit("xAI accepted this key. xAI bills Grok's requests per use.");
    }).pipe(
      Effect.scoped,
      Effect.mapError((error) => failure(error instanceof Error ? error.message : String(error))),
    );

  return {
    flows: apiKey ? ["login"] : ownFolder ? ["login", "logout"] : ["login"],
    describe: (flow) =>
      flow === "logout"
        ? "Sign out of Grok"
        : apiKey
          ? "Check the xAI API key"
          : "Sign in with Grok",
    run: ({ flow, report: emit }) => {
      if (flow === "logout" && ownFolder && !apiKey) return signOut(emit);
      if (flow !== "login") return Effect.fail(failure("Grok has no such sign-in flow."));
      if (apiKey) return checkKey(emit);
      report = emit;
      return signIn(emit).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            report = undefined;
          }),
        ),
      );
    },
    completeRedirect: (raw) =>
      Effect.gen(function* () {
        const acp = pendingLoopback;
        if (!acp) {
          return yield* Effect.fail(
            failure("No sign-in is waiting for a browser address. Start sign-in first."),
          );
        }
        const code = raw.trim();
        if (!code) return yield* Effect.fail(failure("Paste the address your browser ended on."));
        yield* acp
          .request("_x.ai/auth/submit_code", { code })
          .pipe(Effect.mapError(() => failure("Grok didn't accept that address.")));
        if (report) yield* report("Got the address; finishing sign-in…");
      }),
  };
}

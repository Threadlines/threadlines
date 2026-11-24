// @effect-diagnostics nodeBuiltinImport:off - writes a stand-in `agy` and reads the profile it signs in
import * as NodeFS from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { AntigravitySettings } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makeAntigravityDescriptor } from "../acp/AntigravityAcpSupport.ts";
import { makeLaunchGate } from "../managedRuntime/LaunchGate.ts";
import {
  ANTIGRAVITY_CODE_REDIRECT_URI,
  antigravityLoginResponse,
  antigravitySignInErrorMessage,
  makeAntigravityAuthFlows,
  parseAntigravityCodeSignInLink,
} from "./AntigravityAuth.ts";
import { antigravityInstancePaths, antigravityTokenPath } from "./AntigravityProfile.ts";
import { antigravitySignInConfig, readAntigravityGoogleSignIn } from "./AntigravitySignInMethod.ts";

const STATE = "c3RhdGUtMTIz";
const LINK = `https://accounts.google.com/o/oauth2/auth?client_id=1071006060591.apps.googleusercontent.com&redirect_uri=${encodeURIComponent(ANTIGRAVITY_CODE_REDIRECT_URI)}&response_type=code&scope=openid&state=${STATE}`;
const CODE = "4/0AeaYSHB-xyz_123";

describe("parseAntigravityCodeSignInLink", () => {
  it("takes Google's code sign-in link that `agy acp --login` prints", () => {
    expect(parseAntigravityCodeSignInLink(`  ${LINK}  `)).toEqual({ url: LINK, state: STATE });
  });

  it("refuses a link that would send the code anywhere but Antigravity's page", () => {
    const refused = (url: string) => parseAntigravityCodeSignInLink(url) === undefined;
    expect(refused(LINK.replace("accounts.google.com", "accounts.google.com.evil.test"))).toBe(
      true,
    );
    expect(refused(LINK.replace("antigravity.google", "evil.test"))).toBe(true);
    expect(refused(LINK.replace("%2Foauth-callback", "%2Foauth-callback%2Fx"))).toBe(true);
    expect(refused(LINK.replace("response_type=code", "response_type=token"))).toBe(true);
    expect(refused(`${LINK}&state=second`)).toBe(true);
    expect(refused("Open this link: something else")).toBe(true);
  });
});

describe("antigravityLoginResponse", () => {
  const link = { url: LINK, state: STATE };

  it("takes the code, or the Antigravity page's address for this sign-in", () => {
    expect(antigravityLoginResponse(link, ` ${CODE}\n`)).toBe(CODE);
    const page = `${ANTIGRAVITY_CODE_REDIRECT_URI}?state=${STATE}&code=${encodeURIComponent(CODE)}`;
    expect(antigravityLoginResponse(link, page)).toBe(page);
  });

  it("never hands the CLI a second line or another sign-in's page", () => {
    expect(antigravityLoginResponse(link, `${CODE}\nmore`)).toBeUndefined();
    expect(antigravityLoginResponse(link, "two words")).toBeUndefined();
    expect(
      antigravityLoginResponse(link, `${ANTIGRAVITY_CODE_REDIRECT_URI}?state=other&code=x`),
    ).toBeUndefined();
    expect(
      antigravityLoginResponse(link, `https://evil.test/oauth-callback?state=${STATE}&code=x`),
    ).toBeUndefined();
  });
});

describe("antigravitySignInErrorMessage", () => {
  it("names what went wrong in the user's words", () => {
    expect(antigravitySignInErrorMessage("error: SUBSCRIPTION_REQUIRED")).toContain(
      "eligible plan",
    );
    expect(antigravitySignInErrorMessage("oauth2: invalid_grant")).toContain(
      "Google didn't accept",
    );
    expect(
      antigravitySignInErrorMessage("dial tcp [2001:db8::1]:443: connect: network is unreachable"),
    ).toContain("IPv6");
    expect(
      antigravitySignInErrorMessage(
        'PERMISSION_DENIED: Verify your account to continue. {"reason":"VALIDATION_REQUIRED","metadata":{"validation_url":"https://accounts.google.com/v3/signin/continue?plt=abc"}}',
      ),
    ).toContain("https://accounts.google.com/v3/signin/continue?plt=abc");
    // A link anywhere else is never shown as Google's.
    expect(
      antigravitySignInErrorMessage(
        "VALIDATION_REQUIRED https://accounts.google.com.evil.test/v3/signin/continue",
      ),
    ).not.toContain("evil");
  });
});

const mockAgentPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/acp-mock-agent.ts",
);

/**
 * A stand-in `agy`: with `--login` it prints Google's link and signs the
 * profile in when it reads `CODE`, as Google's CLI does; otherwise it is the
 * mock ACP agent, reporting Antigravity's name and version.
 */
const makeStandInAgy = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = await NodeFS.mkdtemp(path.join(os.tmpdir(), "threadlines-agy-"));
    const login = path.join(dir, "login.mjs");
    await NodeFS.writeFile(
      login,
      `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const profile = args[args.indexOf("--gemini-dir") + 1];
console.log("Sign in to continue:");
console.log(${JSON.stringify(LINK)});
if (process.env.STANDIN_EXIT_AFTER_LINK === "1") {
  console.error("dial tcp: lookup oauth2.googleapis.com: no such host");
  process.exit(1);
}
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line !== ${JSON.stringify(CODE)}) {
    console.error("oauth2: cannot fetch token: invalid_grant");
    process.exit(1);
  }
  mkdirSync(join(profile, "antigravity-acp"), { recursive: true });
  if (process.env.STANDIN_KEEPS_SIGN_IN_ELSEWHERE !== "1") writeFileSync(join(profile, "antigravity-acp", "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "ya29.test" } }));
  console.log("Signed in.");
  process.exit(0);
}
process.exit(2);
`,
    );
    const agy = path.join(dir, "agy");
    await NodeFS.writeFile(
      agy,
      `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--login" ]; then exec ${JSON.stringify(process.execPath)} ${JSON.stringify(login)} "$@"; fi
done
export T3_ACP_AGENT_INFO='{"name":"Antigravity ACP Server","version":"1.5.14"}'
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`,
      { mode: 0o755 },
    );
    return { dir, agy };
  }),
  ({ dir }) => Effect.promise(() => NodeFS.rm(dir, { recursive: true, force: true })),
);

/** Real processes and files; a Google sign-in check never reaches the network. */
const services = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("A Google sign-in doesn't use Threadlines' HTTP client")),
  ),
);

const DEFAULT_SETTINGS = Schema.decodeSync(AntigravitySettings)({});

const makeFlows = (
  answers: ReadonlyArray<string | null>,
  extraEnv: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const { dir, agy } = yield* makeStandInAgy;
    const settings = { ...DEFAULT_SETTINGS, binaryPath: agy };
    const paths = antigravityInstancePaths(dir, "antigravity-test");
    const signIn = antigravitySignInConfig(settings, undefined);
    const gate = makeLaunchGate();
    const descriptor = makeAntigravityDescriptor({
      paths,
      runtime: undefined,
      releases: undefined,
      signIn,
    });
    const flows = makeAntigravityAuthFlows({
      descriptor,
      settings,
      environment: { ...process.env, ...extraEnv },
      childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      profileDir: paths.profileDir,
      gate,
      stopSessions: Effect.void,
      signIn,
      httpClient: yield* HttpClient.HttpClient,
    });
    const lines: Array<string> = [];
    const asked: Array<string> = [];
    const pending = [...answers];
    const run = (flow: "login" | "logout") =>
      flows.run({
        flow,
        report: (line) => Effect.sync(() => void lines.push(line)),
        requestPage: () => Effect.succeed(true),
        showCode: () => Effect.void,
        ask: (question) =>
          Effect.sync(() => {
            asked.push(question.message);
            return pending.shift() ?? null;
          }),
      });
    const runAskingForever = flows.run({
      flow: "login",
      report: (line) => Effect.sync(() => void lines.push(line)),
      requestPage: () => Effect.succeed(true),
      showCode: () => Effect.void,
      ask: () => Effect.never,
    });
    return { run, runAskingForever, lines, asked, profileDir: paths.profileDir };
  });

const makeFlowsAskingForever = (flows: {
  readonly runAskingForever: Effect.Effect<void, { readonly message: string }>;
}) => Effect.succeed(flows.runAskingForever.pipe(Effect.timeout("20 seconds")));

describe.skipIf(process.platform === "win32")("Antigravity Google sign-in", () => {
  it.live("signs the profile in with the code from the Antigravity page", () =>
    Effect.gen(function* () {
      // A pasted line that isn't a code is asked again, never sent to the CLI.
      const flows = yield* makeFlows(["not a code", CODE]);
      yield* flows.run("login");
      assert.include(flows.lines, LINK);
      assert.strictEqual(flows.asked.length, 2);
      const signedIn = yield* readAntigravityGoogleSignIn(flows.profileDir);
      assert.strictEqual(signedIn.method, "oauth-personal");
      assert.include(flows.lines, "Signed in.");
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("fails in plain words when Google refuses the code, and stays signed out", () =>
    Effect.gen(function* () {
      const flows = yield* makeFlows(["4/0Wrong-code"]);
      const failure = yield* Effect.flip(flows.run("login"));
      expect(failure.message).toContain("Google didn't accept the sign-in");
      const signedIn = yield* readAntigravityGoogleSignIn(flows.profileDir);
      assert.isUndefined(signedIn.method);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("stops waiting for a code when the CLI gives up after printing its link", () =>
    Effect.gen(function* () {
      // Nobody answers: only the CLI's exit can end the wait.
      const flows = yield* makeFlows([], { STANDIN_EXIT_AFTER_LINK: "1" });
      const neverAnswered = yield* makeFlowsAskingForever(flows);
      const failure = yield* Effect.flip(neverAnswered);
      expect(failure.message).toContain("couldn't reach Google");
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("fails when the CLI keeps the sign-in outside the profile", () =>
    Effect.gen(function* () {
      const flows = yield* makeFlows([CODE], { STANDIN_KEEPS_SIGN_IN_ELSEWHERE: "1" });
      const failure = yield* Effect.flip(flows.run("login"));
      expect(failure.message).toContain("didn't keep the sign-in in this account's own folder");
      assert.notInclude(flows.lines, "Signed in.");
      const signedIn = yield* readAntigravityGoogleSignIn(flows.profileDir);
      assert.isUndefined(signedIn.method);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("stays signed out when Google refuses a session on the new sign-in", () =>
    Effect.gen(function* () {
      const flows = yield* makeFlows([CODE], { T3_ACP_AUTH_REQUIRED: "1" });
      yield* Effect.flip(flows.run("login"));
      const signedIn = yield* readAntigravityGoogleSignIn(flows.profileDir);
      assert.isUndefined(signedIn.method);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("signs out by removing only the profile's own sign-in", () =>
    Effect.gen(function* () {
      const flows = yield* makeFlows([CODE]);
      yield* flows.run("login");
      yield* flows.run("logout");
      const signedIn = yield* readAntigravityGoogleSignIn(flows.profileDir);
      assert.isUndefined(signedIn.method);
      const token = yield* Effect.promise(() =>
        NodeFS.stat(antigravityTokenPath(flows.profileDir)).then(
          () => true,
          () => false,
        ),
      );
      assert.isFalse(token);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});

import { createServer } from "node:http";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";

import { antigravityEnvironment } from "./AntigravityProfile.ts";
import {
  antigravityAdcPath,
  antigravityCredentialEnvironment,
  antigravitySignInConfig,
  antigravitySignInStatus,
  type AntigravitySignInConfig,
  checkGeminiApiKey,
  classifyAntigravityGoogleToken,
  mergeAntigravityProfileSettings,
  resolveAntigravityAdc,
} from "./AntigravitySignInMethod.ts";

const KEY = "AIzaSyTestKey000000000007Qx2";

const config = (overrides: Partial<AntigravitySignInConfig>): AntigravitySignInConfig => ({
  method: "oauth-personal",
  project: "",
  location: "",
  key: "",
  ...overrides,
});

describe("antigravitySignInConfig", () => {
  it("takes the method's own key from the instance, never another method's or an ambient one", () => {
    const environment = [
      { name: "gemini_api_key", value: ` ${KEY} `, sensitive: true },
      { name: "GOOGLE_API_KEY", value: "vertex-key", sensitive: true },
    ];
    const settings = { gcpProject: "acme", gcpLocation: "us-central1" };
    assert.deepEqual(
      antigravitySignInConfig({ authMethod: "gemini-api-key", ...settings }, environment),
      // The project only belongs to methods that use one.
      { method: "gemini-api-key", project: "", location: "", key: KEY },
    );
    assert.deepEqual(
      antigravitySignInConfig({ authMethod: "agent-platform", ...settings }, environment),
      { method: "agent-platform", project: "acme", location: "us-central1", key: "vertex-key" },
    );
    assert.equal(
      antigravitySignInConfig({ authMethod: "gemini-api-key", ...settings }, undefined).key,
      "",
    );
  });
});

describe("antigravity process environment", () => {
  const base = {
    PATH: "/usr/bin",
    HOME: "/home/me",
    GEMINI_API_KEY: "ambient-key",
    GOOGLE_API_KEY: "ambient-vertex",
    GOOGLE_APPLICATION_CREDENTIALS: "/home/me/sa.json",
    CLOUDSDK_CONFIG: "/home/me/gcloud",
    GOOGLE_CLOUD_PROJECT: "ambient-project",
  };
  const env = (signIn: AntigravitySignInConfig) =>
    antigravityEnvironment({
      base,
      profileDir: "/state/profile",
      tempDir: "/state/tmp",
      platform: "linux",
      credentials: antigravityCredentialEnvironment(signIn, base),
    });
  const google = (value: NodeJS.ProcessEnv) =>
    Object.keys(value).filter((name) => /^(GEMINI_API|GOOGLE_|CLOUDSDK_)/u.test(name));

  it("carries only the selected method's credential", () => {
    assert.deepEqual(google(env(config({}))), []);
    assert.deepEqual(
      google(env(config({ method: "oauth-business", project: "p", location: "l" }))),
      [],
    );
    // No instance key: the ambient one does not stand in.
    assert.deepEqual(google(env(config({ method: "gemini-api-key" }))), []);
    const gemini = env(config({ method: "gemini-api-key", key: KEY }));
    assert.deepEqual(google(gemini), ["GEMINI_API_KEY"]);
    assert.equal(gemini.GEMINI_API_KEY, KEY);
    const vertexKey = env(config({ method: "agent-platform", key: "vertex-key" }));
    assert.deepEqual(google(vertexKey), ["GOOGLE_API_KEY"]);
    assert.equal(vertexKey.GOOGLE_API_KEY, "vertex-key");
  });

  it("passes the computer's Google Cloud sign-in only to keyless Vertex AI", () => {
    const vertex = env(config({ method: "agent-platform", project: "p", location: "l" }));
    assert.deepEqual(google(vertex).sort(), ["CLOUDSDK_CONFIG", "GOOGLE_APPLICATION_CREDENTIALS"]);
    assert.equal(vertex.GOOGLE_APPLICATION_CREDENTIALS, "/home/me/sa.json");
  });
});

describe("mergeAntigravityProfileSettings", () => {
  it("sets the method and project and keeps what the agent wrote", () => {
    const existing = {
      auth: { type: "oauth-personal", selected: "x" },
      gcp: { project: "old", location: "old-loc", other: 1 },
      ui: { theme: "dark" },
    };
    assert.deepEqual(
      mergeAntigravityProfileSettings(
        existing,
        config({ method: "agent-platform", project: "acme", location: "us-central1" }),
      ),
      {
        auth: { type: "agent-platform", selected: "x" },
        gcp: { project: "acme", location: "us-central1", other: 1 },
        ui: { theme: "dark" },
      },
    );
    assert.deepEqual(
      mergeAntigravityProfileSettings(
        { auth: { type: "agent-platform" }, gcp: { project: "acme", location: "eu" } },
        config({ method: "gemini-api-key", key: KEY }),
      ),
      { auth: { type: "gemini-api-key" } },
    );
    assert.deepEqual(mergeAntigravityProfileSettings("not an object", config({})), {
      auth: { type: "oauth-personal" },
    });
  });
});

describe("Application Default Credentials", () => {
  it("looks where Google's library looks, in its order", () => {
    assert.deepEqual(
      antigravityAdcPath(
        { GOOGLE_APPLICATION_CREDENTIALS: "/sa.json", CLOUDSDK_CONFIG: "/g" },
        "linux",
      ),
      { path: "/sa.json", explicit: true },
    );
    assert.deepEqual(antigravityAdcPath({ CLOUDSDK_CONFIG: "/g" }, "linux"), {
      path: join("/g", "application_default_credentials.json"),
      explicit: false,
    });
    assert.deepEqual(antigravityAdcPath({ HOME: "/home/me" }, "darwin"), {
      path: join("/home/me", ".config", "gcloud", "application_default_credentials.json"),
      explicit: false,
    });
    assert.deepEqual(antigravityAdcPath({ AppData: "C:\\Users\\me\\AppData\\Roaming" }, "win32"), {
      path: join(
        "C:\\Users\\me\\AppData\\Roaming",
        "gcloud",
        "application_default_credentials.json",
      ),
      explicit: false,
    });
  });

  it.live("finds a credential file, and never looks past a named one that's gone", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => fs.mkdtemp(join(tmpdir(), "agy-adc-")));
      const gcloud = join(dir, "gcloud");
      yield* Effect.promise(async () => {
        await fs.mkdir(gcloud);
        await fs.writeFile(
          join(gcloud, "application_default_credentials.json"),
          JSON.stringify({ type: "authorized_user" }),
        );
        await fs.writeFile(join(dir, "broken.json"), "{");
      });
      const found = yield* resolveAntigravityAdc({ CLOUDSDK_CONFIG: gcloud }, "linux");
      assert.equal(found.status, "found");
      const named = yield* resolveAntigravityAdc(
        { CLOUDSDK_CONFIG: gcloud, GOOGLE_APPLICATION_CREDENTIALS: join(dir, "gone.json") },
        "linux",
      );
      assert.equal(named.status, "unreadable");
      const broken = yield* resolveAntigravityAdc(
        { GOOGLE_APPLICATION_CREDENTIALS: join(dir, "broken.json") },
        "linux",
      );
      assert.equal(broken.status, "unreadable");
      const none = yield* resolveAntigravityAdc({ CLOUDSDK_CONFIG: join(dir, "empty") }, "linux");
      assert.equal(none.status, "missing");
      yield* Effect.promise(() => fs.rm(dir, { recursive: true, force: true }));
    }),
  );
});

describe("classifyAntigravityGoogleToken", () => {
  it("tells a Google account sign-in from a Gemini Enterprise one by the token alone", () => {
    // Field shapes of the agent's acp_token.json (values made up).
    const token = {
      client_secret: "x",
      refresh_token: "x",
      token_uri: "https://oauth2.googleapis.com/token",
    };
    expect(
      classifyAntigravityGoogleToken({
        ...token,
        client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
      }),
    ).toBe("oauth-personal");
    expect(
      classifyAntigravityGoogleToken({
        ...token,
        client_id: "884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com",
      }),
    ).toBe("oauth-business");
    // An unknown client: only a Google account asks for Code Assist.
    expect(
      classifyAntigravityGoogleToken({
        ...token,
        client_id: "other",
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      }),
    ).toBe("oauth-business");
    expect(classifyAntigravityGoogleToken({})).toBeUndefined();
    expect(classifyAntigravityGoogleToken(null)).toBeUndefined();
  });
});

describe("antigravitySignInStatus", () => {
  const status = (
    signIn: Partial<AntigravitySignInConfig>,
    extra: Partial<Parameters<typeof antigravitySignInStatus>[0]> = {},
  ) =>
    antigravitySignInStatus({
      config: config(signIn),
      signedIn: false,
      check: undefined,
      adc: undefined,
      ...extra,
    });

  it("says what each method still needs, and names the method it describes", () => {
    const cases: ReadonlyArray<[ReturnType<typeof status>, string, string]> = [
      [status({}), "unauthenticated", "Sign in with Google to use Antigravity."],
      [
        status({ method: "oauth-business" }, { signedIn: true }),
        "unauthenticated",
        "Add your Google Cloud project and location to use Gemini Enterprise.",
      ],
      [
        status({ method: "oauth-business", project: "acme", location: "global" }),
        "unauthenticated",
        "Sign in with your work Google account to use Gemini Enterprise.",
      ],
      [
        status({ method: "gemini-api-key" }),
        "unauthenticated",
        "Add a Gemini API key to use Antigravity.",
      ],
      [
        status(
          { method: "agent-platform", project: "acme", location: "us" },
          { adc: { status: "missing", path: "/x" } },
        ),
        "unauthenticated",
        "Sign in to Google Cloud on the computer that runs Threadlines: `gcloud auth application-default login`.",
      ],
    ];
    for (const [result, auth, message] of cases) {
      assert.equal(result.auth.status, auth);
      assert.equal(result.message, message);
      assert.equal(result.status, "warning");
    }
    assert.equal(status({ method: "gemini-api-key" }).auth.type, "gemini-api-key");
  });

  it("labels a working sign-in without needing an email, and never shows more than four characters of a key", () => {
    assert.equal(status({}, { signedIn: true }).auth.label, "Google account");
    assert.equal(
      status({ method: "oauth-business", project: "acme", location: "global" }, { signedIn: true })
        .auth.label,
      "Gemini Enterprise · acme",
    );
    const gemini = status({ method: "gemini-api-key", key: KEY });
    assert.equal(gemini.auth.label, "Gemini API key ••••7Qx2 · per use");
    assert.equal(gemini.auth.capabilities?.chat?.status, "configured");
    assert.equal(
      status(
        { method: "agent-platform", project: "acme", location: "us-central1" },
        { adc: { status: "found", path: "/adc.json" } },
      ).auth.label,
      "Vertex AI · acme · us-central1 · per use",
    );
  });

  it("shows a key Google rejected as an error until the key changes", () => {
    const check = { fingerprint: "f", checkedAt: "" };
    const rejected = status(
      { method: "gemini-api-key", key: KEY },
      { check: { ...check, accepted: false, message: "API key not valid." } },
    );
    assert.equal(rejected.status, "error");
    assert.equal(rejected.auth.status, "unauthenticated");
    const accepted = status(
      { method: "gemini-api-key", key: KEY },
      { check: { ...check, accepted: true } },
    );
    assert.equal(accepted.auth.capabilities?.chat?.status, "verified");
  });
});

describe("checkGeminiApiKey", () => {
  it.live("reports what Google said about the key", () =>
    Effect.gen(function* () {
      const seen: Array<string | undefined> = [];
      const server = createServer((request, response) => {
        const key = request.headers["x-goog-api-key"];
        seen.push(Array.isArray(key) ? key[0] : key);
        const [status, body] =
          key === "good"
            ? [200, { models: [] }]
            : key === "busy"
              ? [503, {}]
              : [400, { error: { message: "API key not valid. Please pass a valid API key." } }];
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
      yield* Effect.promise(() => new Promise<void>((done) => server.listen(0, "127.0.0.1", done)));
      const address = server.address();
      const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/models`;
      const check = (key: string) =>
        checkGeminiApiKey(key, url).pipe(Effect.provide(FetchHttpClient.layer));

      assert.deepEqual(yield* check("good"), { verdict: "accepted" });
      assert.deepEqual(yield* check("bad"), {
        verdict: "rejected",
        message: "API key not valid. Please pass a valid API key.",
      });
      assert.equal((yield* check("busy")).verdict, "unreachable");
      // The key goes in a header, never the address.
      assert.deepEqual(seen, ["good", "bad", "busy"]);
      yield* Effect.promise(() => new Promise<void>((done) => server.close(() => done())));
    }),
  );
});

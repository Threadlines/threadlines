import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AntigravityAuthMethod, ServerProvider } from "@threadlines/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { antigravityTokenPath } from "./AntigravityProfile.ts";
import {
  ANTIGRAVITY_USAGE_EXPIRED_DETAIL,
  ANTIGRAVITY_USAGE_FAILED_DETAIL,
  ANTIGRAVITY_USAGE_USER_AGENT,
  makeAntigravityUsageReader,
} from "./AntigravityUsage.ts";

const ACCESS_TOKEN = "ya29.secret-access-token";
const REFRESH_TOKEN = "1//secret-refresh-token";

// Shapes from T3 Code's fixtures (antigravityUsageLimits.test.ts and its open pull requests).
const SUMMARY = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          window: "weekly",
          remainingFraction: 0.96,
          resetTime: "2026-10-12T19:41:43Z",
        },
        {
          bucketId: "gemini-5h",
          window: "5h",
          remainingFraction: 0.91,
          resetTime: "2026-10-09T16:06:01Z",
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        {
          bucketId: "3p-weekly",
          window: "weekly",
          remainingFraction: 0,
          resetTime: "2026-10-10T15:28:22Z",
        },
        { bucketId: "3p-5h", window: "5h", remainingFraction: 0.44 },
      ],
    },
  ],
};

const SUMMARY_WITHOUT_GEMINI = { groups: [SUMMARY.groups[1]!] };

const MODELS = {
  models: {
    "gemini-4-hydrogen-sonar": {
      modelProvider: "MODEL_PROVIDER_GOOGLE",
      quotaInfo: { remainingFraction: 0.9471137, resetTime: "2026-11-17T15:36:00Z" },
    },
    "gemini-3.1-pro-high": {
      modelProvider: "MODEL_PROVIDER_GOOGLE",
      quotaInfo: { remainingFraction: 0.6, resetTime: "2026-11-17T12:00:00Z" },
    },
    chat_20706: { isInternal: true, quotaInfo: { remainingFraction: 0 } },
    "claude-opus-5-5-high": { quotaInfo: { remainingFraction: 0.2 } },
  },
};

/** An Enterprise answer: one group of per-model buckets with no window length. */
const ENTERPRISE_SUMMARY = {
  groups: [
    {
      displayName: "All Models",
      buckets: [
        { bucketId: "gemini-3.1-pro-high", remainingFraction: 0.5 },
        { bucketId: "gemini-3.1-pro-low", remainingFraction: 0.75 },
        {
          bucketId: "gemini-4-argon-high",
          remainingFraction: 0.1,
          resetTime: "2026-11-24T00:00:00Z",
        },
        { bucketId: "claude-opus-5-5-high", remainingFraction: 1 },
        { bucketId: "claude-sonnet-5-5", remainingFraction: 0.3 },
        { bucketId: "gpt-6-2-high", remainingFraction: 0.9, disabled: true },
        { bucketId: "gpt-6-1", remainingFraction: 0.95 },
      ],
    },
  ],
};

interface Answer {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

type Route = (url: URL) => Answer | "hang";

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** A stand-in for Google: answers per host and operation, and records what was asked. */
function stubFetch(route: Route) {
  const sent: Array<Sent> = [];
  const aborted: Array<string> = [];
  const fetch = (rawUrl: string, init: RequestInit) => {
    const url = new URL(rawUrl);
    sent.push({
      url: rawUrl,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers)),
      body: typeof init.body === "string" ? init.body : undefined,
    });
    const answer = route(url);
    if (answer === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted.push(rawUrl);
          reject(new Error("aborted"));
        });
      });
    }
    return Promise.resolve(
      new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        ...(answer.headers ? { headers: answer.headers } : {}),
      }),
    );
  };
  return { fetch, sent, aborted };
}

const googleRoute =
  (answers: {
    summary?: Answer | ((host: string) => Answer);
    models?: Answer | ((host: string) => Answer);
    userinfo?: Answer;
  }): Route =>
  (url) => {
    const pick = (answer: Answer | ((host: string) => Answer) | undefined) =>
      typeof answer === "function" ? answer(url.host) : (answer ?? { status: 404 });
    if (url.pathname.endsWith(":retrieveUserQuotaSummary")) return pick(answers.summary);
    if (url.pathname.endsWith(":fetchAvailableModels")) return pick(answers.models);
    if (url.pathname === "/oauth2/v2/userinfo") return answers.userinfo ?? { status: 403 };
    return { status: 404 };
  };

const makeProfile = Effect.promise(() => fs.mkdtemp(join(tmpdir(), "threadlines-agy-usage-")));

const writeToken = (
  profileDir: string,
  overrides: { expiry?: string; refresh?: string; email?: string | null } = {},
) =>
  Effect.promise(async () => {
    const path = antigravityTokenPath(profileDir);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(
      path,
      JSON.stringify({
        token: {
          access_token: ACCESS_TOKEN,
          token_type: "Bearer",
          refresh_token: overrides.refresh ?? REFRESH_TOKEN,
          expiry: overrides.expiry ?? "2099-01-01T00:00:00Z",
        },
        auth_method: "consumer",
        ...(overrides.email === null
          ? {}
          : { id_token_email: overrides.email ?? "someone@example.com" }),
      }),
    );
  });

const signedInSnapshot = (method: AntigravityAuthMethod) =>
  ({
    enabled: true,
    auth: { status: "authenticated", type: method, label: "Google account" },
  }) as unknown as ServerProvider;

/**
 * A reader on a fresh profile with a stub Google. `published` resolves with
 * the snapshot the first finished read writes.
 */
const setup = (input: {
  route: Route;
  method?: AntigravityAuthMethod;
  token?: Parameters<typeof writeToken>[1] | false;
}) =>
  Effect.gen(function* () {
    const profileDir = yield* makeProfile;
    if (input.token !== false) yield* writeToken(profileDir, input.token);
    const google = stubFetch(input.route);
    const method = input.method ?? "oauth-personal";
    const reader = yield* makeAntigravityUsageReader({
      profileDir,
      method,
      fingerprint: "fingerprint-a",
      fetch: google.fetch,
    });
    let snapshot = signedInSnapshot(method);
    let published = yield* Deferred.make<ServerProvider>();
    reader.publishTo((update) =>
      Effect.gen(function* () {
        const next = update(snapshot);
        if (next) snapshot = next;
        yield* Deferred.succeed(published, snapshot);
      }),
    );
    /** Runs a status check and waits for the read it starts to publish. */
    const readOnce = Effect.gen(function* () {
      published = yield* Deferred.make<ServerProvider>();
      yield* reader.status;
      return yield* Deferred.await(published);
    });
    return { profileDir, reader, google, readOnce };
  });

const windowsOf = (snapshot: ServerProvider) =>
  snapshot.accountUsage?.limits[0]?.scoped?.map((window) => ({
    label: window.scopeLabel,
    minutes: window.windowDurationMins,
    used: window.usedPercent,
  }));

describe("Antigravity plan limits", () => {
  it.effect("reads each family's 5-hour and weekly limits, with the email from the sign-in", () =>
    Effect.gen(function* () {
      const { readOnce, google } = yield* setup({
        route: googleRoute({ summary: { body: SUMMARY } }),
      });
      const snapshot = yield* readOnce;

      assert.deepEqual(windowsOf(snapshot), [
        { label: "Gemini", minutes: 300, used: 9 },
        { label: "Gemini", minutes: 10080, used: 4 },
        { label: "Claude & GPT", minutes: 300, used: 56 },
        { label: "Claude & GPT", minutes: 10080, used: 100 },
      ]);
      const scoped = snapshot.accountUsage!.limits[0]!.scoped!;
      assert.deepEqual(scoped[0]!.scopeModels, ["Gemini"]);
      assert.deepEqual(scoped[2]!.scopeModels, ["Claude", "GPT"]);
      assert.equal(scoped[3]!.resetsAt, Date.parse("2026-10-10T15:28:22Z"));
      assert.equal(snapshot.accountUsage!.source, "antigravity-quota");
      assert.equal(snapshot.auth.email, "someone@example.com");
      assert.equal(snapshot.auth.capabilities?.usage, undefined);

      // Both hosts, our own name, the token only as a Bearer header, nowhere else.
      assert.deepEqual(google.sent.map((request) => new URL(request.url).host).toSorted(), [
        "cloudcode-pa.googleapis.com",
        "daily-cloudcode-pa.googleapis.com",
      ]);
      for (const request of google.sent) {
        assert.equal(request.method, "POST");
        assert.equal(request.body, "{}");
        assert.equal(request.headers["user-agent"], ANTIGRAVITY_USAGE_USER_AGENT);
        assert.match(request.headers["user-agent"]!, /^Threadlines\/\d/);
        assert.equal(request.headers.authorization, `Bearer ${ACCESS_TOKEN}`);
      }
      assert.notInclude(JSON.stringify(snapshot), ACCESS_TOKEN);
      assert.notInclude(JSON.stringify(snapshot), REFRESH_TOKEN);
    }),
  );

  it.effect("fills Gemini in from the per-model quotas when the summary leaves it out", () =>
    Effect.gen(function* () {
      const { readOnce } = yield* setup({
        route: googleRoute({
          summary: { body: SUMMARY_WITHOUT_GEMINI },
          models: { body: MODELS },
        }),
      });
      const snapshot = yield* readOnce;
      // The fullest Gemini model stands for the family; Claude stays the summary's shared pool.
      assert.deepEqual(windowsOf(snapshot), [
        { label: "Gemini", minutes: undefined, used: 40 },
        { label: "Gemini Hydrogen", minutes: undefined, used: 5 },
        { label: "Claude & GPT", minutes: 300, used: 56 },
        { label: "Claude & GPT", minutes: 10080, used: 100 },
      ]);
      const gemini = snapshot.accountUsage!.limits[0]!.scoped![0]!;
      assert.deepEqual(gemini.scopeExcludes, ["Hydrogen"]);
    }),
  );

  it.effect("falls back to per-model quotas without making up a window length", () =>
    Effect.gen(function* () {
      const { readOnce } = yield* setup({
        route: googleRoute({ summary: { status: 404 }, models: { body: MODELS } }),
      });
      assert.deepEqual(windowsOf(yield* readOnce), [
        { label: "Gemini", minutes: undefined, used: 40 },
        { label: "Gemini Hydrogen", minutes: undefined, used: 5 },
        { label: "Claude", minutes: undefined, used: 80 },
      ]);
    }),
  );

  it.effect("folds an Enterprise answer's per-model buckets into one row per family", () =>
    Effect.gen(function* () {
      const { readOnce } = yield* setup({
        method: "oauth-business",
        route: googleRoute({
          // The host an Enterprise account is metered on wins where both answer.
          summary: (host) =>
            host === "cloudcode-pa.googleapis.com"
              ? { body: ENTERPRISE_SUMMARY }
              : { body: { buckets: [{ bucketId: "claude-opus-5-5-high", remainingFraction: 0 }] } },
        }),
      });
      const snapshot = yield* readOnce;
      assert.deepEqual(windowsOf(snapshot), [
        { label: "Gemini", minutes: undefined, used: 50 },
        { label: "Gemini Argon", minutes: undefined, used: 90 },
        { label: "Claude", minutes: undefined, used: 70 },
        { label: "GPT", minutes: undefined, used: 5 },
      ]);
      const argon = snapshot.accountUsage!.limits[0]!.scoped![1]!;
      assert.equal(argon.resetsAt, Date.parse("2026-11-24T00:00:00Z"));
    }),
  );

  it.effect("labels Gemini 4 pools apart and leaves them out of the default Gemini pool", () =>
    Effect.gen(function* () {
      const { readOnce } = yield* setup({
        route: googleRoute({
          summary: {
            body: {
              groups: [
                ...SUMMARY.groups,
                {
                  displayName: "Gemini 4 Argon",
                  buckets: [
                    {
                      bucketId: "gemini-argon-wtu-weekly",
                      window: "weekly",
                      remainingFraction: 0.6,
                    },
                  ],
                },
                {
                  displayName: " ",
                  buckets: [{ bucketId: "gemini-neon-5h", window: "5h", remainingFraction: 0.8 }],
                },
              ],
            },
          },
        }),
      });
      const scoped = (yield* readOnce).accountUsage!.limits[0]!.scoped!;
      assert.deepEqual(
        scoped.map((window) => window.scopeLabel),
        ["Gemini", "Gemini", "Gemini 4 Argon", "Gemini Neon", "Claude & GPT", "Claude & GPT"],
      );
      assert.deepEqual(scoped[0]!.scopeExcludes, ["Argon", "Neon"]);
      assert.deepEqual(scoped[2]!.scopeModels, ["Argon"]);
    }),
  );

  it.effect("leaves out the reset of a pool nobody has touched", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-21T10:16:04Z"));
      const { readOnce } = yield* setup({
        route: googleRoute({
          summary: {
            body: {
              buckets: [
                {
                  bucketId: "3p-5h",
                  window: "5h",
                  remainingFraction: 1,
                  resetTime: "2026-10-21T15:16:05Z",
                },
                {
                  bucketId: "gemini-5h",
                  window: "5h",
                  remainingFraction: 0.848104,
                  resetTime: "2026-10-21T13:29:53Z",
                  description: "You have used some of your 5-hour limit.",
                },
              ],
            },
          },
        }),
      });
      const scoped = (yield* readOnce).accountUsage!.limits[0]!.scoped!;
      assert.equal(
        scoped.find((window) => window.scopeLabel === "Claude & GPT")!.resetsAt,
        undefined,
      );
      assert.equal(
        scoped.find((window) => window.scopeLabel === "Gemini")!.resetsAt,
        Date.parse("2026-10-21T13:29:53Z"),
      );
    }),
  );

  it.effect("asks for the email when the sign-in doesn't carry it", () =>
    Effect.gen(function* () {
      const { readOnce, google } = yield* setup({
        token: { email: null },
        route: googleRoute({
          summary: { body: SUMMARY },
          userinfo: { body: { id: "1", email: "other@example.com" } },
        }),
      });
      assert.equal((yield* readOnce).auth.email, "other@example.com");
      const userinfo = google.sent.find((request) => request.url.includes("userinfo"))!;
      assert.equal(userinfo.method, "GET");
      assert.equal(new URL(userinfo.url).host, "www.googleapis.com");
    }),
  );

  it.effect(
    "with an expired sign-in, keeps the last numbers and asks for a chat, without a request",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-09T12:00:00Z"));
        const { readOnce, reader, google, profileDir } = yield* setup({
          route: googleRoute({ summary: { body: SUMMARY } }),
        });
        const first = yield* readOnce;
        const asked = google.sent.length;

        yield* writeToken(profileDir, { expiry: "2000-01-01T00:00:00Z" });
        const status = yield* reader.status;
        assert.equal(google.sent.length, asked);
        assert.deepEqual(status.accountUsage, first.accountUsage);
        assert.deepEqual(status.usage, {
          status: "unavailable",
          detail: ANTIGRAVITY_USAGE_EXPIRED_DETAIL,
        });

        // A fresh reader (a restart) with an expired sign-in asks nothing either.
        const cold = yield* setup({
          token: { expiry: "2026-10-09T12:00:30Z" },
          route: googleRoute({ summary: { body: SUMMARY } }),
        });
        const coldStatus = yield* cold.reader.status;
        assert.equal(coldStatus.accountUsage, undefined);
        assert.equal(coldStatus.usage?.detail, ANTIGRAVITY_USAGE_EXPIRED_DETAIL);
        assert.deepEqual(cold.google.sent, []);
      }),
  );

  it.effect("when Google refuses, says it couldn't read and keeps the last good numbers", () =>
    Effect.gen(function* () {
      let refuse = false;
      const { readOnce, google } = yield* setup({
        route: (url) =>
          refuse
            ? { status: 403, body: { error: { message: "unknown client" } } }
            : googleRoute({ summary: { body: SUMMARY } })(url),
      });
      const first = yield* readOnce;

      refuse = true;
      yield* TestClock.adjust("3 minutes");
      const second = yield* readOnce;
      assert.deepEqual(second.accountUsage, first.accountUsage);
      assert.deepEqual(second.auth.capabilities?.usage, {
        status: "unavailable",
        reason: "unreachable",
        detail: ANTIGRAVITY_USAGE_FAILED_DETAIL,
      });
      // The summary had nothing, so the per-model quotas were asked too.
      assert.isTrue(google.sent.some((request) => request.url.endsWith(":fetchAvailableModels")));

      refuse = false;
      yield* TestClock.adjust("3 minutes");
      assert.equal((yield* readOnce).auth.capabilities?.usage, undefined);
    }),
  );

  it.effect("treats a redirect as a failed read and never follows it", () =>
    Effect.gen(function* () {
      const { readOnce, google } = yield* setup({
        route: (url) =>
          url.host.endsWith("cloudcode-pa.googleapis.com")
            ? { status: 302, headers: { location: "https://collector.example/steal" } }
            : { status: 404 },
      });
      const snapshot = yield* readOnce;
      assert.equal(snapshot.accountUsage, undefined);
      assert.equal(snapshot.auth.capabilities?.usage?.detail, ANTIGRAVITY_USAGE_FAILED_DETAIL);
      assert.isFalse(google.sent.some((request) => request.url.includes("collector.example")));
    }),
  );

  it.effect(
    "reads nothing for a sign-in that isn't Google's, even with a Google token on disk",
    () =>
      Effect.gen(function* () {
        for (const method of ["gemini-api-key", "agent-platform"] as const) {
          const { reader, google } = yield* setup({
            method,
            route: googleRoute({ summary: { body: SUMMARY } }),
          });
          assert.deepEqual(yield* reader.status, {});
          assert.equal(yield* reader.usageLimitFor("Gemini 3.1 Pro"), undefined);
          assert.deepEqual(google.sent, []);
        }
      }),
  );

  it.effect("never shows one Google account's numbers for another", () =>
    Effect.gen(function* () {
      const { readOnce, reader, profileDir } = yield* setup({
        route: googleRoute({ summary: { body: SUMMARY } }),
      });
      yield* readOnce;
      yield* writeToken(profileDir, { refresh: "1//another-account", email: "b@example.com" });
      const status = yield* reader.status;
      assert.equal(status.accountUsage, undefined);
      assert.equal(status.email, "b@example.com");

      // Signed out: nothing at all.
      yield* Effect.promise(() => fs.rm(antigravityTokenPath(profileDir)));
      assert.deepEqual(yield* reader.status, {});
    }),
  );

  it.effect("signing in or out cancels a read in flight, and it never lands", () =>
    Effect.gen(function* () {
      const { reader, google } = yield* setup({ route: () => "hang" });
      yield* reader.status;
      yield* Effect.yieldNow;
      assert.isAbove(google.sent.length, 0);
      yield* reader.reset;
      assert.sameMembers(
        google.aborted,
        google.sent.map((request) => request.url),
      );
      assert.equal((yield* reader.status).accountUsage, undefined);
    }),
  );

  it.effect("names the limit a stopped model waits on, from the last reading", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-09T12:00:00Z"));
      const { readOnce, reader } = yield* setup({
        route: googleRoute({ summary: { body: SUMMARY } }),
      });
      yield* readOnce;
      assert.deepEqual(yield* reader.usageLimitFor("Claude Sonnet 5.5"), {
        window: "weekly",
        resetsAt: "2026-10-10T15:28:22.000Z",
      });
      assert.equal(yield* reader.usageLimitFor("Gemini 3.1 Pro"), undefined);
    }),
  );
});

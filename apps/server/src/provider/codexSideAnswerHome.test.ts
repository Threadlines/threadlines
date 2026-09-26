import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  borrowCodexSignIn,
  CODEX_SIDE_ANSWER_CONFIG,
  codexSignInHome,
  prepareCodexSideAnswerHome,
  readCodexSignIn,
  removeCodexSideAnswerHome,
} from "./codexSideAnswerHome.ts";

const threadId = "01a0dc00-9850-7ca0-8836-c52b67ffe2a3";
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeSignInHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-signin-test-"));
  scratch.push(home);
  const idToken = `x.${Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }),
  ).toString("base64url")}.y`;
  fs.writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: "at", account_id: "acct", id_token: idToken } }),
  );
  const day = path.join(home, "sessions/2026/09/26");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-09-26T00-00-00-${threadId}.jsonl`), "{}\n");
  return home;
}

describe("codex side-answer home", () => {
  it("copies the conversation into a home of its own and leaves the sign-in behind", async () => {
    const signInHome = fakeSignInHome();
    const authBefore = fs.readFileSync(path.join(signInHome, "auth.json"), "utf8");
    const home = await Effect.runPromise(
      prepareCodexSideAnswerHome({ signInHome, sourceProviderThreadId: threadId }),
    );
    scratch.push(home.homePath);

    expect(fs.readFileSync(path.join(home.homePath, "config.toml"), "utf8")).toBe(
      CODEX_SIDE_ANSWER_CONFIG,
    );
    expect(home.rolloutPath).toBe(
      path.join(home.homePath, `sessions/2026/09/26/rollout-2026-09-26T00-00-00-${threadId}.jsonl`),
    );
    expect(fs.existsSync(home.rolloutPath!)).toBe(true);
    expect(fs.existsSync(path.join(home.homePath, "auth.json"))).toBe(false);
    expect(fs.readFileSync(path.join(signInHome, "auth.json"), "utf8")).toBe(authBefore);
    expect(await Effect.runPromise(readCodexSignIn(signInHome, {}))).toEqual({
      kind: "chatgpt",
      accessToken: "at",
      chatgptAccountId: "acct",
      chatgptPlanType: "pro",
    });

    expect(await Effect.runPromise(removeCodexSideAnswerHome(home.homePath))).toBe(true);
    expect(fs.existsSync(home.homePath)).toBe(false);
  });

  it("never deletes a folder that is not one of its own homes", async () => {
    const signInHome = fakeSignInHome();
    expect(await Effect.runPromise(removeCodexSideAnswerHome(signInHome))).toBe(false);
    expect(fs.existsSync(path.join(signInHome, "auth.json"))).toBe(true);
  });

  it("finds the user's Codex home the way their normal runtime does", () => {
    expect(codexSignInHome("/configured", { CODEX_HOME: "/from-env" })).toBe("/configured");
    expect(codexSignInHome(undefined, { CODEX_HOME: "/from-env" })).toBe("/from-env");
    expect(codexSignInHome("", {})).toBe(path.join(os.homedir(), ".codex"));
  });

  it("has the user's own Codex renew a refused or expiring token, and never hands back a dead one", async () => {
    const signInHome = fakeSignInHome();
    const jwt = (expSeconds: number) =>
      `x.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.y`;
    const writeToken = (accessToken: string) =>
      fs.writeFileSync(
        path.join(signInHome, "auth.json"),
        JSON.stringify({ tokens: { access_token: accessToken, account_id: "acct" } }),
      );
    const inAnHour = Math.floor(Date.now() / 1000) + 3600;
    const expired = Math.floor(Date.now() / 1000) - 60;
    let renewals = 0;
    const borrow = (renewTo: string | null, rejectedAccessToken?: string) =>
      Effect.runPromise(
        borrowCodexSignIn({
          signInHome,
          environment: {},
          renewOwner: Effect.sync(() => {
            renewals += 1;
            if (renewTo !== null) writeToken(renewTo);
          }),
          ...(rejectedAccessToken !== undefined ? { rejectedAccessToken } : {}),
        }).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
          Effect.orElseSucceed(() => "ok"),
        ),
      );

    // A live token is handed over as is.
    writeToken(jwt(inAnHour));
    expect(await borrow(null)).toBe("ok");
    expect(renewals).toBe(0);
    // Codex refused it: the owner renews, and the new one goes over.
    expect(await borrow(jwt(inAnHour + 1), jwt(inAnHour))).toBe("ok");
    expect(renewals).toBe(1);
    // Expired and the owner could not renew it: a clear failure, not the dead token.
    writeToken(jwt(expired));
    expect(await borrow(null)).toBe("The Codex sign-in has expired. Sign in to Codex again.");
  });

  it("shares one renewal between side answers that need a new token at once", async () => {
    const signInHome = fakeSignInHome();
    const jwt = (expSeconds: number) =>
      `x.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.y`;
    const writeToken = (accessToken: string) =>
      fs.writeFileSync(
        path.join(signInHome, "auth.json"),
        JSON.stringify({ tokens: { access_token: accessToken, account_id: "acct" } }),
      );
    const expired = jwt(Math.floor(Date.now() / 1000) - 60);
    const renewed = jwt(Math.floor(Date.now() / 1000) + 3600);
    writeToken(expired);
    let renewals = 0;
    const renewOwner = Effect.sleep("50 millis").pipe(
      Effect.andThen(
        Effect.sync(() => {
          renewals += 1;
          writeToken(renewed);
        }),
      ),
    );
    const borrow = borrowCodexSignIn({ signInHome, environment: {}, renewOwner });
    const both = await Effect.runPromise(Effect.all([borrow, borrow], { concurrency: 2 }));
    expect(renewals).toBe(1);
    expect(both.map((signIn) => signIn.kind === "chatgpt" && signIn.accessToken)).toEqual([
      renewed,
      renewed,
    ]);
  });
});

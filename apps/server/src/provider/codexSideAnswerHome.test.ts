import * as Effect from "effect/Effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CODEX_SIDE_ANSWER_CONFIG,
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
    expect(await Effect.runPromise(readCodexSignIn(signInHome))).toEqual({
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
});

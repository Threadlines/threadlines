import { describe, expect, it } from "vite-plus/test";

import { piTurnFailure } from "./PiFailure.ts";

const HINT = "Sign in again from Settings → Pi → Sign in, then retry.";

describe("piTurnFailure", () => {
  // Pi 1.3's own text for each provider's refused key: captured with fake keys, and
  // Google's in the shape its SDK writes it.
  it.each([
    [
      "openai",
      'OpenAI API error (401): {"message":"Incorrect API key provided: sk-bogus*************test. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key","param":null}',
      "OpenAI rejected Pi's key or sign-in: Incorrect API key provided: sk-bogus*************test. You can find your API key at https://platform.openai.com/account/api-keys.",
    ],
    [
      "deepseek",
      '401: {"message":"Authentication Fails, Your api key: ****test is invalid","type":"authentication_error","param":null,"code":"invalid_request_error"}',
      "DeepSeek rejected Pi's key or sign-in: Authentication Fails, Your api key: ****test is invalid.",
    ],
    [
      "zai",
      '401: {"code":"1000","message":"Authentication Failed"}',
      "Z.AI rejected Pi's key or sign-in: Authentication Failed.",
    ],
    [
      "minimax-cn",
      `401 {"type":"error","error":{"type":"authentication_error","message":"login fail: Please carry the API secret key in the 'X-Api-Key' field of the request header"}}`,
      "MiniMax CN rejected Pi's key or sign-in: login fail: Please carry the API secret key in the 'X-Api-Key' field of the request header.",
    ],
    [
      "google",
      '{"error":{"code":401,"message":"Request had invalid authentication credentials.","status":"UNAUTHENTICATED"}}',
      "Google rejected Pi's key or sign-in: Request had invalid authentication credentials.",
    ],
  ])("says a key %s refused plainly, with the way to fix it", (provider, failure, said) => {
    expect(piTurnFailure(failure, provider)).toEqual({
      category: "auth",
      message: `${said} ${HINT}`,
    });
  });

  it("names the provider Pi has no key for, from Pi's own words or the chat's model", () => {
    const noKeyForModel =
      "Pi did not accept the message: No API key found for the selected model.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /Users/someone/.pi/docs/providers.md";
    expect(piTurnFailure(noKeyForModel, "moonshotai-cn")).toEqual({
      category: "auth",
      message:
        "Pi has no key or sign-in for Moonshot AI CN, which this chat's model needs. Sign in to Moonshot AI CN from Settings → Pi → Sign in, or pick another model.",
    });
    expect(piTurnFailure('No API key found for "deepseek"', undefined).message).toContain(
      "Pi has no key or sign-in for DeepSeek,",
    );
    expect(piTurnFailure("No API key for provider: zai", "openai").message).toContain(
      "Pi has no key or sign-in for Z.AI,",
    );
    const renewal =
      "Pi couldn't renew its sign-in to OpenAI Codex. Check that this computer can reach OpenAI Codex, or sign in again from Settings → Pi → Sign in, then retry.";
    expect(piTurnFailure("OAuth refresh failed for openai-codex", undefined)).toEqual({
      category: "auth",
      message: renewal,
    });
    expect(
      piTurnFailure(
        `Authentication failed for "openai-codex". Credentials may have expired or network is unavailable. Run '/login openai-codex' to re-authenticate.`,
        "deepseek",
      ),
    ).toEqual({ category: "auth", message: renewal });
  });

  it("keeps other failures in Pi's words, with the category their status names", () => {
    const refused = '403: {"error":{"message":"Unauthorized region"}}';
    // A 403 is the provider refusing an account it knows; signing in again won't fix it.
    expect(piTurnFailure(refused, "openai")).toEqual({ category: "permission", message: refused });
    expect(piTurnFailure('429: {"message":"Too many requests"}', "openai").category).toBe(
      "rate_limit",
    );
    expect(piTurnFailure("The model request failed.", "openai")).toEqual({
      message: "The model request failed.",
    });
  });
});

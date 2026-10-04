import { describe, expect, it } from "vite-plus/test";

import {
  antigravityNextStep,
  isAntigravityKeyEnvName,
  readAntigravitySignInSetup,
} from "./antigravitySignIn.ts";

describe("readAntigravitySignInSetup", () => {
  it("reads the method's own key only, saved or just typed", () => {
    const environment = [
      { name: "GOOGLE_API_KEY", value: "", valueRedacted: true },
      { name: "gemini_api_key", value: "" },
    ];
    expect(
      readAntigravitySignInSetup({ config: { authMethod: "agent-platform" }, environment }).hasKey,
    ).toBe(true);
    // An empty, unsaved value is no key.
    expect(
      readAntigravitySignInSetup({ config: { authMethod: "gemini-api-key" }, environment }).hasKey,
    ).toBe(false);
    expect(readAntigravitySignInSetup({ config: {} }).method).toBe("oauth-personal");
    expect(isAntigravityKeyEnvName(" gemini_api_key ")).toBe(true);
  });
});

describe("antigravityNextStep", () => {
  const step = (
    config: Record<string, string>,
    environment: ReadonlyArray<{ name: string; value: string; valueRedacted?: boolean }> = [],
    snapshot?: { status: string; auth: { status: string; type?: string } },
  ) =>
    antigravityNextStep({
      setup: readAntigravitySignInSetup({ config, environment }),
      ...(snapshot ? { snapshot } : {}),
    });
  const savedGeminiKey = [{ name: "GEMINI_API_KEY", value: "", valueRedacted: true }];

  it("sends what only a field can fix to the Account tab, and runs the rest", () => {
    expect(step({})).toEqual({ kind: "run", label: "Sign in with Google" });
    expect(step({ authMethod: "oauth-business" })).toEqual({ kind: "settings", label: "Set up" });
    expect(
      step({ authMethod: "oauth-business", gcpProject: "acme", gcpLocation: "global" }),
    ).toEqual({ kind: "run", label: "Sign in" });
    expect(step({ authMethod: "gemini-api-key" })).toEqual({ kind: "settings", label: "Add key" });
    expect(step({ authMethod: "gemini-api-key" }, savedGeminiKey)).toEqual({
      kind: "run",
      label: "Check key",
    });
    expect(step({ authMethod: "agent-platform" })).toEqual({ kind: "settings", label: "Set up" });
    expect(step({ authMethod: "agent-platform", gcpProject: "acme", gcpLocation: "us" })).toEqual({
      kind: "run",
      label: "Check again",
    });
  });

  it("asks for a new key once Google rejected the saved one, not for another method's status", () => {
    const rejected = {
      status: "error",
      auth: { status: "unauthenticated", type: "gemini-api-key" },
    };
    expect(step({ authMethod: "gemini-api-key" }, savedGeminiKey, rejected)).toEqual({
      kind: "settings",
      label: "Replace key",
    });
    // A status still about the previous method says nothing about this key.
    expect(
      step({ authMethod: "gemini-api-key" }, savedGeminiKey, {
        ...rejected,
        auth: { status: "unauthenticated", type: "agent-platform" },
      }),
    ).toEqual({ kind: "run", label: "Check key" });
  });
});

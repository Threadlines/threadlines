import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";

import {
  analyticsModelProperties,
  classifyProviderSessionStart,
  classifyModelRerouteReason,
  classifyProviderFailure,
  normalizeAnalyticsModel,
  providerChecksSettled,
  providerReadinessProperties,
} from "./AnalyticsProperties.ts";

const providerSnapshot = (
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-02T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("AnalyticsProperties", () => {
  it("keeps known public model slugs", () => {
    assert.deepStrictEqual(normalizeAnalyticsModel(" GPT-5.4 "), {
      model: "gpt-5.4",
      modelKind: "known",
      modelFamily: "gpt",
    });
    assert.deepStrictEqual(normalizeAnalyticsModel("claude-sonnet-4-6"), {
      model: "claude-sonnet-4-6",
      modelKind: "known",
      modelFamily: "claude",
    });
    assert.deepStrictEqual(normalizeAnalyticsModel("claude-opus-5"), {
      model: "claude-opus-5",
      modelKind: "known",
      modelFamily: "claude",
    });
  });

  it("redacts custom and provider-prefixed model strings", () => {
    assert.deepStrictEqual(normalizeAnalyticsModel("openai/private-gpt-5-prod"), {
      model: "custom",
      modelKind: "custom",
      modelFamily: "gpt",
    });
    assert.deepStrictEqual(normalizeAnalyticsModel("my-internal-model"), {
      model: "custom",
      modelKind: "custom",
      modelFamily: "other",
    });
  });

  it("emits prefixed model properties", () => {
    assert.deepStrictEqual(analyticsModelProperties({ model: "claude-opus-4-8", prefix: "from" }), {
      fromModel: "claude-opus-4-8",
      fromModelKind: "known",
      fromModelFamily: "claude",
    });
  });

  it("categorizes provider failures without exposing raw messages", () => {
    assert.strictEqual(
      classifyProviderFailure({ message: "API Error: 429 rate limit exceeded" }),
      "rate_limit",
    );
    assert.strictEqual(
      classifyProviderFailure({ errorClass: "authentication_error", message: "raw detail" }),
      "auth",
    );
    assert.strictEqual(
      classifyProviderFailure({ message: "Context window exceeded for this request" }),
      "context_length",
    );
  });

  it("categorizes the failures providers actually report", () => {
    const cases = [
      [
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:19 AM.",
        "rate_limit",
      ],
      [
        "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
        "auth",
      ],
      ["Selected model is at capacity. Please try a different model.", "overloaded"],
      [
        "Provider adapter process error (claudeAgent) for thread t1: Claude Code native binary not found at claude. Please ensure Claude Code is installed.",
        "not_installed",
      ],
      ["'claude' is not recognized as an internal or external command", "not_installed"],
      [
        "Provider adapter process error (claudeAgent) for thread t1: Claude Code returned an error result: No conversation found with session ID: s1",
        "session_lost",
      ],
      [
        "Provider adapter process error (claudeAgent) for thread t1: Claude Code process exited with code 143",
        "process_exit",
      ],
      ['Path "/Users/someone/project" does not exist', "missing_directory"],
      ["Thread does not exist", "session_lost"],
      ["The model `gpt-x` does not exist or you do not have access to it.", "model_unavailable"],
      // Folder names are arbitrary words; only the provider's wording counts.
      ['Path "/Users/someone/model" does not exist', "missing_directory"],
      ['Path "/Users/someone/auth-login-fix" does not exist', "missing_directory"],
      [
        "Provider adapter process error (claudeAgent) for thread t1: This thread's folder no longer exists: /Users/someone/network-tools",
        "missing_directory",
      ],
      ["Error: spawn /usr/local/bin/claude ENOENT", "not_installed"],
    ] as const;
    for (const [message, category] of cases) {
      assert.strictEqual(
        classifyProviderFailure({ errorClass: "provider_error", message }),
        category,
        message,
      );
    }
    assert.strictEqual(
      classifyProviderFailure({ errorClass: "provider_error", message: "Something odd happened" }),
      "provider_error",
    );
  });

  it("summarizes whether an agent is ready without account details", () => {
    const codexSignedIn = providerSnapshot("codex", {
      auth: { status: "authenticated", email: "someone@example.com", label: "ChatGPT Pro" },
    });
    const claudeSignedOut = providerSnapshot("claudeAgent", {
      status: "warning",
      auth: { status: "unauthenticated" },
    });
    assert.deepStrictEqual(providerReadinessProperties([codexSignedIn, claudeSignedOut]), {
      anyAgentInstalled: true,
      anyAgentSignedIn: true,
      anyAgentReady: true,
      anyAgentCheckTimedOut: false,
      claudeEnabled: true,
      claudeInstalled: true,
      claudeSignedIn: "no",
      codexEnabled: true,
      codexInstalled: true,
      codexSignedIn: "yes",
    });

    // Nothing usable: Codex missing, Claude turned off in Settings.
    assert.deepStrictEqual(
      providerReadinessProperties([
        providerSnapshot("codex", {
          installed: false,
          status: "error",
          auth: { status: "unknown" },
        }),
        providerSnapshot("claudeAgent", { enabled: false }),
      ]),
      {
        anyAgentInstalled: false,
        anyAgentSignedIn: false,
        anyAgentReady: false,
        anyAgentCheckTimedOut: false,
        claudeEnabled: false,
        claudeInstalled: false,
        claudeSignedIn: "unknown",
        codexEnabled: true,
        codexInstalled: false,
        codexSignedIn: "unknown",
      },
    );
  });

  it("does not count an agent whose check timed out as ready", () => {
    const properties = providerReadinessProperties([
      providerSnapshot("codex", {
        status: "warning",
        statusReason: "provider_probe_timeout",
        auth: { status: "unknown" },
      }),
    ]);
    assert.strictEqual(properties.anyAgentInstalled, true);
    assert.strictEqual(properties.anyAgentReady, false);
    assert.strictEqual(properties.anyAgentCheckTimedOut, true);
  });

  it("waits for provider checks that are still running", () => {
    assert.isFalse(providerChecksSettled([]));
    assert.isFalse(
      providerChecksSettled([
        providerSnapshot("codex"),
        providerSnapshot("claudeAgent", { statusReason: "provider_probe_pending" }),
      ]),
    );
    assert.isTrue(
      providerChecksSettled([
        providerSnapshot("codex"),
        providerSnapshot("claudeAgent", { statusReason: "provider_probe_timeout" }),
      ]),
    );
  });

  it("categorizes model reroutes", () => {
    assert.deepStrictEqual(classifyModelRerouteReason("fallback:model-unavailable"), {
      reasonCategory: "model_unavailable",
      isFallback: true,
    });
    assert.deepStrictEqual(classifyModelRerouteReason("fallback:refusal"), {
      reasonCategory: "refusal",
      isFallback: true,
    });
  });

  it("classifies provider session starts", () => {
    assert.strictEqual(
      classifyProviderSessionStart({
        hasPreviousBinding: false,
        nextProvider: "codex",
        nextInstanceId: "codex",
        hasContextSeed: false,
        hasResumeCursor: false,
      }),
      "fresh",
    );
    assert.strictEqual(
      classifyProviderSessionStart({
        hasPreviousBinding: true,
        previousProvider: "codex",
        previousInstanceId: "codex",
        nextProvider: "claudeAgent",
        nextInstanceId: "claudeAgent",
        hasContextSeed: true,
        hasResumeCursor: false,
      }),
      "provider_switch",
    );
    assert.strictEqual(
      classifyProviderSessionStart({
        hasPreviousBinding: true,
        previousProvider: "codex",
        previousInstanceId: "codex",
        nextProvider: "codex",
        nextInstanceId: "codex",
        hasContextSeed: false,
        hasResumeCursor: true,
      }),
      "resume",
    );
  });
});

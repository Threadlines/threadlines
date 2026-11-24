import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@threadlines/contracts";

import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import {
  analyticsAgentProperties,
  analyticsModelProperties,
  classifyProviderSessionStart,
  classifyModelRerouteReason,
  classifyProviderFailure,
  normalizeAnalyticsModel,
  providerChecksSettled,
  providerReadinessProperties,
  stallDurationBucket,
  themeAnalyticsProperties,
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
    // A version may end in a letter.
    assert.strictEqual(normalizeAnalyticsModel("gpt-4o").model, "gpt-4o");
    assert.strictEqual(normalizeAnalyticsModel("gpt-4o-mini").model, "gpt-4o-mini");
    assert.strictEqual(
      normalizeAnalyticsModel("openai/gpt-4o-2024-08-06").model,
      "gpt-4o-2024-08-06",
    );
    assert.strictEqual(normalizeAnalyticsModel("grok-4.7-build-fast").model, "grok-4.7-build-fast");
    assert.strictEqual(normalizeAnalyticsModel("grok-code-fast-1").model, "grok-code-fast-1");
    assert.strictEqual(
      normalizeAnalyticsModel("gemini-2.0-flash-001").model,
      "gemini-2.0-flash-001",
    );
    assert.deepStrictEqual(normalizeAnalyticsModel("gemini-4-argon"), {
      model: "gemini-4-argon",
      modelKind: "known",
      modelFamily: "gemini",
    });
    assert.strictEqual(normalizeAnalyticsModel("gemini-4-argon-high").model, "gemini-4-argon-high");
    assert.strictEqual(normalizeAnalyticsModel("gemini-4-carbon").model, "gemini-4-carbon");
    assert.strictEqual(normalizeAnalyticsModel("gemini-4-neon").model, "gemini-4-neon");
    assert.strictEqual(
      normalizeAnalyticsModel("gemini-4-hydrogen-sonar").model,
      "gemini-4-hydrogen-sonar",
    );
    assert.deepStrictEqual(normalizeAnalyticsModel("muse-spark-1.3"), {
      model: "muse-spark-1.3",
      modelKind: "known",
      modelFamily: "muse",
    });
    assert.deepStrictEqual(normalizeAnalyticsModel("claude-mythos-5-1"), {
      model: "claude-mythos-5-1",
      modelKind: "known",
      modelFamily: "claude",
    });
    assert.deepStrictEqual(normalizeAnalyticsModel("o3"), {
      model: "o3",
      modelKind: "known",
      modelFamily: "gpt",
    });
    assert.strictEqual(normalizeAnalyticsModel("openai/o4-mini").model, "o4-mini");
    // Antigravity, Cursor, and Claude variant shapes.
    assert.strictEqual(normalizeAnalyticsModel("gpt-6-1").model, "gpt-6-1");
    assert.strictEqual(normalizeAnalyticsModel("gpt-oss-120b-medium").model, "gpt-oss-120b-medium");
    assert.strictEqual(normalizeAnalyticsModel("gemini-pro-agent").model, "gemini-pro-agent");
    assert.strictEqual(normalizeAnalyticsModel("gemini-4-pro-xhigh").model, "gemini-4-pro-xhigh");
    assert.strictEqual(
      normalizeAnalyticsModel("gemini-4-flash-extra").model,
      "gemini-4-flash-extra",
    );
    assert.strictEqual(normalizeAnalyticsModel("composer-2.5-fast").model, "composer-2.5-fast");
    assert.strictEqual(normalizeAnalyticsModel("grok-build-0.1").model, "grok-build-0.1");
    assert.strictEqual(
      normalizeAnalyticsModel("claude-4.6-opus-high-thinking").model,
      "claude-4-6-opus-high-thinking",
    );
    assert.deepStrictEqual(normalizeAnalyticsModel("opus-4.6"), {
      model: "claude-opus-4-6",
      modelKind: "known",
      modelFamily: "claude",
    });
    assert.deepStrictEqual(normalizeAnalyticsModel("opus-4.6-thinking"), {
      model: "claude-opus-4-6-thinking",
      modelKind: "known",
      modelFamily: "claude",
    });
    assert.deepStrictEqual(normalizeAnalyticsModel("opus"), {
      model: "opus",
      modelKind: "known",
      modelFamily: "claude",
    });
    assert.deepStrictEqual(normalizeAnalyticsModel("claude-opus-5-5[1m]"), {
      model: "claude-opus-5-5",
      modelKind: "known",
      modelFamily: "claude",
    });
    assert.strictEqual(normalizeAnalyticsModel("gpt-5.4[reasoning=high]").model, "gpt-5.4");
    assert.strictEqual(
      normalizeAnalyticsModel("gpt-5.4[reasoning=xhigh,fast=true,context=1m]").model,
      "gpt-5.4",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("openrouter/anthropic/claude-opus-5.5:batch").model,
      "claude-opus-5-5",
    );
    assert.strictEqual(normalizeAnalyticsModel("kimi-for-coding").model, "kimi-for-coding");
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
    const privateNames = [
      // A public name behind a gateway nobody knows, or an Azure deployment.
      "acme-gateway/claude-sonnet-5-5",
      "acme-gateway/deepseek-v4-pro",
      "acme-gateway/big-pickle",
      "azure/gpt-5.4",
      "openrouter/acme/claude-sonnet-5-5",
      "openrouter/acme/deepseek-v4-pro",
      // A user's own model added under a public provider's name, or named
      // like a public one with no provider at all.
      "openai/gpt-5.4-acme-payroll",
      "gpt-5.4-acme-payroll",
      "gpt-4o-acme-payroll",
      "gpt-5x-sol",
      "gpt-oss-120b-acme",
      "google/gemini-2.5-acme-payroll",
      "gemini-4-acme",
      "muse-acme-payroll",
      "muse-4242-1717",
      "gpt-5-4242-1717",
      "grok-4-12-34-56-78",
      "mistral/mistral-small-12-34-56-78",
      "deepseek-v4-0101-0202-0303",
      "qwen3-12-34-56-78",
      "llama-4-12-34-56-78",
      "claude-sonnet-4-20999999",
      "claude-mythos-5-acme",
      "o3-acme",
      "deepseek-v4-4242",
      "qwen3-acme-payroll",
      "glm-5.3-acme",
      "kimi-k3-acme",
      "minimax-m3-acme",
      "llama-4-acme",
      // Private bracket traits or unknown colon modifiers.
      "gpt-5.4[acme=secret]",
      "cloudflare-workers-ai/@cf/openai/gpt-oss-120b[acme=secret]",
      "claude-opus-5-5[acme]",
      "gpt-5.4:acme",
      // Bare single English words from the catalog stay custom without a provider.
      "apex",
      "fusion",
      "openai/gpt-5.4-123456789012",
      // Whatever made a long name private may be past the cut.
      `gpt-5-${"a".repeat(96)}:acme`,
    ];
    for (const name of privateNames) {
      assert.strictEqual(normalizeAnalyticsModel(name).model, "custom", name);
    }
  });

  it("names public models that agents write behind a public provider", () => {
    assert.deepStrictEqual(normalizeAnalyticsModel("google/gemini-2.5-pro"), {
      model: "gemini-2.5-pro",
      modelKind: "known",
      modelFamily: "gemini",
    });
    assert.deepStrictEqual(normalizeAnalyticsModel("openrouter/anthropic/claude-sonnet-4.5"), {
      model: "claude-sonnet-4-5",
      modelKind: "known",
      modelFamily: "claude",
    });
    assert.strictEqual(
      normalizeAnalyticsModel("github-copilot/claude-opus-4.7").model,
      "claude-opus-4-7",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("gemini-3-pro-preview").model,
      "gemini-3-pro-preview",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("google/gemini-3.1-pro-preview-customtools").model,
      "gemini-3.1-pro-preview-customtools",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("anthropic/claude-sonnet-4-5-20250929").model,
      "claude-sonnet-4-5-20250929",
    );
  });

  it("names public models across OpenCode, fx, Pi, and community agents", () => {
    assert.deepStrictEqual(normalizeAnalyticsModel("deepseek/deepseek-v4-pro", "pi"), {
      model: "deepseek-v4-pro",
      modelKind: "known",
      modelFamily: "other",
    });
    assert.strictEqual(normalizeAnalyticsModel("zai/GLM-4.7", "pi").model, "glm-4.7");
    assert.strictEqual(
      normalizeAnalyticsModel("google/gemini-4-argon", "pi").model,
      "gemini-4-argon",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("amazon-bedrock/global.openai.gpt-6-sol", "pi").model,
      "global.openai.gpt-6-sol",
    );
    // OpenCode, fx, and community agents share the same public model families and catalog.
    assert.strictEqual(
      normalizeAnalyticsModel("deepseek/deepseek-v4-pro", "opencode").model,
      "deepseek-v4-pro",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("opencode/big-pickle", "opencode").model,
      "big-pickle",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("opencode-go/mimo-v2.6-pro", "opencode").model,
      "mimo-v2.6-pro",
    );
    assert.strictEqual(normalizeAnalyticsModel("moonshotai/kimi-k3", "fx").model, "kimi-k3");
    assert.strictEqual(normalizeAnalyticsModel("spacexai/grok-4.6", "fx").model, "grok-4.6");
    assert.strictEqual(normalizeAnalyticsModel("alibaba/qwen-3-235b", "fx").model, "qwen-3-235b");
    assert.strictEqual(
      normalizeAnalyticsModel("vercel-ai-gateway/moonshotai/kimi-k3", "opencode").model,
      "kimi-k3",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("openrouter/baidu/ernie-5.5-flash-preview:free", "opencode").model,
      "ernie-5.5-flash-preview",
    );
    assert.strictEqual(
      normalizeAnalyticsModel(
        "cloudflare-workers-ai/@cf/openai/gpt-oss-120b[reasoning=high]",
        "opencode",
      ).model,
      "gpt-oss-120b",
    );
    assert.strictEqual(normalizeAnalyticsModel("alibaba/qwen3.8-max", "fx").model, "qwen3.8-max");
    assert.strictEqual(
      normalizeAnalyticsModel("qwen3-coder-plus", "acpRegistry").model,
      "qwen3-coder-plus",
    );
    assert.strictEqual(normalizeAnalyticsModel("glm-5.3", "acpRegistry").model, "glm-5.3");
    assert.strictEqual(
      normalizeAnalyticsModel("openrouter/z-ai/glm-5.3", "opencode").model,
      "glm-5.3",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("minimax/minimax-m3.1-flash", "acpRegistry").model,
      "minimax-m3.1-flash",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("mistral/devstral-2512", "opencode").model,
      "devstral-2512",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("meta-llama/llama-4-scout-17b-16e-instruct", "opencode").model,
      "llama-4-scout-17b-16e-instruct",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("openrouter/google/gemma-4-26b-a4b-it:free", "opencode").model,
      "gemma-4-26b-a4b-it",
    );
    // A user-added model under a public provider stays custom everywhere.
    assert.strictEqual(
      normalizeAnalyticsModel("deepseek/deepseek-acme-payroll", "pi").model,
      "custom",
    );
    assert.strictEqual(
      normalizeAnalyticsModel("deepseek/deepseek-acme-payroll", "opencode").model,
      "custom",
    );
    // Azure stays custom outside built-in Pi.
    assert.strictEqual(normalizeAnalyticsModel("azure/gpt-5.4", "opencode").model, "custom");
    assert.strictEqual(normalizeAnalyticsModel("azure/gpt-5.4", "pi").model, "gpt-5.4");
  });

  it("names a community agent by its registry id", () => {
    assert.deepStrictEqual(
      analyticsAgentProperties({ provider: "acpRegistry", communityAgentId: "pi-acp" }),
      { provider: "acpRegistry", communityAgentId: "pi-acp" },
    );
    assert.deepStrictEqual(analyticsAgentProperties({ provider: "codex" }), {
      provider: "codex",
    });
    assert.deepStrictEqual(
      analyticsAgentProperties({ provider: "acpRegistry", communityAgentId: "/Users/someone" }),
      { provider: "acpRegistry" },
    );
    assert.deepStrictEqual(
      analyticsAgentProperties({
        provider: "acpRegistry",
        communityAgentId: "pi-acp",
        prefix: "source",
      }),
      { sourceProvider: "acpRegistry", sourceCommunityAgentId: "pi-acp" },
    );
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
    // The agent's own code beats both the error class and the wording.
    assert.strictEqual(
      classifyProviderFailure({
        category: "context_length",
        errorClass: "authentication_error",
        message: "Please sign in again",
      }),
      "context_length",
    );
    // A stop reason alone still names the failure.
    assert.strictEqual(classifyProviderFailure({ reason: "rate_limit" }), "rate_limit");
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
      ["You've hit your session limit · resets 1:50am (America/New_York)", "rate_limit"],
      ["Credit balance is too low", "rate_limit"],
      ["prompt is too long: 214000 tokens > 200000 maximum", "context_length"],
      [
        "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)",
        "network",
      ],
      ["unexpected status 500 Internal Server Error", "server_error"],
      ['unexpected status 400 Bad Request: {"detail":"Unsupported parameter"}', "validation"],
      ["The model refused to answer this request.", "refusal"],
      // A refused connection is a network fault, not a model refusing.
      ["connection refused by the proxy", "network"],
      // A generic internal error defers to the cause it wraps.
      ["Internal error: connection refused", "network"],
      ["Internal error: spawn /usr/local/bin/claude ENOENT", "not_installed"],
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

  it("names every built-in agent, and community agents together without naming them", () => {
    for (const { driverKind } of BUILT_IN_DRIVERS) {
      const properties = providerReadinessProperties([providerSnapshot(driverKind)]);
      assert.isTrue(
        Object.keys(properties).some((key) => key.endsWith("Enabled")),
        `${driverKind} has no readiness properties of its own`,
      );
    }

    const communityAgent = (id: string, overrides: Partial<ServerProvider> = {}) =>
      providerSnapshot("acpRegistry", {
        instanceId: ProviderInstanceId.make(`acp-${id}`),
        ...overrides,
      });
    const properties = providerReadinessProperties([
      communityAgent("pi-acp"),
      communityAgent("kimi-cli", { installed: false, auth: { status: "unknown" } }),
    ]);
    assert.include(properties, {
      communityAgentEnabled: true,
      communityAgentInstalled: true,
      communityAgentSignedIn: "yes",
    });
    assert.notInclude(JSON.stringify(properties), "pi-acp");
    assert.notInclude(JSON.stringify(properties), "kimi-cli");
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

  it("distinguishes VS Code / Open VSX themes and buckets stall durations", () => {
    const baseColors = {
      background: "#111111",
      foreground: "#eeeeee",
      mutedForeground: "#999999",
      accent: "#3366ff",
      accentForeground: "#ffffff",
    };
    assert.deepStrictEqual(
      themeAnalyticsProperties({
        format: "threadlines-theme@1",
        name: "Dracula",
        base: "dark",
        colors: baseColors,
        createdBy: {
          kind: "imported",
          vscode: { extension: "dracula-theme.theme-dracula", theme: "Dracula" },
        },
      }),
      { origin: "vscode", base: "dark", art: "none", customFonts: false },
    );
    assert.deepStrictEqual(
      themeAnalyticsProperties({
        format: "threadlines-theme@1",
        name: "Local",
        base: "light",
        colors: baseColors,
        createdBy: { kind: "imported" },
      }),
      { origin: "imported", base: "light", art: "none", customFonts: false },
    );

    assert.strictEqual(stallDurationBucket(2_000), "2-5s");
    assert.strictEqual(stallDurationBucket(4_999), "2-5s");
    assert.strictEqual(stallDurationBucket(5_000), "5-15s");
    assert.strictEqual(stallDurationBucket(14_999), "5-15s");
    assert.strictEqual(stallDurationBucket(15_000), "15s+");
  });
});

import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@threadlines/contracts";

import {
  claudeAuthCapabilityBadge,
  deriveProviderModelsForDisplay,
  hasClaudeCredentialOverrideEnvironment,
  preferClaudeNormalSignInEnvironment,
  preferClaudeLongLivedOAuthTokenEnvironment,
  providerAuthBadge,
} from "./ProviderInstanceCard";
import { getProviderSummary } from "./providerStatus";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("Claude credential preference helpers", () => {
  it("switches to normal Claude sign-in while masking inherited credential overrides", () => {
    expect(
      preferClaudeNormalSignInEnvironment([
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "oauth-token", sensitive: true },
        { name: "ANTHROPIC_API_KEY", value: "api-key", sensitive: true },
        { name: "OTHER_VAR", value: "kept", sensitive: false },
      ]),
    ).toEqual([
      { name: "OTHER_VAR", value: "kept", sensitive: false },
      {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "",
        sensitive: false,
        valueRedacted: false,
      },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: false, valueRedacted: false },
      { name: "ANTHROPIC_API_KEY", value: "", sensitive: false, valueRedacted: false },
    ]);
  });

  it("detects Claude credential overrides that take precedence over the long-lived token", () => {
    expect(
      hasClaudeCredentialOverrideEnvironment([
        { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      ]),
    ).toBe(false);
    expect(
      hasClaudeCredentialOverrideEnvironment([
        { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: true, valueRedacted: true },
      ]),
    ).toBe(true);
    expect(
      hasClaudeCredentialOverrideEnvironment([
        { name: "ANTHROPIC_API_KEY", value: "sk-ant-test", sensitive: true },
      ]),
    ).toBe(true);
  });

  it("prefers the long-lived token by clearing Anthropic credential overrides", () => {
    expect(
      preferClaudeLongLivedOAuthTokenEnvironment([
        { name: "ANTHROPIC_AUTH_TOKEN", value: "old-token", sensitive: true },
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "oauth-token", sensitive: true },
        { name: "OTHER_VAR", value: "kept", sensitive: false },
        { name: "ANTHROPIC_API_KEY", value: "sk-ant-test", sensitive: true },
        { name: "ANTHROPIC_AUTH_TOKEN", value: "duplicate", sensitive: true },
      ]),
    ).toEqual([
      { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "oauth-token", sensitive: true },
      { name: "OTHER_VAR", value: "kept", sensitive: false },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "", sensitive: false, valueRedacted: false },
      { name: "ANTHROPIC_API_KEY", value: "", sensitive: false, valueRedacted: false },
    ]);
  });
});

describe("Claude authentication presentation", () => {
  it("does not present a locally discovered credential as verified authentication", () => {
    const auth = {
      status: "authenticated" as const,
      capabilities: {
        chat: { status: "configured" as const },
        usage: { status: "unavailable" as const },
      },
    };

    expect(providerAuthBadge(auth)).toEqual({
      label: "Credential configured",
      variant: "secondary",
    });
    expect(claudeAuthCapabilityBadge(auth.capabilities.chat, "chat")).toEqual({
      label: "Chat configured",
      variant: "secondary",
    });
    expect(claudeAuthCapabilityBadge(auth.capabilities.usage, "usage")).toEqual({
      label: "Usage unavailable",
      variant: "warning",
    });
  });

  it("presents successful live chat and usage checks as verified", () => {
    const auth = {
      status: "authenticated" as const,
      capabilities: {
        chat: { status: "verified" as const },
        usage: { status: "verified" as const },
      },
    };

    expect(providerAuthBadge(auth)).toEqual({ label: "Authenticated", variant: "success" });
    expect(claudeAuthCapabilityBadge(auth.capabilities.chat, "chat")).toEqual({
      label: "Chat verified",
      variant: "success",
    });
    expect(claudeAuthCapabilityBadge(auth.capabilities.usage, "usage")).toEqual({
      label: "Usage verified",
      variant: "success",
    });
  });

  it("uses configured rather than authenticated language before a live turn succeeds", () => {
    const provider = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: "2.1.211",
      status: "ready",
      auth: {
        status: "authenticated",
        label: "Claude Max Subscription",
        capabilities: {
          chat: {
            status: "configured",
            detail: "A credential was found locally.",
          },
        },
      },
      checkedAt: "2026-07-15T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(getProviderSummary(provider)).toEqual({
      headline: "Credential configured · Claude Max Subscription",
      detail: null,
    });
  });
});

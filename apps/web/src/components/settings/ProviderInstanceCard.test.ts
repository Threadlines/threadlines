import { describe, expect, it } from "vitest";
import type {
  ProviderInstanceEnvironmentVariable,
  ServerProviderModel,
} from "@threadlines/contracts";

import {
  buildClaudeAuthLoginCommand,
  buildClaudeSetupTokenCommand,
  buildCodexLoginCommand,
  deriveClaudeLongLivedOAuthTokenState,
  deriveProviderModelsForDisplay,
  hasClaudeCredentialOverrideEnvironment,
  preferClaudeLongLivedOAuthTokenEnvironment,
  removeClaudeLongLivedOAuthTokenEnvironment,
  sanitizeClaudeLongLivedOAuthTokenInput,
  upsertClaudeLongLivedOAuthTokenEnvironment,
} from "./ProviderInstanceCard";

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

describe("Claude long-lived OAuth token environment helpers", () => {
  it("builds Claude terminal login commands for default and custom homes", () => {
    expect(buildClaudeAuthLoginCommand({ binaryPath: "", homePath: "" })).toBe("claude auth login");
    expect(
      buildClaudeAuthLoginCommand({
        binaryPath: "/Applications/Claude Code/claude",
        homePath: "/Users/example/Claude Home",
      }),
    ).toBe("HOME='/Users/example/Claude Home' '/Applications/Claude Code/claude' auth login");
  });

  it("builds the default setup-token command", () => {
    expect(buildClaudeSetupTokenCommand({ binaryPath: "", homePath: "" })).toBe(
      "claude setup-token",
    );
  });

  it("builds a setup-token command for custom Claude homes and binary paths", () => {
    expect(
      buildClaudeSetupTokenCommand({
        binaryPath: "/Applications/Claude Code/claude",
        homePath: "/Users/example/Claude Home",
      }),
    ).toBe("HOME='/Users/example/Claude Home' '/Applications/Claude Code/claude' setup-token");
  });

  it("keeps tilde homes unquoted so the shell can expand them", () => {
    expect(buildClaudeSetupTokenCommand({ binaryPath: "claude", homePath: "~/.claude_work" })).toBe(
      "HOME=~/.claude_work claude setup-token",
    );
  });

  it("detects redacted stored tokens without exposing a value", () => {
    expect(
      deriveClaudeLongLivedOAuthTokenState([
        {
          name: "CLAUDE_CODE_OAUTH_TOKEN",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
      ]),
    ).toEqual({
      configured: true,
      redacted: true,
      value: "",
    });
  });

  it("stores the token as a sensitive provider environment variable", () => {
    const environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> = [
      { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
    ];

    expect(upsertClaudeLongLivedOAuthTokenEnvironment(environment, " token-123 \n")).toEqual([
      { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
      {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "token-123",
        sensitive: true,
        valueRedacted: false,
      },
    ]);
  });

  it("removes paste artifacts from Claude setup-token output before storing", () => {
    expect(
      sanitizeClaudeLongLivedOAuthTokenInput(
        " export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-part one\\npart two' ",
      ),
    ).toBe("sk-ant-oat01-partoneparttwo");

    expect(
      upsertClaudeLongLivedOAuthTokenEnvironment([], "sk-ant-oat01-part one\npart two"),
    ).toEqual([
      {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "sk-ant-oat01-partoneparttwo",
        sensitive: true,
        valueRedacted: false,
      },
    ]);
  });

  it("replaces duplicate token variables with one sensitive value", () => {
    expect(
      upsertClaudeLongLivedOAuthTokenEnvironment(
        [
          {
            name: "CLAUDE_CODE_OAUTH_TOKEN",
            value: "",
            sensitive: true,
            valueRedacted: true,
          },
          { name: "OTHER_VAR", value: "kept", sensitive: false },
          { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "old", sensitive: false },
        ],
        "new-token",
      ),
    ).toEqual([
      {
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "new-token",
        sensitive: true,
        valueRedacted: false,
      },
      { name: "OTHER_VAR", value: "kept", sensitive: false },
    ]);
  });

  it("removes the token variable without touching unrelated environment", () => {
    expect(
      removeClaudeLongLivedOAuthTokenEnvironment([
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "token", sensitive: true },
        { name: "OTHER_VAR", value: "kept", sensitive: false },
      ]),
    ).toEqual([{ name: "OTHER_VAR", value: "kept", sensitive: false }]);
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

describe("Codex login command helpers", () => {
  it("builds default and custom Codex login commands", () => {
    expect(buildCodexLoginCommand({ binaryPath: "", homePath: "", shadowHomePath: "" })).toBe(
      "codex login",
    );
    expect(
      buildCodexLoginCommand({
        binaryPath: "codex",
        homePath: "~/.codex_work",
        shadowHomePath: "",
      }),
    ).toBe("CODEX_HOME=~/.codex_work codex login");
  });

  it("uses the Codex shadow home for account-specific login", () => {
    expect(
      buildCodexLoginCommand({
        binaryPath: "/opt/Code Agent/codex",
        homePath: "~/.codex",
        shadowHomePath: "/Users/example/Codex Personal",
      }),
    ).toBe("CODEX_HOME='/Users/example/Codex Personal' '/opt/Code Agent/codex' login");
  });
});

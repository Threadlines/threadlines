import { describe, expect, it } from "vite-plus/test";
import type { ProviderInstanceEnvironmentVariable } from "@threadlines/contracts";

import {
  buildClaudeAuthLoginCommand,
  buildClaudeSetupTokenCommand,
  buildCodexLoginCommand,
  buildProviderAuthCommand,
  deriveClaudeLongLivedOAuthTokenState,
  removeClaudeLongLivedOAuthTokenEnvironment,
  sanitizeClaudeLongLivedOAuthTokenInput,
  upsertClaudeLongLivedOAuthTokenEnvironment,
} from "./providerAuthCommands.ts";

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

describe("buildProviderAuthCommand", () => {
  it("runs the ACP providers' own login commands with no environment overrides", () => {
    expect(
      buildProviderAuthCommand({ driver: "fx", flow: "login", binaryPath: "", homePath: "" }),
    ).toEqual({ file: "fx", args: ["login"], env: {}, display: "fx login" });
    expect(
      buildProviderAuthCommand({
        driver: "cursor",
        flow: "login",
        binaryPath: "/opt/cursor/agent",
        homePath: "",
      }),
    ).toEqual({
      file: "/opt/cursor/agent",
      args: ["login"],
      env: {},
      display: "/opt/cursor/agent login",
    });
    expect(
      buildProviderAuthCommand({
        driver: "fx",
        flow: "claude-setup-token",
        binaryPath: "",
        homePath: "",
      }),
    ).toBeNull();
  });

  it("spawns the Codex binary directly with the shadow CODEX_HOME", () => {
    expect(
      buildProviderAuthCommand({
        driver: "codex",
        flow: "login",
        binaryPath: "/opt/Code Agent/codex",
        homePath: "~/.codex",
        shadowHomePath: "/Users/example/Codex Personal",
      }),
    ).toEqual({
      file: "/opt/Code Agent/codex",
      args: ["login"],
      env: { CODEX_HOME: "/Users/example/Codex Personal" },
      display: "CODEX_HOME='/Users/example/Codex Personal' '/opt/Code Agent/codex' login",
    });
  });

  it("resolves both Claude flows against the configured HOME", () => {
    expect(
      buildProviderAuthCommand({
        driver: "claudeAgent",
        flow: "claude-setup-token",
        binaryPath: "",
        homePath: "/Users/example/Claude Home",
      }),
    ).toEqual({
      file: "claude",
      args: ["setup-token"],
      env: { HOME: "/Users/example/Claude Home" },
      display: "HOME='/Users/example/Claude Home' claude setup-token",
    });
    expect(
      buildProviderAuthCommand({
        driver: "claudeAgent",
        flow: "login",
        binaryPath: "",
        homePath: "",
      })?.args,
    ).toEqual(["auth", "login"]);
  });

  it("has no command for flows a driver does not support", () => {
    expect(
      buildProviderAuthCommand({
        driver: "codex",
        flow: "claude-setup-token",
        binaryPath: "",
        homePath: "",
      }),
    ).toBeNull();
    expect(
      buildProviderAuthCommand({
        driver: "someFork",
        flow: "login",
        binaryPath: "",
        homePath: "",
      }),
    ).toBeNull();
  });
});

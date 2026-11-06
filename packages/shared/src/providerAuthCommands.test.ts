import { describe, expect, it } from "vite-plus/test";

import {
  buildClaudeAuthLoginCommand,
  buildCodexLoginCommand,
  buildProviderAuthCommand,
  openCodeAccountEnvironment,
} from "./providerAuthCommands.ts";

describe("Claude login command helpers", () => {
  it("builds Claude terminal login commands for default and custom homes", () => {
    expect(buildClaudeAuthLoginCommand({ binaryPath: "", homePath: "" })).toBe("claude auth login");
    expect(
      buildClaudeAuthLoginCommand({
        binaryPath: "/Applications/Claude Code/claude",
        homePath: "/Users/example/Claude Home",
      }),
    ).toBe("HOME='/Users/example/Claude Home' '/Applications/Claude Code/claude' auth login");
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
    // `agent`, Cursor's old default, can be Grok Build's own `agent` on PATH.
    expect(
      buildProviderAuthCommand({
        driver: "cursor",
        flow: "login",
        binaryPath: "agent",
        homePath: "",
      }),
    ).toEqual({ file: "cursor-agent", args: ["login"], env: {}, display: "cursor-agent login" });
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

  it("signs Claude in against the configured HOME and never mints a token", () => {
    expect(
      buildProviderAuthCommand({
        driver: "claudeAgent",
        flow: "login",
        binaryPath: "",
        homePath: "/Users/example/Claude Home",
      }),
    ).toEqual({
      file: "claude",
      args: ["auth", "login"],
      env: { HOME: "/Users/example/Claude Home" },
      display: "HOME='/Users/example/Claude Home' claude auth login",
    });
    expect(
      buildProviderAuthCommand({
        driver: "claudeAgent",
        flow: "claude-setup-token",
        binaryPath: "",
        homePath: "",
      }),
    ).toBeNull();
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

describe("openCodeAccountEnvironment", () => {
  it("points OpenCode at the account folder's own database on either platform", () => {
    expect(
      openCodeAccountEnvironment({ accountFolder: "/state/accounts/opencode_work//" }),
    ).toEqual({ OPENCODE_DB: "/state/accounts/opencode_work/opencode.db" });
    expect(openCodeAccountEnvironment({ accountFolder: "C:\\Users\\me\\opencode_work\\" })).toEqual(
      {
        OPENCODE_DB: "C:\\Users\\me\\opencode_work\\opencode.db",
      },
    );
    expect(openCodeAccountEnvironment({ accountFolder: "  " })).toEqual({});
  });
});

import { describe, expect, it, vi } from "vite-plus/test";

import {
  deleteEnvVars,
  mergeProviderInstanceEnvironment,
  readEnvVar,
  refreshProviderInstanceEnvironment,
  setEnvVar,
} from "./ProviderInstanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("refreshes inherited PATH for existing runtimes while retaining an instance override", () => {
    const inherited = { PATH: "/old/bin" };
    const overridden = { PATH: "/custom/bin" };
    vi.stubEnv("PATH", "/new/bin");
    try {
      refreshProviderInstanceEnvironment(undefined, inherited);
      refreshProviderInstanceEnvironment(
        [{ name: "PATH", value: "/custom/bin", sensitive: false }],
        overridden,
      );
      expect(inherited.PATH).toBe("/new/bin");
      expect(overridden.PATH).toBe("/custom/bin");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("overrides inherited environment values and preserves empty strings", () => {
    expect(
      mergeProviderInstanceEnvironment(
        [
          { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
          { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
        ],
        { ANTHROPIC_API_KEY: "inherited", PATH: "/bin" },
      ),
    ).toMatchObject({
      OPENROUTER_API_KEY: "sk-or-test",
      ANTHROPIC_API_KEY: "",
      PATH: "/bin",
    });
  });

  it("handles case-insensitive environment keys on Windows and exact keys on POSIX", () => {
    const winEnv: NodeJS.ProcessEnv = {
      anthropic_api_key: "secret",
      Anthropic_Auth_Token: "token",
      opencode_db: "C:\\old\\opencode.db",
      KEEP: "1",
    };
    expect(readEnvVar(winEnv, "OPENCODE_DB", "win32")).toBe("C:\\old\\opencode.db");
    deleteEnvVars(winEnv, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], "win32");
    setEnvVar(winEnv, "OPENCODE_DB", "C:\\new\\opencode.db", "win32");
    expect(winEnv).toEqual({ KEEP: "1", OPENCODE_DB: "C:\\new\\opencode.db" });

    const posixEnv: NodeJS.ProcessEnv = { anthropic_api_key: "keep", ANTHROPIC_API_KEY: "drop" };
    deleteEnvVars(posixEnv, ["ANTHROPIC_API_KEY"], "darwin");
    expect(posixEnv).toEqual({ anthropic_api_key: "keep" });
  });
});

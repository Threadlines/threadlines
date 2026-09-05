import { describe, expect, it, vi } from "vite-plus/test";

import {
  mergeProviderInstanceEnvironment,
  refreshProviderInstanceEnvironment,
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
});

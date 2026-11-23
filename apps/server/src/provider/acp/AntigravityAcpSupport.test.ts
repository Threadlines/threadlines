import { RUNTIME_MODES } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  antigravityAgentMode,
  antigravityAgentProblem,
  antigravityModelsFromCatalog,
  antigravityModelsFromChoices,
  isLegacyAntigravityServerPath,
  nextAntigravityCatalog,
  parseAntigravitySignInUrl,
  resolveAntigravityModelId,
} from "./AntigravityAcpSupport.ts";

// The model list a free-tier account got from agy-acp-server 1.3.0, which
// named the reasoning level in the model.
const RECORDED_CHOICES = [
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["gemini-3.7-flash-high", "Gemini 3.7 Flash (High)"],
  ["gemini-pro-agent", "Gemini 3.1 Pro (High)"],
  ["gemini-3.1-pro-low", "Gemini 3.1 Pro (Low)"],
].map(([value, name]) => ({ value: value!, name: name! }));

const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gemini-3.8-flash-high",
    options: RECORDED_CHOICES.map((choice) => ({ ...choice, description: choice.value })),
  },
];

describe("Antigravity models", () => {
  it("lists each family once, with its efforts as a Reasoning option", () => {
    const models = antigravityModelsFromChoices(RECORDED_CHOICES);
    expect(models.map((model) => [model.slug, model.name])).toEqual([
      ["gemini-3.8-flash", "Gemini 3.8 Flash"],
      ["gemini-3.7-flash", "Gemini 3.7 Flash"],
      ["gemini-3.1-pro", "Gemini 3.1 Pro"],
    ]);
    const efforts = models[0]?.capabilities?.optionDescriptors?.[0];
    // Lowest first, as the effort meter fills; High stays the default.
    expect(efforts?.type === "select" ? efforts.options.map((option) => option.id) : []).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(efforts?.type === "select" ? efforts.currentValue : undefined).toBe("high");
  });

  it("sends the agent's own id for a family and effort, irregular ids included", () => {
    const resolve = (model: string, effort?: string) =>
      resolveAntigravityModelId(model, {
        selections: effort ? [{ id: "effort", value: effort }] : [],
        configOptions,
      });
    expect(resolve("gemini-3.8-flash", "medium")).toBe("gemini-3.8-flash-medium");
    expect(resolve("gemini-3.8-flash")).toBe("gemini-3.8-flash-high");
    expect(resolve("gemini-3.1-pro", "high")).toBe("gemini-pro-agent");
    expect(resolve("gemini-3.1-pro", "low")).toBe("gemini-3.1-pro-low");
    expect(resolve("gemini-3.7-flash-high")).toBe("gemini-3.7-flash-high");
  });
});

describe("antigravityAgentMode", () => {
  const CLI_MODES = ["default", "accept-edits", "plan", "auto"];

  it("maps each access level onto the CLI's modes, never to one it refuses", () => {
    expect(
      RUNTIME_MODES.map((mode) => [mode, antigravityAgentMode(mode, "default", CLI_MODES)]),
    ).toEqual([
      ["approval-required", "default"],
      ["auto-accept-edits", "accept-edits"],
      ["auto", "auto"],
      // Full access has no CLI mode: Threadlines answers each request.
      ["full-access", "default"],
    ]);
    expect(antigravityAgentMode("full-access", "plan", CLI_MODES)).toBe("default");
  });

  it("runs Auto as Auto-accept edits where the session offers no Auto", () => {
    const withoutAuto = CLI_MODES.filter((mode) => mode !== "auto");
    expect(antigravityAgentMode("auto", "default", withoutAuto)).toBe("accept-edits");
    for (const mode of RUNTIME_MODES) {
      expect(withoutAuto, mode).toContain(antigravityAgentMode(mode, "default", withoutAuto));
    }
  });
});

describe("antigravityAgentProblem", () => {
  const problem = (version: string | undefined) =>
    antigravityAgentProblem({
      agentInfo: version === undefined ? null : { name: "Antigravity ACP Server", version },
    });

  it("refuses an agent older than the minimum, or one that won't say its version", () => {
    expect(problem("1.5.14")).toBeUndefined();
    expect(problem("1.6.0")).toBeUndefined();
    expect(problem("1.5.13")).toContain("needs 1.5.14 or newer");
    expect(problem("1.5.2")).toContain("is 1.5.2");
    // Build tags and prereleases don't lift a version over the minimum.
    expect(problem("1.5.9+local")).toContain("needs 1.5.14 or newer");
    expect(problem("1.5.14-rc.1")).toContain("needs 1.5.14 or newer");
    expect(problem("1.5.14+build.7")).toBeUndefined();
    expect(problem(undefined)).toContain("doesn't say its version");
  });

  it("knows a path to Google's old server, which the CLI replaced", () => {
    expect(isLegacyAntigravityServerPath("/opt/agy/agy_acp_server.par")).toBe(true);
    expect(isLegacyAntigravityServerPath("C:\\agy\\agy_acp_server.exe")).toBe(true);
    expect(isLegacyAntigravityServerPath("/usr/local/bin/agy")).toBe(false);
  });
});

describe("Antigravity reasoning levels", () => {
  const thought = (current: string, values: ReadonlyArray<string>) =>
    ({
      id: "thought_level",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: current,
      options: values.map((value) => ({ value, name: value[0]!.toUpperCase() + value.slice(1) })),
    }) satisfies EffectAcpSchema.SessionConfigOption;
  const model = (current: string) =>
    ({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: current,
      options: [
        { value: "gemini-4-argon", name: "Gemini 4 Argon" },
        { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        { value: "gpt-6-1", name: "GPT-6.1" },
      ],
    }) satisfies EffectAcpSchema.SessionConfigOption;

  it("remembers each model's own levels as sessions report them", () => {
    const first = nextAntigravityCatalog(undefined, [
      model("gemini-4-argon"),
      thought("high", ["low", "medium", "high"]),
    ]);
    // Claude has no reasoning option of its own in this session.
    const second = nextAntigravityCatalog(first as never, [model("claude-sonnet-4-6")]);
    const models = antigravityModelsFromCatalog(second!);
    const levels = (slug: string) => {
      const descriptor = models.find((entry) => entry.slug === slug)?.capabilities
        ?.optionDescriptors?.[0];
      return descriptor?.type === "select"
        ? [descriptor.id, descriptor.options.map((option) => option.id)]
        : undefined;
    };
    // Models keep the agent's own ids, so they are sent back unchanged.
    expect(models.map((entry) => entry.slug)).toEqual([
      "gemini-4-argon",
      "claude-sonnet-4-6",
      "gpt-6-1",
    ]);
    expect(levels("gemini-4-argon")).toEqual(["thought_level", ["low", "medium", "high"]]);
    expect(levels("claude-sonnet-4-6")).toBeUndefined();
    // Not seen yet: the current model's levels stand in (here, none).
    expect(levels("gpt-6-1")).toBeUndefined();
  });

  it("falls back to folding names when the agent names the level in the model", () => {
    const next = nextAntigravityCatalog(undefined, configOptions);
    expect(next?.thoughtLevels).toBeUndefined();
    expect(antigravityModelsFromCatalog(next!).map((entry) => entry.slug)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.1-pro",
    ]);
  });
});

describe("parseAntigravitySignInUrl", () => {
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A53789%2F&state=8Jy4kHH5&code_challenge_method=S256";

  it("takes Google's sign-in URL from the agent's stderr line", () => {
    expect(
      parseAntigravitySignInUrl(`Open the following link to authenticate the ACP server: ${url}`),
    ).toBe(url);
  });

  it("refuses a URL that is not Google's OAuth page with a loopback redirect", () => {
    const prefix = "Open the following link to authenticate the ACP server: ";
    expect(parseAntigravitySignInUrl(`${prefix}https://evil.example/o/oauth2/v2/auth?x=1`)).toBe(
      undefined,
    );
    expect(
      parseAntigravitySignInUrl(
        `${prefix}${url.replace("127.0.0.1%3A53789", "attacker.example%3A443")}`,
      ),
    ).toBe(undefined);
    expect(parseAntigravitySignInUrl("I1003 server.py] Starting AGY ACP Server...")).toBe(
      undefined,
    );
  });
});

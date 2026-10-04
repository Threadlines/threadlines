import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  antigravityModelsFromChoices,
  parseAntigravitySignInUrl,
  resolveAntigravityModelId,
} from "./AntigravityAcpSupport.ts";

// The model list a free-tier account got from agy-acp-server 1.3.0.
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
    expect(efforts?.type === "select" ? efforts.options.map((option) => option.id) : []).toEqual([
      "high",
      "medium",
      "low",
    ]);
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

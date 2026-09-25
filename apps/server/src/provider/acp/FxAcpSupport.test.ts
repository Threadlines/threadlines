import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildFxAcpSpawnInput,
  buildFxCommand,
  FX_MODEL_OPTION_MAPPING,
  parseFxStatusOutput,
} from "./FxAcpSupport.ts";

const fxConfigOptions = (provider: string): ReadonlyArray<EffectAcpSchema.SessionConfigOption> => [
  {
    id: "provider",
    name: "Provider",
    category: "model",
    type: "select",
    currentValue: provider,
    options: [
      { value: "gateway", name: "Vercel AI Gateway" },
      { value: "codex", name: "Codex subscription" },
      { value: "grok", name: "Grok subscription" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "moonshotai/kimi-k3",
    options: [{ value: "moonshotai/kimi-k3", name: "moonshotai/kimi-k3" }],
  },
  {
    id: "effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select",
    currentValue: "auto",
    options: [
      { value: "auto", name: "Auto" },
      { value: "high", name: "High" },
    ],
  },
];

describe("FX_MODEL_OPTION_MAPPING", () => {
  it("keeps the catalog source out of the model picker and names the auto effort", () => {
    const capabilities = FX_MODEL_OPTION_MAPPING.capabilitiesFromConfigOptions(
      fxConfigOptions("gateway"),
    );
    expect(capabilities.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual(["effort"]);
    const effort = capabilities.optionDescriptors?.[0];
    expect(effort?.type === "select" ? effort.options.map((choice) => choice.label) : []).toEqual([
      "Model default",
      "High",
    ]);
  });

  it("pins sessions to Gateway and ignores a stale provider selection", () => {
    const staleSelections = [
      { id: "provider", value: "codex" },
      { id: "effort", value: "high" },
    ];
    expect(
      FX_MODEL_OPTION_MAPPING.configUpdatesFromSelections(fxConfigOptions("grok"), staleSelections),
    ).toEqual([
      { configId: "provider", value: "gateway" },
      { configId: "effort", value: "high" },
    ]);
    expect(
      FX_MODEL_OPTION_MAPPING.configUpdatesFromSelections(fxConfigOptions("gateway"), []),
    ).toEqual([]);
  });
});

describe("buildFxCommand", () => {
  it("runs the binary directly on Linux and macOS", () => {
    expect(buildFxCommand({ binaryPath: "/opt/fx/bin/fx" }, ["acp"], "linux")).toEqual({
      file: "/opt/fx/bin/fx",
      args: ["acp"],
    });
  });

  it("routes through a WSL login shell on Windows", () => {
    expect(buildFxCommand(null, ["status", "--json"], "win32")).toEqual({
      file: "wsl.exe",
      args: ["--", "bash", "-lc", "fx status --json"],
    });
  });
});

describe("buildFxAcpSpawnInput", () => {
  it("keeps the host cwd for the spawn (WSL maps it itself)", () => {
    const input = buildFxAcpSpawnInput({ binaryPath: "fx" }, "/tmp/project");
    expect(input.cwd).toBe("/tmp/project");
    expect(input.args[input.args.length - 1]).toMatch(/acp$/);
  });
});

describe("parseFxStatusOutput", () => {
  // Captured from `fx status --json` (fx 0.0.7) with no credential configured.
  const missingAuthLine =
    '{"kind":"status","model":"moonshotai/kimi-k3","update_channel":"stable","build_channel":"stable","build_revision":"cef08aa0f178","auth":"missing","auth_refreshable":false,"auth_help":"fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.","permission_mode":"auto","workspace":"/tmp","history_turns":0}';

  it("reports missing credentials as unauthenticated, pointing at sign-in", () => {
    expect(parseFxStatusOutput({ stdout: missingAuthLine, stderr: "", code: 0 }, "linux")).toEqual({
      auth: { status: "unauthenticated" },
      defaultModel: "moonshotai/kimi-k3",
      message:
        "fx isn't signed in to Vercel AI Gateway. Use Sign in, or run `fx login` in a terminal.",
    });
    // On Windows fx lives in WSL, so a bare `fx login` would not be found.
    expect(
      parseFxStatusOutput({ stdout: missingAuthLine, stderr: "", code: 0 }, "win32")?.message,
    ).toContain("`wsl fx login`");
  });

  it("treats any active credential source as authenticated", () => {
    expect(
      parseFxStatusOutput({
        stdout: '{"kind":"status","model":"gpt-5.6-sol","auth":"chatgpt_subscription"}\n',
        stderr: "",
        code: 0,
      }),
    ).toEqual({
      auth: {
        status: "authenticated",
        type: "chatgpt_subscription",
        label: "Codex subscription",
      },
      defaultModel: "gpt-5.6-sol",
      message: undefined,
    });
  });

  it("labels a Gateway login with the Vercel team it bills", () => {
    // From `fx status --json` (fx 0.0.11) after signing in.
    const signedIn =
      '{"kind":"status","model":"openai/gpt-5.2","auth":"fx login","auth_refreshable":true,"team":"badcubans-projects"}';
    expect(parseFxStatusOutput({ stdout: signedIn, stderr: "", code: 0 })?.auth).toEqual({
      status: "authenticated",
      type: "fx login",
      label: "Vercel AI Gateway · badcubans-projects",
    });
  });

  it("returns undefined when stdout carries no status object", () => {
    expect(parseFxStatusOutput({ stdout: "fx 0.0.7\n", stderr: "", code: 0 })).toBeUndefined();
  });
});

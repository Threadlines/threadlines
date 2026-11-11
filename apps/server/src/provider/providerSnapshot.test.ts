import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ModelCapabilities } from "@threadlines/contracts";
import { createModelCapabilities } from "@threadlines/shared/model";

import { cliStartFailureFrom, providerModelsFromSettings } from "./providerSnapshot.ts";

const OPENCODE_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [{ id: "medium", label: "Medium", isDefault: true }],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "build", label: "Build", isDefault: true }],
      currentValue: "build",
    },
  ],
});

describe("cliStartFailureFrom", () => {
  it("calls a CLI broken only when `--version` itself dies", () => {
    // npm's launcher, after an update skipped the platform package.
    expect(
      cliStartFailureFrom({
        stdout: "",
        stderr: [
          "file:///opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js:108",
          "  throw new Error(",
          "Error: Missing optional dependency @openai/codex-darwin-arm64.",
          "    at findCodexExecutable (codex.js:108:9)",
          "Node.js v22.23.4",
        ].join("\n"),
        code: 1,
      }),
    ).toEqual({ reason: "Missing optional dependency @openai/codex-darwin-arm64." });
    expect(cliStartFailureFrom({ stdout: "", stderr: "", code: 126 })).toEqual({
      reason: "Command exited with code 126.",
    });
    // It started and answered, or started and did not know the flag.
    expect(cliStartFailureFrom({ stdout: "tool 1.2.3\n", stderr: "", code: 0 })).toBeNull();
    expect(
      cliStartFailureFrom({
        stdout: "",
        stderr: "error: unexpected argument '--version' found\n\nUsage: tool [OPTIONS]",
        code: 2,
      }),
    ).toBeNull();
  });
});

describe("providerModelsFromSettings", () => {
  it("applies the provided capabilities to custom models", () => {
    const models = providerModelsFromSettings(
      [],
      ProviderDriverKind.make("opencode"),
      ["openai/gpt-5"],
      OPENCODE_CUSTOM_MODEL_CAPABILITIES,
    );

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "openai/gpt-5",
        isCustom: true,
        capabilities: OPENCODE_CUSTOM_MODEL_CAPABILITIES,
      },
    ]);
  });
});

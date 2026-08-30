import * as Effect from "effect/Effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import { applyAcpModelSelection } from "./AcpProviderRuntime.ts";
import { CURSOR_ACP_DESCRIPTOR } from "./CursorAcpSupport.ts";
import { FX_ACP_DESCRIPTOR } from "./FxAcpSupport.ts";

type RecordedCall =
  | { readonly type: "model"; readonly value: string }
  | { readonly type: "config"; readonly configId: string; readonly value: string | boolean };

function makeRecordingRuntime(configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) {
  const calls: Array<RecordedCall> = [];
  return {
    calls,
    runtime: {
      getConfigOptions: Effect.succeed(configOptions),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    },
  };
}

const mapError = ({
  step,
  configId,
  cause,
}: {
  step: string;
  configId?: string;
  cause: { message: string };
}) =>
  step === "set-config-option"
    ? `failed to set config option ${configId}: ${cause.message}`
    : `failed to set model: ${cause.message}`;

const cursorGpt54ConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5.4-medium-fast",
    options: [{ value: "gpt-5.4-medium-fast", name: "GPT-5.4" }],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "extra-high", name: "Extra High" },
    ],
  },
  {
    id: "context",
    name: "Context",
    category: "model_config",
    type: "select",
    currentValue: "272k",
    options: [
      { value: "272k", name: "272K" },
      { value: "1m", name: "1M" },
    ],
  },
  {
    id: "fast",
    name: "Fast",
    category: "model_config",
    type: "select",
    currentValue: "false",
    options: [
      { value: "false", name: "Off" },
      { value: "true", name: "Fast" },
    ],
  },
];

const fxConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "provider",
    name: "Provider",
    category: "model",
    type: "select",
    currentValue: "gateway",
    options: [
      { value: "gateway", name: "Vercel AI Gateway" },
      { value: "codex", name: "Codex subscription" },
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
];

describe("applyAcpModelSelection", () => {
  it("sets the base model before Cursor's per-model config options", async () => {
    const { calls, runtime } = makeRecordingRuntime(cursorGpt54ConfigOptions);

    await Effect.runPromise(
      applyAcpModelSelection({
        descriptor: CURSOR_ACP_DESCRIPTOR,
        runtime,
        model: "gpt-5.4-medium-fast[reasoning=medium,context=272k]",
        selections: [
          { id: "reasoning", value: "xhigh" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ],
        mapError,
      }),
    );

    expect(calls).toEqual([
      { type: "model", value: "gpt-5.4-medium-fast" },
      { type: "config", configId: "reasoning", value: "extra-high" },
      { type: "config", configId: "context", value: "1m" },
      { type: "config", configId: "fast", value: "true" },
    ]);
  });

  it("applies options the agent lists before the model (fx provider) ahead of it", async () => {
    const { calls, runtime } = makeRecordingRuntime(fxConfigOptions);

    await Effect.runPromise(
      applyAcpModelSelection({
        descriptor: FX_ACP_DESCRIPTOR,
        runtime,
        model: "gpt-5.6-sol",
        selections: [{ id: "provider", value: "codex" }],
        mapError,
      }),
    );

    expect(calls).toEqual([
      { type: "config", configId: "provider", value: "codex" },
      { type: "model", value: "gpt-5.6-sol" },
    ]);
  });

  it("skips the model call when no model is selected", async () => {
    const { calls, runtime } = makeRecordingRuntime(fxConfigOptions);

    await Effect.runPromise(
      applyAcpModelSelection({
        descriptor: FX_ACP_DESCRIPTOR,
        runtime,
        model: undefined,
        selections: [],
        mapError,
      }),
    );

    expect(calls).toEqual([]);
  });
});

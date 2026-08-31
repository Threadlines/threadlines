import { describe, expect, it } from "vite-plus/test";

import { applyGatewayModelMeta, gatewayModelMeta } from "./FxGatewayModels.ts";

describe("gatewayModelMeta", () => {
  it("renders context window and per-million pricing", () => {
    expect(
      gatewayModelMeta({
        id: "spacexai/grok-4.6",
        context_window: 500_000,
        pricing: { input: "0.000002", output: "0.000006" },
      }),
    ).toEqual({ metaLabel: "488K ctx · $2/M in · $6/M out" });
    expect(
      gatewayModelMeta({
        id: "alibaba/qwen-3-235b",
        context_window: 262_144,
        pricing: { input: "0.00000022", output: "0.00000088" },
      }),
    ).toEqual({ metaLabel: "256K ctx · $0.22/M in · $0.88/M out" });
  });

  it("marks zero-priced models Free and drops the price line", () => {
    expect(
      gatewayModelMeta({
        id: "minimax/minimax-m2.7-free",
        context_window: 1_000_000,
        pricing: { input: "0", output: "0" },
      }),
    ).toEqual({ metaLabel: "1M ctx", promoLabel: "Free" });
  });
});

describe("applyGatewayModelMeta", () => {
  it("annotates matching slugs and passes everything else through", () => {
    const models = [
      { slug: "moonshotai/kimi-k3", name: "kimi", isCustom: false, capabilities: null },
      { slug: "gpt-5.6-sol", name: "sol (codex catalog)", isCustom: false, capabilities: null },
    ] as const;
    const [kimi, sol] = applyGatewayModelMeta(models, [
      {
        id: "moonshotai/kimi-k3",
        context_window: 262_144,
        pricing: { input: "0.000001", output: "0.000002" },
      },
    ]);
    expect(kimi?.metaLabel).toBe("256K ctx · $1/M in · $2/M out");
    expect(sol).toEqual(models[1]);
  });
});

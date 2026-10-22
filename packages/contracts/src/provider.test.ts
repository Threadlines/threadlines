import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderSessionStartInput, ThreadContextSeed } from "./provider.ts";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeThreadContextSeed = Schema.decodeUnknownSync(ThreadContextSeed);

describe("ProviderSessionStartInput", () => {
  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      cwd: "/tmp/workspace",
      runtimeMode: "full-access",
      modelSelection: {
        instanceId: "ollama_local",
        model: "llama3.3",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
    expect(parsed.modelSelection?.instanceId).toBe("ollama_local");
  });
});

describe("ThreadContextSeed", () => {
  it("rejects an unknown seed version", () => {
    expect(() =>
      decodeThreadContextSeed({
        version: 2,
        fromProvider: "codex",
        entries: [],
      }),
    ).toThrow();
  });
});

describe("providerInstanceId routing key (slice-2 invariant)", () => {
  it("rejects providerInstanceId values that fail the slug pattern (defense in depth)", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
        providerInstanceId: "1bad",
        runtimeMode: "full-access",
      }),
    ).toThrow();
  });
});

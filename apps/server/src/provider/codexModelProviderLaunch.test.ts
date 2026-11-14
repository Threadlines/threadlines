import { describe, expect, it } from "vite-plus/test";

import {
  codexModelProviderLaunch,
  redactCodexProviderSecrets,
} from "./codexModelProviderLaunch.ts";

describe("codexModelProviderLaunch", () => {
  it("writes a config with the provider alone, its definition whole", () => {
    const launch = codexModelProviderLaunch({
      providerId: "acme.gw v2",
      model: "acme-coder-1",
      definition: {
        name: 'Acme "GW"',
        base_url: "https://llm.acme.example/v1",
        wire_api: "responses",
        env_key: null,
        model_catalog_url: null,
        experimental_bearer_token: "sk-secret-token",
        http_headers: { "X-Org": "org-secret" },
        query_params: { "api-version": "2026-01-01", code: "fn-key-secret" },
        request_max_retries: 2,
        requires_openai_auth: false,
        gateway_oauth: null,
        auth: { command: "acme-token", args: ["--audience", "llm"] },
      },
    });

    expect(launch).toEqual({
      providerId: "acme.gw v2",
      model: "acme-coder-1",
      config: [
        'model_provider = "acme.gw v2"',
        'model_providers = {"acme.gw v2" = {"name" = "Acme \\"GW\\"", "base_url" = "https://llm.acme.example/v1", "wire_api" = "responses", "experimental_bearer_token" = "sk-secret-token", "http_headers" = {"X-Org" = "org-secret"}, "query_params" = {"api-version" = "2026-01-01", "code" = "fn-key-secret"}, "request_max_retries" = 2, "requires_openai_auth" = false, "auth" = {"command" = "acme-token", "args" = ["--audience", "llm"]}}}',
        "",
      ].join("\n"),
      // Longest first, so one is never struck out from inside another.
      secrets: ["sk-secret-token", "fn-key-secret", "org-secret", "2026-01-01"],
    });
  });

  // A run's own home has no sign-in: these providers use what the user's
  // Codex home stores, so their runs stay as they were.
  it("gives no launch for a provider that needs Codex's stored sign-in", () => {
    for (const definition of [
      { base_url: "https://proxy.acme.example/v1", requires_openai_auth: true },
      { base_url: "https://llm.acme.example/v1", gateway_oauth: { issuer: "https://id.acme" } },
      { aws: { profile: "work", region: "us-east-1" } },
      { project_id: "acme-ml", location: "us-central1" },
    ]) {
      expect(codexModelProviderLaunch({ providerId: "acme", definition })).toBeUndefined();
    }
  });

  // No definition to hand over: it runs in the user's own home, where any
  // sign-in Codex keeps for it is, named beside --ignore-user-config.
  it("names a built-in provider by its id alone, as an argument", () => {
    expect(codexModelProviderLaunch({ providerId: "ollama" })).toEqual({
      providerId: "ollama",
      args: ["-c", 'model_provider="ollama"'],
      secrets: [],
    });
    expect(codexModelProviderLaunch({ providerId: 'odd" & id' })).toBeUndefined();
  });

  // Codex's errors repeat the address of the request that failed.
  it("strikes the provider's secrets from text, also where an address encodes them", () => {
    const launch = codexModelProviderLaunch({
      providerId: "acme",
      definition: {
        base_url: "https://user:p%40ssw0rd@llm.acme.example/v1?sig=abc123def",
        query_params: { code: "fn key/secret" },
        experimental_bearer_token: "sk-secret-token",
      },
    });
    expect(
      redactCodexProviderSecrets(
        "ERROR: 401 for https://llm.acme.example/v1/responses?code=fn%20key%2Fsecret&sig=abc123def (Bearer sk-secret-token, p@ssw0rd)",
        launch,
      ),
    ).toBe(
      "ERROR: 401 for https://llm.acme.example/v1/responses?code=[redacted]&sig=[redacted] (Bearer [redacted], [redacted])",
    );
    expect(redactCodexProviderSecrets("ERROR: nothing to strike", undefined)).toBe(
      "ERROR: nothing to strike",
    );
  });
});

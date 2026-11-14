import { describe, expect, it } from "vite-plus/test";

import { codexModelProviderLaunch } from "./codexModelProviderLaunch.ts";

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
        query_params: { "api-version": "2026-01-01", code: "fn-key" },
        request_max_retries: 2,
        requires_openai_auth: false,
        gateway_oauth: null,
        auth: { command: "acme-token", args: ["--client-secret", "s3cret"] },
      },
    });

    expect(launch).toEqual({
      providerId: "acme.gw v2",
      model: "acme-coder-1",
      config: [
        'model_provider = "acme.gw v2"',
        'model_providers = {"acme.gw v2" = {"name" = "Acme \\"GW\\"", "base_url" = "https://llm.acme.example/v1", "wire_api" = "responses", "experimental_bearer_token" = "sk-secret-token", "http_headers" = {"X-Org" = "org-secret"}, "query_params" = {"api-version" = "2026-01-01", "code" = "fn-key"}, "request_max_retries" = 2, "requires_openai_auth" = false, "auth" = {"command" = "acme-token", "args" = ["--client-secret", "s3cret"]}}}',
        "",
      ].join("\n"),
    });
  });

  // A run's own home has no sign-in: these providers use the one stored in
  // the user's Codex home, so their runs stay as they were.
  it("gives no launch for a provider that needs Codex's stored sign-in", () => {
    for (const definition of [
      { base_url: "https://proxy.acme.example/v1", requires_openai_auth: true },
      { base_url: "https://llm.acme.example/v1", gateway_oauth: { issuer: "https://id.acme" } },
    ]) {
      expect(codexModelProviderLaunch({ providerId: "acme", definition })).toBeUndefined();
    }
  });

  it("names a built-in provider by its id alone", () => {
    expect(codexModelProviderLaunch({ providerId: "ollama" })).toEqual({
      providerId: "ollama",
      config: 'model_provider = "ollama"\n',
    });
  });
});

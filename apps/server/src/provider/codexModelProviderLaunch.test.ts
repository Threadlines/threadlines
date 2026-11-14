import { describe, expect, it } from "vite-plus/test";

import { codexModelProviderLaunch } from "./codexModelProviderLaunch.ts";

describe("codexModelProviderLaunch", () => {
  it("hands over the provider's definition as one table, keyed by its quoted id", () => {
    const launch = codexModelProviderLaunch({
      providerId: "acme.gw v2",
      model: "acme-coder-1",
      definition: {
        name: 'Acme "GW"',
        base_url: "https://llm.acme.example/v1",
        wire_api: "responses",
        env_key: "ACME_API_KEY",
        model_catalog_url: null,
        query_params: { "api-version": "2026-01-01" },
        request_max_retries: 2,
        supports_websockets: false,
        auth: { command: "acme-token", args: ["--audience", "llm"] },
      },
      environment: { ACME_API_KEY: "sk-env" },
    });

    expect(launch).toEqual({
      providerId: "acme.gw v2",
      model: "acme-coder-1",
      args: [
        "-c",
        'model_provider="acme.gw v2"',
        "-c",
        'model_providers={"acme.gw v2" = {"name" = "Acme \\"GW\\"", "base_url" = "https://llm.acme.example/v1", "wire_api" = "responses", "env_key" = "ACME_API_KEY", "query_params" = {"api-version" = "2026-01-01"}, "request_max_retries" = 2, "supports_websockets" = false, "auth" = {"command" = "acme-token", "args" = ["--audience", "llm"]}}}',
      ],
      environment: {},
    });
  });

  it("moves a plain token and plain headers into the environment", () => {
    const launch = codexModelProviderLaunch({
      providerId: "acme",
      definition: {
        base_url: "https://llm.acme.example/v1",
        experimental_bearer_token: "sk-secret-token",
        http_headers: { "X-Org": "org-secret", "X-Team": "team-secret" },
        env_http_headers: { "X-Trace": "TRACE_ENV" },
      },
      environment: {},
    });

    const args = launch?.args.join(" ") ?? "";
    expect(args).not.toContain("sk-secret-token");
    expect(args).not.toContain("org-secret");
    expect(args).not.toContain("team-secret");
    expect(args).toContain('"env_key" = "THREADLINES_CODEX_PROVIDER_TOKEN"');
    expect(args).toContain(
      '"env_http_headers" = {"X-Trace" = "TRACE_ENV", "X-Org" = "THREADLINES_CODEX_PROVIDER_HEADER", "X-Team" = "THREADLINES_CODEX_PROVIDER_HEADER_1"}',
    );
    expect(launch?.environment).toEqual({
      THREADLINES_CODEX_PROVIDER_TOKEN: "sk-secret-token",
      THREADLINES_CODEX_PROVIDER_HEADER: "org-secret",
      THREADLINES_CODEX_PROVIDER_HEADER_1: "team-secret",
    });
  });

  // As Codex resolves them itself: `env_key` wins over a plain token, and a
  // header named both ways takes its variable when that variable is set.
  it("keeps Codex's own precedence between a variable and a plain value", () => {
    const definition = {
      env_key: "ACME_API_KEY",
      experimental_bearer_token: "sk-unused-token",
      http_headers: { "x-org": "plain-org" },
      env_http_headers: { "X-Org": "ORG_ENV" },
    };
    const withVariable = codexModelProviderLaunch({
      providerId: "acme",
      definition,
      environment: { ORG_ENV: "from-env" },
    });
    expect(withVariable?.environment).toEqual({});
    expect(withVariable?.args.join(" ")).toContain('"env_http_headers" = {"X-Org" = "ORG_ENV"}');
    expect(withVariable?.args.join(" ")).toContain('"env_key" = "ACME_API_KEY"');
    expect(withVariable?.args.join(" ")).not.toContain("sk-unused-token");

    const withoutVariable = codexModelProviderLaunch({
      providerId: "acme",
      definition,
      environment: {},
    });
    expect(withoutVariable?.environment).toEqual({
      THREADLINES_CODEX_PROVIDER_HEADER: "plain-org",
    });
    expect(withoutVariable?.args.join(" ")).toContain(
      '"env_http_headers" = {"x-org" = "THREADLINES_CODEX_PROVIDER_HEADER"}',
    );
  });

  // A name of ours that the run or the definition already uses would hand
  // Codex the wrong value: here, a header's value as the bearer token.
  it("never reuses a variable name the run or the definition already has", () => {
    const launch = codexModelProviderLaunch({
      providerId: "acme",
      definition: {
        env_key: "THREADLINES_CODEX_PROVIDER_HEADER",
        http_headers: { "X-Org": "org-secret" },
      },
      environment: {
        THREADLINES_CODEX_PROVIDER_HEADER: "sk-real-token",
        THREADLINES_CODEX_PROVIDER_HEADER_1: "something else",
      },
    });
    expect(launch?.environment).toEqual({ THREADLINES_CODEX_PROVIDER_HEADER_2: "org-secret" });
    expect(launch?.args.join(" ")).toContain('"env_key" = "THREADLINES_CODEX_PROVIDER_HEADER"');

    // Windows reads variable names without letter case.
    const otherCase = codexModelProviderLaunch({
      providerId: "acme",
      definition: {
        env_key: "threadlines_codex_provider_header",
        http_headers: { "X-Org": "org-secret" },
      },
      environment: {},
    });
    expect(otherCase?.environment).toEqual({ THREADLINES_CODEX_PROVIDER_HEADER_1: "org-secret" });
  });

  // Codex reads these as plain values only, so nothing but the command line
  // could carry them. The run then goes without the gateway.
  it("gives no launch when a secret could only travel as an argument", () => {
    for (const definition of [
      { base_url: "https://llm.acme.example/v1", query_params: { "api-key": "sk-secret" } },
      { base_url: "https://user:sk-secret@llm.acme.example/v1" },
      { base_url: "https://llm.acme.example/v1", model_catalog_url: "https://u:p@acme.example" },
      {
        base_url: "https://llm.acme.example/v1",
        model_catalog_url: "https://acme.example/catalog.json?token=sk-secret",
      },
      {
        base_url: "https://llm.acme.example/v1",
        auth: { command: "acme-token", args: ["--client-secret", "sk-secret"] },
      },
      {
        base_url: "https://llm.acme.example/v1",
        auth: { command: "acme-token", env: { ACME_PASSWORD: "sk-secret" } },
      },
    ]) {
      expect(
        codexModelProviderLaunch({ providerId: "acme", definition, environment: {} }),
      ).toBeUndefined();
    }
  });

  it("names a built-in provider by its id alone", () => {
    expect(codexModelProviderLaunch({ providerId: "ollama", environment: {} })).toEqual({
      providerId: "ollama",
      args: ["-c", 'model_provider="ollama"'],
      environment: {},
    });
  });
});

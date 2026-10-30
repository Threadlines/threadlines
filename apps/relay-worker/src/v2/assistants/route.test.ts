import {
  assistantRouteTag,
  formatAssistantCredential,
  importAssistantRouteKey,
  randomAssistantSecret,
} from "@threadlines/shared/assistantCredentials";
import { randomBytes, toBase64Url } from "@threadlines/shared/relaySecure";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { loggedPath } from "../../log.ts";
import type { RelayV2Env } from "../env.ts";
import { clearClientMetadataCache } from "./clients.ts";
import { routeAssistants } from "./route.ts";
import type { NewSignIn } from "./signIns.ts";

const ORIGIN = "https://connect.test";
const HOST = "8911ad8a-f546-45e5-a2e8-7a6a8adfc65c";
const ROUTE_KEY = toBase64Url(randomBytes(32));
const CLIENT_KEY = toBase64Url(randomBytes(32));
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const CIMD_URL = "https://claude.ai/oauth/mcp-client.json";

type LimiterAnswer = "allow" | "refuse" | "fail";

/** The worker's env with limiters, and object namespaces that record every wake-up. */
function edgeEnv(options: { readonly limiter?: LimiterAnswer; readonly enabled?: string } = {}) {
  const woken: string[] = [];
  const hostCalls: unknown[] = [];
  const created: NewSignIn[] = [];
  const limiter = {
    limit: async () => {
      if (options.limiter === "fail") throw new Error("Rate limiter unavailable.");
      return { success: options.limiter !== "refuse" };
    },
  };
  const env = {
    ASSISTANTS_ORIGIN: ORIGIN,
    ASSISTANTS_ENABLED: options.enabled ?? "true",
    ASSISTANT_ROUTE_KEY: ROUTE_KEY,
    ASSISTANT_CLIENT_KEY: CLIENT_KEY,
    ASSISTANT_SIGN_IN_RATE_LIMITER: limiter,
    ASSISTANT_STATUS_RATE_LIMITER: limiter,
    ASSISTANT_CONNECTION_RATE_LIMITER: limiter,
    RELAY_HOST: {
      getByName: (name: string) => {
        woken.push(`host:${name}`);
        return {
          assistantRequest: async (input: unknown) => {
            hostCalls.push(input);
            return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
          },
        };
      },
    },
    RELAY_ASSISTANT_SIGN_IN: {
      getByName: (name: string) => {
        woken.push(`sign-in:${name}`);
        return {
          create: async (input: NewSignIn) => {
            created.push(input);
            return { ok: true, expiresAt: 0 };
          },
        };
      },
    },
  } as unknown as RelayV2Env;
  return { env, woken, hostCalls, created };
}

async function credential(kind: "access" | "refresh" | "code" | "key", routeTag?: string) {
  const key = await importAssistantRouteKey(ROUTE_KEY);
  const route = {
    hostId: HOST,
    connectionId: "conn-1",
    routeTag: routeTag ?? (await assistantRouteTag(key, HOST, "conn-1")),
  };
  const secret = randomAssistantSecret();
  switch (kind) {
    case "code":
    case "key":
      return formatAssistantCredential({ kind, route, secret });
    case "access":
      return formatAssistantCredential({
        kind,
        route,
        generation: 0,
        expiresAtSeconds: 1_900_000_000,
        mac: secret,
      });
    case "refresh":
      return formatAssistantCredential({ kind, route, generation: 0, mac: secret });
  }
}

function mcpPost(authorization: string | null, body = '{"jsonrpc":"2.0","id":1,"method":"ping"}') {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      cookie: "never=forwarded",
      ...(authorization === null ? {} : { authorization }),
    },
    body,
  });
}

function tokenPost(form: Record<string, string>) {
  return new Request(`${ORIGIN}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

async function route(request: Request, env: RelayV2Env, fetchStub?: typeof fetch) {
  const response = await routeAssistants(request, env, fetchStub ? { fetch: fetchStub } : {});
  if (!response) throw new Error("Expected the assistants door to answer.");
  return response;
}

beforeEach(() => clearClientMetadataCache());

describe("the assistants door at the edge", () => {
  it("answers only on its own origin and paths, and 503 everywhere while it's off", async () => {
    const { env } = edgeEnv();
    expect(await routeAssistants(new Request("https://relay.test/mcp"), env)).toBeNull();
    expect(await routeAssistants(new Request(`${ORIGIN}/v2/hosts`), env)).toBeNull();
    const off = edgeEnv({ enabled: "false" });
    for (const path of [
      "/mcp",
      "/token",
      "/authorize",
      "/.well-known/oauth-authorization-server",
    ]) {
      expect((await route(new Request(`${ORIGIN}${path}`), off.env)).status).toBe(503);
    }
    const missingKey = { ...edgeEnv().env, ASSISTANT_CLIENT_KEY: "" } as RelayV2Env;
    expect((await route(mcpPost(null), missingKey)).status).toBe(503);
  });

  it("refuses junk credentials and made-up route tags without waking any object", async () => {
    const { env, woken } = edgeEnv();
    const missing = await route(mcpPost(null), env);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    const forgedTag = toBase64Url(randomBytes(32));
    for (const bearer of [
      "Bearer junk",
      `Bearer ${await credential("access", forgedTag)}`,
      // A refresh token or authorization code is never a bearer.
      `Bearer ${await credential("refresh")}`,
    ]) {
      const response = await route(mcpPost(bearer), env);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
    for (const form of [
      { grant_type: "authorization_code", code: "junk" },
      { grant_type: "authorization_code", code: await credential("code", forgedTag) },
      { grant_type: "authorization_code", code: await credential("refresh") },
      { grant_type: "refresh_token", refresh_token: await credential("code") },
    ]) {
      const response = await route(tokenPost(form), env);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_grant" });
    }
    expect(woken).toEqual([]);
  });

  it("forwards a routable credential with only the allowed headers", async () => {
    const { env, woken, hostCalls } = edgeEnv();
    const access = await credential("access");
    expect((await route(mcpPost(`Bearer ${access}`), env)).status).toBe(200);
    const refresh = await credential("refresh");
    await route(tokenPost({ grant_type: "refresh_token", refresh_token: refresh }), env);
    expect(woken).toEqual([`host:${HOST}`, `host:${HOST}`]);
    expect(hostCalls[0]).toEqual({
      route: "mcp",
      hostId: HOST,
      connectionId: "conn-1",
      credential: access,
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    });
    expect(hostCalls[1]).toMatchObject({ route: "token", credential: refresh });
  });

  it("fails closed when the per-connection limiter can't answer", async () => {
    for (const [answer, status] of [
      ["fail", 503],
      ["refuse", 429],
    ] as const) {
      const { env, woken } = edgeEnv({ limiter: answer });
      const response = await route(mcpPost(`Bearer ${await credential("key")}`), env);
      expect(response.status).toBe(status);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(woken).toEqual([]);
    }
  });

  it("answers GET and DELETE on /mcp with 405", async () => {
    const { env } = edgeEnv();
    for (const method of ["GET", "DELETE"]) {
      const response = await route(new Request(`${ORIGIN}/mcp`, { method }), env);
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });
});

describe("discovery", () => {
  it("describes the resource and the authorization server", async () => {
    const { env } = edgeEnv();
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      expect(await (await route(new Request(`${ORIGIN}${path}`), env)).json()).toEqual({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
        scopes_supported: ["threads:read", "threads:start"],
        bearer_methods_supported: ["header"],
        resource_name: "Threadlines",
      });
    }
    const server = await (
      await route(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env)
    ).json();
    expect(server).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/token`,
      registration_endpoint: `${ORIGIN}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });
});

describe("clients and the sign-in page", () => {
  async function register(env: RelayV2Env, metadata: unknown) {
    return route(
      new Request(`${ORIGIN}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(metadata),
      }),
      env,
    );
  }

  function authorizeUrl(params: Record<string, string>) {
    return `${ORIGIN}/authorize?${new URLSearchParams({
      response_type: "code",
      state: "state-1",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      resource: `${ORIGIN}/mcp`,
      ...params,
    })}`;
  }

  it("registers a client statelessly, and its client id signs it in; a tampered one doesn't", async () => {
    const { env, created } = edgeEnv();
    const registered = await register(env, {
      client_name: "Grok Bot",
      redirect_uris: ["https://cursor.sh/oauth/callback"],
      token_endpoint_auth_method: "none",
    });
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string; client_name: string };
    expect(client.client_name).toBe("Grok Bot");

    const page = await route(
      new Request(
        authorizeUrl({
          client_id: client.client_id,
          redirect_uri: "https://cursor.sh/oauth/callback",
        }),
      ),
      env,
    );
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Connect Grok Bot to Threadlines");
    expect(html).toContain("Says it&#39;s Grok Bot. Sign-in returns to cursor.sh");
    expect(html).not.toContain("—");
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9_-]+'/u);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      clientName: "Grok Bot",
      identity: { kind: "registered", host: "cursor.sh", known: true },
      redirectUri: "https://cursor.sh/oauth/callback",
      oauthState: "state-1",
      codeChallenge: CHALLENGE,
      scopes: ["threads:read", "threads:start"],
      resource: `${ORIGIN}/mcp`,
      issuer: ORIGIN,
    });

    const [prefix, payload, mac] = client.client_id.split(".");
    const tampered = `${prefix}.${payload!.slice(0, -2)}AA.${mac}`;
    const refused = await route(
      new Request(
        authorizeUrl({ client_id: tampered, redirect_uri: "https://cursor.sh/oauth/callback" }),
      ),
      env,
    );
    expect(refused.status).toBe(400);
    expect(created).toHaveLength(1);
  });

  it("shows an error page, never a redirect, for a bad request", async () => {
    const { env, created, woken } = edgeEnv();
    const registered = (await (
      await register(env, { redirect_uris: ["https://evil.test/cb"] })
    ).json()) as { client_id: string };
    const base = { client_id: registered.client_id, redirect_uri: "https://evil.test/cb" };
    for (const params of [
      { ...base, redirect_uri: "https://evil.test/other" },
      { ...base, state: "" },
      { ...base, code_challenge_method: "plain" },
      { ...base, resource: "https://elsewhere.test/mcp" },
      { ...base, scope: "x".repeat(600) },
      { ...base, response_type: "token" },
    ]) {
      const response = await route(new Request(authorizeUrl(params)), env);
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-type")).toContain("text/html");
    }
    expect(created).toEqual([]);
    expect(woken).toEqual([]);
    expect((await register(env, { redirect_uris: ["http://example.test/cb"] })).status).toBe(400);
  });

  it("takes loopback return addresses on any port, and ignores scopes it doesn't define", async () => {
    const { env } = edgeEnv();
    const registered = (await (
      await register(env, { redirect_uris: ["http://127.0.0.1:3000/callback"] })
    ).json()) as { client_id: string };
    const base = {
      client_id: registered.client_id,
      redirect_uri: "http://127.0.0.1:51234/callback",
      scope: "threads:read offline_access",
    };
    const page = await route(new Request(authorizeUrl(base)), env);
    expect(page.status).toBe(200);
    for (const redirect_uri of [
      "http://127.0.0.1:51234/other",
      "http://localhost:51234/callback",
    ]) {
      const refused = await route(new Request(authorizeUrl({ ...base, redirect_uri })), env);
      expect(refused.status).toBe(400);
    }
  });

  it("signs in a CIMD client from its fetched metadata, refusing redirects and IP literals", async () => {
    const { env, created } = edgeEnv();
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const document = {
      client_id: CIMD_URL,
      client_name: "Claude",
      redirect_uris: ["http://localhost:1234/callback", "https://claude.ai/api/mcp/auth_callback"],
      token_endpoint_auth_method: "none",
    };
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), redirect: init?.redirect });
      return new Response(JSON.stringify(document), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const page = await route(
      new Request(
        authorizeUrl({
          client_id: CIMD_URL,
          redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        }),
      ),
      env,
      fetchStub,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Signs in from claude.ai");
    expect(requests).toEqual([{ url: CIMD_URL, redirect: "manual" }]);
    expect(created[0]?.identity).toEqual({ kind: "cimd", host: "claude.ai", known: true });

    const redirecting = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.test/doc.json" },
      })) as unknown as typeof fetch;
    const other = "https://assistant.example.com/client.json";
    expect(
      (
        await route(
          new Request(authorizeUrl({ client_id: other, redirect_uri: "https://x.test/cb" })),
          env,
          redirecting,
        )
      ).status,
    ).toBe(400);

    let fetched = false;
    const noFetch = (async () => {
      fetched = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    for (const clientId of ["https://127.0.0.1/client.json", "https://[::1]/client.json"]) {
      const response = await route(
        new Request(authorizeUrl({ client_id: clientId, redirect_uri: "https://x.test/cb" })),
        env,
        noFetch,
      );
      expect(response.status).toBe(400);
    }
    expect(fetched).toBe(false);
    expect(created).toHaveLength(1);
  });
});

describe("logging", () => {
  it("never keeps a sign-in link's query", () => {
    expect(loggedPath("/authorize?client_id=x&state=secret")).toBe("/authorize");
    expect(loggedPath("/authorize/status?signInId=1.a&pageSecret=s")).toBe("/authorize/status");
  });
});

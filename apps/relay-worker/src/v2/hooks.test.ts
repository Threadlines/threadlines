import { RELAY_HOOK_MAX_BODY_BYTES } from "@threadlines/contracts/relay";
import {
  hookDeliveryAad,
  openHookDelivery,
  sealHookDelivery,
} from "@threadlines/shared/relayHookSeal";
import { fromUtf8, generateStoredKeyPair, utf8 } from "@threadlines/shared/relaySecure";
import { describe, expect, it } from "vite-plus/test";

import { loggedPath } from "../log.ts";
import type { RelayV2Env } from "./env.ts";
import { routeHook } from "./hookRoute.ts";
import {
  type HookDeliveryInput,
  hookMac,
  hookPayload,
  hookUrl,
  parseKeptHeaders,
  readCappedBody,
} from "./hooks.ts";

const HOST_ID = "8911ad8a-f546-45e5-a2e8-7a6a8adfc65c";
const HOOK_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const PATH_KEY = "test-hook-path-key";

/** The worker's env with every limiter allowing, and a host namespace that records each delivery. */
type LimiterAnswer = "allow" | "refuse" | "fail";

function edgeEnv(options: { readonly byIp?: LimiterAnswer; readonly byHook?: LimiterAnswer } = {}) {
  const reached: HookDeliveryInput[] = [];
  const limiter = (answer: LimiterAnswer = "allow") => ({
    limit: async () => {
      if (answer === "fail") throw new Error("Rate limiter unavailable.");
      return { success: answer === "allow" };
    },
  });
  const env = {
    HOOK_PATH_KEY: PATH_KEY,
    HOOK_IP_RATE_LIMITER: limiter(options.byIp),
    HOOK_RATE_LIMITER: limiter(options.byHook),
    RELAY_HOST: {
      getByName: () => ({
        deliverHook: async (input: HookDeliveryInput) => {
          reached.push(input);
          return { status: 202 };
        },
      }),
    },
  } as unknown as RelayV2Env;
  return { env, reached };
}

async function hookRequest(
  init: { readonly mac?: string; readonly method?: string; readonly length?: string | null } = {},
) {
  const mac = init.mac ?? (await hookMac(PATH_KEY, HOST_ID, HOOK_ID));
  const headers = new Headers({ "content-type": "application/json", cookie: "session=1" });
  if (init.length !== null) headers.set("content-length", init.length ?? "2");
  const method = init.method ?? "POST";
  return new Request(`${hookUrl("https://relay.test", HOST_ID, HOOK_ID, mac)}?ref=main`, {
    method,
    headers,
    ...(method === "GET" ? {} : { body: "{}" }),
  });
}

describe("hook addresses at the edge", () => {
  it("answers a made-up address like any unknown path, without touching the host", async () => {
    const { env, reached } = edgeEnv();
    const forged = await hookMac("another-key", HOST_ID, HOOK_ID);
    const response = await routeHook(await hookRequest({ mac: forged }), env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });

    const mangled = new Request(`https://relay.test/v2/hooks/${HOST_ID}/${HOOK_ID}`, {
      method: "POST",
      headers: { "content-length": "2" },
    });
    expect((await routeHook(mangled, env)).status).toBe(404);
    expect(reached).toEqual([]);
  });

  it("limits by IP before checking the mac, and needs a bounded Content-Length", async () => {
    const limited = edgeEnv({ byIp: "refuse" });
    expect((await routeHook(await hookRequest(), limited.env)).status).toBe(429);

    const { env, reached } = edgeEnv();
    expect((await routeHook(await hookRequest({ method: "GET" }), env)).status).toBe(405);
    expect((await routeHook(await hookRequest({ length: null }), env)).status).toBe(411);
    const tooLarge = String(RELAY_HOOK_MAX_BODY_BYTES + 1);
    expect((await routeHook(await hookRequest({ length: tooLarge }), env)).status).toBe(413);
    expect(reached).toEqual([]);

    expect((await routeHook(await hookRequest(), env)).status).toBe(202);
    expect(reached).toHaveLength(1);
    expect(reached[0]).toMatchObject({ hostId: HOST_ID, hookId: HOOK_ID, query: "ref=main" });
    expect(fromUtf8(reached[0]!.body)).toBe("{}");
    // Headers the relay never keeps don't even reach the host's object.
    expect(reached[0]!.headers.map(([name]) => name)).not.toContain("cookie");
  });

  it("refuses events while a limiter can't answer", async () => {
    for (const env of [edgeEnv({ byIp: "fail" }), edgeEnv({ byHook: "fail" })]) {
      const response = await routeHook(await hookRequest(), env.env);
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(await response.json()).toEqual({ error: "The relay can't take events right now." });
      expect(env.reached).toEqual([]);
    }
  });

  it("keeps hook addresses out of logged paths", () => {
    expect(loggedPath(`/v2/hooks/${HOST_ID}/${HOOK_ID}/secret-mac`)).toBe("/v2/hooks/…");
    expect(loggedPath(`/v2/hosts/${HOST_ID}/control`)).toBe(`/v2/hosts/${HOST_ID}/control`);
  });
});

describe("hook delivery bodies", () => {
  function streamOf(chunks: ReadonlyArray<Uint8Array>, close = true): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (close) controller.close();
      },
    });
  }

  it("reads a body within its cap and deadline", async () => {
    const options = { maxBytes: 8, deadlineMs: 50 };
    const read = await readCappedBody(streamOf([utf8("abc"), utf8("def")]), options);
    expect(read.ok && fromUtf8(read.body)).toBe("abcdef");
    expect(await readCappedBody(streamOf([utf8("abcdef"), utf8("ghi")]), options)).toEqual({
      ok: false,
      status: 413,
    });
    // A sender that stops partway gets 408 rather than holding the object.
    expect(await readCappedBody(streamOf([utf8("abc")], false), options)).toEqual({
      ok: false,
      status: 408,
    });
  });

  it("seals what the host may keep, and only the host can open it", async () => {
    const keyPair = await generateStoredKeyPair();
    const payload = hookPayload({
      method: "POST",
      query: "ref=main&x=1",
      headers: new Headers({
        "X-GitHub-Event": "issues",
        "X-Custom": "kept",
        "X-Other": "dropped",
        Cookie: "session=1",
        "CF-Connecting-IP": "203.0.113.9",
      }),
      keptHeaders: parseKeptHeaders(["X-Custom", "cookie", "cf-ray"])!,
      body: utf8('{"action":"opened"}'),
      receivedAt: "2026-10-23T12:00:00.000Z",
    });
    const aad = hookDeliveryAad(HOST_ID, HOOK_ID, "delivery-1");
    const envelope = await sealHookDelivery({ publicKey: keyPair.publicKey, aad, payload });

    const opened = await openHookDelivery({ keyPair, aad, envelope });
    expect(opened).toMatchObject({
      method: "POST",
      query: "ref=main&x=1",
      headers: { "x-github-event": "issues", "x-custom": "kept" },
      receivedAt: "2026-10-23T12:00:00.000Z",
    });
    expect(opened && fromUtf8(opened.body)).toBe('{"action":"opened"}');
    // Sealed for one delivery, it can't be passed off as another's.
    const otherAad = hookDeliveryAad(HOST_ID, HOOK_ID, "delivery-2");
    expect(await openHookDelivery({ keyPair, aad: otherAad, envelope })).toBeNull();
  });
});

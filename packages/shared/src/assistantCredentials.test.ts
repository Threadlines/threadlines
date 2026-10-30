import { describe, expect, it } from "vite-plus/test";

import {
  assistantRouteTag,
  formatAssistantCredential,
  generateAssistantSignInCode,
  importAssistantRouteKey,
  normalizeAssistantSignInCode,
  parseAssistantCredential,
  randomAssistantSecret,
  verifyAssistantRouteTag,
} from "./assistantCredentials.ts";
import { toBase64Url } from "./relaySecure.ts";

const HOST = "0b5c3a52-6f0e-4c1e-9d8e-1f2a3b4c5d6e";
const CONNECTION = "asst-1";

const routeKey = () => importAssistantRouteKey(toBase64Url(new Uint8Array(32).fill(7)));

describe("assistant credentials", () => {
  it("parse what format writes, for every kind", async () => {
    const routeTag = await assistantRouteTag(await routeKey(), HOST, CONNECTION);
    const route = { hostId: HOST, connectionId: CONNECTION, routeTag };
    const secret = randomAssistantSecret();
    for (const credential of [
      { kind: "code", route, secret },
      { kind: "key", route, secret },
      { kind: "access", route, generation: 3, expiresAtSeconds: 1_900_000_000, mac: secret },
      { kind: "refresh", route, generation: 0, mac: secret },
    ] as const) {
      expect(parseAssistantCredential(formatAssistantCredential(credential))).toEqual(credential);
    }
  });

  it("refuse anything that isn't exactly one of ours", async () => {
    const routeTag = await assistantRouteTag(await routeKey(), HOST, CONNECTION);
    const secret = randomAssistantSecret();
    const key = `tlak1.${HOST}.${CONNECTION}.${routeTag}.${secret}`;
    expect(parseAssistantCredential(key)).not.toBeNull();
    for (const junk of [
      "",
      `tlax1.${HOST}.${CONNECTION}.${routeTag}.${secret}`,
      `tlak1.${HOST.toUpperCase()}.${CONNECTION}.${routeTag}.${secret}`,
      `tlak1.${HOST}.${CONNECTION}.${routeTag}.${secret}.extra`,
      `tlak1.${HOST}.${CONNECTION}.${routeTag}`,
      `tlak1.${HOST}.has.dot.${routeTag}.${secret}`,
      `tlaa1.${HOST}.${CONNECTION}.${routeTag}.01.1900000000.${secret}`,
      `tlaa1.${HOST}.${CONNECTION}.${routeTag}.1.19.${secret}`,
      `tlc1.${HOST}.${CONNECTION}.1.${secret}`,
    ]) {
      expect(parseAssistantCredential(junk)).toBeNull();
    }
  });

  it("route tags check host and connection together", async () => {
    const key = await routeKey();
    const routeTag = await assistantRouteTag(key, HOST, CONNECTION);
    expect(
      await verifyAssistantRouteTag(key, { hostId: HOST, connectionId: CONNECTION, routeTag }),
    ).toBe(true);
    expect(
      await verifyAssistantRouteTag(key, { hostId: HOST, connectionId: "asst-2", routeTag }),
    ).toBe(false);
    const otherKey = await importAssistantRouteKey(toBase64Url(new Uint8Array(32).fill(8)));
    expect(
      await verifyAssistantRouteTag(otherKey, { hostId: HOST, connectionId: CONNECTION, routeTag }),
    ).toBe(false);
  });

  it("sign-in codes read back however they were typed", () => {
    const code = generateAssistantSignInCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(normalizeAssistantSignInCode(code)).toBe(code);
    expect(normalizeAssistantSignInCode(" k4d8-2pqx ")).toBe("K4D82PQX");
    expect(normalizeAssistantSignInCode("K4D8-2PQO")).toBe("K4D82PQ0");
    expect(normalizeAssistantSignInCode("K4D8-2PQL")).toBe("K4D82PQ1");
    expect(normalizeAssistantSignInCode("K4D8-2PQ")).toBeNull();
    expect(normalizeAssistantSignInCode("K4D8-2PQU")).toBeNull();
  });
});

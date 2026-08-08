import { afterEach, describe, expect, it } from "vite-plus/test";

import { randomUUIDv4Sync } from "./uuid.ts";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const originalRandomUUID = globalThis.crypto.randomUUID;

/**
 * Insecure browser contexts (a phone paired over plain `http://<lan-ip>`) do
 * not expose `crypto.randomUUID` at all.
 */
function withoutRandomUUID(): void {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: undefined,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: originalRandomUUID,
  });
});

describe("randomUUIDv4Sync", () => {
  it("returns distinct RFC 4122 v4 identifiers", () => {
    const ids = Array.from({ length: 200 }, () => randomUUIDv4Sync());

    for (const id of ids) {
      expect(id).toMatch(UUID_V4_RE);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("still returns distinct v4 identifiers when crypto.randomUUID is unavailable", () => {
    withoutRandomUUID();

    const ids = Array.from({ length: 200 }, () => randomUUIDv4Sync());

    for (const id of ids) {
      expect(id).toMatch(UUID_V4_RE);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

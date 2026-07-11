import * as assert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AuthBearerBootstrapResult } from "./auth.ts";

const decodeAuthBearerBootstrapResult = Schema.decodeUnknownPromise(AuthBearerBootstrapResult);
const encodeAuthBearerBootstrapResult = Schema.encodePromise(AuthBearerBootstrapResult);

describe("auth contracts", () => {
  it("decodes and encodes bearer bootstrap JSON timestamps", async () => {
    const wireResult = {
      authenticated: true,
      role: "owner",
      sessionMethod: "bearer-session-token",
      expiresAt: "2036-06-20T12:00:00.000Z",
      sessionToken: "bearer-token",
    };

    const decoded = await decodeAuthBearerBootstrapResult(wireResult);
    const encoded = await encodeAuthBearerBootstrapResult(decoded);

    assert.deepEqual(encoded, wireResult);
  });
});

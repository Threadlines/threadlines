import { describe, expect, it } from "vitest";
import { HttpServerResponse } from "effect/unstable/http";

import { normalizeMcpHttpResponse } from "./McpHttpServer.ts";

/**
 * The whole browser feature hung on this.
 *
 * A JSON-RPC notification has no reply, and the transport answered 200 with
 * `content-type: application/json` and nothing in the body. Codex believed the
 * content type, tried to parse an empty document, failed with "EOF while
 * parsing a value", and gave up on the handshake -- registering the server with
 * zero tools. Every browser tool was then missing, and the model told the user
 * the in-app browser was unavailable, which was true and impossible to act on.
 */
describe("normalizeMcpHttpResponse", () => {
  it("turns an empty 200 into 202, because there is nothing to parse", () => {
    const normalized = normalizeMcpHttpResponse(HttpServerResponse.empty({ status: 200 }));

    expect(normalized.status).toBe(202);
  });

  it("leaves a response that actually has a body alone", () => {
    // tools/list is the one that matters: turning that into a 202 would break
    // the handshake in the opposite direction.
    const normalized = normalizeMcpHttpResponse(
      HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
    );

    expect(normalized.status).toBe(200);
  });

  it("leaves other statuses alone even when they are empty", () => {
    // A 401 carries meaning in its status; promoting it to 202 would say the
    // opposite of what happened.
    for (const status of [204, 401, 404, 500]) {
      expect(normalizeMcpHttpResponse(HttpServerResponse.empty({ status })).status).toBe(status);
    }
  });
});

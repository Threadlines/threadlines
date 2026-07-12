import { describe, expect, it } from "vite-plus/test";

import {
  parseBearerToken,
  parseRelayClientMessage,
  parseRelayTokenProtocol,
  RELAY_WEBSOCKET_PROTOCOL,
} from "./protocol.ts";

describe("relay protocol helpers", () => {
  it("extracts tokens from WebSocket subprotocols", () => {
    expect(parseRelayTokenProtocol("threadlines-relay, threadlines-token.device-token")).toEqual({
      selectedProtocol: RELAY_WEBSOCKET_PROTOCOL,
      token: "device-token",
    });
  });

  it("accepts forward and ping client messages", () => {
    expect(
      parseRelayClientMessage({
        version: 1,
        type: "relay.forward",
        target: "desktop",
        payload: { id: 1 },
      }),
    ).toEqual({
      version: 1,
      type: "relay.forward",
      target: "desktop",
      payload: { id: 1 },
    });
    expect(parseRelayClientMessage({ version: 1, type: "relay.ping" })).toEqual({
      version: 1,
      type: "relay.ping",
    });
  });

  it("parses bearer tokens from Authorization headers", () => {
    expect(parseBearerToken("Bearer device-token")).toBe("device-token");
    expect(parseBearerToken("bearer device-token")).toBe("device-token");
    expect(parseBearerToken("  Bearer   device-token ")).toBe("device-token");
    expect(parseBearerToken("Basic dXNlcjpwYXNz")).toBe(null);
    expect(parseBearerToken("Bearer")).toBe(null);
    expect(parseBearerToken(null)).toBe(null);
  });

  it("rejects malformed client messages", () => {
    expect(parseRelayClientMessage({ version: 1, type: "relay.forward", target: "device" })).toBe(
      null,
    );
    expect(parseRelayClientMessage({ version: 2, type: "relay.ping" })).toBe(null);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
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

  it("rejects malformed client messages", () => {
    expect(parseRelayClientMessage({ version: 1, type: "relay.forward", target: "device" })).toBe(
      null,
    );
    expect(parseRelayClientMessage({ version: 2, type: "relay.ping" })).toBe(null);
  });
});

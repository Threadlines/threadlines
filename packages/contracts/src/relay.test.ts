import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { RelayClientMessage, RelayCreateSessionResult, RelayServerEvent } from "./relay.ts";

const decodeCreateSessionResult = Schema.decodeUnknownSync(RelayCreateSessionResult);
const decodeClientMessage = Schema.decodeUnknownSync(RelayClientMessage);
const decodeServerEvent = Schema.decodeUnknownSync(RelayServerEvent);

describe("relay contracts", () => {
  it("decodes a relay session creation result", () => {
    const result = decodeCreateSessionResult({
      sessionId: "relay-session-1",
      desktopToken: "desktop-token",
      deviceToken: "device-token",
      expiresAt: "2026-06-20T12:00:00.000Z",
      desktopSocketUrl:
        "wss://relay.threadlines.dev/v1/sessions/relay-session-1/connect?role=desktop",
      deviceSocketUrl:
        "wss://relay.threadlines.dev/v1/sessions/relay-session-1/connect?role=device",
      pairingUrl:
        "https://app.threadlines.dev/pair?relay=https%3A%2F%2Frelay.threadlines.dev&session=relay-session-1#token=device-token",
    });

    expect(result.expiresAt).toBe("2026-06-20T12:00:00.000Z");
    expect(result.sessionId).toBe("relay-session-1");
    expect(result.desktopToken).toBe("desktop-token");
  });

  it("decodes client messages and server events", () => {
    const message = decodeClientMessage({
      version: 1,
      type: "relay.forward",
      target: "desktop",
      payload: { method: "thread.list" },
    });
    const event = decodeServerEvent({
      version: 1,
      type: "relay.forwarded",
      from: "device",
      connectionId: "conn-1",
      payload: { method: "thread.list" },
    });

    expect(message.type).toBe("relay.forward");
    expect(event.type).toBe("relay.forwarded");
    if (message.type !== "relay.forward" || event.type !== "relay.forwarded") {
      throw new Error("Unexpected relay contract variant.");
    }
    expect(message.target).toBe("desktop");
    expect(event.from).toBe("device");
  });
});

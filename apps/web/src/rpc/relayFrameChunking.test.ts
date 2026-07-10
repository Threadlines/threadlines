import { isRelayChunkFrame, RELAY_CHUNK_MAX_CHARS } from "@threadlines/shared/relayChunking";
import { describe, expect, it } from "vitest";

import { applyRelayFrameChunking } from "./relayFrameChunking";

class FakeWebSocket {
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const forType = this.listeners.get(type) ?? new Set();
    forType.add(listener);
    this.listeners.set(type, forType);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  emitMessage(data: unknown) {
    for (const listener of this.listeners.get("message") ?? []) {
      const event = new MessageEvent("message", { data });
      if (typeof listener === "function") {
        listener.call(this as unknown as WebSocket, event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
}

function setup() {
  const socket = new FakeWebSocket();
  applyRelayFrameChunking(socket as unknown as WebSocket);
  return socket;
}

describe("applyRelayFrameChunking", () => {
  it("sends small text frames unchanged", () => {
    const socket = setup();
    (socket as unknown as WebSocket).send('{"a":1}');
    expect(socket.sent).toEqual(['{"a":1}']);
  });

  it("splits oversized outgoing frames into chunk frames", () => {
    const socket = setup();
    const frame = "x".repeat(RELAY_CHUNK_MAX_CHARS * 2 + 1);
    (socket as unknown as WebSocket).send(frame);
    expect(socket.sent.length).toBe(3);
    for (const part of socket.sent) {
      expect(typeof part).toBe("string");
      expect(isRelayChunkFrame(part as string)).toBe(true);
    }
  });

  it("reassembles incoming chunk frames before delivering to listeners", () => {
    const sender = setup();
    const receiver = setup();
    const received: unknown[] = [];
    (receiver as unknown as WebSocket).addEventListener("message", ((event: MessageEvent) => {
      received.push(event.data);
    }) as EventListener);

    const frame = "y".repeat(RELAY_CHUNK_MAX_CHARS + 5);
    (sender as unknown as WebSocket).send(frame);
    for (const part of sender.sent) {
      receiver.emitMessage(part);
    }
    expect(received).toEqual([frame]);
  });

  it("delivers ordinary frames to listeners untouched", () => {
    const socket = setup();
    const received: unknown[] = [];
    (socket as unknown as WebSocket).addEventListener("message", ((event: MessageEvent) => {
      received.push(event.data);
    }) as EventListener);
    socket.emitMessage('{"b":2}');
    expect(received).toEqual(['{"b":2}']);
  });

  it("stops delivering to removed listeners", () => {
    const socket = setup();
    const received: unknown[] = [];
    const listener = ((event: MessageEvent) => {
      received.push(event.data);
    }) as EventListener;
    const asSocket = socket as unknown as WebSocket;
    asSocket.addEventListener("message", listener);
    asSocket.removeEventListener("message", listener);
    socket.emitMessage('{"c":3}');
    expect(received).toEqual([]);
  });
});

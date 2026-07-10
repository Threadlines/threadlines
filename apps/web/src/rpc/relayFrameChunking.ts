import {
  createRelayChunkReassembler,
  isRelayChunkFrame,
  splitRelayFrame,
} from "@threadlines/shared/relayChunking";

function invokeListener(
  target: WebSocket,
  listener: EventListenerOrEventListenerObject,
  event: MessageEvent,
): void {
  if (typeof listener === "function") {
    listener.call(target, event);
    return;
  }
  listener.handleEvent(event);
}

/**
 * Patches a relay-bound WebSocket so oversized text frames are split into
 * chunk frames on send and reassembled on receive. The relay runs on
 * Cloudflare, which drops any WebSocket message over 1 MiB, so full-size RPC
 * frames (inline image attachments, large diffs) must never reach the wire
 * whole. The RPC layer above sees ordinary complete frames either way.
 */
export function applyRelayFrameChunking(socket: WebSocket): void {
  const reassembler = createRelayChunkReassembler();
  const nativeSend = socket.send.bind(socket);
  const nativeAddEventListener = socket.addEventListener.bind(socket);
  const nativeRemoveEventListener = socket.removeEventListener.bind(socket);

  socket.send = (data: Parameters<WebSocket["send"]>[0]) => {
    if (typeof data !== "string") {
      nativeSend(data);
      return;
    }
    for (const part of splitRelayFrame(data)) {
      nativeSend(part);
    }
  };

  // All message listeners are funneled through one native listener so a
  // single reassembler sees each frame exactly once, no matter how many
  // consumers subscribe.
  const messageListeners = new Set<EventListenerOrEventListenerObject>();
  nativeAddEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    let deliverable: MessageEvent | null = event;
    if (typeof data === "string" && isRelayChunkFrame(data)) {
      const complete = reassembler.push(data);
      deliverable = complete === null ? null : new MessageEvent("message", { data: complete });
    }
    if (deliverable === null) {
      return;
    }
    for (const listener of messageListeners) {
      invokeListener(socket, listener, deliverable);
    }
  });

  socket.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (!listener) {
      return;
    }
    if (type === "message") {
      messageListeners.add(listener);
      return;
    }
    nativeAddEventListener(type, listener, options);
  }) as WebSocket["addEventListener"];

  socket.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) => {
    if (!listener) {
      return;
    }
    if (type === "message") {
      messageListeners.delete(listener);
      return;
    }
    nativeRemoveEventListener(type, listener, options);
  }) as WebSocket["removeEventListener"];
}

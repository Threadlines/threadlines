import {
  RELAY_HEARTBEAT_PING_FRAME,
  RELAY_HEARTBEAT_PONG_FRAME,
  RELAY_RAW_CONTROL_PREFIX,
} from "@threadlines/contracts";
import {
  binaryFrameBytes,
  fromUtf8,
  handshakeFrame,
  kkMessageLength,
  type NoiseKeyPair,
  readHandshakeFrame,
  SECURE_CONFIRM_PROBE,
  SECURE_CONFIRM_SESSION,
  SECURE_RECORD_ACK,
  SECURE_RECORD_APP,
  SECURE_RECORD_CONFIRM,
  SECURE_RECORD_KEEPALIVE,
  securePrologue,
  SecureStream,
  startKKResponder,
} from "@threadlines/shared/relaySecure";

/** One socket to a device, as the pipe needs it: relay pipe or direct connection. */
export interface SecureDuplex {
  readonly send: (data: Uint8Array) => void;
  readonly close: (code: number, reason: string) => void;
}

export interface SecurePipeHandle {
  /** Feed every message the device side receives. */
  readonly receive: (data: unknown) => void;
  /** Call when the device side closed. */
  readonly closed: () => void;
  readonly close: (reason?: string) => void;
}

/** App frames buffered while the loopback socket opens. */
const MAX_PENDING_APP_FRAMES = 256;
const CONFIRM_MESSAGE_MAX_BYTES = 64;

/**
 * The host end of one end-to-end encrypted device connection, over the relay
 * or direct. It answers the device's Noise KK handshake with the host key and
 * the device key pinned at approval, waits for the device's first encrypted
 * record (so a replayed handshake message never counts as a live device),
 * and only then opens the loopback `/ws` as the device's session and splices
 * the two. Keepalives are acked; probes are acked and closed without `/ws`.
 *
 * On the relay path, edge heartbeat frames and relay control frames are the
 * only text allowed; on a direct connection any text frame ends it.
 */
export function openSecurePipe(input: {
  readonly duplex: SecureDuplex;
  readonly via: "relay" | "direct";
  readonly hostKeyPair: NoiseKeyPair;
  readonly devicePublicKey: Uint8Array;
  readonly hostId: string;
  readonly deviceId: string;
  readonly handshakeTimeoutMs: number;
  readonly openLocal: () => Promise<WebSocket>;
  readonly onHandshake?: (outcome: "ok" | "failed") => void;
  readonly onClosed: () => void;
}): SecurePipeHandle {
  let closed = false;
  let handshakeSettled = false;
  let responder: Awaited<ReturnType<typeof startKKResponder>> | null = null;
  let responderReady: Promise<void> | null = null;
  let stream: SecureStream | null = null;
  let confirmed = false;
  let local: WebSocket | null = null;
  let pendingApp: Array<string> | null = [];

  const settleHandshake = (outcome: "ok" | "failed") => {
    if (handshakeSettled) return;
    handshakeSettled = true;
    clearTimeout(handshakeTimer);
    input.onHandshake?.(outcome);
  };

  const close = (reason = "Connection closed.", code = 1000) => {
    if (closed) return;
    closed = true;
    settleHandshake("failed");
    stream?.stop();
    try {
      input.duplex.close(code, reason.slice(0, 120));
    } catch {
      // Already closed.
    }
    if (local && local.readyState <= WebSocket.OPEN) {
      try {
        local.close(1000, reason.slice(0, 120));
      } catch {
        // Already closing.
      }
    }
    input.onClosed();
  };

  const handshakeTimer = setTimeout(
    () => close("The connection didn't finish setting up.", 1008),
    input.handshakeTimeoutMs,
  );

  responderReady = startKKResponder({
    staticKeyPair: input.hostKeyPair,
    remoteStaticPublicKey: input.devicePublicKey,
    prologue: securePrologue(input.hostId, input.deviceId),
  }).then(
    (started) => {
      responder = started;
    },
    () => close("Couldn't set up encryption.", 1011),
  );

  const openLocalSide = async () => {
    try {
      const socket = await input.openLocal();
      if (closed) {
        socket.close(1000, "Connection closed.");
        return;
      }
      local = socket;
      socket.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data === "string") stream?.sendText(event.data);
      });
      socket.addEventListener("close", () => close("The server ended the connection."));
      socket.addEventListener("error", () => close("The server ended the connection."));
      const buffered = pendingApp ?? [];
      pendingApp = null;
      for (const text of buffered) socket.send(text);
    } catch {
      close("Couldn't reach this server.", 1011);
    }
  };

  const onRecord = (type: number, body: Uint8Array) => {
    if (closed) return;
    if (!confirmed) {
      if (type !== SECURE_RECORD_CONFIRM || body.length !== 1) {
        close("Unexpected first message.", 1008);
        return;
      }
      confirmed = true;
      settleHandshake("ok");
      if (body[0] === SECURE_CONFIRM_PROBE) {
        stream?.sendRecord(SECURE_RECORD_ACK);
        setTimeout(() => close("Probe answered."), 50);
        return;
      }
      if (body[0] !== SECURE_CONFIRM_SESSION) {
        close("Unexpected first message.", 1008);
        return;
      }
      void openLocalSide();
      return;
    }
    switch (type) {
      case SECURE_RECORD_APP: {
        let text: string;
        try {
          text = fromUtf8(body);
        } catch {
          close("Bad message.", 1008);
          return;
        }
        if (pendingApp) {
          if (pendingApp.length >= MAX_PENDING_APP_FRAMES) {
            close("Too many messages before the server was ready.", 1008);
            return;
          }
          pendingApp.push(text);
        } else if (local && local.readyState === WebSocket.OPEN) {
          local.send(text);
        }
        return;
      }
      case SECURE_RECORD_KEEPALIVE:
        stream?.sendRecord(SECURE_RECORD_ACK);
        return;
      default:
        close("Unexpected message.", 1008);
    }
  };

  const handleHandshake = async (frame: Uint8Array) => {
    await responderReady;
    if (closed || !responder) return;
    const message = readHandshakeFrame(frame, kkMessageLength());
    if (!message) {
      close("Bad handshake.", 1008);
      return;
    }
    try {
      await responder.readMessage1(message);
      const reply = await responder.writeMessage2();
      if (closed) return;
      stream = new SecureStream({
        transport: reply.transport,
        sendFrame: (data) => {
          if (!closed) input.duplex.send(data);
        },
        onRecord,
        onError: (reason) => close(reason, 1008),
        // The first record must be the small confirm: until it decrypts, the
        // peer may be a replayed handshake, so nothing bigger is buffered.
        firstMessageMaxBytes: CONFIRM_MESSAGE_MAX_BYTES,
      });
      input.duplex.send(handshakeFrame(reply.message));
    } catch {
      close("The device didn't prove who it is.", 1008);
    }
  };

  let sawHandshake = false;
  const receive = (data: unknown) => {
    if (closed) return;
    if (typeof data === "string") {
      // Relay-only plaintext: edge heartbeats and relay control frames.
      if (
        input.via === "relay" &&
        (data === RELAY_HEARTBEAT_PONG_FRAME ||
          data === RELAY_HEARTBEAT_PING_FRAME ||
          data.startsWith(RELAY_RAW_CONTROL_PREFIX))
      ) {
        return;
      }
      close("Unexpected plaintext.", 1008);
      return;
    }
    const frame = binaryFrameBytes(data);
    if (!frame) {
      close("Unexpected message.", 1008);
      return;
    }
    if (!sawHandshake) {
      sawHandshake = true;
      void handleHandshake(frame);
      return;
    }
    if (!stream) {
      close("Message before the handshake finished.", 1008);
      return;
    }
    stream.receiveFrame(frame);
  };

  return {
    receive,
    closed: () => close("The device disconnected."),
    close: (reason) => close(reason),
  };
}

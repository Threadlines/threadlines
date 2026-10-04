import {
  binaryFrameBytes,
  fromUtf8,
  handshakeFrame,
  P256,
  readHandshakeFrame,
  kkMessageLength,
  SECURE_CONFIRM_PROBE,
  SECURE_CONFIRM_SESSION,
  SECURE_RECORD_ACK,
  SECURE_RECORD_APP,
  SECURE_RECORD_CONFIRM,
  SECURE_RECORD_KEEPALIVE,
  securePrologue,
  SecureStream,
  startKKInitiator,
  type NoiseKeyPair,
} from "@threadlines/shared/relaySecure";
import { describe, expect, it } from "vite-plus/test";

import { computeDirectRoutes } from "./directRoutes.ts";
import { openSecurePipe } from "./securePipe.ts";

/** The loopback `/ws`, as much of it as the pipe uses. */
class FakeLocalSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  readonly sent: Array<string> = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = WebSocket.CLOSED;
  }
  deliver(text: string) {
    this.dispatchEvent(new MessageEvent("message", { data: text }));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function setup(options: { readonly deviceKey?: NoiseKeyPair } = {}) {
  const [host, device] = await Promise.all([P256.generateKeyPair(), P256.generateKeyPair()]);
  const toDevice: Array<Uint8Array> = [];
  const closes: Array<number> = [];
  const local = new FakeLocalSocket();
  let localOpens = 0;
  const pipe = openSecurePipe({
    duplex: { send: (data) => toDevice.push(data), close: (code) => closes.push(code) },
    via: "direct",
    hostKeyPair: host,
    devicePublicKey: device.publicKey,
    hostId: "host-1",
    deviceId: "device-1",
    handshakeTimeoutMs: 1_000,
    openLocal: async () => {
      localOpens += 1;
      return local as unknown as WebSocket;
    },
    onClosed: () => undefined,
  });
  const initiator = await startKKInitiator({
    staticKeyPair: options.deviceKey ?? device,
    remoteStaticPublicKey: host.publicKey,
    prologue: securePrologue("host-1", "device-1"),
  });
  const message1 = await initiator.writeMessage1();
  return {
    pipe,
    toDevice,
    closes,
    local,
    message1,
    localOpens: () => localOpens,
    /** Finishes the device side of the handshake and returns its stream. */
    finish: async () => {
      const reply = readHandshakeFrame(toDevice.shift()!, kkMessageLength());
      const { transport } = await initiator.readMessage2(reply!);
      const records: Array<{ readonly type: number; readonly body: string }> = [];
      const stream = new SecureStream({
        transport,
        sendFrame: (frame) => pipe.receive(frame.buffer),
        onRecord: (type, body) => records.push({ type, body: fromUtf8(body) }),
        onError: () => undefined,
      });
      const drain = async () => {
        await settle();
        while (toDevice.length > 0) stream.receiveFrame(binaryFrameBytes(toDevice.shift())!);
        await settle();
      };
      return { stream, records, drain };
    },
  };
}

describe("openSecurePipe", () => {
  it("opens the app connection only after the device proves its key and confirms", async () => {
    const run = await setup();
    run.pipe.receive(handshakeFrame(run.message1));
    await settle();
    const device = await run.finish();
    expect(run.localOpens()).toBe(0);

    // A real client sends its first request right behind the confirm, before
    // the host has decrypted the confirm; a big one must not trip the confirm-size cap.
    const request = JSON.stringify({ _tag: "Request", id: "1", payload: "x".repeat(4_000) });
    device.stream.sendRecord(SECURE_RECORD_CONFIRM, new Uint8Array([SECURE_CONFIRM_SESSION]));
    device.stream.sendText(request);
    await settle();
    expect(run.localOpens()).toBe(1);
    expect(run.local.sent).toEqual([request]);
    expect(run.closes).toEqual([]);

    run.local.deliver('{"_tag":"Exit","requestId":"1"}');
    device.stream.sendRecord(SECURE_RECORD_KEEPALIVE);
    await device.drain();
    expect(device.records).toEqual([
      { type: SECURE_RECORD_APP, body: '{"_tag":"Exit","requestId":"1"}' },
      { type: SECURE_RECORD_ACK, body: "" },
    ]);
    expect(run.closes).toEqual([]);
  });

  it("never reaches the app for the wrong key, a replayed first message, or a probe", async () => {
    const stranger = await setup({ deviceKey: await P256.generateKeyPair() });
    stranger.pipe.receive(handshakeFrame(stranger.message1));
    await settle();
    expect(stranger.closes.length).toBe(1);
    expect(stranger.localOpens()).toBe(0);

    // A recorded first message gets a reply, but nothing confirms it.
    const replay = await setup();
    replay.pipe.receive(handshakeFrame(replay.message1));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(replay.closes.length).toBe(1);
    expect(replay.localOpens()).toBe(0);

    const probe = await setup();
    probe.pipe.receive(handshakeFrame(probe.message1));
    await settle();
    const device = await probe.finish();
    device.stream.sendRecord(SECURE_RECORD_CONFIRM, new Uint8Array([SECURE_CONFIRM_PROBE]));
    await device.drain();
    await settle();
    expect(device.records).toEqual([{ type: SECURE_RECORD_ACK, body: "" }]);
    expect(probe.localOpens()).toBe(0);
    expect(probe.closes.length).toBe(1);
  });

  it("ends a direct connection on any plaintext frame", async () => {
    const run = await setup();
    run.pipe.receive('{"_tag":"Ping"}');
    expect(run.closes.length).toBe(1);
  });
});

describe("computeDirectRoutes", () => {
  const interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [
      { address: "192.168.1.44", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
    utun3: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
  } as unknown as NonNullable<Parameters<typeof computeDirectRoutes>[0]["interfaces"]>;

  it("offers every outside address when listening on all of them, plus Tailscale HTTPS", () => {
    expect(
      computeDirectRoutes({
        bindHost: "0.0.0.0",
        port: 3773,
        deviceId: "device-1",
        tailscaleHttpsBaseUrl: "https://mac.tail1234.ts.net:8443/",
        interfaces,
      }),
    ).toEqual([
      "ws://192.168.1.44:3773/relay/direct/device-1",
      "ws://100.101.102.103:3773/relay/direct/device-1",
      "wss://mac.tail1234.ts.net:8443/relay/direct/device-1",
    ]);
  });

  it("offers only Tailscale when the server listens on this computer alone", () => {
    expect(
      computeDirectRoutes({
        bindHost: "127.0.0.1",
        port: 3773,
        deviceId: "device-1",
        tailscaleHttpsBaseUrl: null,
        interfaces,
      }),
    ).toEqual([]);
  });
});

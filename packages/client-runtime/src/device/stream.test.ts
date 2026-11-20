import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DEVICE_SOCKET_CONNECTING,
  DEVICE_SOCKET_OPEN,
  type DeviceHubSocket,
  type DeviceHubTransport,
} from "./hubTransport.ts";
import { DEVICE_MAX_FRAME_BYTES, DeviceFrameTooLargeError } from "./frameLimit.ts";
import { MultipartJpegParser } from "./mjpeg.ts";
import {
  AvccDemuxer,
  avcCodecString,
  createDeviceStreamClient,
  parseSemuPacket,
  STILL_FRAME_INTERVAL_MS,
} from "./stream.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A hub reached without any channel: sockets the test opens, requests it answers. */
function fakeTransport(answer: (path: string, method: string) => Response | Promise<Response>) {
  const sockets: Array<{
    path: string;
    socket: DeviceHubSocket;
    sent: unknown[];
    dispatch: (type: string, event: unknown) => void;
  }> = [];
  const requests: Array<{ path: string; method: string }> = [];
  const transport: DeviceHubTransport = {
    fetch: async (path, init) => {
      const method = init?.method ?? "GET";
      requests.push({ path, method });
      return answer(path, method);
    },
    socket: (path) => {
      const sent: unknown[] = [];
      const listeners = new Map<string, Set<(event: never) => void>>();
      const dispatch = (type: string, event: unknown) => {
        for (const listener of listeners.get(type) ?? []) (listener as (e: unknown) => void)(event);
      };
      let readyState = DEVICE_SOCKET_CONNECTING;
      const socket: DeviceHubSocket = {
        binaryType: "arraybuffer",
        get readyState() {
          return readyState;
        },
        protocol: "",
        addEventListener: (type, listener) => {
          const set = listeners.get(type) ?? new Set();
          set.add(listener as (event: never) => void);
          listeners.set(type, set);
        },
        removeEventListener: (type, listener) => {
          listeners.get(type)?.delete(listener as (event: never) => void);
        },
        send: (data) => sent.push(data),
        close: () => {
          readyState = 3;
        },
      };
      sockets.push({ path, socket, sent, dispatch });
      queueMicrotask(() => {
        readyState = DEVICE_SOCKET_OPEN;
        dispatch("open", {});
      });
      return socket;
    },
  };
  return { transport, sockets, requests };
}

const events = () => ({
  onStatus: vi.fn(),
  onScreen: vi.fn(),
  onInputConnected: vi.fn(),
  onVideoMode: vi.fn(),
});

const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

describe("AvccDemuxer", () => {
  it("reassembles tagged envelopes split across reads", () => {
    const demuxer = new AvccDemuxer();
    const envelope = new Uint8Array([0, 0, 0, 5, 1, 1, 0x64, 0, 0x1f, 0, 0, 0, 2, 2, 9]);
    expect(demuxer.push(envelope.subarray(0, 6))).toEqual([]);
    const chunks = demuxer.push(envelope.subarray(6));
    expect(chunks.map((chunk) => chunk.type)).toEqual(["description", "keyframe"]);
    expect(avcCodecString(chunks[0]!.payload)).toBe("avc1.64001f");
    expect(chunks[1]!.payload).toEqual(new Uint8Array([9]));
  });

  it("refuses a frame declared larger than the viewer accepts instead of buffering it", () => {
    const demuxer = new AvccDemuxer();
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, DEVICE_MAX_FRAME_BYTES + 1);
    expect(() => demuxer.push(header)).toThrow(DeviceFrameTooLargeError);
  });
});

describe("parseSemuPacket", () => {
  it("strips serve-emu's header and reads the keyframe flag and timestamp", () => {
    const packet = new Uint8Array(20);
    const view = new DataView(packet.buffer);
    view.setUint32(0, 0x53454d55);
    view.setUint8(4, 1);
    view.setUint8(5, 1);
    view.setBigUint64(8, 42n);
    packet.set([7, 7, 7, 7], 16);
    const parsed = parseSemuPacket(packet.buffer);
    expect(parsed.isKey).toBe(true);
    expect(parsed.timestamp).toBe(42);
    expect(parsed.data).toEqual(new Uint8Array([7, 7, 7, 7]));
  });
});

describe("MultipartJpegParser", () => {
  it("splits serve-sim's MJPEG parts by Content-Length across reads", () => {
    const jpeg = (fill: number) => new Uint8Array([0xff, 0xd8, fill, 0xff, 0xd9]);
    const part = (body: Uint8Array) => {
      const head = new TextEncoder().encode(
        `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n`,
      );
      const out = new Uint8Array(head.length + body.length + 2);
      out.set(head);
      out.set(body, head.length);
      out.set([13, 10], head.length + body.length);
      return out;
    };
    const stream = new Uint8Array([...part(jpeg(1)), ...part(jpeg(2))]);
    const parser = new MultipartJpegParser();
    const frames = [...parser.push(stream.subarray(0, 30)), ...parser.push(stream.subarray(30))];
    expect(frames).toEqual([jpeg(1), jpeg(2)]);
  });

  it("refuses a part whose Content-Length is past the limit", () => {
    const parser = new MultipartJpegParser();
    const head = new TextEncoder().encode(
      `--frame\r\nContent-Length: ${DEVICE_MAX_FRAME_BYTES + 1}\r\n\r\n`,
    );
    expect(() => parser.push(head)).toThrow(DeviceFrameTooLargeError);
  });
});

describe("createDeviceStreamClient", () => {
  it("sends iOS keys as HID usages only once the helper admitted input", async () => {
    // Bodies that send one chunk and stay open, like the hub's streams.
    const hub = fakeTransport(
      () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.enqueue(new Uint8Array([0])),
          }),
        ),
    );
    const client = createDeviceStreamClient(
      { platform: "ios", deviceId: "SIM 1", transport: hub.transport },
      { present: () => true },
      events(),
    );
    client.start();
    await vi.waitFor(() => expect(hub.sockets).toHaveLength(1));
    const input = hub.sockets[0]!;
    expect(input.path).toBe("/vendor/serve-sim/helper/ws?device=SIM%201");
    expect(hub.requests.map((request) => request.path)).toContain(
      "/vendor/serve-sim/helper/SIM%201/stream.mjpeg",
    );

    const key = { code: "KeyA", key: "a" } as KeyboardEvent;
    client.sendKey(key, "down");
    expect(input.sent).toEqual([]);

    input.dispatch("message", { data: new Uint8Array([0x83]).buffer });
    client.sendKey(key, "down");
    expect(input.sent).toHaveLength(1);
    const packet = input.sent[0] as Uint8Array;
    expect(packet[0]).toBe(0x06);
    expect(JSON.parse(new TextDecoder().decode(packet.subarray(1)))).toEqual({
      type: "down",
      usage: 0x04,
    });

    // Text from a phone's on-screen keyboard becomes key presses, with shift where needed.
    input.sent.length = 0;
    client.sendText("A!é");
    const strokes = (input.sent as Array<Uint8Array>).map((sent) =>
      JSON.parse(new TextDecoder().decode(sent.subarray(1))),
    );
    expect(strokes).toEqual([
      { type: "down", usage: 0xe1 },
      { type: "down", usage: 0x04 },
      { type: "up", usage: 0x04 },
      { type: "up", usage: 0xe1 },
      { type: "down", usage: 0xe1 },
      { type: "down", usage: 0x1e },
      { type: "up", usage: 0x1e },
      { type: "up", usage: 0xe1 },
    ]);
    client.stop();
  });

  it("shows Android stills about four times a second without WebCodecs, with touch still live", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 1080, height: 2400, close: vi.fn() })),
    );
    const hub = fakeTransport(() => new Response(PNG));
    const present = vi.fn(() => true);
    const watch = events();
    const client = createDeviceStreamClient(
      { platform: "android", deviceId: "emulator-5554", transport: hub.transport },
      { present },
      watch,
    );
    client.start();
    expect(watch.onVideoMode).toHaveBeenCalledWith("stills");
    await vi.advanceTimersByTimeAsync(0);
    expect(hub.sockets[0]?.path).toBe("/vendor/serve-emu/ws?device=emulator-5554&video=0");
    expect(hub.requests[0]).toEqual({
      path: "/vendor/serve-emu/api/screenshot?device=emulator-5554",
      method: "POST",
    });
    expect(present).toHaveBeenCalledWith(expect.anything(), 1080, 2400);
    expect(watch.onStatus).toHaveBeenLastCalledWith("streaming", undefined);
    expect(watch.onScreen).toHaveBeenCalledWith({
      width: 1080,
      height: 2400,
      orientation: "portrait",
    });

    await vi.advanceTimersByTimeAsync(STILL_FRAME_INTERVAL_MS * 4);
    expect(hub.requests.length).toBeGreaterThanOrEqual(4);
    expect(hub.requests.length).toBeLessThanOrEqual(6);

    client.sendTouch("begin", 0.5, 0.25);
    expect(hub.sockets[0]!.sent).toEqual([
      JSON.stringify({ type: "touch", action: "down", x: 0.5, y: 0.25 }),
    ]);

    client.stop();
    const after = hub.requests.length;
    await vi.advanceTimersByTimeAsync(STILL_FRAME_INTERVAL_MS * 4);
    expect(hub.requests.length).toBe(after);
  });

  it("moves a Duo's video to the panel in front, and back to the ordinary stream when a panel is refused", async () => {
    // The panel feeds need WebCodecs; a decoder that is never configured is enough here.
    class FakeDecoder {
      static isConfigSupported = async () => ({ supported: true });
      state = "unconfigured";
      decodeQueueSize = 0;
      configure() {}
      close() {}
    }
    vi.stubGlobal("VideoDecoder", FakeDecoder);
    vi.stubGlobal("EncodedVideoChunk", function EncodedVideoChunk() {});
    const openBody = () =>
      new Response(
        new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array([0])) }),
      );
    const hub = fakeTransport((path) =>
      path.endsWith("/panel/1/stream.avcc") ? new Response(null, { status: 404 }) : openBody(),
    );
    const watch = {
      ...events(),
      onDuoControl: vi.fn(),
      onDuoUnavailable: vi.fn(),
      onDuoPanel: vi.fn(),
    };
    const client = createDeviceStreamClient(
      { platform: "ios", deviceId: "DUO", transport: hub.transport },
      { present: () => true },
      watch,
    );
    client.start();
    await vi.waitFor(() => expect(hub.sockets).toHaveLength(1));
    const input = hub.sockets[0]!;
    const config = (fields: Record<string, unknown>) =>
      input.dispatch("message", {
        data: new Uint8Array([0x82, ...new TextEncoder().encode(JSON.stringify(fields))]).buffer,
      });
    input.dispatch("message", { data: new Uint8Array([0x83]).buffer });
    config({
      width: 2007,
      height: 2853,
      orientation: "landscape_left",
      screenId: 3,
      supportsHingeAngle: true,
      hingeAngle: 180,
    });
    const sink = { present: () => true };
    client.setDuoPanels({ cover: sink, inner: sink });
    await vi.waitFor(() =>
      expect(hub.requests.map((request) => request.path)).toContain(
        "/vendor/serve-sim/helper/DUO/panel/3/stream.avcc",
      ),
    );
    expect(watch.onDuoPanel).toHaveBeenLastCalledWith(3);

    // Hinge commands go out tagged on the input socket and wait for their reply.
    client.controlDuo({ control: "pose", value: "closed" });
    const command = input.sent.at(-1) as Uint8Array;
    expect(command[0]).toBe(0x10);
    expect(JSON.parse(new TextDecoder().decode(command.subarray(1)))).toEqual({
      requestId: 1,
      command: { control: "pose", value: "closed" },
    });
    expect(watch.onDuoControl).toHaveBeenLastCalledWith({
      pending: true,
      requested: { control: "pose", value: "closed" },
      error: null,
    });
    input.dispatch("message", {
      data: new Uint8Array([
        0x90,
        ...new TextEncoder().encode(JSON.stringify({ requestId: 1, ok: true })),
      ]).buffer,
    });
    expect(watch.onDuoControl).toHaveBeenLastCalledWith({
      pending: false,
      requested: null,
      error: null,
    });

    // The cover takes over; its feed is refused, so the ordinary stream comes back.
    const mainRequests = () =>
      hub.requests.filter((request) => request.path === "/vendor/serve-sim/helper/DUO/stream.avcc")
        .length;
    const before = mainRequests();
    config({
      width: 1398,
      height: 2034,
      orientation: "portrait",
      screenId: 1,
      supportsHingeAngle: true,
      hingeAngle: 0,
    });
    await vi.waitFor(() => expect(watch.onDuoUnavailable).toHaveBeenCalled());
    await vi.waitFor(() => expect(mainRequests()).toBe(before + 1));
    expect(watch.onDuoPanel).toHaveBeenLastCalledWith(null);
    // Input stayed on the one admitted socket throughout.
    expect(hub.sockets).toHaveLength(1);
    client.stop();
  });
});

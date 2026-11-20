import type {
  DeviceChannelCredit,
  DeviceChannelEvent,
  DeviceChannelOpen,
  DeviceChannelSend,
} from "@threadlines/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { bytesToBase64 } from "./base64.ts";
import {
  createDeviceHubTransport,
  DEVICE_SOCKET_CLOSED,
  DEVICE_SOCKET_OPEN,
  type DeviceChannelApi,
} from "./hubTransport.ts";

interface OpenChannel {
  readonly input: DeviceChannelOpen;
  readonly emit: (event: DeviceChannelEvent) => void;
  readonly close: (failure?: unknown) => void;
  stopped: boolean;
}

function fakeChannelApi() {
  const channels: OpenChannel[] = [];
  const sends: DeviceChannelSend[] = [];
  const credits: DeviceChannelCredit[] = [];
  const api: DeviceChannelApi = {
    open: (input, listener, onClosed) => {
      const channel: OpenChannel = {
        input,
        emit: listener,
        close: onClosed,
        stopped: false,
      };
      channels.push(channel);
      return () => {
        channel.stopped = true;
      };
    },
    send: async (input) => {
      sends.push(input);
    },
    credit: async (input) => {
      credits.push(input);
    },
  };
  let id = 0;
  const transport = createDeviceHubTransport(api, { channelId: () => `ch-${++id}` });
  return { api, transport, channels, sends, credits };
}

const bytes = (...values: number[]) => new Uint8Array(values);
const data = (...values: number[]): DeviceChannelEvent => ({
  _tag: "data",
  data: bytesToBase64(bytes(...values)),
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("fetch", () => {
  it("opens an http channel with the path and query split, and answers a streaming Response", async () => {
    const fake = fakeChannelApi();
    const pending = fake.transport.fetch("/vendor/serve-sim/helper/A%20B/stream.avcc?x=1", {
      method: "POST",
      body: "hi",
      contentType: "text/plain",
    });
    expect(fake.channels[0]?.input).toEqual({
      _tag: "http",
      channelId: "ch-1",
      method: "POST",
      path: "/vendor/serve-sim/helper/A%20B/stream.avcc",
      query: { x: "1" },
      body: bytesToBase64(new TextEncoder().encode("hi")),
      contentType: "text/plain",
    });
    fake.channels[0]!.emit({ _tag: "opened", status: 200, contentType: "video/avcc" });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/avcc");

    fake.channels[0]!.emit(data(1, 2, 3));
    fake.channels[0]!.emit(data(4));
    fake.channels[0]!.emit({ _tag: "end" });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes(1, 2, 3, 4));
    expect(fake.channels[0]!.stopped).toBe(true);
  });

  it("credits a chunk only once a reader has taken it", async () => {
    const fake = fakeChannelApi();
    const pending = fake.transport.fetch("/vendor/serve-sim/helper/A/stream.avcc");
    fake.channels[0]!.emit({ _tag: "opened", status: 200 });
    const reader = (await pending).body!.getReader();

    fake.channels[0]!.emit(data(1, 2, 3));
    fake.channels[0]!.emit(data(4, 5));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.credits).toEqual([]);

    expect((await reader.read()).value).toEqual(bytes(1, 2, 3));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.credits).toEqual([{ channelId: "ch-1", bytes: 3 }]);

    expect((await reader.read()).value).toEqual(bytes(4, 5));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.credits).toEqual([
      { channelId: "ch-1", bytes: 3 },
      { channelId: "ch-1", bytes: 2 },
    ]);
  });

  it("rejects when the channel fails before answering, and errors the body after", async () => {
    const fake = fakeChannelApi();
    const refused = fake.transport.fetch("/vendor/serve-sim/helper/A/stream.avcc");
    fake.channels[0]!.close({ _tag: "DeviceChannelError", reason: "forbidden", detail: "No." });
    await expect(refused).rejects.toThrow("No.");

    const pending = fake.transport.fetch("/vendor/serve-sim/helper/A/stream.avcc");
    fake.channels[1]!.emit({ _tag: "opened", status: 200 });
    const reader = (await pending).body!.getReader();
    fake.channels[1]!.close(new Error("The connection dropped."));
    await expect(reader.read()).rejects.toThrow("The connection dropped.");
    // A dropped channel is never reopened by the transport: the caller asks again.
    expect(fake.channels).toHaveLength(2);
  });

  it("closes the channel when aborted", async () => {
    const fake = fakeChannelApi();
    const controller = new AbortController();
    const pending = fake.transport.fetch("/vendor/serve-sim/helper/A/stream.mjpeg", {
      signal: controller.signal,
    });
    fake.channels[0]!.emit({ _tag: "opened", status: 200 });
    const reader = (await pending).body!.getReader();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
    expect(fake.channels[0]!.stopped).toBe(true);
  });
});

describe("socket", () => {
  it("opens on `opened`, reassembles message parts, and credits after the handler ran", async () => {
    const fake = fakeChannelApi();
    const socket = fake.transport.socket("/vendor/serve-emu/ws?device=emu-1&frame-meta=1");
    expect(fake.channels[0]?.input).toEqual({
      _tag: "ws",
      channelId: "ch-1",
      path: "/vendor/serve-emu/ws",
      query: { device: "emu-1", "frame-meta": "1" },
    });
    const opened = vi.fn();
    const received: Array<ArrayBuffer | string> = [];
    socket.addEventListener("open", opened);
    socket.addEventListener("message", (event) => {
      // The message has not been credited while its handler runs.
      expect(fake.credits).toEqual([]);
      received.push(event.data);
    });

    socket.send("dropped before open");
    expect(fake.sends).toEqual([]);

    fake.channels[0]!.emit({ _tag: "opened" });
    expect(opened).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(DEVICE_SOCKET_OPEN);

    const channel = fake.channels[0]!;
    channel.emit({ _tag: "message", binary: true, final: false, data: bytesToBase64(bytes(1)) });
    channel.emit({ _tag: "message", binary: true, final: false, data: bytesToBase64(bytes(2)) });
    expect(received).toEqual([]);
    channel.emit({ _tag: "message", binary: true, final: true, data: bytesToBase64(bytes(3)) });
    channel.emit({ _tag: "message", binary: false, final: true, data: '{"type":"video-session"}' });
    expect(new Uint8Array(received[0] as ArrayBuffer)).toEqual(bytes(1, 2, 3));
    expect(received[1]).toBe('{"type":"video-session"}');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.credits).toEqual([{ channelId: "ch-1", bytes: 3 + 24 }]);
  });

  it("sends text and binary in order with rising seq", () => {
    const fake = fakeChannelApi();
    const socket = fake.transport.socket("/vendor/serve-sim/helper/ws?device=A");
    fake.channels[0]!.emit({ _tag: "opened" });
    socket.send(bytes(3, 1));
    socket.send('{"type":"home"}');
    expect(fake.sends).toEqual([
      { channelId: "ch-1", seq: 0, binary: true, data: bytesToBase64(bytes(3, 1)) },
      { channelId: "ch-1", seq: 1, binary: false, data: '{"type":"home"}' },
    ]);
  });

  it("closes once on failure, drops later input and never reopens", () => {
    const fake = fakeChannelApi();
    const socket = fake.transport.socket("/vendor/serve-sim/helper/ws?device=A");
    const closed = vi.fn();
    const errored = vi.fn();
    socket.addEventListener("close", closed);
    socket.addEventListener("error", errored);
    fake.channels[0]!.emit({ _tag: "opened" });
    fake.channels[0]!.close({ _tag: "DeviceChannelError", reason: "slow", detail: "Too slow." });
    expect(errored).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledExactlyOnceWith({
      code: 1006,
      reason: "Too slow.",
      wasClean: false,
    });
    expect(socket.readyState).toBe(DEVICE_SOCKET_CLOSED);
    socket.send("late");
    expect(fake.sends).toEqual([]);
    expect(fake.channels).toHaveLength(1);
  });

  it("reports the hub's close code, and its own close after the call", async () => {
    const fake = fakeChannelApi();
    const ended = fake.transport.socket("/vendor/serve-sim/helper/ws?device=A");
    const endedClose = vi.fn();
    ended.addEventListener("close", endedClose);
    fake.channels[0]!.emit({ _tag: "opened" });
    fake.channels[0]!.emit({ _tag: "end", code: 4000, reason: "bye" });
    expect(endedClose).toHaveBeenCalledWith({ code: 4000, reason: "bye", wasClean: true });
    expect(fake.channels[0]!.stopped).toBe(true);

    const own = fake.transport.socket("/vendor/serve-sim/helper/ws?device=A");
    const ownClose = vi.fn();
    own.addEventListener("close", ownClose);
    own.close();
    expect(ownClose).not.toHaveBeenCalled();
    expect(fake.channels[1]!.stopped).toBe(true);
    await Promise.resolve();
    expect(ownClose).toHaveBeenCalledWith({ code: 1000, reason: "", wasClean: true });
  });
});

import * as Http from "node:http";
import type { AddressInfo } from "node:net";

import { WebSocketServer } from "@effect/platform-node/NodeWS";
import { describe, expect, it } from "@effect/vitest";
import {
  DEVICE_CHANNEL_CHUNK_BYTES,
  DEVICE_CHANNEL_WINDOW_BYTES,
  type DeviceChannelEvent,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import * as DeviceChannels from "./DeviceChannels.ts";
import { DeviceService } from "./DeviceService.ts";

const TOKEN = "hub-session-token-for-tests";
const BODY_BYTES = 5 * 1024 * 1024;

/** A stand-in hub: refuses requests without the token, streams a large body, echoes ws messages. */
const startFakeHub = Effect.acquireRelease(
  Effect.callback<{ origin: string; seen: Array<string>; close: () => void }>((resume) => {
    const seen: Array<string> = [];
    const server = Http.createServer((request, response) => {
      seen.push(`${request.method} ${request.url} ${request.headers.authorization ?? "-"}`);
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      let sent = 0;
      const pump = () => {
        while (sent < BODY_BYTES) {
          const size = Math.min(64 * 1024, BODY_BYTES - sent);
          sent += size;
          if (!response.write(Buffer.alloc(size, 7))) {
            response.once("drain", pump);
            return;
          }
        }
        response.end();
      };
      pump();
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      seen.push(`WS ${request.url} ${request.headers.authorization ?? "-"}`);
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resume(
        Effect.succeed({
          origin: `http://127.0.0.1:${port}`,
          seen,
          close: () => {
            sockets.close();
            server.closeAllConnections();
            server.close();
          },
        }),
      );
    });
  }),
  (hub) => Effect.sync(() => hub.close()),
);

const channelsFor = (origin: string) =>
  DeviceChannels.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(DeviceService)({
          currentHub: Effect.succeed({ origin, token: TOKEN }),
        }),
        FetchHttpClient.layer,
      ),
    ),
  );

describe("isAllowedDevicePath", () => {
  it("keeps serve-sim's and serve-emu's /api bodies, which carry the exec token, out of reach", () => {
    expect(DeviceChannels.isAllowedDevicePath("GET", "/vendor/serve-sim/api")).toBe(false);
    expect(DeviceChannels.isAllowedDevicePath("GET", "/vendor/serve-emu/api")).toBe(false);
    expect(DeviceChannels.isAllowedDevicePath("ws", "/vendor/serve-sim/exec-ws")).toBe(false);
    expect(DeviceChannels.isAllowedDevicePath("POST", "/api/devices/boot")).toBe(false);
  });

  it("refuses segments a URL parser would rewrite", () => {
    expect(
      DeviceChannels.isAllowedDevicePath("GET", "/vendor/serve-sim/helper/../stream.avcc"),
    ).toBe(false);
    expect(
      DeviceChannels.isAllowedDevicePath("GET", "/vendor/serve-sim/helper/%2e%2e/stream.avcc"),
    ).toBe(false);
  });

  it("allows the viewer's stream and input routes", () => {
    expect(
      DeviceChannels.isAllowedDevicePath("GET", "/vendor/serve-sim/helper/ABC-1/stream.avcc"),
    ).toBe(true);
    expect(DeviceChannels.isAllowedDevicePath("ws", "/vendor/serve-sim/helper/ws")).toBe(true);
    expect(DeviceChannels.isAllowedDevicePath("ws", "/vendor/serve-emu/ws")).toBe(true);
    expect(DeviceChannels.isAllowedDevicePath("POST", "/vendor/serve-emu/api/stream-mode")).toBe(
      true,
    );
  });
});

describe("DeviceChannels", () => {
  it.live("refuses a forbidden path without reaching the hub", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* startFakeHub;
        const channels = yield* channelsFor(hub.origin);
        const error = yield* channels
          .open("connection", {
            _tag: "http",
            channelId: "c1",
            method: "GET",
            path: "/vendor/serve-sim/api",
          })
          .pipe(Effect.flip);
        expect(error.reason).toBe("forbidden");
        expect(hub.seen).toEqual([]);
      }),
    ),
  );

  it.live("adds the hub token, slices the body, and holds it at the credit window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* startFakeHub;
        const channels = yield* channelsFor(hub.origin);
        const events = yield* channels.open("connection", {
          _tag: "http",
          channelId: "c1",
          method: "GET",
          path: "/vendor/serve-sim/helper/SIM-1/stream.avcc",
          query: { token: "client-supplied", fps: "30" },
        });
        const received = yield* Queue.unbounded<DeviceChannelEvent>();
        const reader = yield* events.pipe(
          Stream.runForEach((event) => Queue.offer(received, event)),
          Effect.forkScoped,
        );
        let delivered = 0;
        const take = Effect.gen(function* () {
          const event = yield* Queue.take(received);
          if (event._tag === "data") {
            const size = Buffer.from(event.data, "base64").length;
            expect(size).toBeLessThanOrEqual(DEVICE_CHANNEL_CHUNK_BYTES);
            delivered += size;
          }
          return event;
        });
        expect((yield* take)._tag).toBe("opened");
        // Uncredited, the channel stops at the window instead of reading the whole body.
        yield* Effect.sleep("300 millis");
        while ((yield* Queue.size(received)) > 0) yield* take;
        expect(delivered).toBeGreaterThanOrEqual(DEVICE_CHANNEL_WINDOW_BYTES);
        expect(delivered).toBeLessThan(DEVICE_CHANNEL_WINDOW_BYTES + DEVICE_CHANNEL_CHUNK_BYTES);
        // Crediting lets the rest through.
        let ended = false;
        while (!ended) {
          yield* channels.credit("connection", { channelId: "c1", bytes: delivered || 1 });
          const before = delivered;
          const event = yield* take;
          ended = event._tag === "end";
          if (delivered > before) {
            yield* channels.credit("connection", { channelId: "c1", bytes: delivered - before });
          }
        }
        expect(delivered).toBe(BODY_BYTES);
        yield* Fiber.join(reader);
        // The client's token is dropped and the server's bearer added.
        expect(hub.seen).toEqual([
          `GET /vendor/serve-sim/helper/SIM-1/stream.avcc?fps=30 Bearer ${TOKEN}`,
        ]);
      }),
    ),
  );

  it.live("relays ws messages both ways with the hub token", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hub = yield* startFakeHub;
        const channels = yield* channelsFor(hub.origin);
        const events = yield* channels.open("connection", {
          _tag: "ws",
          channelId: "w1",
          path: "/vendor/serve-sim/helper/ws",
        });
        const received = yield* Queue.unbounded<DeviceChannelEvent>();
        yield* events.pipe(
          Stream.runForEach((event) => Queue.offer(received, event)),
          Effect.forkScoped,
        );
        expect((yield* Queue.take(received))._tag).toBe("opened");
        // Sent out of order, written in order.
        yield* Effect.all(
          [
            channels.send("connection", { channelId: "w1", seq: 1, data: "second", binary: false }),
            channels.send("connection", {
              channelId: "w1",
              seq: 0,
              data: Buffer.from("first").toString("base64"),
              binary: true,
            }),
          ],
          { concurrency: "unbounded" },
        );
        const first = yield* Queue.take(received);
        const second = yield* Queue.take(received);
        expect(first).toEqual({
          _tag: "message",
          data: Buffer.from("first").toString("base64"),
          binary: true,
          final: true,
        });
        expect(second).toEqual({ _tag: "message", data: "second", binary: false, final: true });
        expect(hub.seen).toEqual([`WS /vendor/serve-sim/helper/ws Bearer ${TOKEN}`]);
        // The connection going away closes its channels.
        yield* channels.releaseConnection("connection");
        const end = yield* Queue.take(received);
        expect(end._tag).toBe("end");
      }),
    ),
  );
});

import { assert, describe, it } from "@effect/vitest";
import { PREVIEW_TUNNEL_WINDOW_BYTES, type PreviewTunnelEvent } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as Net from "node:net";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { loopbackAddresses, makePreviewTunnel } from "./PreviewTunnel.ts";

const sessionId = "session-a";

/**
 * A server on loopback, closed with the test's scope. Its connections are
 * destroyed first: they are half-open by design, so one whose peer has gone
 * would otherwise hold the close open forever.
 */
const listen = (onConnection: (socket: Net.Socket) => void) =>
  Effect.acquireRelease(
    Effect.callback<{ server: Net.Server; port: number; sockets: Set<Net.Socket> }>((resume) => {
      const sockets = new Set<Net.Socket>();
      const server = Net.createServer({ allowHalfOpen: true }, (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        onConnection(socket);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as Net.AddressInfo;
        resume(Effect.succeed({ server, port: address.port, sockets }));
      });
    }),
    ({ server, sockets }) =>
      Effect.callback<void>((resume) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resume(Effect.void));
      }),
  );

/** Pulls one event at a time, so a test can see exactly what arrived. */
const pullEvents = <E>(stream: Stream.Stream<PreviewTunnelEvent, E>) =>
  Effect.gen(function* () {
    const pull = yield* Stream.toPull(stream);
    const buffered: PreviewTunnelEvent[] = [];
    return Effect.gen(function* () {
      while (buffered.length === 0) buffered.push(...(yield* pull));
      return buffered.shift()!;
    });
  });

/**
 * A stand-in device hub: a real process run from the hub's entry-point path,
 * listening on one port, with a child of its own (an emulator, say) listening
 * on another. Both exit when their stdin closes, so neither outlives the test.
 */
const HUB_CHILD = `
const server = require("node:net").createServer();
server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;
const HUB_SCRIPT = `
import { spawn } from "node:child_process";
import * as Net from "node:net";
const server = Net.createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const child = spawn(process.execPath, ["-e", ${JSON.stringify(HUB_CHILD)}], {
  stdio: ["pipe", "pipe", "inherit"],
});
let heard = "";
child.stdout.on("data", (chunk) => {
  heard += chunk;
  if (heard.includes("\\n")) {
    const ports = { hub: server.address().port, child: Number.parseInt(heard, 10) };
    process.stdout.write(JSON.stringify(ports) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;

const startStandInHub = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await mkdtemp(Path.join(tmpdir(), "preview-tunnel-hub-"));
    const entry = Path.join(root, "node_modules/expo-device-hub/dist/server/cli.mjs");
    await mkdir(Path.dirname(entry), { recursive: true });
    await writeFile(entry, HUB_SCRIPT);
    const hub = spawn(process.execPath, [entry, "--port", "0"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const ports = await new Promise<{ hub: number; child: number }>((resolve, reject) => {
      let heard = "";
      hub.stdout.on("data", (chunk) => {
        heard += chunk;
        if (heard.includes("\n")) resolve(JSON.parse(heard));
      });
      hub.once("exit", (code) => reject(new Error(`The stand-in hub exited (${code}).`)));
    });
    return { root, hub, ports };
  }),
  ({ root, hub }) =>
    Effect.promise(async () => {
      // Its child exits on its own once the hub's end of the pipe closes.
      hub.stdin.end();
      if (hub.exitCode === null) {
        await new Promise((resolve) => hub.once("exit", resolve));
      }
      await rm(root, { recursive: true, force: true });
    }),
);

const decode = (event: PreviewTunnelEvent) =>
  event._tag === "data" ? Buffer.from(event.data, "base64").toString("utf8") : `<${event._tag}>`;

describe("loopbackAddresses", () => {
  it("maps every spelling of this machine to a loopback address", () => {
    assert.deepStrictEqual(loopbackAddresses("localhost"), ["127.0.0.1", "::1"]);
    assert.deepStrictEqual(loopbackAddresses("app.localhost"), ["127.0.0.1", "::1"]);
    assert.deepStrictEqual(loopbackAddresses("LOCALHOST."), ["127.0.0.1", "::1"]);
    assert.deepStrictEqual(loopbackAddresses("127.0.0.5"), ["127.0.0.5"]);
    assert.deepStrictEqual(loopbackAddresses("[::1]"), ["::1"]);
    assert.deepStrictEqual(loopbackAddresses("0:0:0:0:0:0:0:1"), ["::1"]);
    assert.deepStrictEqual(loopbackAddresses("::ffff:127.0.0.1"), ["127.0.0.1"]);
  });

  it("refuses anything that is not this machine", () => {
    for (const host of [
      "10.0.0.5",
      "192.168.1.20",
      "0.0.0.0",
      "example.com",
      "localhost.example.com",
      "::",
      "1::1",
      "::ffff:10.0.0.1",
      "fe80::1",
    ]) {
      assert.isNull(loopbackAddresses(host), host);
    }
  });
});

describe("PreviewTunnel", () => {
  it.live("carries bytes both ways, in the order the page wrote them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const received: Buffer[] = [];
        const { port } = yield* listen((socket) => {
          socket.on("data", (chunk) => received.push(chunk));
          socket.on("end", () => {
            socket.end(`got ${Buffer.concat(received).toString("utf8")}`);
          });
        });
        const tunnels = yield* makePreviewTunnel({ ownPort: -1 });
        const events = yield* tunnels.open(sessionId, { tunnelId: "t1", host: "localhost", port });
        const next = yield* pullEvents(events);
        assert.strictEqual((yield* next)._tag, "opened");

        // The calls race on the server; the sequence numbers put them back.
        const later = yield* tunnels
          .write(sessionId, {
            tunnelId: "t1",
            seq: 1,
            data: Buffer.from(" world").toString("base64"),
            end: true,
          })
          .pipe(Effect.forkChild);
        yield* tunnels.write(sessionId, {
          tunnelId: "t1",
          seq: 0,
          data: Buffer.from("hello").toString("base64"),
        });
        yield* Fiber.join(later);

        assert.strictEqual(decode(yield* next), "got hello world");
        assert.strictEqual((yield* next)._tag, "end");
      }),
    ),
  );

  it.live("keeps writing after the other side has finished sending", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let heard = "";
        const finished = Promise.withResolvers<void>();
        const { port } = yield* listen((socket) => {
          // Says its piece and closes its half straight away.
          socket.end("bye");
          socket.on("data", (chunk) => {
            heard += chunk.toString("utf8");
          });
          socket.on("end", () => finished.resolve());
        });
        const tunnels = yield* makePreviewTunnel({ ownPort: -1 });
        const events = yield* tunnels.open(sessionId, { tunnelId: "t2", host: "127.0.0.1", port });
        const next = yield* pullEvents(events);
        yield* next;
        assert.strictEqual(decode(yield* next), "bye");
        assert.strictEqual((yield* next)._tag, "end");
        yield* tunnels.write(sessionId, {
          tunnelId: "t2",
          seq: 0,
          data: Buffer.from("still here").toString("base64"),
          end: true,
        });
        yield* Effect.promise(() => finished.promise);
        assert.strictEqual(heard, "still here");
      }),
    ),
  );

  it.live("stops reading once the client has a window's worth undelivered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const total = 3 * PREVIEW_TUNNEL_WINDOW_BYTES;
        const { port } = yield* listen((socket) => {
          socket.end(Buffer.alloc(total, 7));
        });
        const tunnels = yield* makePreviewTunnel({ ownPort: -1 });
        const events = yield* tunnels.open(sessionId, { tunnelId: "t3", host: "localhost", port });
        const next = yield* pullEvents(events);
        yield* next;

        let delivered = 0;
        const readUntilStalled = Effect.gen(function* () {
          for (;;) {
            const event = yield* next.pipe(Effect.timeoutOption("200 millis"));
            if (event._tag === "None") return;
            if (event.value._tag === "data") {
              delivered += Buffer.from(event.value.data, "base64").length;
            }
          }
        });
        yield* readUntilStalled;
        // At most one socket read past the window: then the server waits.
        assert.isAtLeast(delivered, PREVIEW_TUNNEL_WINDOW_BYTES);
        assert.isBelow(delivered, PREVIEW_TUNNEL_WINDOW_BYTES + 256 * 1024);

        for (let credited = 0; credited < total;) {
          yield* tunnels.credit(sessionId, { tunnelId: "t3", bytes: delivered - credited });
          credited = delivered;
          yield* readUntilStalled;
          if (delivered === credited) break;
        }
        assert.strictEqual(delivered, total);
      }),
    ),
  );

  it.live("refuses hosts that are not this machine, and its own port", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tunnels = yield* makePreviewTunnel({ ownPort: 3773 });
        const remote = yield* tunnels
          .open(sessionId, { tunnelId: "t4", host: "10.0.0.5", port: 80 })
          .pipe(Effect.flip);
        assert.strictEqual(remote.reason, "notLoopback");
        const own = yield* tunnels
          .open(sessionId, { tunnelId: "t5", host: "localhost", port: 3773 })
          .pipe(Effect.flip);
        assert.strictEqual(own.reason, "notLoopback");
      }),
    ),
  );

  it.live.skipIf(process.platform === "win32")(
    "refuses a device tool's ports and its children's, and opens a dev server's",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { ports } = yield* startStandInHub;
          const { port: devServer } = yield* listen(() => {});
          const tunnels = yield* makePreviewTunnel({ ownPort: -1 });

          for (const [tunnelId, port] of [
            ["hub", ports.hub],
            ["child", ports.child],
          ] as const) {
            const refused = yield* tunnels
              .open(sessionId, { tunnelId, host: "localhost", port })
              .pipe(Effect.flip);
            assert.strictEqual(
              refused.detail,
              "That port belongs to device support and can't be previewed.",
              tunnelId,
            );
          }

          const events = yield* tunnels.open(sessionId, {
            tunnelId: "dev",
            host: "localhost",
            port: devServer,
          });
          const next = yield* pullEvents(events);
          assert.strictEqual((yield* next)._tag, "opened");
        }),
      ),
  );

  it.live("says plainly when nothing is listening", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // A port that was free a moment ago.
        const { server, port } = yield* listen(() => {});
        yield* Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
        });
        const tunnels = yield* makePreviewTunnel({ ownPort: -1 });
        const failure = yield* tunnels
          .open(sessionId, { tunnelId: "t6", host: "localhost", port })
          .pipe(Effect.flip);
        assert.strictEqual(failure.reason, "unreachable");
        assert.include(failure.detail, `localhost:${port}`);
      }),
    ),
  );

  it.live("keeps one session's tunnels out of another's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { port } = yield* listen(() => {});
        const tunnels = yield* makePreviewTunnel({ ownPort: -1 });
        // Only the tunnel existing matters here, not its events.
        yield* tunnels
          .open(sessionId, { tunnelId: "t7", host: "localhost", port })
          .pipe(Effect.asVoid);
        const failure = yield* tunnels
          .write("session-b", { tunnelId: "t7", seq: 0, data: "aGk=" })
          .pipe(Effect.flip);
        assert.strictEqual(failure.reason, "unknownTunnel");
      }),
    ),
  );
});

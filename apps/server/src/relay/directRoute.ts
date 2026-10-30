import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { RelayHost } from "./RelayHost.ts";
import type { SecureDuplex } from "./securePipe.ts";

/**
 * Direct connections from "Connect a device" devices on the same network or
 * Tailscale. There is no HTTP sign-in: the end-to-end handshake with the key
 * pinned at pairing is the sign-in, and nothing reaches the app until it
 * succeeds. Unknown devices get a plain 404 without an upgrade (410 for one
 * this server removed), and the
 * number of connections still handshaking is capped overall and per address.
 */
export const relayDirectRouteLayer = HttpRouter.add(
  "GET",
  "/relay/direct/:deviceId",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const deviceId = params.deviceId;
    if (!deviceId) return HttpServerResponse.empty({ status: 404 });
    const relay = yield* RelayHost;
    const admission = relay.admitDirect(Option.getOrNull(request.remoteAddress));
    if (!admission) return HttpServerResponse.empty({ status: 503 });

    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    let write:
      | ((
          chunk: Uint8Array | string | Socket.CloseEvent,
        ) => Effect.Effect<void, Socket.SocketError>)
      | null = null;
    let closeRequested: Socket.CloseEvent | null = null;
    const duplex: SecureDuplex = {
      send: (data) => {
        if (write) runFork(write(data).pipe(Effect.ignore));
      },
      close: (code, reason) => {
        const event = new Socket.CloseEvent(code, reason);
        if (write) runFork(write(event).pipe(Effect.ignore));
        else closeRequested = event;
      },
    };

    const handle = yield* relay.acceptDirect({ deviceId, duplex, admission });
    if (!handle) {
      // A device this server removed hears so (410), so a linked computer
      // can mark its link removed instead of retrying a wrong address.
      return HttpServerResponse.empty({
        status: (yield* relay.isRevokedDevice(deviceId)) ? 410 : 404,
      });
    }

    const socket = yield* request.upgrade.pipe(
      Effect.tapError(() => Effect.sync(() => handle.close("Upgrade failed."))),
    );
    // Writes wait until the socket is being read, so take the reader first.
    // `closed` is a no-op once the pipe has closed itself.
    yield* Effect.gen(function* () {
      const { pull } = yield* socket.reader;
      write = (yield* socket.writer).write;
      if (closeRequested) {
        return yield* write(closeRequested);
      }
      while (true) {
        for (const frame of yield* pull) {
          handle.receive(frame);
        }
      }
    }).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => handle.closed())));
    return HttpServerResponse.empty();
  }).pipe(Effect.scoped),
);

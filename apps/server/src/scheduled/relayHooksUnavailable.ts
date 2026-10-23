/**
 * RelayHooks while this computer has no relay client for hooks: every mint
 * fails (event tasks wait for an address), the wanted list is dropped, and
 * nothing arrives. Event tasks still take events on this computer's own port.
 * The relay client's own layer (RelayHooksLive) replaces it.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { RelayHooks, RelayHooksError } from "../relay/RelayHooks.ts";

export const RelayHooksUnavailable = Layer.succeed(
  RelayHooks,
  RelayHooks.of({
    mint: () =>
      Effect.fail(new RelayHooksError({ detail: "The relay isn't set up on this computer yet." })),
    setActive: () => Effect.void,
    deliveries: Stream.empty,
    ack: () => Effect.void,
    hostId: Effect.succeed(null),
    changes: Stream.empty,
    connected: Effect.succeed(false),
  }),
);

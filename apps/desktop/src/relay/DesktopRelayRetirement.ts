import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopRelayStore from "./DesktopRelayStore.ts";

/**
 * Phone links moved to "Connect a device", which the server runs. A desktop
 * updated from a build that had a phone link still has that relay session on
 * disk; this ends it at the relay once (so paired phones see "this link no
 * longer works" right away instead of "computer offline" until it would have
 * expired), then keeps a one-time notice for the Connections page.
 */
export interface DesktopRelayRetirementShape {
  readonly getNotice: Effect.Effect<boolean>;
  readonly dismissNotice: Effect.Effect<void>;
}

export class DesktopRelayRetirement extends Context.Service<
  DesktopRelayRetirement,
  DesktopRelayRetirementShape
>()("threadlines/desktop/RelayRetirement") {}

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-relay");

class RelayRetirementRetry extends Error {}

type DeleteOutcome = "ended" | "retry";

/** 2xx, 401 (the token is no longer ours) and 404 (already gone) all mean the link is over. */
function deleteOutcome(status: number): DeleteOutcome {
  return (status >= 200 && status < 300) || status === 401 || status === 404 || status === 410
    ? "ended"
    : "retry";
}

const endRelaySession = (session: DesktopRelayStore.PersistedRelayPairingSession) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        new URL(`/v1/sessions/${encodeURIComponent(session.sessionId)}`, session.relayOrigin),
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${session.desktopToken}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (deleteOutcome(response.status) === "retry") {
        throw new RelayRetirementRetry(`Relay answered HTTP ${response.status}.`);
      }
    },
    catch: (cause) =>
      cause instanceof RelayRetirementRetry ? cause : new RelayRetirementRetry(String(cause)),
  });

const make = Effect.gen(function* () {
  const store = yield* DesktopRelayStore.DesktopRelayStore;

  const retire = Effect.gen(function* () {
    const persisted = yield* store.load;
    if (Option.isNone(persisted)) {
      return;
    }
    const session = persisted.value;
    const expired = Date.parse(session.expiresAt) <= Date.now();
    if (!expired) {
      // A few quick retries; if the relay stays unreachable the link is left
      // on disk and the next launch tries again (it expires on its own anyway).
      yield* endRelaySession(session).pipe(
        Effect.retry({ schedule: Schedule.exponential("2 seconds"), times: 4 }),
      );
    }
    yield* store.markRetired(DateTime.formatIso(DateTime.nowUnsafe()));
    yield* logInfo("retired old phone link", { sessionId: session.sessionId, expired });
  }).pipe(
    Effect.catch((error: RelayRetirementRetry) =>
      logWarning("could not retire old phone link; will retry next launch", {
        error: error.message,
      }),
    ),
  );

  yield* retire.pipe(Effect.forkDetach);

  return DesktopRelayRetirement.of({
    getNotice: store.notice,
    dismissNotice: store.dismissNotice,
  });
});

export const layer = Layer.effect(DesktopRelayRetirement, make).pipe(
  Layer.provide(DesktopRelayStore.layer),
);

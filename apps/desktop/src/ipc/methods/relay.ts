import {
  DesktopRelayPairingSessionOrNullSchema,
  DesktopRelayPairingSessionSchema,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopRelay from "../../relay/DesktopRelay.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getRelayPairingSession = makeIpcMethod({
  channel: IpcChannels.GET_RELAY_PAIRING_SESSION_CHANNEL,
  payload: Schema.Void,
  result: DesktopRelayPairingSessionOrNullSchema,
  handler: Effect.fn("desktop.ipc.relay.getPairingSession")(function* () {
    const relay = yield* DesktopRelay.DesktopRelay;
    return yield* relay.getPairingSession;
  }),
});

export const createRelayPairingSession = makeIpcMethod({
  channel: IpcChannels.CREATE_RELAY_PAIRING_SESSION_CHANNEL,
  payload: Schema.Void,
  result: DesktopRelayPairingSessionSchema,
  handler: Effect.fn("desktop.ipc.relay.createPairingSession")(function* () {
    const relay = yield* DesktopRelay.DesktopRelay;
    return yield* relay.createPairingSession;
  }),
});

export const disconnectRelayPairingSession = makeIpcMethod({
  channel: IpcChannels.DISCONNECT_RELAY_PAIRING_SESSION_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.relay.disconnectPairingSession")(function* () {
    const relay = yield* DesktopRelay.DesktopRelay;
    yield* relay.disconnectPairingSession;
  }),
});

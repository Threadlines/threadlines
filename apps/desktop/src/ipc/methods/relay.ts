import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopRelayRetirement from "../../relay/DesktopRelayRetirement.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getRetiredPhoneLinkNotice = makeIpcMethod({
  channel: IpcChannels.GET_RETIRED_PHONE_LINK_NOTICE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.relay.getRetiredPhoneLinkNotice")(function* () {
    const retirement = yield* DesktopRelayRetirement.DesktopRelayRetirement;
    return yield* retirement.getNotice;
  }),
});

export const dismissRetiredPhoneLinkNotice = makeIpcMethod({
  channel: IpcChannels.DISMISS_RETIRED_PHONE_LINK_NOTICE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.relay.dismissRetiredPhoneLinkNotice")(function* () {
    const retirement = yield* DesktopRelayRetirement.DesktopRelayRetirement;
    yield* retirement.dismissNotice;
  }),
});

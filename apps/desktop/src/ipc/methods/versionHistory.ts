import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopVersionHistory from "../../app/DesktopVersionHistory.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

export const getPreviousAppVersion = makeSyncIpcMethod({
  channel: IpcChannels.GET_PREVIOUS_APP_VERSION_CHANNEL,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.versionHistory.getPreviousAppVersion")(function* () {
    const history = yield* DesktopVersionHistory.DesktopVersionHistory;
    return history.previousVersion;
  }),
});

export const claimUpdateNotice = makeIpcMethod({
  channel: IpcChannels.CLAIM_UPDATE_NOTICE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.versionHistory.claimUpdateNotice")(function* () {
    const history = yield* DesktopVersionHistory.DesktopVersionHistory;
    return yield* history.claimUpdateNotice;
  }),
});

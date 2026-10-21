import {
  DesktopBackgroundOptionsPatchSchema,
  DesktopBackgroundOptionsSchema,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopBackground from "../../app/DesktopBackground.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getBackgroundOptions = makeIpcMethod({
  channel: IpcChannels.GET_BACKGROUND_OPTIONS_CHANNEL,
  payload: Schema.Void,
  result: DesktopBackgroundOptionsSchema,
  handler: Effect.fn("desktop.ipc.background.getOptions")(function* () {
    const background = yield* DesktopBackground.DesktopBackground;
    return yield* background.options;
  }),
});

export const setBackgroundOptions = makeIpcMethod({
  channel: IpcChannels.SET_BACKGROUND_OPTIONS_CHANNEL,
  payload: DesktopBackgroundOptionsPatchSchema,
  result: DesktopBackgroundOptionsSchema,
  handler: Effect.fn("desktop.ipc.background.setOptions")(function* (patch) {
    const background = yield* DesktopBackground.DesktopBackground;
    return yield* background.setOptions(patch);
  }),
});

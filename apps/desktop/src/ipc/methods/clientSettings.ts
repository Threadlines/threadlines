import { ClientSettingsPatch, ClientSettingsSchema } from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getClientSettings = makeIpcMethod({
  channel: IpcChannels.GET_CLIENT_SETTINGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(ClientSettingsSchema),
  handler: Effect.fn("desktop.ipc.clientSettings.get")(function* () {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return Option.getOrNull(yield* clientSettings.get);
  }),
});

export const updateClientSettings = makeIpcMethod({
  channel: IpcChannels.UPDATE_CLIENT_SETTINGS_CHANNEL,
  payload: ClientSettingsPatch,
  result: ClientSettingsSchema,
  handler: Effect.fn("desktop.ipc.clientSettings.update")(function* (patch) {
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    return yield* clientSettings.update(patch);
  }),
});

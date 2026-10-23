import {
  DesktopCliCommandResultSchema,
  DesktopCliCommandStatusSchema,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopCliCommand from "../../cliCommand/DesktopCliCommand.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getCliCommandStatus = makeIpcMethod({
  channel: IpcChannels.GET_CLI_COMMAND_STATUS_CHANNEL,
  payload: Schema.Void,
  result: DesktopCliCommandStatusSchema,
  handler: Effect.fn("desktop.ipc.cliCommand.status")(function* () {
    const command = yield* DesktopCliCommand.DesktopCliCommand;
    return yield* command.status;
  }),
});

export const installCliCommand = makeIpcMethod({
  channel: IpcChannels.INSTALL_CLI_COMMAND_CHANNEL,
  payload: Schema.Void,
  result: DesktopCliCommandResultSchema,
  handler: Effect.fn("desktop.ipc.cliCommand.install")(function* () {
    const command = yield* DesktopCliCommand.DesktopCliCommand;
    return yield* command.install;
  }),
});

export const removeCliCommand = makeIpcMethod({
  channel: IpcChannels.REMOVE_CLI_COMMAND_CHANNEL,
  payload: Schema.Void,
  result: DesktopCliCommandResultSchema,
  handler: Effect.fn("desktop.ipc.cliCommand.remove")(function* () {
    const command = yield* DesktopCliCommand.DesktopCliCommand;
    return yield* command.remove;
  }),
});

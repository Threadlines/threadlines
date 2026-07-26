import {
  DesktopPreviewEvaluateInputSchema,
  DesktopPreviewStatusSchema,
  DesktopPreviewTargetSchema,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as PreviewAutomation from "../../preview/PreviewAutomation.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const previewAttach = makeIpcMethod({
  channel: IpcChannels.PREVIEW_ATTACH_CHANNEL,
  payload: DesktopPreviewTargetSchema,
  result: DesktopPreviewStatusSchema,
  handler: Effect.fn("desktop.ipc.preview.attach")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    return yield* automation.attach(input.webContentsId);
  }),
});

export const previewDetach = makeIpcMethod({
  channel: IpcChannels.PREVIEW_DETACH_CHANNEL,
  payload: DesktopPreviewTargetSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.detach")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    yield* automation.detach(input.webContentsId);
  }),
});

export const previewStatus = makeIpcMethod({
  channel: IpcChannels.PREVIEW_STATUS_CHANNEL,
  payload: DesktopPreviewTargetSchema,
  result: DesktopPreviewStatusSchema,
  handler: Effect.fn("desktop.ipc.preview.status")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    return yield* automation.status(input.webContentsId);
  }),
});

export const previewEvaluate = makeIpcMethod({
  channel: IpcChannels.PREVIEW_EVALUATE_CHANNEL,
  payload: DesktopPreviewEvaluateInputSchema,
  result: Schema.Unknown,
  handler: Effect.fn("desktop.ipc.preview.evaluate")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    return yield* automation.evaluate(input.webContentsId, input.expression);
  }),
});

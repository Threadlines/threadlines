import {
  DesktopLocalServerSchema,
  DesktopPreviewClickInputSchema,
  DesktopPreviewEvaluateInputSchema,
  DesktopPreviewScreenshotSchema,
  DesktopPreviewSnapshotSchema,
  DesktopPreviewTypeInputSchema,
  DesktopPreviewStatusSchema,
  DesktopPreviewTargetSchema,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as LocalServers from "../../preview/LocalServers.ts";
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

export const previewSnapshot = makeIpcMethod({
  channel: IpcChannels.PREVIEW_SNAPSHOT_CHANNEL,
  payload: DesktopPreviewTargetSchema,
  result: DesktopPreviewSnapshotSchema,
  handler: Effect.fn("desktop.ipc.preview.snapshot")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    return yield* automation.snapshot(input.webContentsId);
  }),
});

export const previewClick = makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLICK_CHANNEL,
  payload: DesktopPreviewClickInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.click")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    yield* automation.click(input.webContentsId, input.ref);
  }),
});

export const previewType = makeIpcMethod({
  channel: IpcChannels.PREVIEW_TYPE_CHANNEL,
  payload: DesktopPreviewTypeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.type")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    yield* automation.type(input);
  }),
});

export const previewLocalServers = makeIpcMethod({
  channel: IpcChannels.PREVIEW_LOCAL_SERVERS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopLocalServerSchema),
  handler: Effect.fn("desktop.ipc.preview.localServers")(function* () {
    const servers = yield* LocalServers.LocalServers;
    return yield* servers.scan();
  }),
});

export const previewScreenshot = makeIpcMethod({
  channel: IpcChannels.PREVIEW_SCREENSHOT_CHANNEL,
  payload: DesktopPreviewTargetSchema,
  result: DesktopPreviewScreenshotSchema,
  handler: Effect.fn("desktop.ipc.preview.screenshot")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    return yield* automation.screenshot(input.webContentsId);
  }),
});

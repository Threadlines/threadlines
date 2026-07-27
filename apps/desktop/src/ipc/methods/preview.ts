import {
  DesktopLocalServerSchema,
  DesktopPreviewClickInputSchema,
  DesktopPreviewColorSchemeInputSchema,
  DesktopPreviewViewportInputSchema,
  DesktopPreviewEvaluateInputSchema,
  DesktopPreviewScreenshotSchema,
  DesktopPreviewSnapshotSchema,
  DesktopPreviewTypeInputSchema,
  DesktopPreviewStatusSchema,
  DesktopPreviewPickedElementSchema,
  DesktopPreviewAnnotateInputSchema,
  DesktopPreviewDrawingSchema,
  DesktopPreviewPointSchema,
  DesktopPreviewPickInputSchema,
  DesktopPreviewPressInputSchema,
  DesktopPreviewRevealInputSchema,
  DesktopPreviewScrollInputSchema,
  DesktopPreviewTargetSchema,
  DesktopPreviewWaitForInputSchema,
} from "@threadlines/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as LocalServers from "../../preview/LocalServers.ts";
import * as PreviewAutomation from "../../preview/PreviewAutomation.ts";
import * as PreviewSession from "../../preview/PreviewSession.ts";
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
    return yield* automation.evaluate(input);
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
  result: DesktopPreviewPointSchema,
  handler: Effect.fn("desktop.ipc.preview.click")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    return yield* automation.click(input);
  }),
});

export const previewType = makeIpcMethod({
  channel: IpcChannels.PREVIEW_TYPE_CHANNEL,
  payload: DesktopPreviewTypeInputSchema,
  result: DesktopPreviewPointSchema,
  handler: Effect.fn("desktop.ipc.preview.type")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    return yield* automation.type(input);
  }),
});

export const previewPress = makeIpcMethod({
  channel: IpcChannels.PREVIEW_PRESS_CHANNEL,
  payload: DesktopPreviewPressInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.press")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    yield* automation.press(input);
  }),
});

export const previewScroll = makeIpcMethod({
  channel: IpcChannels.PREVIEW_SCROLL_CHANNEL,
  payload: DesktopPreviewScrollInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.scroll")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    yield* automation.scroll(input);
  }),
});

export const previewWaitFor = makeIpcMethod({
  channel: IpcChannels.PREVIEW_WAIT_FOR_CHANNEL,
  payload: DesktopPreviewWaitForInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.waitFor")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    yield* automation.waitFor(input);
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

export const previewOpenDevTools = makeIpcMethod({
  channel: IpcChannels.PREVIEW_OPEN_DEVTOOLS_CHANNEL,
  payload: DesktopPreviewTargetSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.openDevTools")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    yield* automation.openDevTools(input.webContentsId);
  }),
});

export const previewClearBrowsingData = makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_BROWSING_DATA_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearBrowsingData")(function* () {
    const session = yield* PreviewSession.PreviewSession;
    yield* session.clearBrowsingData();
  }),
});

export const previewSetColorScheme = makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_COLOR_SCHEME_CHANNEL,
  payload: DesktopPreviewColorSchemeInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setColorScheme")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    yield* automation.setColorScheme(input.webContentsId, input.colorScheme);
  }),
});

export const previewPickElement = makeIpcMethod({
  channel: IpcChannels.PREVIEW_PICK_ELEMENT_CHANNEL,
  payload: DesktopPreviewPickInputSchema,
  result: Schema.Array(DesktopPreviewPickedElementSchema),
  handler: Effect.fn("desktop.ipc.preview.pickElement")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    return yield* automation.pickElement(input.webContentsId, input.colorScheme, input.mode);
  }),
});

export const previewCancelPick = makeIpcMethod({
  channel: IpcChannels.PREVIEW_CANCEL_PICK_CHANNEL,
  payload: DesktopPreviewTargetSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.cancelPick")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    yield* automation.cancelPick(input.webContentsId);
  }),
});

export const previewSetAnnotationMode = makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_ANNOTATION_MODE_CHANNEL,
  payload: DesktopPreviewAnnotateInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setAnnotationMode")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    yield* automation.setAnnotationMode(input.webContentsId, input.mode);
  }),
});

export const previewAwaitDrawing = makeIpcMethod({
  channel: IpcChannels.PREVIEW_AWAIT_DRAWING_CHANNEL,
  payload: DesktopPreviewTargetSchema,
  result: Schema.NullOr(DesktopPreviewDrawingSchema),
  handler: Effect.fn("desktop.ipc.preview.awaitDrawing")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    return yield* automation.awaitDrawing(input.webContentsId);
  }),
});

export const previewRevealElement = makeIpcMethod({
  channel: IpcChannels.PREVIEW_REVEAL_ELEMENT_CHANNEL,
  payload: DesktopPreviewRevealInputSchema,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.preview.revealElement")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    return yield* automation.revealElement(input.webContentsId, input.selector);
  }),
});

export const previewClearCache = makeIpcMethod({
  channel: IpcChannels.PREVIEW_CLEAR_CACHE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.clearCache")(function* () {
    const session = yield* PreviewSession.PreviewSession;
    yield* session.clearCache();
  }),
});

export const previewSetViewport = makeIpcMethod({
  channel: IpcChannels.PREVIEW_SET_VIEWPORT_CHANNEL,
  payload: DesktopPreviewViewportInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.preview.setViewport")(function* (input) {
    const automation = yield* PreviewAutomation.PreviewAutomation;
    yield* automation.setViewport(input.webContentsId, {
      width: input.width,
      height: input.height,
    });
  }),
});

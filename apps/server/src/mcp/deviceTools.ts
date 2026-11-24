/**
 * The device tools (docs/design/devices.md), served at `/mcp/device` by
 * McpDeviceServer: list, open, screenshot and close a simulator or emulator
 * on this server's machine. Driving the device happens through the
 * `agent-device` launcher `device_open` returns, not through more tools.
 *
 * Descriptions from T3 Code's device toolkit, without its host selection: a
 * Threadlines server has one device host, its own machine.
 */
import {
  DeviceToolCloseInput,
  DeviceToolListResult,
  DeviceToolOpenInput,
  DeviceToolOpenResult,
  DeviceToolScreenshotResult,
  DeviceToolTargetInput,
} from "@threadlines/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

export const DEVICE_MCP_SERVER_NAME = "threadlines_device";

export const DEVICE_LIST_TOOL_NAME = "device_list";
export const DEVICE_OPEN_TOOL_NAME = "device_open";
export const DEVICE_SCREENSHOT_TOOL_NAME = "device_screenshot";
export const DEVICE_CLOSE_TOOL_NAME = "device_close";

/** The tools as Claude names them, for its allow list. */
export const CLAUDE_DEVICE_TOOL_IDS = [
  DEVICE_LIST_TOOL_NAME,
  DEVICE_OPEN_TOOL_NAME,
  DEVICE_SCREENSHOT_TOOL_NAME,
  DEVICE_CLOSE_TOOL_NAME,
].map((name) => `mcp__${DEVICE_MCP_SERVER_NAME}__${name}`);

// An empty struct serializes as `anyOf [object, array]`, which some providers
// reject and then drop every tool on the server with it.
export const DeviceToolListInput = Schema.Struct({
  refresh: Schema.optional(
    Schema.Boolean.annotate({
      description: "Ask the device hub again instead of answering from the last listing.",
    }),
  ),
});

export const DeviceListTool = Tool.make(DEVICE_LIST_TOOL_NAME, {
  description:
    "List iOS Simulators and Android Emulators on this computer, what it can run, and what is open in this thread's Device tab. Call before `device_open` when you do not know a device id.",
  parameters: DeviceToolListInput,
  success: DeviceToolListResult,
})
  .annotate(Tool.Title, "List devices")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DeviceOpenTool = Tool.make(DEVICE_OPEN_TOOL_NAME, {
  description:
    "Open a simulator or emulator for this thread. Pass `deviceId` from `device_list`. Boots it if needed and shows it in the user's Device tab. Returns the `agent-device` command bound to that device. Drive the device with that command.",
  parameters: DeviceToolOpenInput,
  success: DeviceToolOpenResult,
})
  .annotate(Tool.Title, "Open device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DeviceScreenshotTool = Tool.make(DEVICE_SCREENSHOT_TOOL_NAME, {
  description:
    "Get a PNG of an open device's screen. For taps and text, use the `agent-device` command.",
  parameters: DeviceToolTargetInput,
  success: DeviceToolScreenshotResult,
})
  .annotate(Tool.Title, "Screenshot device")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DeviceCloseTool = Tool.make(DEVICE_CLOSE_TOOL_NAME, {
  description: "Remove a device from this thread's Device tab. `shutdown=true` also turns it off.",
  parameters: DeviceToolCloseInput,
  success: Schema.Struct({}),
})
  .annotate(Tool.Title, "Close device")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const DEVICE_TOOLS = [DeviceListTool, DeviceOpenTool, DeviceScreenshotTool, DeviceCloseTool];

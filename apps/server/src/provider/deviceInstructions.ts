/**
 * The device tools, introduced to a model (docs/design/devices.md).
 *
 * Sent only to sessions started with `deviceTools`. An agent picks between
 * these tools, `simctl`/`adb` and its own habits before it opens anything, so
 * this says which to reach for. How to drive a device comes back from
 * `device_open` itself: it costs nothing in threads that never open one and
 * cannot drift from the pinned agent-device version.
 *
 * ACP providers get the tool descriptions only, like every other Threadlines
 * tool there.
 */
import { DEVICE_MCP_SERVER_NAME } from "../mcp/deviceTools.ts";

/**
 * `toolPrefix` is what precedes each device tool's own name for this
 * provider: `mcp__threadlines_device__` for Claude and Codex, `` for Muse,
 * `<server>_` for OpenCode.
 */
export function buildDeviceInstructions(
  toolPrefix: string = `mcp__${DEVICE_MCP_SERVER_NAME}__`,
): string {
  return `<threadlines_devices>
The user can watch iOS Simulators and Android Emulators on this computer in the Device tab beside this chat. For any work on a simulator or emulator's screen (opening an app, tapping, typing, reading what is shown, taking a screenshot), call \`${toolPrefix}device_open\` and drive the device with the \`agent-device\` command it returns, so the user sees each step. \`${toolPrefix}device_list\` shows what can be opened, \`${toolPrefix}device_screenshot\` shows you the screen, and \`${toolPrefix}device_close\` ends your hold on a device. \`simctl\`, \`adb\` and build tools stay fine for builds, installs, logs and test runners.
</threadlines_devices>`;
}

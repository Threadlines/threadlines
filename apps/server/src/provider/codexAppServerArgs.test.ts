import { assert, it } from "@effect/vitest";

import {
  CODEX_APP_SERVER_ARGS,
  CODEX_DEVICE_TOOL_TIMEOUT_SEC,
  codexAppServerArgs,
} from "./codexAppServerArgs.ts";

it("suppresses the warning for Threadlines' intentional unstable Codex features", () => {
  assert.deepStrictEqual(CODEX_APP_SERVER_ARGS, [
    "app-server",
    "-c",
    "features.default_mode_request_user_input=true",
    "-c",
    "features.apply_patch_streaming_events=true",
    "-c",
    "suppress_unstable_features_warning=true",
  ]);
});

it("approves the page tools without asking, and only them", () => {
  const args = codexAppServerArgs({
    browser: { url: "http://127.0.0.1:1/mcp", serverName: "threadlines_browser" },
    pages: { url: "http://127.0.0.1:1/mcp/pages", serverName: "threadlines_pages" },
  });
  assert.include(args, 'mcp_servers.threadlines_pages.default_tools_approval_mode="approve"');
  assert.notInclude(args, 'mcp_servers.threadlines_browser.default_tools_approval_mode="approve"');
});

it("gives the device server a longer tool timeout for installs and cold boots", () => {
  const args = codexAppServerArgs({
    device: { url: "http://127.0.0.1:1/mcp/device", serverName: "threadlines_device" },
  });
  assert.include(args, 'mcp_servers.threadlines_device.default_tools_approval_mode="approve"');
  assert.include(
    args,
    `mcp_servers.threadlines_device.tool_timeout_sec=${CODEX_DEVICE_TOOL_TIMEOUT_SEC}`,
  );
});

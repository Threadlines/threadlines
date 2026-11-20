import type { DeviceStreamClient } from "@threadlines/client-runtime/device";
import { describe, expect, it } from "vite-plus/test";

import { observeDeviceStreamInput } from "./deviceInputObserver";
import type { DeviceInput } from "./deviceRecording.logic";

describe("observeDeviceStreamInput", () => {
  it("hears iPhone Duo touches, which go to a display's own framebuffer", () => {
    const sent: string[] = [];
    const client = {
      sendRawTouch: (phase: string) => sent.push(`raw ${phase}`),
    } as unknown as DeviceStreamClient;
    const heard: DeviceInput[] = [];
    const observed = observeDeviceStreamInput(client, "ios", (input) => heard.push(input));
    observed.sendRawTouch("begin", 0.2, 0.3);
    observed.sendRawTouch("end", 0.2, 0.3);
    expect(sent).toEqual(["raw begin", "raw end"]);
    expect(heard).toEqual([
      { type: "touch", phase: "begin", x: 0.2, y: 0.3 },
      { type: "touch", phase: "end", x: 0.2, y: 0.3 },
    ]);
  });
});

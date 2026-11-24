import { describe, expect, it } from "vite-plus/test";

import {
  deviceAxElementAt,
  flattenIosAxTree,
  parseAndroidAxNodes,
  readDeviceAxElements,
} from "./accessibility.ts";
import type { DeviceHubTransport } from "./hubTransport.ts";

describe("accessibility elements", () => {
  it("flattens serve-sim's tree to screen fractions, without whole-screen containers", () => {
    const elements = flattenIosAxTree([
      {
        frame: { x: 0, y: 0, width: 400, height: 800 },
        children: [
          {
            AXLabel: "Settings",
            type: "Button",
            frame: { x: 20, y: 40, width: 100, height: 40 },
            children: [{ AXLabel: "Icon", frame: { x: 30, y: 50, width: 20, height: 20 } }],
          },
        ],
      },
    ]);
    expect(elements.map((element) => [element.label, element.x, element.width])).toEqual([
      ["Settings", 0.05, 0.25],
      ["Icon", 0.075, 0.05],
    ]);
    // A tap lands on the smallest element under it.
    expect(deviceAxElementAt(elements, 0.08, 0.07)?.label).toBe("Icon");
    expect(deviceAxElementAt(elements, 0.2, 0.07)?.label).toBe("Settings");
    expect(deviceAxElementAt(elements, 0.9, 0.9)).toBeNull();
  });

  it("keeps serve-emu's labeled or clickable nodes, in fractions of the root's bounds", () => {
    const elements = parseAndroidAxNodes([
      { bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } },
      {
        bounds: { left: 108, top: 240, right: 540, bottom: 480 },
        text: "OK",
        className: "android.widget.Button",
        id: 7,
      },
      { bounds: { left: 0, top: 0, right: 100, bottom: 100 } },
      { bounds: { left: 0, top: 0, right: 100, bottom: 100 }, clickable: true },
    ]);
    expect(elements.map((element) => [element.label, element.role, element.x, element.y])).toEqual([
      ["OK", "Button", 0.1, 0.1],
      ["", "", 0, 0],
    ]);
  });

  it("filters Android unlabeled containers before applying the element cap", () => {
    const noise = Array.from({ length: 600 }, () => ({
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
    }));
    const elements = parseAndroidAxNodes([
      { bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } },
      ...noise,
      {
        bounds: { left: 108, top: 240, right: 540, bottom: 480 },
        text: "Continue",
        className: "android.widget.Button",
      },
    ]);
    expect(elements.map((element) => element.label)).toEqual(["Continue"]);
  });

  it("propagates AbortError instead of replacing it with an unexpected reply error", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    const transport: DeviceHubTransport = {
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          json: () => Promise.reject(abortError),
        }) as unknown as Response,
      socket: () => {
        throw new Error("not used");
      },
    };
    await expect(
      readDeviceAxElements(transport, { platform: "ios", deviceId: "SIM-1" }),
    ).rejects.toBe(abortError);
  });
});

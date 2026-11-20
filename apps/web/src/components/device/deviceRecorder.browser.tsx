import type { DeviceHubTransport } from "@threadlines/client-runtime/device";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startDeviceRecorder } from "./deviceRecorder";

function paintedCanvas(color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 60;
  canvas.height = 120;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

/** A hub that answers screenshots with a PNG and the accessibility tree with nothing. */
async function fakeTransport(): Promise<{ transport: DeviceHubTransport }> {
  const blob = await new Promise<Blob>((resolve) =>
    paintedCanvas("#888").toBlob((value) => resolve(value!), "image/png"),
  );
  const png = await blob.arrayBuffer();
  return {
    transport: {
      fetch: async (path) =>
        path.includes("/api/screenshot")
          ? new Response(png.slice(0), { headers: { "content-type": "image/png" } })
          : new Response("[]", { headers: { "content-type": "application/json" } }),
      socket: () => {
        throw new Error("not used");
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startDeviceRecorder", () => {
  it("stops capturing at once on stop, and still logs a Tools action that answers after", async () => {
    const { transport } = await fakeTransport();
    let watching = 0;
    const recorder = startDeviceRecorder({
      transport,
      platform: "ios",
      deviceId: "SIM-1",
      frames: true,
      videoSource: paintedCanvas("#f00"),
      observeFrames: () => {
        watching += 1;
        return () => {
          watching -= 1;
        };
      },
      onVideoFull: () => {},
    });
    expect(watching).toBe(1);
    let answer: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const stopped = recorder.stop(undefined, pending);
    // The video stops taking frames before the pending action answers.
    await vi.waitFor(() => expect(watching).toBe(0));
    recorder.record({ type: "action", description: "Launched com.example.app" });
    answer();
    const result = await stopped;
    expect(result.inputs.map((entry) => entry.input)).toEqual([
      { type: "action", description: "Launched com.example.app" },
    ]);
    // Once it closed, nothing more is logged.
    recorder.record({ type: "button", button: "home" });
    expect(result.inputs).toHaveLength(1);
  });

  it("records whichever canvas drew the last frame, such as the iPhone Duo display in front", async () => {
    const { transport } = await fakeTransport();
    const stream = paintedCanvas("#f00");
    const innerDisplay = paintedCanvas("#0f0");
    let emit: (drawn: HTMLCanvasElement) => void = () => {};
    const draws = vi.spyOn(CanvasRenderingContext2D.prototype, "drawImage");
    const recorder = startDeviceRecorder({
      transport,
      platform: "ios",
      deviceId: "SIM-1",
      frames: false,
      videoSource: stream,
      observeFrames: (listener) => {
        emit = listener;
        return () => {};
      },
      onVideoFull: () => {},
    });
    draws.mockClear();
    emit(innerDisplay);
    expect(draws.mock.calls.map((call) => call[0])).toContain(innerDisplay);
    expect(draws.mock.calls.map((call) => call[0])).not.toContain(stream);
    await recorder.stop();
  });
});

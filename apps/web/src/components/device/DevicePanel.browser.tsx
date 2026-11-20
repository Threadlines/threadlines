import "../../index.css";

import {
  type DeviceChannelEvent,
  type DeviceChannelOpen,
  type DeviceDetail,
  type DeviceServiceState,
  type DeviceSession,
  type EnvironmentApi,
  EnvironmentId,
  ThreadId,
} from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { writePrimaryEnvironmentDescriptor } from "../../environments/primary/context";
import { resetTestPage } from "../../lib/testPage.browser-harness";
import { DevicePanel } from "./DevicePanel";
import { onAgentOpenedDevice, resetDeviceStateForTests } from "./deviceState";

const ENVIRONMENT_ID = EnvironmentId.make("environment-devices");
const THREAD_ID = ThreadId.make("thread-devices");
const THREAD_KEY = `${ENVIRONMENT_ID}:${THREAD_ID}`;

const IPHONE = {
  id: "SIM-1",
  platform: "ios",
  name: "iPhone 17 Pro",
  version: "iOS 27.2",
  booted: false,
  physical: false,
} as const;
const PIXEL = {
  id: "emulator-5554",
  platform: "android",
  name: "Pixel 9",
  version: "Android 16",
  booted: true,
  physical: false,
} as const;

function deviceState(patch: Partial<DeviceServiceState> = {}): DeviceServiceState {
  return {
    enabled: true,
    agentAccessEnabled: false,
    hostStatus: "ready",
    platforms: [
      { platform: "ios", available: true },
      { platform: "android", available: true },
    ],
    incompletePlatforms: [],
    tools: {
      hub: { requiredVersion: "0.22.1", installedVersions: ["0.22.1"], runningVersion: "0.22.1" },
      agent: { requiredVersion: "0.9.0", installedVersions: [], runningVersion: null },
    },
    hubInstalled: true,
    agentDeviceInstalled: false,
    devices: [IPHONE, PIXEL],
    sessions: [],
    bootingDevices: [],
    revision: 1,
    ...patch,
  };
}

const session = (
  deviceId: string,
  platform: "ios" | "android",
  openedBy: "user" | "agent",
): DeviceSession => ({
  threadId: THREAD_ID,
  deviceId,
  platform,
  openedAt: "2026-11-20T00:00:00.000Z",
  bootedByThreadlines: true,
  openedBy,
});

const DETAIL: DeviceDetail = {
  deviceId: IPHONE.id,
  settings: { appearance: "light", textSize: "default", reduceMotion: false },
  foregroundApp: null,
  readAt: "2026-11-20T00:00:00.000Z",
};

interface FakeChannel {
  readonly input: DeviceChannelOpen;
  readonly emit: (event: DeviceChannelEvent) => void;
  stopped: boolean;
}

/** A computer with devices, answering from `state` and holding every channel the tab opens. */
function fakeComputer(initial: DeviceServiceState) {
  let state = initial;
  let listener: ((next: DeviceServiceState) => void) | null = null;
  const channels: FakeChannel[] = [];
  const device = {
    list: vi.fn(async () => state),
    updateTool: vi.fn(async () => state),
    open: vi.fn(async (input: { deviceId: string; platform: "ios" | "android" }) =>
      session(input.deviceId, input.platform, "user"),
    ),
    close: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
    detail: vi.fn(async () => DETAIL),
    action: vi.fn(async () => DETAIL),
    subscribeState: (next: (value: DeviceServiceState) => void) => {
      listener = next;
      next(state);
      return () => {
        listener = null;
      };
    },
    channel: {
      open: (input: DeviceChannelOpen, emit: (event: DeviceChannelEvent) => void) => {
        const channel: FakeChannel = { input, emit, stopped: false };
        channels.push(channel);
        return () => {
          channel.stopped = true;
        };
      },
      send: vi.fn(async () => undefined),
      credit: vi.fn(async () => undefined),
    },
  };
  const settings = { update: vi.fn(async () => ({})) };
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
    device,
    settings,
  } as unknown as EnvironmentApi);
  return {
    device,
    settings,
    channels,
    push(next: DeviceServiceState) {
      state = next;
      listener?.(next);
    },
    channel(path: string) {
      return channels.find((channel) => channel.input.path === path && !channel.stopped);
    },
  };
}

function base64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A JPEG of a plain screen, wrapped as serve-sim's AVCC "seed" envelope. */
async function seedEnvelope(): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = 118;
  canvas.height = 256;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#3b82f6";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((value) => resolve(value!), "image/jpeg"),
  );
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  const envelope = new Uint8Array(5 + jpeg.length);
  new DataView(envelope.buffer).setUint32(0, jpeg.length + 1);
  envelope[4] = 4;
  envelope.set(jpeg, 5);
  return envelope;
}

function Host(props: { visible: boolean }) {
  return (
    <div style={{ width: 420, height: 720, display: "flex" }}>
      <DevicePanel
        environmentId={ENVIRONMENT_ID}
        threadId={THREAD_ID}
        threadKey={THREAD_KEY}
        visible={props.visible}
      />
    </div>
  );
}

describe("DevicePanel", () => {
  beforeEach(() => {
    writePrimaryEnvironmentDescriptor({
      environmentId: ENVIRONMENT_ID,
      label: "This computer",
      capabilities: { devices: true },
    } as never);
  });

  afterEach(async () => {
    __resetEnvironmentApiOverridesForTests();
    resetDeviceStateForTests();
    writePrimaryEnvironmentDescriptor(null);
    await resetTestPage();
  });

  it("explains setup and installs nothing until Use devices is turned on", async () => {
    const computer = fakeComputer(
      deviceState({ enabled: false, hostStatus: "disabled", devices: [], hubInstalled: false }),
    );
    await render(<Host visible />);

    await expect.element(page.getByRole("heading", { name: "Set up devices" })).toBeVisible();
    await expect.element(page.getByText("expo-device-hub 0.22.1")).toBeVisible();
    expect(computer.device.list).not.toHaveBeenCalled();

    await page.getByRole("switch", { name: "Use devices", exact: true }).click();
    await vi.waitFor(() =>
      expect(computer.settings.update).toHaveBeenCalledWith({ enableDevices: true }),
    );
    await vi.waitFor(() => expect(computer.device.list).toHaveBeenCalledWith({ refresh: true }));
  });

  it("opens a device for the thread and shows its screen through the device channel", async () => {
    const computer = fakeComputer(deviceState());
    const mounted = await render(<Host visible />);

    await page.getByRole("button", { name: "Start iPhone 17 Pro" }).click();
    await vi.waitFor(() =>
      expect(computer.device.open).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        deviceId: IPHONE.id,
        platform: "ios",
      }),
    );
    computer.push(
      deviceState({
        devices: [{ ...IPHONE, booted: true }, PIXEL],
        sessions: [session(IPHONE.id, "ios", "user")],
        revision: 2,
      }),
    );
    await expect.element(page.getByRole("toolbar", { name: "Device controls" })).toBeVisible();

    // The helper is primed through its MJPEG stream, then the input socket opens.
    await vi.waitFor(() =>
      expect(computer.channel("/vendor/serve-sim/helper/SIM-1/stream.mjpeg")).toBeDefined(),
    );
    const prime = computer.channel("/vendor/serve-sim/helper/SIM-1/stream.mjpeg")!;
    prime.emit({ _tag: "opened", status: 200, contentType: "multipart/x-mixed-replace" });
    prime.emit({ _tag: "data", data: base64(new Uint8Array([45, 45])) });
    await vi.waitFor(() => expect(computer.channel("/vendor/serve-sim/helper/ws")).toBeDefined());
    expect(computer.channel("/vendor/serve-sim/helper/ws")!.input).toMatchObject({
      _tag: "ws",
      query: { device: "SIM-1" },
    });

    const video = computer.channel("/vendor/serve-sim/helper/SIM-1/stream.avcc")!;
    expect(video.input).toMatchObject({ _tag: "http", method: "GET" });
    video.emit({ _tag: "opened", status: 200, contentType: "application/octet-stream" });
    video.emit({ _tag: "data", data: base64(await seedEnvelope()) });

    await expect.element(page.getByText("Connecting to the screen…")).not.toBeInTheDocument();
    const canvas = document.querySelector<HTMLCanvasElement>("[data-testid=device-frame] canvas");
    expect(canvas?.width).toBe(118);
    await vi.waitFor(() => expect(computer.device.channel.credit).toHaveBeenCalled());

    // Only the device on screen streams: hiding the tab drops every channel.
    await mounted.rerender(<Host visible={false} />);
    await vi.waitFor(() =>
      expect(computer.channels.every((channel) => channel.stopped)).toBe(true),
    );
  });

  it("reports a device an agent opened, but not one already open when the tab loaded", async () => {
    const computer = fakeComputer(
      deviceState({ sessions: [session(PIXEL.id, "android", "agent")] }),
    );
    const opened: string[] = [];
    const stop = onAgentOpenedDevice((_environmentId, next) => opened.push(next.deviceId));
    await render(<Host visible />);
    await expect.element(page.getByText("Open in this thread")).toBeVisible();
    expect(opened).toEqual([]);

    computer.push(
      deviceState({
        devices: [{ ...IPHONE, booted: true }, PIXEL],
        sessions: [session(PIXEL.id, "android", "agent"), session(IPHONE.id, "ios", "agent")],
        revision: 2,
      }),
    );
    await vi.waitFor(() => expect(opened).toEqual([IPHONE.id]));
    stop();
  });
});

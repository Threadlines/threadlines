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
import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { writePrimaryEnvironmentDescriptor } from "../../environments/primary/context";
import { resetTestPage } from "../../lib/testPage.browser-harness";
import { DeviceFloatingWindow } from "./DeviceFloatingWindow";
import { DevicePanel } from "./DevicePanel";
import { onAgentOpenedDevice, resetDeviceStateForTests, selectThreadDevice } from "./deviceState";
import { readThreadDeviceViews } from "./deviceViewStore";

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
const DUO = {
  id: "DUO-1",
  platform: "ios",
  name: "Renamed phone",
  version: "iOS 27.2",
  booted: true,
  physical: false,
  model: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo",
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
async function seedEnvelope(width = 118, height = 256): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
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

/** One tagged message from serve-sim's helper socket, as the channel carries it. */
const helperMessage = (tag: number, payload?: unknown): DeviceChannelEvent => {
  const json =
    payload === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(payload));
  return {
    _tag: "message",
    binary: true,
    final: true,
    data: base64(new Uint8Array([tag, ...json])),
  };
};

/** What the Device tab sent on the helper socket, decoded: tag and JSON. */
const helperSends = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.flatMap(([input]) => {
    const { binary, data } = input as { binary: boolean; data: string };
    if (!binary) return [];
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    return [
      { tag: bytes[0], body: JSON.parse(new TextDecoder().decode(bytes.subarray(1)) || "null") },
    ];
  });

function Host(props: { visible: boolean; onOpenInPanel?: (deviceId: string) => void }) {
  return (
    <div style={{ display: "flex", gap: 0 }}>
      {/* The chat column the float is measured against. */}
      <div style={{ width: 600, height: 720, position: "relative" }}>
        {props.onOpenInPanel ? (
          <DeviceFloatingWindow
            environmentId={ENVIRONMENT_ID}
            threadId={THREAD_ID}
            threadKey={THREAD_KEY}
            onOpenInPanel={props.onOpenInPanel}
          />
        ) : null}
      </div>
      <div style={{ width: 420, height: 720, display: "flex" }}>
        <DevicePanel
          environmentId={ENVIRONMENT_ID}
          threadId={THREAD_ID}
          threadKey={THREAD_KEY}
          visible={props.visible}
        />
      </div>
    </div>
  );
}

/** Both devices booted and open in the thread, the iPhone shown. */
function twoOpenDevices() {
  selectThreadDevice(THREAD_KEY, IPHONE.id);
  return fakeComputer(
    deviceState({
      devices: [{ ...IPHONE, booted: true }, PIXEL],
      sessions: [session(IPHONE.id, "ios", "user"), session(PIXEL.id, "android", "user")],
    }),
  );
}

const openChannels = (computer: ReturnType<typeof fakeComputer>) =>
  computer.channels.filter((channel) => !channel.stopped).map((channel) => channel.input.path);

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

  it("shows open devices as chips; only the shown one streams, and chips rename and close", async () => {
    const computer = twoOpenDevices();
    await render(<Host visible />);

    const chips = page.getByRole("tablist", { name: "Open devices" });
    await expect.element(chips.getByRole("tab", { name: "iPhone 17 Pro" })).toBeVisible();
    await expect.element(chips.getByRole("tab", { name: "Pixel 9" })).toBeVisible();
    await vi.waitFor(() =>
      expect(openChannels(computer)).toContain("/vendor/serve-sim/helper/SIM-1/stream.mjpeg"),
    );

    // Switching releases the hidden device's channels and opens the shown one's.
    await chips.getByRole("tab", { name: "Pixel 9" }).click();
    await vi.waitFor(() => {
      const open = openChannels(computer);
      expect(open.some((path) => path.startsWith("/vendor/serve-sim/"))).toBe(false);
      expect(open).toContain("/vendor/serve-emu/ws");
    });

    // Double-click renames; the name is kept for the thread.
    await chips.getByRole("tab", { name: "Pixel 9" }).dblClick();
    const field = page.getByRole("textbox", { name: "Rename Pixel 9" });
    await field.fill("Checkout phone");
    await userEvent.keyboard("{Enter}");
    await expect.element(chips.getByRole("tab", { name: "Checkout phone" })).toBeVisible();
    expect(readThreadDeviceViews(THREAD_KEY).names).toEqual({ [PIXEL.id]: "Checkout phone" });

    // The chip's menu closes the device; the tab moves to the chip beside it.
    await chips.getByRole("button", { name: "Checkout phone menu" }).click();
    await page.getByRole("menuitem", { name: "Close device" }).click();
    await vi.waitFor(() =>
      expect(computer.device.close).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        deviceId: PIXEL.id,
        shutdown: false,
      }),
    );
    expect(readThreadDeviceViews(THREAD_KEY).selected).toBe(IPHONE.id);
  });

  it("floats the device over the chat, kept inside the window, and docks it again", async () => {
    const computer = twoOpenDevices();
    const docked: string[] = [];
    await render(<Host visible onOpenInPanel={(deviceId) => docked.push(deviceId)} />);

    await page.getByRole("button", { name: "Float over the chat" }).click();
    await expect.element(page.getByTestId("device-floating-placeholder")).toBeVisible();
    const float = page.getByTestId("device-float");
    await expect.element(float).toBeVisible();
    // The float now holds the screen; the tab holds nothing for it.
    await vi.waitFor(() =>
      expect(
        openChannels(computer).filter(
          (path) => path === "/vendor/serve-sim/helper/SIM-1/stream.mjpeg",
        ),
      ).toHaveLength(1),
    );

    // Dragged far past the window's corner, it stops at the edge.
    const corner = document.createElement("div");
    corner.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;";
    document.body.append(corner);
    await userEvent.dragAndDrop(
      page.getByTestId("device-float-handle"),
      page.elementLocator(corner),
    );
    corner.remove();
    await vi.waitFor(() => {
      const rect = float.element().getBoundingClientRect();
      expect([rect.left, rect.top]).toEqual([8, 8]);
    });

    await float.getByRole("button", { name: "Open in right panel" }).click();
    expect(docked).toEqual([IPHONE.id]);

    // Close dismisses the float; the device stays open.
    await float.getByRole("button", { name: "Close floating device" }).click();
    await expect.element(page.getByTestId("device-float")).not.toBeInTheDocument();
    await expect.element(page.getByRole("toolbar", { name: "Device controls" })).toBeVisible();
    expect(computer.device.close).not.toHaveBeenCalled();
  });

  it("reads the iOS event log through the channel while Tools is open", async () => {
    const computer = twoOpenDevices();
    const mounted = await render(<Host visible />);

    await page.getByRole("button", { name: "Tools" }).click();
    await vi.waitFor(() =>
      expect(computer.channel("/vendor/serve-sim/api/event-log/events")).toBeDefined(),
    );
    const log = computer.channel("/vendor/serve-sim/api/event-log/events")!;
    expect(log.input).toMatchObject({ _tag: "http", query: { device: "SIM-1", limit: "100" } });
    log.emit({ _tag: "opened", status: 200, contentType: "text/event-stream" });
    const text = (value: string) => base64(new TextEncoder().encode(value));
    log.emit({
      _tag: "data",
      data: text(
        'data: {"events":[{"id":1,"timestamp":"2026-11-20T10:00:00Z","kind":"app","summary":"Launched Settings"}]}\n\n',
      ),
    });
    log.emit({
      _tag: "data",
      data: text('data: {"event":{"id":2,"kind":"ui","summary":"Opened General"}}\n\n'),
    });
    const list = page.getByRole("list", { name: "Device events" });
    await expect.element(list.getByText("Opened General")).toBeVisible();
    await expect.element(list.getByText("Launched Settings")).toBeVisible();

    await page.getByRole("button", { name: "Close tools" }).click();
    await vi.waitFor(() => expect(log.stopped).toBe(true));

    // Tools left open while another right-panel tab shows reads nothing.
    await page.getByRole("button", { name: "Tools" }).click();
    await vi.waitFor(() =>
      expect(computer.channel("/vendor/serve-sim/api/event-log/events")).toBeDefined(),
    );
    const reopened = computer.channel("/vendor/serve-sim/api/event-log/events")!;
    await mounted.rerender(<Host visible={false} />);
    await vi.waitFor(() => expect(reopened.stopped).toBe(true));
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

  it("shows an iPhone Duo's displays from their own feeds, takes stances, and keeps touches on the screen in front", async () => {
    const computer = fakeComputer(deviceState({ devices: [DUO] }));
    await render(<Host visible />);
    await page.getByRole("button", { name: "Open Renamed phone" }).click();
    computer.push(
      deviceState({ devices: [DUO], sessions: [session(DUO.id, "ios", "user")], revision: 2 }),
    );
    await vi.waitFor(() =>
      expect(computer.channel("/vendor/serve-sim/helper/DUO-1/stream.mjpeg")).toBeDefined(),
    );
    const prime = computer.channel("/vendor/serve-sim/helper/DUO-1/stream.mjpeg")!;
    prime.emit({ _tag: "opened", status: 200, contentType: "multipart/x-mixed-replace" });
    prime.emit({ _tag: "data", data: base64(new Uint8Array([45, 45])) });
    await vi.waitFor(() => expect(computer.channel("/vendor/serve-sim/helper/ws")).toBeDefined());
    const input = computer.channel("/vendor/serve-sim/helper/ws")!;
    input.emit({ _tag: "opened" });
    input.emit(helperMessage(0x83));
    // Book: the inner display is in front, half open, so both displays show.
    input.emit(
      helperMessage(0x82, {
        width: 2007,
        height: 2853,
        orientation: "landscape_left",
        screenId: 3,
        supportsHingeAngle: true,
        hingeAngle: 90,
        hingePose: "book",
      }),
    );
    await vi.waitFor(() =>
      expect(computer.channel("/vendor/serve-sim/helper/DUO-1/panel/3/stream.avcc")).toBeDefined(),
    );
    const inner = computer.channel("/vendor/serve-sim/helper/DUO-1/panel/3/stream.avcc")!;
    inner.emit({ _tag: "opened", status: 200, contentType: "application/octet-stream" });
    inner.emit({ _tag: "data", data: base64(await seedEnvelope(118, 168)) });

    await expect.element(page.getByText("Connecting to the screen…")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("device-duo-inner")).toBeVisible();
    await expect.element(page.getByTestId("device-duo-cover")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Book" }))
      .toHaveAttribute("aria-pressed", "true");

    // A tap on the inner screen reaches the device; one on the cover behind it does not.
    const layer = page.getByTestId("device-touch-layer");
    const box = (testId: string) =>
      document.querySelector(`[data-testid=${testId}]`)!.getBoundingClientRect();
    const layerBox = layer.element().getBoundingClientRect();
    const at = (rect: DOMRect) => ({
      x: rect.left + rect.width / 2 - layerBox.left,
      y: rect.top + rect.height / 2 - layerBox.top,
    });
    await layer.click({ position: at(box("device-duo-cover")) });
    await layer.click({ position: at(box("device-duo-inner")) });
    await vi.waitFor(() =>
      expect(helperSends(computer.device.channel.send).filter((sent) => sent.tag === 0x03)).toEqual(
        [
          { tag: 0x03, body: expect.objectContaining({ type: "begin" }) },
          { tag: 0x03, body: expect.objectContaining({ type: "end" }) },
        ],
      ),
    );

    // A stance goes out as a hinge command on the same socket.
    await page.getByRole("button", { name: "Closed" }).click();
    await vi.waitFor(() =>
      expect(helperSends(computer.device.channel.send).at(-1)).toEqual({
        tag: 0x10,
        body: { requestId: 1, command: { control: "pose", value: "closed" } },
      }),
    );
    input.emit(helperMessage(0x90, { requestId: 1, ok: true }));

    // The cover takes over; this helper has no fixed cover feed, so the ordinary stream is back.
    input.emit(
      helperMessage(0x82, {
        width: 1398,
        height: 2034,
        orientation: "portrait",
        screenId: 1,
        supportsHingeAngle: true,
        hingeAngle: 0,
        hingePose: "closed",
      }),
    );
    await vi.waitFor(() =>
      expect(computer.channel("/vendor/serve-sim/helper/DUO-1/panel/1/stream.avcc")).toBeDefined(),
    );
    computer
      .channel("/vendor/serve-sim/helper/DUO-1/panel/1/stream.avcc")!
      .emit({ _tag: "opened", status: 404, contentType: "application/json" });
    await vi.waitFor(() =>
      expect(computer.channel("/vendor/serve-sim/helper/DUO-1/stream.avcc")).toBeDefined(),
    );
    await expect
      .element(page.getByRole("toolbar", { name: "iPhone Duo stance" }))
      .not.toBeInTheDocument();
    expect(document.querySelector("[data-testid=device-frame]")?.getAttribute("data-frame")).toBe(
      "plain",
    );
    // Input stayed on the one socket the helper admitted.
    expect(
      computer.channels.filter((channel) => channel.input.path === "/vendor/serve-sim/helper/ws"),
    ).toHaveLength(1);
  });
});

import type { DevicePlatform, EnvironmentId } from "@threadlines/contracts";
import {
  createCanvasFrameSink,
  createDeviceHubTransport,
  createDeviceStreamClient,
  type DeviceHubTransport,
  type DeviceScreenSize,
  type DeviceStreamClient,
  type DeviceStreamStatus,
  type DeviceVideoMode,
  type DuoControlState,
  type DuoPanelId,
  IDLE_DUO_CONTROL,
} from "@threadlines/client-runtime/device";
import { useEffect, useState, useSyncExternalStore } from "react";

import { observeDeviceStreamInput } from "./deviceInputObserver";
import type { DeviceInput } from "./deviceRecording.logic";
import { deviceChannelApi } from "./deviceState";

export interface DeviceStreamState {
  readonly status: DeviceStreamStatus;
  /** Started and not stopped: the view is on screen. Polls beside the stream follow this. */
  readonly active: boolean;
  readonly detail: string | undefined;
  readonly screen: DeviceScreenSize | null;
  readonly mode: DeviceVideoMode;
  readonly input: { readonly connected: boolean; readonly detail?: string };
  /** iPhone Duo: the hinge command in flight and the last one's error. */
  readonly duo: DuoControlState;
  /** iPhone Duo: the display whose fixed feed is live, null on the ordinary stream. */
  readonly duoPanel: DuoPanelId | null;
  /** iPhone Duo: why the fixed feeds are not used this session. */
  readonly duoUnavailable: string | null;
}

const CONNECTING: DeviceStreamState = {
  status: "connecting",
  active: true,
  detail: undefined,
  screen: null,
  mode: "video",
  input: { connected: false },
  duo: IDLE_DUO_CONTROL,
  duoPanel: null,
  duoUnavailable: null,
};

const streamCanvas = () => {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  return canvas;
};

/** One device's stream for one view: its canvas, its client and what it last reported. */
export interface DeviceStream {
  /** The stream draws here; the view mounts it. */
  readonly canvas: HTMLCanvasElement;
  /** iPhone Duo: each display's own picture, kept while the other one is in front. */
  readonly panelCanvases: { readonly cover: HTMLCanvasElement; readonly inner: HTMLCanvasElement };
  /** iPhone Duo: draw from the displays' fixed feeds (true) or the one ordinary stream. */
  readonly setDuoPanels: (on: boolean) => void;
  readonly client: DeviceStreamClient;
  readonly transport: DeviceHubTransport;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getState: () => DeviceStreamState;
  readonly start: () => void;
  readonly stop: () => void;
  /** Drops the channels and opens fresh ones, with a decoder waiting for a keyframe. */
  readonly reconnect: () => void;
  /** Hears the input this view sends to the device (a recording listens here). */
  readonly observeInput: (listener: (input: DeviceInput) => void) => () => void;
  /**
   * Hears each frame drawn, with the canvas it went to: the stream canvas, or
   * an iPhone Duo display's own (a recording copies it).
   */
  readonly observeFrames: (listener: (drawn: HTMLCanvasElement) => void) => () => void;
}

export function createDeviceStream(input: {
  readonly environmentId: EnvironmentId;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly transport?: DeviceHubTransport;
}): DeviceStream {
  const canvas = streamCanvas();
  const panelCanvases = { cover: streamCanvas(), inner: streamCanvas() };
  const frameListeners = new Set<(drawn: HTMLCanvasElement) => void>();
  const notifyFrame = (drawn: HTMLCanvasElement) => () => {
    for (const listener of frameListeners) listener(drawn);
  };
  const panelSinks = {
    cover: createCanvasFrameSink(panelCanvases.cover, notifyFrame(panelCanvases.cover)),
    inner: createCanvasFrameSink(panelCanvases.inner, notifyFrame(panelCanvases.inner)),
  };
  const transport =
    input.transport ?? createDeviceHubTransport(deviceChannelApi(input.environmentId));
  const listeners = new Set<() => void>();
  let state = CONNECTING;
  const update = (patch: Partial<DeviceStreamState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const inputListeners = new Set<(input: DeviceInput) => void>();
  const sentClient = createDeviceStreamClient(
    { platform: input.platform, deviceId: input.deviceId, transport },
    createCanvasFrameSink(canvas, notifyFrame(canvas)),
    {
      onStatus: (status, detail) => update({ status, detail }),
      onScreen: (screen) => update({ screen }),
      onInputConnected: (connected, detail) =>
        update({ input: detail === undefined ? { connected } : { connected, detail } }),
      onVideoMode: (mode) => update({ mode }),
      onDuoControl: (duo) => update({ duo }),
      onDuoPanel: (duoPanel) => update({ duoPanel }),
      onDuoUnavailable: (duoUnavailable) => update({ duoUnavailable }),
    },
  );
  const client = observeDeviceStreamInput(sentClient, input.platform, (sent) => {
    for (const listener of inputListeners) listener(sent);
  });
  return {
    canvas,
    panelCanvases,
    setDuoPanels: (on) => client.setDuoPanels(on ? panelSinks : null),
    client,
    transport,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    start: () => {
      update(CONNECTING);
      client.start();
    },
    stop: () => {
      client.stop();
      update({ active: false });
    },
    reconnect: () => {
      client.stop();
      update(CONNECTING);
      client.start();
    },
    observeInput: (listener) => {
      inputListeners.add(listener);
      return () => {
        inputListeners.delete(listener);
      };
    },
    observeFrames: (listener) => {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
  };
}

/**
 * A device's live screen and input while `active`: only the device on screen
 * streams, so a hidden tab, another thread or a closed panel holds no channel.
 * Each start opens fresh channels with a fresh decoder. Mount it keyed by the
 * computer and device.
 */
export function useDeviceStream(input: {
  readonly environmentId: EnvironmentId;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly active: boolean;
}): { readonly stream: DeviceStream; readonly state: DeviceStreamState } {
  const { environmentId, platform, deviceId, active } = input;
  const [stream] = useState(() => createDeviceStream({ environmentId, platform, deviceId }));
  useEffect(() => {
    if (!active) return;
    stream.start();
    return () => stream.stop();
  }, [active, stream]);
  const state = useSyncExternalStore(stream.subscribe, stream.getState, stream.getState);
  return { stream, state };
}

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
} from "@threadlines/client-runtime/device";
import { useEffect, useState, useSyncExternalStore } from "react";

import { observeDeviceStreamInput } from "./deviceInputObserver";
import type { DeviceInput } from "./deviceRecording.logic";
import { deviceChannelApi } from "./deviceState";

export interface DeviceStreamState {
  readonly status: DeviceStreamStatus;
  readonly detail: string | undefined;
  readonly screen: DeviceScreenSize | null;
  readonly mode: DeviceVideoMode;
  readonly input: { readonly connected: boolean; readonly detail?: string };
}

const CONNECTING: DeviceStreamState = {
  status: "connecting",
  detail: undefined,
  screen: null,
  mode: "video",
  input: { connected: false },
};

/** One device's stream for one view: its canvas, its client and what it last reported. */
export interface DeviceStream {
  /** The stream draws here; the view mounts it. */
  readonly canvas: HTMLCanvasElement;
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
}

export function createDeviceStream(input: {
  readonly environmentId: EnvironmentId;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly transport?: DeviceHubTransport;
}): DeviceStream {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
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
    createCanvasFrameSink(canvas),
    {
      onStatus: (status, detail) => update({ status, detail }),
      onScreen: (screen) => update({ screen }),
      onInputConnected: (connected, detail) =>
        update({ input: detail === undefined ? { connected } : { connected, detail } }),
      onVideoMode: (mode) => update({ mode }),
    },
  );
  const client = observeDeviceStreamInput(sentClient, input.platform, (sent) => {
    for (const listener of inputListeners) listener(sent);
  });
  return {
    canvas,
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
    stop: () => client.stop(),
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

// @effect-diagnostics globalTimers:off - The 3 minute cap and the elapsed clock are plain browser timers.
import type { DeviceSummary, ScopedThreadRef } from "@threadlines/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { toastManager } from "../ui/toast";
import { composerAcceptsImages } from "../chat/composerImageSupport";
import {
  DEVICE_RECORDING_MAX_MS,
  type DeviceRecorder,
  startDeviceRecorder,
} from "./deviceRecorder";
import { type DeviceActionBody, describeDeviceAction } from "./deviceRecording.logic";
import { handOffDeviceRecording } from "./deviceRecordingHandoff";
import type { DeviceStream } from "./useDeviceStream";

export type DeviceRecordingState =
  | { readonly status: "idle" }
  | { readonly status: "recording"; readonly startedAt: number }
  | { readonly status: "saving" };

interface ActiveRecording {
  readonly recorder: DeviceRecorder;
  readonly threadKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly context: string;
  readonly unobserve: () => void;
  readonly limitTimer: ReturnType<typeof setTimeout>;
  /** Tools actions started during the recording that have not answered yet. */
  readonly pendingActions: Set<Promise<void>>;
}

/**
 * Records a flow on one device view (docs/design/devices.md, "Record a
 * flow"). The recording belongs to the view it started in: when the view
 * hides or unmounts (another chip, floating, docking, closing the device or
 * hiding the tab) it stops and hands off to the thread's draft, the same as
 * Stop. Discard throws it away. Ends on its own after 3 minutes, or when the
 * video reaches its byte budget.
 */
export function useDeviceRecording(options: {
  readonly threadKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly device: DeviceSummary;
  readonly stream: DeviceStream;
  readonly visible: boolean;
  /** The app in front when recording starts, such as a bundle id. */
  readonly appId: string | null;
}) {
  const { device, stream, visible } = options;
  const [state, setState] = useState<DeviceRecordingState>({ status: "idle" });
  const active = useRef<ActiveRecording | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const setStateIfMounted = (next: DeviceRecordingState) => {
    if (mounted.current) setState(next);
  };

  const end = (keep: boolean, endedEarly?: "time" | "size") => {
    const recording = active.current;
    if (!recording) return;
    active.current = null;
    recording.unobserve();
    clearTimeout(recording.limitTimer);
    if (!keep) {
      void recording.recorder.stop();
      setStateIfMounted({ status: "idle" });
      return;
    }
    setStateIfMounted({ status: "saving" });
    // Finishes even when the view is gone: the recording is the user's.
    // Capture stops now; a Tools action still running lands in the log
    // before it closes.
    void recording.recorder
      .stop(endedEarly, Promise.allSettled(recording.pendingActions))
      .then((result) =>
        handOffDeviceRecording({
          threadKey: recording.threadKey,
          threadRef: recording.threadRef,
          result,
          context: recording.context,
        }),
      )
      .then(
        ({ steps, frames, video }) =>
          toastManager.add({
            type: "success",
            title: "Recording added to the draft",
            description: `${steps === 1 ? "1 step" : `${steps} steps`}${
              frames > 0 ? `, ${frames === 1 ? "1 screenshot" : `${frames} screenshots`}` : ""
            }${video ? " and a video" : ""}. Edit it, then send.`,
          }),
        (cause: unknown) =>
          toastManager.add({
            type: "error",
            title: "Could not add the recording",
            description: cause instanceof Error ? cause.message : "Try recording again.",
          }),
      )
      .finally(() => setStateIfMounted({ status: "idle" }));
  };

  const start = () => {
    if (active.current || state.status !== "idle" || !visible) return;
    const recorder = startDeviceRecorder({
      transport: stream.transport,
      platform: device.platform,
      deviceId: device.id,
      frames: composerAcceptsImages(options.threadKey),
      videoSource: activeVideoCanvas(stream),
      observeFrames: stream.observeFrames,
      onVideoFull: () => end(true, "size"),
    });
    active.current = {
      recorder,
      threadKey: options.threadKey,
      threadRef: options.threadRef,
      context: [`${device.name} (${device.version})`, options.appId ? `in ${options.appId}` : null]
        .filter(Boolean)
        .join(" "),
      unobserve: stream.observeInput(recorder.record),
      limitTimer: setTimeout(() => end(true, "time"), DEVICE_RECORDING_MAX_MS),
      pendingActions: new Set(),
    };
    setState({ status: "recording", startedAt: Date.now() });
  };

  const endOnHide = useEffectEvent(() => end(true));
  // The view hiding or going away stops the stream it records, so it hands off now.
  useEffect(() => {
    if (!visible) return;
    return () => endOnHide();
  }, [visible]);

  return {
    state,
    start,
    stop: () => end(true),
    discard: () => end(false),
    /**
     * Logs a Tools action, which does not go through the stream, once it
     * worked. It belongs to the recording running when it started, which
     * waits for it before closing; one started before the recording is not
     * logged.
     */
    trackAction: (action: DeviceActionBody, done: Promise<boolean>) => {
      const recording = active.current;
      if (!recording) return;
      const logged = done.then(
        (succeeded) => {
          if (succeeded) {
            recording.recorder.record({
              type: "action",
              description: describeDeviceAction(action),
            });
          }
        },
        () => {},
      );
      recording.pendingActions.add(logged);
      void logged.finally(() => recording.pendingActions.delete(logged));
    },
  };
}

export type DeviceRecording = ReturnType<typeof useDeviceRecording>;

/** The canvas showing the device now: an iPhone Duo display's own while its fixed feed is live. */
function activeVideoCanvas(stream: DeviceStream): HTMLCanvasElement {
  const panel = stream.getState().duoPanel;
  return panel === 1
    ? stream.panelCanvases.cover
    : panel === 3
      ? stream.panelCanvases.inner
      : stream.canvas;
}

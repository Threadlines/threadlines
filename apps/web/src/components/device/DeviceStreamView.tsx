import type { DevicePlatform } from "@threadlines/contracts";
import { type CSSProperties, type PointerEvent, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { DeviceLoadingView } from "./DeviceLoadingView";
import { deviceScreenAspect, deviceScreenRotation, fitDeviceFrame } from "./deviceFrameLayout";
import type { DeviceStream, DeviceStreamState } from "./useDeviceStream";

/** The bezel around the screen, in px: the frame is drawn in CSS, not a model. */
const BEZEL = 6;
/** The bezel and the frame's 1px hairline. */
const FRAME_INSET = BEZEL + 1;

/**
 * The device's screen in a flat rounded frame sized to its aspect. Pointer
 * input becomes touches, keys go to the device while the screen has focus,
 * and paste types the clipboard (Android). The frame keeps the last picture
 * while a dropped stream reconnects.
 */
export function DeviceStreamView(props: {
  readonly platform: DevicePlatform;
  readonly deviceName: string;
  readonly deviceDescription: string;
  readonly stream: DeviceStream;
  readonly state: DeviceStreamState;
}) {
  const { stream, state, platform } = props;
  const { client } = stream;
  const [host, setHost] = useState({ width: 0, height: 0 });
  const hostRef = (element: HTMLDivElement | null) => {
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setHost((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  };
  const mountCanvas = (node: HTMLDivElement | null) => {
    if (!node) return;
    node.append(stream.canvas);
    return () => stream.canvas.remove();
  };

  const aspect = deviceScreenAspect(platform, state.screen);
  // The screen fits inside the host less its bezel on every side.
  const screenBox = fitDeviceFrame(
    aspect,
    Math.max(0, host.width - 2 * FRAME_INSET),
    Math.max(0, host.height - 2 * FRAME_INSET),
  );
  const rotation = deviceScreenRotation(platform, state.screen);
  const sideways = rotation === 90 || rotation === -90;
  const mediaStyle: CSSProperties = sideways
    ? {
        width: screenBox.height,
        height: screenBox.width,
        left: (screenBox.width - screenBox.height) / 2,
        top: (screenBox.height - screenBox.width) / 2,
        transform: `rotate(${rotation}deg)`,
      }
    : {
        width: screenBox.width,
        height: screenBox.height,
        ...(rotation ? { transform: `rotate(${rotation}deg)` } : {}),
      };

  const activePointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const normalizedPoint = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };
  const endPointer = (event: PointerEvent<HTMLElement>) => {
    const pointer = activePointer.current;
    if (pointer?.id !== event.pointerId) return;
    activePointer.current = null;
    const { x, y } = event.type === "lostpointercapture" ? pointer : normalizedPoint(event);
    client.sendTouch("end", x, y);
  };

  const streaming = state.status === "streaming";
  return (
    <div
      ref={hostRef}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden outline-none",
        // An overlay, so the focus ring paints above the canvas.
        "after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring",
      )}
      tabIndex={0}
      role="application"
      aria-label={platform === "ios" ? "iOS Simulator screen" : "Android Emulator screen"}
      data-testid="device-screen"
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.metaKey) return;
        // Let paste chords fire the paste event.
        if (
          (event.ctrlKey && (event.key === "v" || event.key === "V")) ||
          (event.shiftKey && event.key === "Insert")
        ) {
          return;
        }
        event.preventDefault();
        client.sendKey(event.nativeEvent, "down");
      }}
      onKeyUp={(event) => {
        if (event.target !== event.currentTarget) return;
        client.sendKey(event.nativeEvent, "up");
      }}
      onPaste={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        client.sendText(event.clipboardData.getData("text/plain"));
      }}
    >
      <div
        data-testid="device-frame"
        className="rounded-4xl border border-border bg-muted"
        style={{ padding: BEZEL }}
      >
        <div
          className="relative overflow-hidden rounded-3xl bg-background select-none"
          style={{ width: screenBox.width, height: screenBox.height }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !state.input.connected || activePointer.current !== null)
              return;
            event.currentTarget.setPointerCapture(event.pointerId);
            (event.currentTarget.closest("[role=application]") as HTMLElement | null)?.focus();
            const { x, y } = normalizedPoint(event);
            activePointer.current = { id: event.pointerId, x, y };
            client.sendTouch("begin", x, y);
          }}
          onPointerMove={(event) => {
            if (activePointer.current?.id !== event.pointerId) return;
            const { x, y } = normalizedPoint(event);
            activePointer.current = { id: event.pointerId, x, y };
            client.sendTouch("move", x, y);
          }}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onLostPointerCapture={endPointer}
        >
          <div ref={mountCanvas} className="absolute top-0 left-0" style={mediaStyle} />
          {!streaming ? (
            <div className="absolute inset-0">
              <DeviceLoadingView
                name={props.deviceName}
                description={props.deviceDescription}
                message={
                  state.status === "error"
                    ? (state.detail ?? "The stream stopped.")
                    : (state.detail ?? "Connecting to the screen…")
                }
                error={state.status === "error"}
              >
                {state.status === "error" ? (
                  <Button size="sm" variant="outline" onClick={stream.reconnect}>
                    Reconnect
                  </Button>
                ) : null}
              </DeviceLoadingView>
            </div>
          ) : null}
        </div>
      </div>
      {streaming && !state.input.connected ? (
        <p
          role="status"
          className="pointer-events-none absolute inset-x-0 bottom-1 truncate px-3 text-center text-xs text-muted-foreground"
        >
          {state.input.detail
            ? `Touch is reconnecting (${state.input.detail}).`
            : "Touch is reconnecting…"}
        </p>
      ) : null}
    </div>
  );
}

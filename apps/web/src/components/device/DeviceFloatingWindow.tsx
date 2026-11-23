import type { DeviceSummary, EnvironmentId, ThreadId } from "@threadlines/contracts";
import { threadDeviceSessions } from "@threadlines/client-runtime/deviceState";
import { GripVerticalIcon, PanelRightIcon, XIcon } from "lucide-react";
import {
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { useIsMobile } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  DEVICE_FLOAT_DEFAULT_WIDTH,
  DEVICE_FLOAT_HEADER_HEIGHT,
  DEVICE_FLOAT_MARGIN,
  type DeviceFloatEdge,
  type DeviceFloatRect,
  dragDeviceFloat,
  fitDeviceFloat,
  resizeDeviceFloat,
} from "./deviceFloatLayout";
import { deviceScreenAspect } from "./deviceFrameLayout";
import { useDevicesSupported, useDeviceState } from "./deviceState";
import { DeviceStreamView } from "./DeviceStreamView";
import {
  dockDeviceFloat,
  placeDeviceFloat,
  useDeviceFloat,
  useThreadDeviceViews,
} from "./deviceViewStore";
import { useDeviceStream } from "./useDeviceStream";

/** Below the chat header, clear of the window's right edge, when first floated. */
const DEFAULT_TOP_OFFSET = 52;

/**
 * The device floating over a thread's chat, when the phone layout is not in
 * use: the phone layout has no room for one, so there the device stays in
 * the Device tab.
 */
export function useFloatingDevice(threadKey: string | null) {
  const float = useDeviceFloat(threadKey);
  const phone = useIsMobile();
  return phone ? null : float;
}

const subscribeViewport = (listener: () => void) => {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
};
const readViewportWidth = () => window.innerWidth;
const readViewportHeight = () => window.innerHeight;

/**
 * The floating device window (docs/design/devices.md, "Float the device over
 * the chat"). Render it inside the chat column; it measures the column for
 * its first spot and draws in a layer over the app, kept inside the window.
 * It streams and takes touch while the thread is on screen, whatever the
 * right panel shows. Drag it by its title strip, resize it from its sides
 * and bottom. "Open in right panel" docks it; close dismisses the float and
 * leaves the device running.
 */
export function DeviceFloatingWindow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly onOpenInPanel: (deviceId: string) => void;
}) {
  const { environmentId, threadId, threadKey } = props;
  const float = useFloatingDevice(threadKey);
  const supported = useDevicesSupported(environmentId);
  const state = useDeviceState(environmentId, supported && float !== null);
  const views = useThreadDeviceViews(threadKey);
  // The chat column this renders in, known once mounted; the float's first spot comes from it.
  const [column, setColumn] = useState<HTMLElement | null>(null);
  const measureColumn = useCallback((node: HTMLSpanElement | null) => {
    setColumn(node?.parentElement ?? null);
  }, []);

  const session =
    float && state
      ? threadDeviceSessions(state, threadId).find((entry) => entry.deviceId === float.deviceId)
      : undefined;
  const device =
    session && state ? state.devices.find((entry) => entry.id === session.deviceId) : undefined;
  // A device closed or gone (here, by an agent, or on another client) takes its float with it.
  const gone = float !== null && state !== null && (!supported || !session);
  useEffect(() => {
    if (gone) dockDeviceFloat(threadKey);
  }, [gone, threadKey]);

  return (
    <>
      <span ref={measureColumn} hidden />
      {float && device && column
        ? createPortal(
            <FloatingDevice
              key={`${environmentId}\u0000${device.id}`}
              environmentId={environmentId}
              threadKey={threadKey}
              device={device}
              name={views.names[device.id] ?? device.name}
              position={float.position}
              width={float.width}
              column={column}
              onOpenInPanel={() => props.onOpenInPanel(device.id)}
            />,
            document.body,
          )
        : null}
    </>
  );
}

type Gesture =
  | { readonly kind: "drag"; readonly pointerId: number; readonly x: number; readonly y: number }
  | {
      readonly kind: "resize";
      readonly edge: DeviceFloatEdge;
      readonly pointerId: number;
      readonly x: number;
      readonly y: number;
    };

const EDGES: ReadonlyArray<{ readonly edge: DeviceFloatEdge; readonly className: string }> = [
  { edge: "left", className: "top-7 bottom-3 -left-1 w-2 cursor-ew-resize" },
  { edge: "right", className: "top-7 bottom-3 -right-1 w-2 cursor-ew-resize" },
  { edge: "bottom", className: "inset-x-3 -bottom-1 h-2 cursor-ns-resize" },
  { edge: "bottomLeft", className: "-bottom-1 -left-1 size-4 cursor-nesw-resize" },
  { edge: "bottomRight", className: "-right-1 -bottom-1 size-4 cursor-nwse-resize" },
];

function FloatingDevice(props: {
  readonly environmentId: EnvironmentId;
  readonly threadKey: string;
  readonly device: DeviceSummary;
  readonly name: string;
  readonly position: { readonly x: number; readonly y: number } | null;
  readonly width: number | null;
  readonly column: HTMLElement;
  readonly onOpenInPanel: () => void;
}) {
  const { device, threadKey } = props;
  const { stream, state } = useDeviceStream({
    environmentId: props.environmentId,
    platform: device.platform,
    deviceId: device.id,
    active: true,
  });
  const viewport = {
    width: useSyncExternalStore(subscribeViewport, readViewportWidth, readViewportWidth),
    height: useSyncExternalStore(subscribeViewport, readViewportHeight, readViewportHeight),
  };
  const aspect = deviceScreenAspect(device.platform, state.screen);
  // First placement: the top right of the chat column, under its header.
  const [initial] = useState(() => {
    const column = props.column.getBoundingClientRect();
    const width = props.width ?? DEVICE_FLOAT_DEFAULT_WIDTH;
    return {
      x: column.right - width - 2 * DEVICE_FLOAT_MARGIN,
      y: column.top + DEFAULT_TOP_OFFSET,
    };
  });
  // Held while a gesture runs, so the store only hears where it ends.
  const [live, setLive] = useState<DeviceFloatRect | null>(null);
  const rect =
    live ??
    fitDeviceFloat({
      position: props.position ?? initial,
      width: props.width ?? DEVICE_FLOAT_DEFAULT_WIDTH,
      aspect,
      viewport,
    });
  const gesture = useRef<{ readonly start: DeviceFloatRect; readonly gesture: Gesture } | null>(
    null,
  );

  const begin = (event: PointerEvent<HTMLElement>, next: Gesture) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { start: rect, gesture: next };
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const held = gesture.current;
    if (!held || held.gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - held.gesture.x;
    const dy = event.clientY - held.gesture.y;
    setLive(
      held.gesture.kind === "drag"
        ? dragDeviceFloat(held.start, dx, dy, aspect, viewport)
        : resizeDeviceFloat(held.start, held.gesture.edge, dx, dy, aspect, viewport),
    );
  };
  const end = (event: PointerEvent<HTMLElement>) => {
    const held = gesture.current;
    if (!held || held.gesture.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (live) {
      placeDeviceFloat(threadKey, device.id, {
        position: { x: live.x, y: live.y },
        width: live.width,
      });
    }
    setLive(null);
  };
  const gestureHandlers = {
    onPointerMove: move,
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
  };

  return (
    <section
      aria-label={`${props.name}, floating`}
      data-testid="device-float"
      className={cn(
        // Under toasts (z-45), which land in the same corner it first floats to.
        "fixed z-40 flex flex-col rounded-xl bg-popover text-popover-foreground ring-1 ring-border elevate-overlay",
        live && "select-none",
      )}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
    >
      <div
        data-testid="device-float-handle"
        className="flex shrink-0 cursor-grab touch-none items-center gap-1 pr-1 pl-1.5 active:cursor-grabbing"
        style={{ height: DEVICE_FLOAT_HEADER_HEIGHT }}
        onPointerDown={(event) =>
          begin(event, {
            kind: "drag",
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          })
        }
        {...gestureHandlers}
      >
        <GripVerticalIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        <p className="min-w-0 flex-1 truncate text-xs font-medium">{props.name}</p>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Open in right panel"
          tooltip="Open in right panel"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={props.onOpenInPanel}
        >
          <PanelRightIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close floating device"
          tooltip="Close floating device"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => dockDeviceFloat(threadKey)}
        >
          <XIcon />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 px-1.5 pb-1.5">
        <DeviceStreamView
          platform={device.platform}
          deviceName={props.name}
          deviceDescription={device.version}
          stream={stream}
          state={state}
        />
      </div>
      {EDGES.map(({ edge, className }) => (
        <div
          key={edge}
          role="presentation"
          data-device-float-edge={edge}
          className={cn("absolute touch-none", className)}
          onPointerDown={(event) =>
            begin(event, {
              kind: "resize",
              edge,
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
            })
          }
          {...gestureHandlers}
        />
      ))}
    </section>
  );
}

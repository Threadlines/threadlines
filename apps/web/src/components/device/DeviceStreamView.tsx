import type { DevicePlatform } from "@threadlines/contracts";
import {
  type DeviceAxElement,
  deviceAxElementAt,
  type DuoPanelId,
} from "@threadlines/client-runtime/device";
import { type CSSProperties, type PointerEvent, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { DeviceBodyView } from "./DeviceBody";
import { DeviceLoadingView } from "./DeviceLoadingView";
import { DeviceDuoControls, DeviceFoldControls } from "./DeviceSideControls";
import {
  bodyBox,
  DEVICE_BUTTON_DEPTH,
  deviceScreenAspect,
  deviceScreenRotation,
  duoLayout,
  duoPanelPoint,
  duoScreenRect,
  duoTouchPoint,
  fitDeviceFrame,
  fitTurned,
  type Rect,
  singleDeviceTurns,
  turnRect,
} from "./deviceFrameLayout";
import { deviceShape } from "./deviceShapes";
import { useAndroidFold } from "./useAndroidFold";
import { useDeviceAccessibility } from "./useDeviceAccessibility";
import type { DeviceStream, DeviceStreamState } from "./useDeviceStream";

/** The plain frame's bezel, in px, for a device without a known outline. */
const BEZEL = 6;
/** The bezel and the frame's 1px hairline. */
const FRAME_INSET = BEZEL + 1;
/** Room around a drawn body for its buttons and the focus ring, in px. */
const STAGE_MARGIN = 10;

/** Where the user's finger is going: a display and its gesture, or the plain screen. */
type ActivePointer = {
  readonly id: number;
  x: number;
  y: number;
  /** iPhone Duo: the display the gesture started on. */
  readonly panel?: DuoPanelId;
};

const rectStyle = (rect: Rect): CSSProperties => ({
  left: rect.x,
  top: rect.y,
  width: rect.width,
  height: rect.height,
});

/**
 * The device's live screen in a frame drawn for its model (the plain rounded
 * frame when the model is unknown). Pointer input becomes touches, keys go
 * to the device while the screen has focus, and paste types the clipboard.
 * An iPhone Duo shows the display in front, and both part way open, with its
 * stances beside it; an Android foldable gets fold and unfold. The
 * accessibility overlay draws the element frames over the screen, with the
 * label on hover, or on tap in inspect mode (where taps stay off the device).
 * The frame keeps the last picture while a dropped stream reconnects.
 */
export function DeviceStreamView(props: {
  readonly platform: DevicePlatform;
  readonly deviceName: string;
  readonly deviceDescription: string;
  readonly stream: DeviceStream;
  readonly state: DeviceStreamState;
  readonly deviceId?: string;
  /** `DeviceSummary.model`: picks the frame. */
  readonly model?: string | undefined;
  readonly physical?: boolean;
  /** Draw the accessibility element frames over the screen. */
  readonly axOverlay?: boolean;
  /** With the overlay: a tap shows the element's label instead of reaching the device. */
  readonly axInspect?: boolean;
}) {
  const { stream, state, platform } = props;
  const { client } = stream;
  const streaming = state.status === "streaming";
  // Reads beside the stream (fold, accessibility) run only while it is on screen.
  const live = streaming && state.active;
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
  const mount = (canvas: HTMLCanvasElement) => (node: HTMLDivElement | null) => {
    if (!node) return;
    node.append(canvas);
    return () => canvas.remove();
  };

  // Android foldables: the fold controls, and the frame follows the posture.
  const fold = useAndroidFold({
    transport: stream.transport,
    deviceId: props.deviceId ?? "",
    active: platform === "android" && !props.physical && !!props.deviceId && live,
    screenKey: state.screen ? `${state.screen.width}x${state.screen.height}` : null,
  });

  const aspect = deviceScreenAspect(platform, state.screen);
  const shape = deviceShape(
    { platform, model: props.model, physical: props.physical ?? false },
    { foldable: fold.fold?.supported === true, portraitAspect: Math.min(aspect, 1 / aspect) },
  );
  const screen = state.screen;
  // The Duo's own drawing needs the helper's hinge and its fixed feeds; otherwise the plain screen.
  const duo =
    shape?.kind === "duo" &&
    platform === "ios" &&
    screen?.supportsHingeAngle === true &&
    state.duoUnavailable === null &&
    state.mode === "video"
      ? { shape, screen }
      : null;
  const duoOn = duo !== null;
  useEffect(() => {
    stream.setDuoPanels(duoOn);
  }, [stream, duoOn]);

  const accessibility = useDeviceAccessibility({
    transport: stream.transport,
    platform,
    deviceId: props.deviceId ?? "",
    enabled: props.axOverlay === true && !!props.deviceId && live,
  });
  const [axFocus, setAxFocus] = useState<{
    readonly element: DeviceAxElement;
    readonly tapped: boolean;
  } | null>(null);
  const axShown = props.axOverlay === true;

  // Lay the drawing out: where it sits, how it turns, and the screen as the user sees it.
  const drawing = (() => {
    if (duo) {
      const layout = duoLayout(duo.screen, duo.shape);
      const fit = fitTurned(layout, layout.turn, host, STAGE_MARGIN + DEVICE_BUTTON_DEPTH);
      const active = duoScreenRect(layout, layout.active);
      return {
        kind: "duo" as const,
        shape: duo.shape,
        layout,
        fit,
        screenRect: active
          ? {
              x: fit.box.x + active.x * fit.scale,
              y: fit.box.y + active.y * fit.scale,
              width: active.width * fit.scale,
              height: active.height * fit.scale,
            }
          : null,
      };
    }
    if (shape?.kind === "single") {
      const body = shape.body;
      const turns = singleDeviceTurns(platform, screen, body.screen.width > body.screen.height);
      const box = bodyBox(body, turns.uprightAspect);
      const fit = fitTurned(box, turns.turn, host, STAGE_MARGIN + DEVICE_BUTTON_DEPTH);
      const visual = turnRect(box.screen, box.width, box.height, turns.turn);
      return {
        kind: "single" as const,
        body,
        box,
        turns,
        fit,
        screenRect: {
          x: fit.box.x + visual.x * fit.scale,
          y: fit.box.y + visual.y * fit.scale,
          width: visual.width * fit.scale,
          height: visual.height * fit.scale,
        },
      };
    }
    const screenBox = fitDeviceFrame(
      aspect,
      Math.max(0, host.width - 2 * FRAME_INSET),
      Math.max(0, host.height - 2 * FRAME_INSET),
    );
    return {
      kind: "plain" as const,
      screenBox,
      rotation: deviceScreenRotation(platform, screen),
      screenRect: {
        x: (host.width - screenBox.width) / 2,
        y: (host.height - screenBox.height) / 2,
        width: screenBox.width,
        height: screenBox.height,
      },
    };
  })();

  // The input layer covers the screen the user sees (the whole drawing on a Duo).
  const layerRect: Rect = drawing.kind === "duo" ? drawing.fit.box : drawing.screenRect;
  const layerOrigin = { x: layerRect.x, y: layerRect.y };

  const activePointer = useRef<ActivePointer | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  // A handoff to the other display ends a gesture there: its touches would land on the wrong screen.
  const activeDuoPanel = drawing.kind === "duo" ? drawing.layout.active : null;
  useEffect(() => {
    const pointer = activePointer.current;
    if (pointer?.panel === undefined || pointer.panel === activeDuoPanel) return;
    activePointer.current = null;
    client.sendRawTouch("end", pointer.x, pointer.y);
  }, [activeDuoPanel, client]);

  /** 0..1 of the screen the user sees, for the plain and single frames and the overlay. */
  const screenPoint = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };
  /** A point in the Duo drawing's points, from the stage the layer covers. */
  const duoPoint = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = drawing.kind === "duo" ? drawing.fit.scale : 1;
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  };
  /** The overlay's element under a pointer, in the active screen's fractions. */
  const axElementUnder = (event: PointerEvent<HTMLElement>) => {
    const rect = drawing.screenRect;
    const layer = layerRef.current?.getBoundingClientRect();
    if (!rect || !layer) return null;
    const x = (event.clientX - layer.left - (rect.x - layerOrigin.x)) / rect.width;
    const y = (event.clientY - layer.top - (rect.y - layerOrigin.y)) / rect.height;
    return deviceAxElementAt(accessibility.elements, x, y);
  };

  const begin = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || activePointer.current !== null) return;
    (event.currentTarget.closest("[role=application]") as HTMLElement | null)?.focus();
    if (axShown && props.axInspect) {
      const element = axElementUnder(event);
      setAxFocus(element ? { element, tapped: true } : null);
      return;
    }
    if (!state.input.connected) return;
    if (drawing.kind === "duo") {
      const point = duoPoint(event);
      const hit = duoTouchPoint(drawing.layout, point.x, point.y);
      // Touches on the display not in front never reach the device.
      if (!hit?.active) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointer.current = { id: event.pointerId, x: hit.x, y: hit.y, panel: hit.panel };
      client.sendRawTouch("begin", hit.x, hit.y);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = screenPoint(event);
    activePointer.current = { id: event.pointerId, x, y };
    client.sendTouch("begin", x, y);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const pointer = activePointer.current;
    if (axShown && !props.axInspect && pointer === null) {
      const element = axElementUnder(event);
      setAxFocus(element ? { element, tapped: false } : null);
    }
    if (pointer?.id !== event.pointerId) return;
    if (pointer.panel !== undefined && drawing.kind === "duo") {
      const point = duoPoint(event);
      // A drag that reaches the other display ends where it left this one: it never continues there.
      const over = duoTouchPoint(drawing.layout, point.x, point.y);
      if (over && over.panel !== pointer.panel) {
        activePointer.current = null;
        client.sendRawTouch("end", pointer.x, pointer.y);
        return;
      }
      const raw = duoPanelPoint(drawing.layout, pointer.panel, point.x, point.y);
      if (!raw) return;
      pointer.x = raw.x;
      pointer.y = raw.y;
      client.sendRawTouch("move", raw.x, raw.y);
      return;
    }
    const { x, y } = screenPoint(event);
    pointer.x = x;
    pointer.y = y;
    client.sendTouch("move", x, y);
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const pointer = activePointer.current;
    if (pointer?.id !== event.pointerId) return;
    activePointer.current = null;
    if (pointer.panel !== undefined) {
      let { x, y } = pointer;
      if (event.type !== "lostpointercapture" && drawing.kind === "duo") {
        const point = duoPoint(event);
        const raw = duoPanelPoint(drawing.layout, pointer.panel, point.x, point.y);
        if (raw) ({ x, y } = raw);
      }
      client.sendRawTouch("end", x, y);
      return;
    }
    const { x, y } = event.type === "lostpointercapture" ? pointer : screenPoint(event);
    client.sendTouch("end", x, y);
  };

  const loadingRect = drawing.kind === "duo" ? drawing.fit.box : drawing.screenRect;
  const ax = axShown && drawing.screenRect ? drawing.screenRect : null;
  // A tapped label belongs to inspect mode; the element is looked up again in each fresh read.
  const label =
    axShown && axFocus && (!axFocus.tapped || props.axInspect)
      ? (accessibility.elements.find((element) => element.id === axFocus.element.id) ?? null)
      : null;

  const loading = !streaming ? (
    <div className="absolute z-10 overflow-hidden rounded-md" style={rectStyle(loadingRect)}>
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
  ) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div
        ref={hostRef}
        className={cn(
          "relative min-h-0 min-w-0 flex-1 overflow-hidden outline-none",
          // An overlay, so the focus ring paints above the canvas.
          "after:pointer-events-none after:absolute after:inset-0 after:z-20 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring",
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
        {drawing.kind === "plain" ? (
          <div
            data-testid="device-frame"
            data-frame="plain"
            className="absolute rounded-4xl border border-border bg-muted"
            style={{
              left: drawing.screenRect.x - FRAME_INSET,
              top: drawing.screenRect.y - FRAME_INSET,
              padding: BEZEL,
            }}
          >
            <div
              className="relative overflow-hidden rounded-3xl bg-background select-none"
              style={{ width: drawing.screenBox.width, height: drawing.screenBox.height }}
            >
              <div
                ref={mount(stream.canvas)}
                className="absolute top-0 left-0"
                style={
                  drawing.rotation === 90 || drawing.rotation === -90
                    ? {
                        width: drawing.screenBox.height,
                        height: drawing.screenBox.width,
                        left: (drawing.screenBox.width - drawing.screenBox.height) / 2,
                        top: (drawing.screenBox.height - drawing.screenBox.width) / 2,
                        transform: `rotate(${drawing.rotation}deg)`,
                      }
                    : {
                        width: drawing.screenBox.width,
                        height: drawing.screenBox.height,
                        ...(drawing.rotation
                          ? { transform: `rotate(${drawing.rotation}deg)` }
                          : {}),
                      }
                }
              />
            </div>
          </div>
        ) : (
          <div
            data-testid="device-frame"
            data-frame={drawing.kind === "duo" ? "duo" : (props.model ?? "generic")}
            className="absolute"
            style={rectStyle(drawing.fit.box)}
          >
            {(() => {
              const size =
                drawing.kind === "duo"
                  ? { width: drawing.layout.width, height: drawing.layout.height }
                  : drawing.box;
              const turn = drawing.kind === "duo" ? drawing.layout.turn : drawing.turns.turn;
              const { scale, box } = drawing.fit;
              return (
                <div
                  className="absolute"
                  style={{
                    left: (box.width - size.width * scale) / 2,
                    top: (box.height - size.height * scale) / 2,
                    width: size.width * scale,
                    height: size.height * scale,
                    ...(turn ? { transform: `rotate(${turn}deg)` } : {}),
                  }}
                >
                  {drawing.kind === "duo" ? (
                    drawing.layout.panels.map((panel) => (
                      <DeviceBodyView
                        key={panel.id}
                        testId={panel.id === 1 ? "device-duo-cover" : "device-duo-inner"}
                        body={panel.id === 1 ? drawing.shape.cover : drawing.shape.inner}
                        box={panel.box}
                        scale={scale}
                        x={panel.x}
                        y={panel.y}
                        canvasTurn={panel.canvasTurn}
                        hinge={panel.id === 3}
                        inactive={panel.id !== drawing.layout.active}
                        mountCanvas={mount(
                          panel.id === 1 ? stream.panelCanvases.cover : stream.panelCanvases.inner,
                        )}
                      />
                    ))
                  ) : (
                    <DeviceBodyView
                      body={drawing.body}
                      box={drawing.box}
                      scale={scale}
                      x={0}
                      y={0}
                      canvasTurn={drawing.turns.canvasTurn}
                      mountCanvas={mount(stream.canvas)}
                    />
                  )}
                </div>
              );
            })()}
          </div>
        )}
        <div
          ref={layerRef}
          data-testid="device-touch-layer"
          className={cn(
            "absolute z-10 touch-none select-none",
            props.axInspect && axShown && "cursor-help",
          )}
          style={rectStyle(layerRect)}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerLeave={() =>
            setAxFocus((current) => (current?.tapped && props.axInspect ? current : null))
          }
          onPointerUp={end}
          onPointerCancel={end}
          onLostPointerCapture={end}
        >
          {ax ? (
            <div
              aria-hidden
              data-testid="device-ax-overlay"
              className="pointer-events-none absolute"
              style={rectStyle({
                x: ax.x - layerOrigin.x,
                y: ax.y - layerOrigin.y,
                width: ax.width,
                height: ax.height,
              })}
            >
              {accessibility.elements.map((element) => (
                <div
                  key={element.id}
                  className={cn(
                    "absolute border",
                    label === element ? "border-info bg-info/20" : "border-info/70 bg-info/8",
                  )}
                  style={{
                    left: `${element.x * 100}%`,
                    top: `${element.y * 100}%`,
                    width: `${element.width * 100}%`,
                    height: `${element.height * 100}%`,
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>
        {ax && label ? <AxLabel element={label} screen={ax} host={host} /> : null}
        {loading}
        {streaming && !state.input.connected ? (
          <p
            role="status"
            className="pointer-events-none absolute inset-x-0 bottom-1 z-10 truncate px-3 text-center text-xs text-muted-foreground"
          >
            {state.input.detail
              ? `Touch is reconnecting (${state.input.detail}).`
              : "Touch is reconnecting…"}
          </p>
        ) : axShown && accessibility.error ? (
          <p
            role="status"
            className="pointer-events-none absolute inset-x-0 bottom-1 z-10 truncate px-3 text-center text-xs text-muted-foreground"
          >
            Accessibility frames are unavailable: {accessibility.error}
          </p>
        ) : null}
      </div>
      {duo ? (
        <DeviceDuoControls
          screen={duo.screen}
          control={state.duo}
          enabled={state.input.connected}
          onCommand={(command) => client.controlDuo(command)}
        />
      ) : platform === "android" ? (
        <DeviceFoldControls fold={fold} enabled={streaming} />
      ) : null}
    </div>
  );
}

/** The element's label and role, beside its frame, kept inside the panel. */
function AxLabel(props: {
  readonly element: DeviceAxElement;
  readonly screen: Rect;
  readonly host: { readonly width: number; readonly height: number };
}) {
  const { element, screen } = props;
  const top = screen.y + element.y * screen.height;
  const bottom = top + element.height * screen.height;
  const left = screen.x + element.x * screen.width;
  const above = top > 28;
  const text = element.label || "No label";
  return (
    <div
      role="status"
      data-testid="device-ax-label"
      className="pointer-events-none absolute z-20 max-w-60 truncate rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground elevate-popover"
      style={{
        left: Math.max(4, Math.min(left, props.host.width - 244)),
        ...(above ? { bottom: props.host.height - top + 4 } : { top: bottom + 4 }),
      }}
    >
      <span className={element.label ? undefined : "text-muted-foreground"}>{text}</span>
      {element.role ? (
        <span className="ml-1.5 font-mono text-[10.5px] text-muted-foreground">{element.role}</span>
      ) : null}
    </div>
  );
}

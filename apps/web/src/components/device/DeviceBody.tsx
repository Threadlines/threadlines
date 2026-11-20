import type { CSSProperties, ReactNode } from "react";

import { type BodyBox, DEVICE_BUTTON_DEPTH, type QuarterTurn } from "./deviceFrameLayout";
import type { DeviceBody } from "./deviceShapes";

/** The metal band's width, in points; the glass inside it is the bezel. */
const BAND = 2.5;
/** The band and the side buttons: a step off the panel in both themes, flat. */
const BAND_COLOR = "color-mix(in oklab, var(--foreground) 24%, var(--background))";
/** The hinge's knuckles on a Duo's band. */
const HINGE_COLOR = "color-mix(in oklab, var(--foreground) 38%, var(--background))";

const px = (value: number) => `${value}px`;

const cornerRadii = (radii: readonly number[], scale: number, grow: number) =>
  radii.map((radius) => px(Math.max(0, radius + grow) * scale)).join(" ");

/**
 * One device body drawn upright at `scale` px per point: the band, the black
 * glass, side buttons, the screen with the stream in it, and whatever the
 * hardware puts over the screen (Dynamic Island, notch, punch hole, a fold
 * line). Flat: no shadows, no gloss, theme colors for everything but the glass.
 */
export function DeviceBodyView(props: {
  readonly body: DeviceBody;
  readonly box: BodyBox;
  readonly scale: number;
  /** Top left in the drawing, in points. */
  readonly x: number;
  readonly y: number;
  /** The stream's turn inside the screen. */
  readonly canvasTurn: QuarterTurn;
  /** Mounts the stream's canvas. */
  readonly mountCanvas: (node: HTMLDivElement | null) => (() => void) | undefined;
  /** iPhone Duo: draw the knuckles of a hinge down the middle. */
  readonly hinge?: boolean;
  /** A display not in front: its last picture, dimmed. */
  readonly inactive?: boolean;
  readonly children?: ReactNode;
  readonly testId?: string;
}) {
  const { body, box, scale, mountCanvas } = props;
  const { bezel } = body;
  const outer = Math.min(bezel.top, bezel.right, bezel.bottom, bezel.left);
  // The body's corners follow the screen's, out by the bezel; a square screen keeps a phone's rounding.
  const bodyRadii = body.screenRadius.map((radius) =>
    radius > 0 ? radius + outer : Math.min(61, outer * 2.2),
  );
  const screen = box.screen;
  const sideways = props.canvasTurn === 90 || props.canvasTurn === -90;
  const mediaStyle: CSSProperties = sideways
    ? {
        width: screen.height * scale,
        height: screen.width * scale,
        left: ((screen.width - screen.height) * scale) / 2,
        top: ((screen.height - screen.width) * scale) / 2,
        transform: `rotate(${props.canvasTurn}deg)`,
      }
    : {
        width: screen.width * scale,
        height: screen.height * scale,
        ...(props.canvasTurn ? { transform: `rotate(${props.canvasTurn}deg)` } : {}),
      };
  const depth = DEVICE_BUTTON_DEPTH * scale;
  const cutout = body.cutout;
  return (
    <div
      data-testid={props.testId}
      className="absolute"
      style={{
        left: props.x * scale,
        top: props.y * scale,
        width: box.width * scale,
        height: box.height * scale,
      }}
    >
      {body.buttons.map((button) => {
        const along = button.offset * scale;
        const length = button.length * scale;
        const style: CSSProperties =
          button.edge === "top"
            ? { left: along, top: -depth, width: length, height: depth + scale * 2 }
            : {
                top: along,
                height: length,
                width: depth + scale * 2,
                ...(button.edge === "left" ? { left: -depth } : { right: -depth }),
              };
        return (
          <span
            key={`${button.edge}-${button.offset}`}
            aria-hidden
            className="absolute rounded-[1.5px]"
            style={{ ...style, background: BAND_COLOR }}
          />
        );
      })}
      <div
        className="absolute inset-0"
        style={{ borderRadius: cornerRadii(bodyRadii, scale, 0), background: BAND_COLOR }}
      />
      <div
        className="absolute bg-black"
        style={{
          inset: Math.max(1, BAND * scale),
          borderRadius: cornerRadii(bodyRadii, scale, -BAND),
        }}
      />
      {props.hinge ? (
        <>
          <span
            aria-hidden
            className="absolute top-0 -translate-x-1/2"
            style={{
              left: "50%",
              width: 6 * scale,
              height: bezel.top * scale,
              background: HINGE_COLOR,
            }}
          />
          <span
            aria-hidden
            className="absolute bottom-0 -translate-x-1/2"
            style={{
              left: "50%",
              width: 6 * scale,
              height: bezel.bottom * scale,
              background: HINGE_COLOR,
            }}
          />
        </>
      ) : null}
      <div
        className="absolute overflow-hidden bg-black select-none"
        style={{
          left: screen.x * scale,
          top: screen.y * scale,
          width: screen.width * scale,
          height: screen.height * scale,
          borderRadius: cornerRadii(body.screenRadius, scale, 0),
        }}
      >
        <div
          ref={mountCanvas}
          className={props.inactive ? "absolute top-0 left-0 opacity-45" : "absolute top-0 left-0"}
          style={mediaStyle}
        />
        {body.crease ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/12"
          />
        ) : null}
        {cutout?.kind === "island" ? (
          <span
            aria-hidden
            data-testid="device-island"
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full bg-black"
            style={{
              top: cutout.top * scale,
              width: cutout.width * scale,
              height: cutout.height * scale,
            }}
          />
        ) : cutout?.kind === "notch" ? (
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 bg-black"
            style={{
              width: cutout.width * scale,
              height: cutout.height * scale,
              borderRadius: `0 0 ${px(cutout.height * 0.62 * scale)} ${px(cutout.height * 0.62 * scale)}`,
            }}
          />
        ) : cutout?.kind === "punch" ? (
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 rounded-full bg-black"
            style={{
              top: cutout.top * scale,
              width: cutout.diameter * scale,
              height: cutout.diameter * scale,
            }}
          />
        ) : null}
        {props.children}
      </div>
      {body.homeButton ? (
        <span
          aria-hidden
          className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            top: (screen.y + screen.height + bezel.bottom / 2) * scale,
            width: body.homeButton * scale,
            height: body.homeButton * scale,
            border: `${Math.max(1, 2.5 * scale)}px solid ${BAND_COLOR}`,
          }}
        />
      ) : null}
    </div>
  );
}

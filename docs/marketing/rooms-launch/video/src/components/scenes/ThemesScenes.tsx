// The themes scenes (0.10.0). The art is the point, so the camera shows the
// whole window whenever a theme arrives, and closes in only on what you do:
// typing, the offer and its Try it, the Glass slider, the Share dialog.
import type React from "react";
import { AbsoluteFill } from "remotion";
import { useFrame } from "../../frame";
import type { Camera, CameraKey } from "../../camera";
import type { Layout } from "../../layout";
import { frameAt, type Plan, takeTimeAt } from "../../plan";
import type { SceneSpec } from "../../scenes";
import { MONTAGE, MONTAGE_LEAD } from "../../scenes-themes";
import { full, mark, pad, type Rect, rectAt, rectOf, type Take, union } from "../../takes";
import { Caption } from "../Caption";
import { Note, presence, Spotlight } from "../overlays";
import { Stage } from "../Stage";
import { Clicks, DOTS, rowsFocus, tiltIn } from "./shared";

type SceneProps = { layout: Layout; plan: Plan; spec: SceneSpec };

/** A part of the window, as fractions of it. */
const part = (take: Take, x: number, y: number, w: number, h: number): Rect => ({
  x: take.width * x,
  y: take.height * y,
  w: take.width * w,
  h: take.height * h,
});

/** The message box while you type, with the chat's last rows above it. */
const typingFocus = (take: Take, t: number): Rect => pad(rectOf(take, "composer", t), 60, 320);

/** The strip of themes and the message box under it. */
const stripFocus = (take: Take, t: number): Rect =>
  pad(union(rectOf(take, "strip", t), rectOf(take, "composer", t)), 90, 150);

/** When a tracked element first showed. */
const firstSeen = (take: Take, name: string, fallback: number): number =>
  take.tracks[name]?.[0]?.[0] ?? fallback;

/**
 * A name at the foot of the window as framed, wherever the camera is: a
 * theme's name in the opening, Honu Lagoon's credit while it shows.
 */
const FootNote: React.FC<{
  camera: Camera;
  text: string;
  size: number;
  at: number;
  out?: number;
}> = ({ camera, text, size, at, out }) => (
  <Note
    side="above"
    anchor={{
      x: camera.visible.x + camera.visible.w * 0.06,
      y: camera.visible.y + camera.visible.h * 0.95,
      w: camera.visible.w * 0.3,
      h: 4,
    }}
    clip={camera.visible}
    text={text}
    size={size}
    at={at}
    out={out}
    dot={DOTS.codex}
  />
);

const HONU_CREDIT = "Honu Lagoon, after @handsher_NGU";

/**
 * 01: the new-thread screen, whole, with each starter's art behind it in
 * turn. The camera doesn't move: the cuts are the themes changing. Each
 * theme's name shows at the foot while it plays.
 */
export const LiveArt: React.FC<SceneProps> = ({ layout, plan, spec }) => {
  const frame = useFrame();
  const take = plan.take;
  return (
    <AbsoluteFill>
      <Stage
        plan={plan}
        keys={[{ at: 0, focus: full(take) }]}
        options={{ stage: layout.stage }}
        radius={layout.windowRadius}
        float={layout.bare ? undefined : tiltIn(frame)}
        renderOverlay={(camera) =>
          MONTAGE.map(([id, name, seconds]) => {
            const from = mark(take, `art-${id}-in`) + MONTAGE_LEAD;
            return (
              <FootNote
                key={id}
                camera={camera}
                text={name}
                size={layout.chip}
                at={frameAt(plan, from) + 3}
                out={frameAt(plan, from + seconds) - 4}
              />
            );
          })
        }
      />
      <Caption layout={layout} kicker={spec.kicker} caption={spec.caption} />
    </AbsoluteFill>
  );
};

/**
 * 02: in a thread, close on the message box as you type /theme. The strip
 * opens and the camera widens to the lower part of the window, so each key
 * press shows twice: the highlight moving along the strip and the art
 * changing around it. Enter keeps Lantern Lake and the camera pulls back.
 */
export const TypeTheme: React.FC<SceneProps> = ({ layout, plan, spec }) => {
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);

  const keys: CameraKey[] = [
    { at: 0, focus: typingFocus(take, m("slash")) },
    { at: f("strip") - 4, focus: stripFocus(take, m("strip") + 0.8), glide: 26 },
    { at: f("theme-aurora") - 8, focus: part(take, 0.1, 0.26, 0.8, 0.74), glide: 30 },
    { at: f("kept-theme") + 2, focus: full(take), glide: 32 },
  ];

  return (
    <AbsoluteFill>
      <Stage
        plan={plan}
        keys={keys}
        options={{ stage: layout.stage }}
        radius={layout.windowRadius}
        renderOverlay={(camera) => <Clicks plan={plan} camera={camera} />}
      />
      <Caption layout={layout} kicker={spec.kicker} caption={spec.caption} />
    </AbsoluteFill>
  );
};

/**
 * 03: you ask for a theme from a page you link; the camera closes on the
 * agent's offer and its Try it button, then pulls back as Honu Lagoon fills
 * the window. Its credit stays on screen while it shows.
 */
export const AskForYourOwn: React.FC<SceneProps> = ({ layout, plan, spec }) => {
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);
  const sent = firstSeen(take, "ask-msg", m("ask") + 5);
  const offered = m("offered") + 0.6;

  const keys: CameraKey[] = [
    { at: 0, focus: full(take) },
    { at: 4, focus: typingFocus(take, m("ask") + 0.5), glide: 24 },
    {
      at: frameAt(plan, sent) + 2,
      focus: rowsFocus(rectOf(take, "ask-msg", offered), rectOf(take, "theme-reply", offered)),
      glide: 30,
    },
    { at: f("trying") - 4, focus: full(take), glide: 34 },
  ];

  return (
    <AbsoluteFill>
      <Stage
        plan={plan}
        keys={keys}
        options={{ stage: layout.stage }}
        radius={layout.windowRadius}
        renderOverlay={(camera) => (
          <>
            <FootNote camera={camera} text={HONU_CREDIT} size={layout.chip} at={f("trying") + 24} />
            <Clicks plan={plan} camera={camera} />
          </>
        )}
      />
      <Caption layout={layout} kicker={spec.kicker} caption={spec.caption} />
    </AbsoluteFill>
  );
};

/**
 * 04: you ask for bolder text; the camera closes on the new version, offered
 * as "Updated", then pulls back for the bar at the top: Update replaces the
 * copy you kept.
 */
export const MakeItYours: React.FC<SceneProps> = ({ layout, plan, spec }) => {
  const frame = useFrame();
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);
  const t = takeTimeAt(plan, frame);
  const sent = firstSeen(take, "tweak-msg", m("tweak") + 4);
  const offered = m("offered-update") + 0.6;
  const rows = rowsFocus(rectOf(take, "tweak-msg", offered), rectOf(take, "tweak-reply", offered));

  const keys: CameraKey[] = [
    { at: 0, focus: full(take) },
    { at: 4, focus: typingFocus(take, m("tweak") + 0.5), glide: 24 },
    { at: frameAt(plan, sent) + 2, focus: rows, glide: 30 },
    { at: f("trying-update") - 2, focus: full(take), glide: 30 },
  ];

  return (
    <AbsoluteFill>
      <Stage
        plan={plan}
        keys={keys}
        options={{ stage: layout.stage }}
        radius={layout.windowRadius}
        renderOverlay={(camera) => {
          const bar = rectAt(take, "trial-bar", t);
          return (
            <>
              {/* Not while you type: it would sit on the message box. */}
              <FootNote
                camera={camera}
                text={HONU_CREDIT}
                size={layout.chip}
                at={f("trying-update") + 8}
              />
              {bar ? (
                <Spotlight
                  clip={camera.visible}
                  target={camera.toScreen(bar)}
                  amount={0.3 * presence(frame, f("trying-update") + 8, 14, f("updated") + 4)}
                  radius={12}
                />
              ) : null}
              <Clicks plan={plan} camera={camera} />
            </>
          );
        }}
      />
      <Caption layout={layout} kicker={spec.kicker} caption={spec.caption} />
    </AbsoluteFill>
  );
};

/**
 * 05: /theme again. The camera frames the strip with the chat above it while
 * the Glass slider goes most of the way to Clear, then pulls back to the
 * whole window with the lagoon showing through.
 */
export const SetTheGlass: React.FC<SceneProps> = ({ layout, plan, spec }) => {
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);

  const keys: CameraKey[] = [
    { at: 0, focus: full(take) },
    { at: f("glass-strip") - 4, focus: part(take, 0.12, 0.3, 0.76, 0.7), glide: 30 },
    { at: f("glass-clear") + 8, focus: full(take), glide: 36 },
  ];

  return (
    <AbsoluteFill>
      <Stage
        plan={plan}
        keys={keys}
        options={{ stage: layout.stage }}
        radius={layout.windowRadius}
        renderOverlay={(camera) => (
          <>
            <FootNote
              camera={camera}
              text={HONU_CREDIT}
              size={layout.chip}
              at={f("glass-clear") + 30}
            />
            <Clicks plan={plan} camera={camera} />
          </>
        )}
      />
      <Caption layout={layout} kicker={spec.kicker} caption={spec.caption} />
    </AbsoluteFill>
  );
};

/**
 * 06: Settings › Appearance. Your own theme's menu has Share to Showcase;
 * the camera closes on the dialog while you add a credit and share, and
 * pulls back to the thread wearing that theme.
 */
export const ShareIt: React.FC<SceneProps> = ({ layout, plan, spec }) => {
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);
  const themes = part(take, 0.3, 0.02, 0.58, 0.78);
  const dialog = pad(rectOf(take, "share-dialog", m("share-dialog") + 0.5), 260, 70);

  const keys: CameraKey[] = [
    { at: 0, focus: themes },
    { at: f("share-dialog") - 8, focus: dialog, glide: 28 },
    { at: f("shared", 1.6) - 2, focus: full(take), glide: 30 },
  ];

  return (
    <AbsoluteFill>
      <Stage
        plan={plan}
        keys={keys}
        options={{ stage: layout.stage }}
        radius={layout.windowRadius}
        renderOverlay={(camera) => (
          <>
            <FootNote
              camera={camera}
              text="Speedcube"
              size={layout.chip}
              at={f("back", 0.6) + 10}
            />
            <Clicks plan={plan} camera={camera} />
          </>
        )}
      />
      <Caption layout={layout} kicker={spec.kicker} caption={spec.caption} />
    </AbsoluteFill>
  );
};

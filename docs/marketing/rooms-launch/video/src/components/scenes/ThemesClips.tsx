// Square clips cut from the themes story's wide take, for X: the starters'
// opening on its own, and the Honu Lagoon scenes (ask, try, the Glass
// slider). The window is wider than a square frame, so each shot frames the
// part of it that matters: the middle of the new-thread screen with art on
// both sides, the message box while you type, the strip while the slider moves.
import type React from "react";
import { AbsoluteFill } from "remotion";
import type { Camera, CameraKey } from "../../camera";
import type { Layout } from "../../layout";
import { frameAt, type Plan } from "../../plan";
import type { SceneSpec } from "../../scenes";
import { MONTAGE, MONTAGE_LEAD } from "../../scenes-themes";
import { mark, pad, type Rect, rectOf, type Take, union } from "../../takes";
import { Caption } from "../Caption";
import { Note } from "../overlays";
import { Stage } from "../Stage";
import { Clicks, DOTS } from "./shared";

/** `opening`: the clip's first scene, whose caption is there from the first frame. */
type SceneProps = { layout: Layout; plan: Plan; spec: SceneSpec; opening?: boolean };

/**
 * The window from just right of the thread list to its right edge: the chat
 * (or the new-thread screen's middle) centred, with art on both sides.
 */
const windowFocus = (take: Take): Rect => {
  const width = take.height * 1.2245;
  return { x: take.width - width - take.width * 0.054, y: 0, w: width, h: take.height };
};

/** The start of the message box, where your words are, with the chat above. */
const typingFocus = (take: Take, t: number): Rect => {
  const composer = rectOf(take, "composer", t);
  return { x: composer.x - 40, y: composer.y + composer.h + 60 - 1274, w: 1560, h: 1274 };
};

/** The strip's start (its Glass slider), the message box under it, the chat above. */
const sliderFocus = (take: Take, t: number): Rect => {
  const strip = rectOf(take, "strip", t);
  const composer = rectOf(take, "composer", t);
  return { x: strip.x - 60, y: composer.y + composer.h + 60 - 1274, w: 1560, h: 1274 };
};

const Foot: React.FC<{ camera: Camera; text: string; size: number; at: number; out?: number }> = ({
  camera,
  text,
  size,
  at,
  out,
}) => (
  <Note
    side="above"
    anchor={{
      x: camera.visible.x + camera.visible.w * 0.06,
      y: camera.visible.y + camera.visible.h * 0.95,
      w: camera.visible.w * 0.4,
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

/** The starters, each named at the foot. The camera doesn't move. */
export const LiveArtSquare: React.FC<SceneProps> = ({ layout, plan, spec, opening }) => {
  const take = plan.take;
  return (
    <AbsoluteFill>
      <Stage
        plan={plan}
        keys={[{ at: 0, focus: windowFocus(take) }]}
        options={{ stage: layout.stage }}
        radius={layout.windowRadius}
        renderOverlay={(camera) =>
          MONTAGE.map(([id, name, seconds], index) => {
            const from = mark(take, `art-${id}-in`) + MONTAGE_LEAD;
            return (
              <Foot
                key={id}
                camera={camera}
                text={name}
                size={layout.chip}
                // The first name is there from the first frame: X shows that frame as the picture.
                at={index === 0 ? -30 : frameAt(plan, from) + 3}
                out={frameAt(plan, from + seconds) - 4}
              />
            );
          })
        }
      />
      <Caption layout={layout} kicker={spec.kicker} caption={spec.caption} settled={opening} />
    </AbsoluteFill>
  );
};

/**
 * The Honu clip's opening: a moment of the finished theme, the lagoon behind
 * the chat, before the clip shows how it was made. X shows a video's first
 * frame as its picture, and this is the one worth showing.
 */
export const HonuOpenSquare: React.FC<SceneProps> = ({ layout, plan, spec }) => (
  <AbsoluteFill>
    <Stage
      plan={plan}
      keys={[{ at: 0, focus: windowFocus(plan.take) }]}
      options={{ stage: layout.stage }}
      radius={layout.windowRadius}
      renderOverlay={(camera) => (
        <Foot camera={camera} text={HONU_CREDIT} size={layout.chip} at={-30} />
      )}
    />
    <Caption layout={layout} kicker={spec.kicker} caption={spec.caption} settled />
  </AbsoluteFill>
);

/** You ask for a theme; the offer and Try it; Honu Lagoon fills the window. */
export const AskSquare: React.FC<SceneProps> = ({ layout, plan, spec, opening }) => {
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);
  const sent = take.tracks["ask-msg"]?.[0]?.[0] ?? m("ask") + 5;
  const offered = m("offered") + 0.6;

  const keys: CameraKey[] = [
    { at: 0, focus: typingFocus(take, m("ask") + 0.5) },
    {
      at: frameAt(plan, sent) + 2,
      // The whole rows: your message ends at the right, Try it sits there too.
      focus: pad(
        union(rectOf(take, "ask-msg", offered), rectOf(take, "theme-reply", offered)),
        40,
        200,
      ),
      glide: 30,
    },
    { at: f("trying") - 4, focus: windowFocus(take), glide: 34 },
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
            <Foot camera={camera} text={HONU_CREDIT} size={layout.chip} at={f("trying") + 24} />
            <Clicks plan={plan} camera={camera} />
          </>
        )}
      />
      <Caption layout={layout} kicker={spec.kicker} caption={spec.caption} settled={opening} />
    </AbsoluteFill>
  );
};

/** The Glass slider goes most of the way to Clear, and the lagoon comes through. */
export const GlassSquare: React.FC<SceneProps> = ({ layout, plan, spec, opening }) => {
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);

  const keys: CameraKey[] = [
    { at: 0, focus: windowFocus(take) },
    { at: f("glass-strip") - 4, focus: sliderFocus(take, m("glass-strip") + 0.8), glide: 30 },
    { at: f("glass-clear") + 8, focus: windowFocus(take), glide: 36 },
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
            <Foot camera={camera} text={HONU_CREDIT} size={layout.chip} at={-30} />
            <Clicks plan={plan} camera={camera} />
          </>
        )}
      />
      <Caption layout={layout} kicker={spec.kicker} caption={spec.caption} settled={opening} />
    </AbsoluteFill>
  );
};

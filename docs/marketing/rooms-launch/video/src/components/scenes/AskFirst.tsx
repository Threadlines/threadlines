import type React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { CameraKey } from "../../camera";
import type { Layout } from "../../layout";
import { frameAt, type Plan, takeTimeAt } from "../../plan";
import type { SceneSpec } from "../../scenes";
import { mark, pad, rectAt, rectOf, union } from "../../takes";
import { Caption } from "../Caption";
import { Note, presence, Spotlight } from "../overlays";
import { Stage } from "../Stage";
import { Clicks, DOTS, tiltIn } from "./shared";
import { questionFocus } from "./threads-shared";

/**
 * 01: the window settles in on your question and Opus's plan; the request
 * box docks above the message box and the camera closes on it ("Opus asks
 * first"), lit softly while its three threads are read; you click Start and
 * the camera pulls back to the chat, where "Started 3 threads" shows a live
 * dot for each.
 */
export const AskFirst: React.FC<{ layout: Layout; plan: Plan; spec: SceneSpec }> = ({
  layout,
  plan,
  spec,
}) => {
  const frame = useCurrentFrame();
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);
  const t = takeTimeAt(plan, frame);

  const asked = m("asked") + 0.6;
  const started = m("started") + 1.2;
  const keys: CameraKey[] = [
    { at: 0, focus: questionFocus(take, m("open") + 0.2) },
    // Opus's line and the request under it. The message box grows to hold the
    // request, so framing it frames both.
    {
      at: f("asked") - 8,
      focus: pad(union(rectOf(take, "opus-plan", asked), rectOf(take, "composer", asked)), 30),
      glide: 34,
    },
    { at: f("started") + 4, focus: questionFocus(take, started), glide: 34 },
  ];

  return (
    <AbsoluteFill>
      <Stage
        plan={plan}
        keys={keys}
        options={{ stage: layout.stage }}
        radius={layout.windowRadius}
        float={layout.bare ? undefined : tiltIn(frame)}
        renderOverlay={(camera) => {
          const request = rectAt(take, "request-box", t);
          return (
            <>
              {request ? (
                <Spotlight
                  clip={camera.visible}
                  target={camera.toScreen(request)}
                  amount={0.4 * presence(frame, f("asked") + 6, 14, f("start") + 4)}
                />
              ) : null}
              {request ? (
                // Over the box's right half: the rows above it end well short of there.
                <Note
                  side="above"
                  anchor={camera.toScreen({
                    ...request,
                    x: request.x + request.w * 0.55,
                    w: request.w * 0.45,
                  })}
                  clip={camera.visible}
                  text="Opus asks first"
                  size={layout.chip}
                  at={f("asked") + 10}
                  out={f("start") + 2}
                  dot={DOTS.opus}
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

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
import { Clicks, DOTS, threadBottom, tiltIn } from "./shared";

/**
 * 01: the window settles in on the user's report of the bug and Opus's first
 * answer ("Opus can't find the cause"); the camera closes on the model picker, which the
 * rest of the app dims around while GPT-6.1-Sol is added; then it settles on
 * the message box while the user points it back at Opus ("Sending to Opus")
 * and asks the two to work together.
 */
export const AddAgent: React.FC<{ layout: Layout; plan: Plan; spec: SceneSpec }> = ({
  layout,
  plan,
  spec,
}) => {
  const frame = useCurrentFrame();
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);
  const t = takeTimeAt(plan, frame);

  const pickerFocus = pad(
    union(rectOf(take, "picker", m("codex") + 0.5), rectOf(take, "trigger", m("codex") + 0.5)),
    60,
  );
  // The opening frames the request down to the message box, so the earlier
  // finished work above it is out of frame.
  const reported = m("reported") + 0.2;
  const keys: CameraKey[] = [
    {
      at: 0,
      focus: pad(union(rectOf(take, "prompt", reported), rectOf(take, "composer", reported)), 30),
    },
    { at: f("picker-open") - 14, focus: pickerFocus, glide: 34 },
    { at: f("added") + 8, focus: threadBottom(take, m("team-mention") + 1, layout), glide: 34 },
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
          const picker = rectAt(take, "picker", t);
          const reportEnd = rectAt(take, "report-end", t);
          const trigger = rectAt(take, "trigger", t);
          return (
            <>
              {reportEnd ? (
                <Note
                  anchor={camera.toScreen(reportEnd)}
                  clip={camera.visible}
                  text="Opus can't find the cause"
                  size={layout.chip}
                  at={f("reported") + 4}
                  out={f("add")}
                  dot={DOTS.opus}
                />
              ) : null}
              {trigger ? (
                <Note
                  side="above"
                  anchor={camera.toScreen(trigger)}
                  clip={camera.visible}
                  text="Sending to Opus"
                  size={layout.chip}
                  at={f("team-recipient") + 2}
                  out={f("team-sent")}
                  dot={DOTS.opus}
                />
              ) : null}
              {picker ? (
                <Spotlight
                  clip={camera.visible}
                  target={camera.toScreen(picker)}
                  amount={0.8 * presence(frame, f("picker-open") + 2, 12, f("added") - 2)}
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

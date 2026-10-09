import type React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { CameraKey } from "../../camera";
import type { Layout } from "../../layout";
import { frameAt, type Plan, takeTimeAt } from "../../plan";
import type { SceneSpec } from "../../scenes";
import { mark, rectAt, rectOf } from "../../takes";
import { Caption } from "../Caption";
import { Note, presence, Spotlight } from "../overlays";
import { Stage } from "../Stage";
import { DOTS, rowsFocus } from "./shared";
import { newestFocus } from "./threads-shared";

/**
 * 03: the camera rests on the newest rows of Opus's thread while the answers
 * land there one by one, each under its thread's name, and Opus says one
 * short line after each. The third names the cause: it is lit softly and
 * labelled ("Sol's thread finds the cause"). Opus fixes it, and the camera
 * settles on that answer and the result.
 */
export const AnswersComeBack: React.FC<{ layout: Layout; plan: Plan; spec: SceneSpec }> = ({
  layout,
  plan,
  spec,
}) => {
  const frame = useCurrentFrame();
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);
  const t = takeTimeAt(plan, frame);

  const settled = m("end") - 0.5;
  const keys: CameraKey[] = [
    { at: 0, focus: newestFocus(take, m("back") + 0.3, layout) },
    {
      at: f("opus-done") + 2,
      focus: rowsFocus(
        rectOf(take, "report-queries", settled),
        rectOf(take, "opus-done-text", settled),
      ),
      glide: 30,
    },
  ];

  return (
    <AbsoluteFill>
      <Stage
        plan={plan}
        keys={keys}
        options={{ stage: layout.stage }}
        radius={layout.windowRadius}
        renderOverlay={(camera) => {
          const cause = rectAt(take, "report-queries", t);
          const causeEnd = rectAt(take, "report-queries-end", t);
          const result = rectAt(take, "opus-done-text", t);
          const causeOut = f("found", 1.2);
          return (
            <>
              {cause ? (
                <Spotlight
                  clip={camera.visible}
                  target={camera.toScreen(cause)}
                  amount={0.35 * presence(frame, f("report-queries") + 6, 16, causeOut)}
                />
              ) : null}
              {result ? (
                <Spotlight
                  clip={camera.visible}
                  target={camera.toScreen(result)}
                  amount={0.3 * presence(frame, f("opus-done") + 2, 16)}
                />
              ) : null}
              {causeEnd ? (
                <Note
                  anchor={camera.toScreen(causeEnd)}
                  clip={camera.visible}
                  text="Sol's thread finds the cause"
                  size={layout.chip}
                  at={f("report-queries") + 12}
                  out={causeOut}
                  dot={DOTS.codex}
                />
              ) : null}
            </>
          );
        }}
      />
      <Caption layout={layout} kicker={spec.kicker} caption={spec.caption} />
    </AbsoluteFill>
  );
};

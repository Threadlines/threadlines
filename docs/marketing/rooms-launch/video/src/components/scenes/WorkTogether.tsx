import type React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { CameraKey } from "../../camera";
import type { Layout } from "../../layout";
import { frameAt, type Plan, takeTimeAt } from "../../plan";
import type { SceneSpec } from "../../scenes";
import { mark, type Rect, rectAt, rectOf, type Take } from "../../takes";
import { Caption } from "../Caption";
import { Note, presence, Spotlight } from "../overlays";
import { Stage } from "../Stage";
import { DOTS, rowsFocus, threadBottom } from "./shared";

/** Opus's question to Astra, Astra's answer, and Opus's result, once Opus is done. */
export const resultFocus = (take: Take): Rect => {
  const done = mark(take, "opus-done") + 1;
  return rowsFocus(rectOf(take, "opus-ask", done), rectOf(take, "opus-done-text", done));
};

/**
 * 02: Opus asks Astra an open question and keeps reading while Astra
 * answers; Astra's answer holds, lit softly; Opus reproduces the double charge
 * and fixes it. One label at a time names each step ("Opus asks Astra",
 * "Astra finds the cause", "Opus fixes it"), pinned after the line it is
 * about; the result is lit softly once it lands. The camera frames your
 * request and the exchange, follows Opus's work, and settles on question,
 * answer and result.
 */
export const WorkTogether: React.FC<{ layout: Layout; plan: Plan; spec: SceneSpec }> = ({
  layout,
  plan,
  spec,
}) => {
  const frame = useCurrentFrame();
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);
  const t = takeTimeAt(plan, frame);

  const answered = m("answer-published") + 0.5;
  const fixed = m("fixed");
  const keys: CameraKey[] = [
    { at: 0, focus: threadBottom(take, m("team-sent") + 0.3, layout) },
    {
      at: f("asked") - 6,
      focus: rowsFocus(rectOf(take, "team-msg", answered), rectOf(take, "working", answered)),
      glide: 36,
    },
    {
      at: f("repro") + 6,
      focus: rowsFocus(rectOf(take, "astra-answer", fixed), rectOf(take, "working", fixed)),
      glide: 40,
    },
    { at: f("opus-done") + 2, focus: resultFocus(take), glide: 30 },
  ];

  return (
    <AbsoluteFill>
      <Stage
        plan={plan}
        keys={keys}
        options={{ stage: layout.stage }}
        radius={layout.windowRadius}
        renderOverlay={(camera) => {
          const askEnd = rectAt(take, "ask-end", t);
          const answer = rectAt(take, "astra-answer", t);
          const answerEnd = rectAt(take, "answer-end", t);
          const reproEnd = rectAt(take, "repro-end", t);
          const result = rectAt(take, "opus-done-text", t);
          const answerOut = f("repro", 2.2);
          return (
            <>
              {answer ? (
                <Spotlight
                  clip={camera.visible}
                  target={camera.toScreen(answer)}
                  amount={0.35 * presence(frame, f("answer-published") + 2, 16, answerOut)}
                />
              ) : null}
              {result ? (
                <Spotlight
                  clip={camera.visible}
                  target={camera.toScreen(result)}
                  amount={0.3 * presence(frame, f("opus-done") + 2, 16)}
                />
              ) : null}
              {askEnd ? (
                <Note
                  anchor={camera.toScreen(askEnd)}
                  clip={camera.visible}
                  text="Opus asks Astra"
                  size={layout.chip}
                  at={f("asked") + 8}
                  out={f("answer-published") - 2}
                  dot={DOTS.opus}
                />
              ) : null}
              {answerEnd ? (
                <Note
                  anchor={camera.toScreen(answerEnd)}
                  clip={camera.visible}
                  text="Astra finds the cause"
                  size={layout.chip}
                  at={f("answer-published") + 4}
                  out={answerOut}
                  dot={DOTS.codex}
                />
              ) : null}
              {reproEnd ? (
                <Note
                  anchor={camera.toScreen(reproEnd)}
                  clip={camera.visible}
                  text="Opus fixes it"
                  size={layout.chip}
                  at={f("repro", 2.4)}
                  out={f("fixed")}
                  dot={DOTS.opus}
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

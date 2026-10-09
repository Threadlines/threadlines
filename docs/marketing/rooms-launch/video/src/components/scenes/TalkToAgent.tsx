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
import { DOTS, rowsFocus, threadBottom } from "./shared";
import { resultFocus } from "./WorkTogether";

/**
 * 03: the user points the message box at Sol ("Sending to Sol") and asks
 * it to check the fix; Sol reads the change and the test and answers. Once
 * the question is sent the camera settles close on it and Sol's reply, lit
 * softly and labelled "Sol checks the fix", and stays still while it is read.
 */
export const TalkToAgent: React.FC<{ layout: Layout; plan: Plan; spec: SceneSpec }> = ({
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
    { at: 0, focus: resultFocus(take) },
    {
      at: f("check-mention"),
      focus: threadBottom(take, m("check-mention") + 1, layout),
      glide: 30,
    },
    {
      at: f("check-sent") + 4,
      focus: rowsFocus(rectOf(take, "check-msg", settled), rectOf(take, "sol-reply", settled)),
      glide: 36,
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
          const trigger = rectAt(take, "trigger", t);
          const reply = rectAt(take, "sol-reply", t);
          const replyEnd = rectAt(take, "reply-end", t);
          return (
            <>
              {reply ? (
                <Spotlight
                  clip={camera.visible}
                  target={camera.toScreen(reply)}
                  amount={0.3 * presence(frame, f("sol-done") + 2, 16)}
                />
              ) : null}
              {trigger ? (
                <Note
                  side="above"
                  anchor={camera.toScreen(trigger)}
                  clip={camera.visible}
                  text="Sending to Sol"
                  size={layout.chip}
                  at={f("check-recipient") + 2}
                  out={f("check-sent")}
                  dot={DOTS.codex}
                />
              ) : null}
              {replyEnd ? (
                <Note
                  anchor={camera.toScreen(replyEnd)}
                  clip={camera.visible}
                  text="Sol checks the fix"
                  size={layout.chip}
                  at={f("sol-done") + 6}
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

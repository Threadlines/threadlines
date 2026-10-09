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
import { Clicks } from "./shared";
import { familyFocus, familyRows, newestFocus, questionFocus } from "./threads-shared";

/**
 * 02: the camera goes to the sidebar, where Opus's row has grown a "3
 * threads" line; it opens into the three threads ("Each in its own
 * worktree"), lit softly. You open one: the camera frames its header, the
 * request Opus wrote and its agent at work. Then back to Opus's thread.
 */
export const ThreeAtOnce: React.FC<{ layout: Layout; plan: Plan; spec: SceneSpec }> = ({
  layout,
  plan,
  spec,
}) => {
  const frame = useCurrentFrame();
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);
  const t = takeTimeAt(plan, frame);
  const tall = take.id === "tall";

  const open = m("family-open") + 0.8;
  const inside = m("peek-done") - 0.3;
  const keys: CameraKey[] = [
    { at: 0, focus: questionFocus(take, m("started") + 1.2) },
    // At phone width the sidebar is a sheet that opens first; the camera
    // goes to it once it is there.
    { at: tall ? f("family-open") - 20 : 2, focus: familyFocus(take, open), glide: 30 },
    // Inside the thread: from where its title starts, across the chat column,
    // down to its agent at work. (The header runs the window's whole width;
    // only its left edge matters here.)
    {
      at: f("peek-open") - 8,
      focus: pad(
        union(
          { ...rectOf(take, "child-heading", inside), w: 1 },
          rectOf(take, "started-by", inside),
          rectOf(take, "child-request", inside),
          rectOf(take, "working", inside),
        ),
        40,
        60,
      ),
      glide: 32,
    },
    { at: f("back") - 6, focus: newestFocus(take, m("back") + 0.3, layout), glide: 30 },
  ];

  return (
    <AbsoluteFill>
      <Stage
        plan={plan}
        keys={keys}
        options={{ stage: layout.stage }}
        radius={layout.windowRadius}
        renderOverlay={(camera) => {
          const middle = rectAt(take, "child-row-queries", t);
          // The rows exist once the family is open.
          const family = middle ? familyRows(take, t) : null;
          const shown = presence(frame, f("family-open") + 4, 14, f("peek") + 6);
          return (
            <>
              {family ? (
                <Spotlight
                  clip={camera.visible}
                  target={camera.toScreen(family)}
                  amount={0.35 * shown}
                  radius={8}
                />
              ) : null}
              {family && middle ? (
                // Beside the rows where there is room (the wide window), under
                // them in the sheet, so the threads' names stay readable.
                <Note
                  side={tall ? "below" : "after"}
                  anchor={camera.toScreen(tall ? family : middle)}
                  clip={camera.visible}
                  text="Each in its own worktree"
                  size={layout.chip}
                  at={f("family-open") + 10}
                  out={f("peek") + 4}
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

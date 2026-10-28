// The "Screenshots on Windows" scenes (0.8.0): Opus on the MacBook Pro asks to
// start a thread on the Windows PC, the thread works there, and its answer
// comes back. Each scene's first framing is the last one's, so the cuts
// between them don't move.
import type React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import type { CameraKey } from "../../camera";
import type { Layout } from "../../layout";
import { frameAt, type Plan, takeTimeAt } from "../../plan";
import type { SceneSpec } from "../../scenes";
import { mark, pad, type Rect, rectAt, rectOf, type Take, union } from "../../takes";
import { Caption } from "../Caption";
import { Note, presence, Spotlight } from "../overlays";
import { Stage } from "../Stage";
import { Clicks, DOTS, rowsFocus, tiltIn } from "./shared";

type SceneProps = { layout: Layout; plan: Plan; spec: SceneSpec };

/** The message box while you type, close enough to read the words. */
const typingFocus = (take: Take, t: number): Rect => pad(rectOf(take, "composer", t), 40, 220);

/** Your question down to Opus's line, with "Started 1 thread" between them. */
const conversationFocus = (take: Take, t: number): Rect =>
  rowsFocus(rectOf(take, "prompt", t), rectOf(take, "opus-plan", t));

/** Opus's line and what sits under it (the request box, or the message box). */
const planFocus = (take: Take, t: number): Rect =>
  pad(union(rectOf(take, "opus-plan", t), rectOf(take, "composer", t)), 30);

/** Opus's row, its "1 thread" line and the PC's thread under it. */
const familyRows = (take: Take, t: number): Rect =>
  union(rectOf(take, "parent-row", t), rectOf(take, "family", t), rectOf(take, "child-row", t));

/**
 * The family in the sidebar, with the chat beside it down to "Started 1
 * thread", so the PC's thread shows in both places. At phone width the
 * sidebar is a sheet as wide as the take: only room above and below.
 */
const familyFocus = (take: Take, t: number): Rect => {
  const rows = familyRows(take, t);
  if (take.id === "tall") return pad(rows, 12, 90);
  const top = rows.y - 120;
  return { x: 0, y: top, w: take.width * 0.74, h: take.height * 0.7 };
};

/**
 * Fleet's map and each computer's threads under it. In the wide window that is
 * the page's middle column; at phone width the page is the whole take.
 */
const fleetFocus = (take: Take, t: number): Rect => {
  const page = rectOf(take, "fleet", t);
  // At phone width: the map and the lists, without the page's empty foot.
  if (take.id === "tall") return { x: page.x, y: page.y + 130, w: page.w, h: page.h * 0.79 };
  return { x: page.x + page.w * 0.15, y: page.y + 20, w: page.w * 0.7, h: page.h * 0.76 };
};

/** Inside the PC's thread: its title and "Started by", the request, Sol at work. */
const insideFocus = (take: Take, t: number): Rect =>
  pad(
    union(
      { ...rectOf(take, "child-heading", t), w: 1 },
      rectOf(take, "started-by", t),
      rectOf(take, "child-request", t),
      rectOf(take, "working", t),
    ),
    40,
    60,
  );

/**
 * 01: the window settles in on the message box while you type your question
 * and send it; the camera rises to the conversation as Opus tests on the Mac
 * and says why it needs the PC. The request
 * box docks above the message box and the camera closes on it ("Opus asks
 * first"); you click Start, and the camera pulls back to the chat, where the
 * start goes out to the PC and its thread shows up working.
 */
export const AskThePc: React.FC<SceneProps> = ({ layout, plan, spec }) => {
  const frame = useCurrentFrame();
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);
  const t = takeTimeAt(plan, frame);

  const keys: CameraKey[] = [
    { at: 0, focus: typingFocus(take, m("open") + 0.2) },
    // Sent: up to the conversation, framed for all it will hold by Opus's line.
    { at: f("sent") - 2, focus: conversationFocus(take, m("asked") + 0.6), glide: 30 },
    { at: f("asked") - 8, focus: planFocus(take, m("asked") + 0.6), glide: 34 },
    { at: f("started") + 4, focus: conversationFocus(take, m("started") + 1.2), glide: 34 },
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
                // Over the box's right half: the rows above it end short of there.
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

/**
 * 02: the camera goes to the sidebar, where Opus's row has grown a "1 thread"
 * line; it opens into the PC's thread, marked with the cloud ("Running on
 * your Windows PC"). You open it: its header says which Mac thread started
 * it, and Sol is at work on the PC. Then Fleet, with both computers and what
 * each one runs, and back to Opus's thread.
 */
export const RunsOnThePc: React.FC<SceneProps> = ({ layout, plan, spec }) => {
  const frame = useCurrentFrame();
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);
  const t = takeTimeAt(plan, frame);
  const tall = take.id === "tall";

  const open = m("family-open") + 0.8;
  const keys: CameraKey[] = [
    { at: 0, focus: conversationFocus(take, m("started") + 1.2) },
    { at: tall ? f("family-open") - 20 : 2, focus: familyFocus(take, open), glide: 30 },
    { at: f("peek-open") - 8, focus: insideFocus(take, m("peek-done") - 0.3), glide: 32 },
    { at: f("fleet") - 6, focus: fleetFocus(take, m("fleet-done") - 0.3), glide: 30 },
    { at: f("back") - 6, focus: planFocus(take, m("back") + 0.3), glide: 30 },
  ];

  return (
    <AbsoluteFill>
      <Stage
        plan={plan}
        keys={keys}
        options={{ stage: layout.stage }}
        radius={layout.windowRadius}
        renderOverlay={(camera) => {
          const child = rectAt(take, "child-row", t);
          // The rows exist once the family is open.
          const family = child ? familyRows(take, t) : null;
          const shown = presence(frame, f("family-open") + 4, 14, f("peek") + 6);
          const startedBy = rectAt(take, "started-by", t);
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
              {family && child ? (
                // Under the rows, over the sidebar's other threads: beside them
                // it would cover the chat.
                <Note
                  side="below"
                  anchor={camera.toScreen(family)}
                  clip={camera.visible}
                  text="Running on your Windows PC"
                  size={layout.chip}
                  at={f("family-open") + 10}
                  out={f("peek") + 4}
                  dot={DOTS.codex}
                />
              ) : null}
              {startedBy ? (
                // The header says it already ("Started by ... on MacBook Pro");
                // a label would cover the request line under it.
                <Spotlight
                  clip={camera.visible}
                  target={camera.toScreen(startedBy)}
                  amount={0.35 * presence(frame, f("peek-open") + 6, 14, f("peek-done") + 2)}
                  radius={8}
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
 * 03: back in Opus's thread, the PC's answer lands folded under its thread's
 * name ("reply from Windows PC"); you open it and the camera closes on it
 * ("The PC's answer"). Opus changes its plan and fixes it, and the camera
 * settles on the answer and the result.
 */
export const AnswerComesBack: React.FC<SceneProps> = ({ layout, plan, spec }) => {
  const frame = useCurrentFrame();
  const take = plan.take;
  const m = (name: string) => mark(take, name);
  const f = (name: string, after = 0) => frameAt(plan, m(name) + after);
  const t = takeTimeAt(plan, frame);

  const opened = m("report-open") + 1;
  const settled = m("end") - 1.5;
  const keys: CameraKey[] = [
    { at: 0, focus: planFocus(take, m("back") + 0.3) },
    {
      at: f("report-open") - 2,
      focus: rowsFocus(rectOf(take, "opus-plan", opened), rectOf(take, "report", opened)),
      glide: 30,
    },
    {
      at: f("opus-done") + 2,
      focus: rowsFocus(rectOf(take, "report", settled), rectOf(take, "opus-done-text", settled)),
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
          const report = rectAt(take, "report", t);
          const reportEnd = rectAt(take, "report-end", t);
          // At phone width the line runs to the window's edge: no room after it.
          const changeEnd = take.id === "tall" ? null : rectAt(take, "change-end", t);
          const result = rectAt(take, "opus-done-text", t);
          const answerOut = f("change", 0.4);
          return (
            <>
              {report ? (
                <Spotlight
                  clip={camera.visible}
                  target={camera.toScreen(report)}
                  amount={0.35 * presence(frame, f("report-open") + 4, 16, answerOut)}
                />
              ) : null}
              {result ? (
                <Spotlight
                  clip={camera.visible}
                  target={camera.toScreen(result)}
                  amount={0.3 * presence(frame, f("opus-done") + 2, 16)}
                />
              ) : null}
              {reportEnd ? (
                <Note
                  anchor={camera.toScreen(reportEnd)}
                  clip={camera.visible}
                  text="The answer from your PC"
                  size={layout.chip}
                  at={f("report-open") + 10}
                  out={answerOut}
                  dot={DOTS.codex}
                />
              ) : null}
              {changeEnd ? (
                <Note
                  anchor={camera.toScreen(changeEnd)}
                  clip={camera.visible}
                  text="Opus changes its plan"
                  size={layout.chip}
                  at={f("change", 3.2)}
                  out={f("fixed")}
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

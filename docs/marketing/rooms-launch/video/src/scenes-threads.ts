// The "Slow checkout" story's scenes (0.6.0, ../../storyboard-child-threads.html):
// Opus asks to start three threads, the family works in the sidebar with a
// look inside one thread, and the answers come back to Opus. Ranges are
// anchored to the marks of ../../source/story-child-threads.ts.
import { hold, play } from "./plan";
import type { PosterSpec, SceneSpec } from "./scenes";
import { mark } from "./takes";

export const THREADS_SCENES: ReadonlyArray<SceneSpec> = [
  {
    id: "ask-first",
    kicker: "ASK FIRST",
    caption: "Opus asks to start three threads.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      return [
        // Opus's plan, then the request box docks above the message box.
        play(m("open"), m("asked") + 0.3, 1.25),
        // Time to read the three titles and their models.
        play(m("asked") + 0.3, m("start")),
        // The pointer's trip to Start is quick; the click lands.
        play(m("start"), m("started") - 0.9, 2.2),
        play(m("started") - 0.9, m("started") + 0.4),
        // "Started 3 threads", with a live dot for each.
        play(m("started") + 0.4, m("family") - 0.2, 1.15),
      ];
    },
  },
  {
    id: "three-at-once",
    kicker: "THREE AT ONCE",
    caption: "Each thread works in its own worktree.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      return [
        // To the sidebar: the "3 threads" line opens into the three threads.
        play(m("family") - 0.2, m("family-open") - 0.5, 2.2),
        play(m("family-open") - 0.5, m("peek"), 0.9),
        // Into one of them.
        play(m("peek"), m("peek-open") - 0.5, 2.2),
        // Its header, the request Opus wrote, and Sol at work.
        play(m("peek-open") - 0.5, m("peek-done"), 1.05),
        // And back to Opus's thread.
        play(m("peek-done"), m("back") + 0.3, 2.3),
      ];
    },
  },
  {
    id: "answers-come-back",
    kicker: "THE ANSWERS COME BACK",
    caption: "Opus reads each answer and fixes the cause.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      return [
        play(m("back") + 0.3, m("report-payments"), 1.3),
        // An answer, then Opus's one short line, twice.
        play(m("report-payments"), m("ack-payments") + 0.2),
        play(m("ack-payments") + 0.2, m("report-page"), 1.3),
        play(m("report-page"), m("ack-page") + 0.2),
        play(m("ack-page") + 0.2, m("report-queries"), 1.3),
        // The third answer is the line the video is about.
        play(m("report-queries"), m("found")),
        play(m("found"), m("fixed"), 1.5),
        play(m("fixed"), m("opus-done") + 0.3),
        // The result holds, the camera still.
        play(m("opus-done") + 0.3, m("end") - 0.6),
        hold(m("end") - 0.6, 0.6),
      ];
    },
  },
];

export const THREADS_POSTER: PosterSpec = {
  scene: "answers-come-back",
  mark: "report-queries",
  after: 2.5,
};

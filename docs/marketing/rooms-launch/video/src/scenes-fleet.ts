// The "Screenshots on Windows" story's scenes (0.8.0, ../../source/story-fleet.ts):
// Opus on the MacBook Pro asks to start a thread on the Windows PC, that
// thread works there (its row in the sidebar, a look inside, Fleet), and its
// answer comes back and changes Opus's plan. Ranges are anchored to the
// marks of ../../source/story-fleet.ts.
import { hold, play } from "./plan";
import type { PosterSpec, SceneSpec } from "./scenes";
import { mark } from "./takes";

export const FLEET_SCENES: ReadonlyArray<SceneSpec> = [
  {
    id: "ask-the-pc",
    kicker: "ASK ANOTHER COMPUTER",
    caption: "Opus asks to start a thread on your Windows PC.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      return [
        // You type the question and send it.
        play(m("open"), m("sent") + 0.4, 2.6),
        // Opus reads, tests on the Mac, then says why it needs the PC.
        play(m("sent") + 0.4, m("mac-test"), 2.2),
        play(m("mac-test"), m("asked") + 0.3, 2.1),
        // Time to read the request: the thread, its agent, "on Windows PC".
        play(m("asked") + 0.3, m("start"), 1.1),
        // The pointer's trip to Start is quick; the click lands.
        play(m("start"), m("started") - 0.9, 2.2),
        play(m("started") - 0.9, m("started") + 0.4),
        // "Sending to Windows PC", then "Started 1 thread" with its live dot.
        play(m("started") + 0.4, m("family") - 0.2, 1.6),
      ];
    },
  },
  {
    id: "runs-on-the-pc",
    kicker: "IT RUNS ON THE PC",
    caption: "Follow it from your Mac, or see it in Fleet.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      return [
        // Opus's row opens into the PC's thread, with the cloud: it isn't here.
        play(m("family") - 0.2, m("family-open") - 0.5, 2.2),
        play(m("family-open") - 0.5, m("peek"), 1.1),
        // Into it: "Started by ... on MacBook Pro", Sol at work on the PC.
        play(m("peek"), m("peek-open") - 0.5, 2.2),
        play(m("peek-open") - 0.5, m("peek-done"), 2),
        // Fleet: both computers and what each one runs.
        play(m("peek-done"), m("fleet") - 0.2, 2.2),
        play(m("fleet") - 0.2, m("fleet-done"), 1.2),
        // And back to Opus's thread.
        play(m("fleet-done"), m("back") + 0.3, 2.2),
      ];
    },
  },
  {
    id: "answer-comes-back",
    kicker: "THE ANSWER COMES BACK",
    caption: "What the PC found changes Opus's plan.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      return [
        // The PC finishes off screen; its answer lands folded, and you open it.
        play(m("back") + 0.3, m("report") - 0.4, 3),
        play(m("report") - 0.4, m("report-open") + 0.2, 1.9),
        // The answer is the line the video is about.
        play(m("report-open") + 0.2, m("change"), 1.1),
        play(m("change"), m("fixed"), 1.9),
        play(m("fixed"), m("opus-done") + 0.3, 1.5),
        // The result holds, the camera still.
        play(m("opus-done") + 0.3, m("end") - 1.4),
        hold(m("end") - 1.4, 0.6),
      ];
    },
  },
];

export const FLEET_POSTER: PosterSpec = {
  scene: "answer-comes-back",
  mark: "report-open",
  after: 2.2,
};

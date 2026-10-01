// The feature scenes: their copy, and which parts of the take they
// play. Every range is anchored to a mark the recording noted, so a new take
// drops in without re-timing anything. Actions play near real time; the
// travel between them is quicker; each payoff gets time to be read.
import { hold, planScene, play, type Plan, type Step } from "./plan";
import { mark, TAKES, type Take, type TakeId } from "./takes";

export type SceneId = "add-a-model" | "work-together" | "talk-to-any-agent";

export type SceneSpec = {
  id: SceneId;
  kicker: string;
  caption: string;
  steps: (take: Take) => Step[];
};

export const SCENES: ReadonlyArray<SceneSpec> = [
  {
    id: "add-a-model",
    kicker: "ADD A MODEL",
    caption: "Bring another model into the thread.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      return [
        // Opus finishes its first look; its report holds for reading.
        play(m("open"), m("reported") + 0.3, 1.4),
        play(m("reported") + 0.3, m("add"), 1.15),
        // Adding Astra: pointer travel is a little quick, each pick lands.
        play(m("add"), m("picker-open") - 0.3, 2.4),
        play(m("picker-open") - 0.3, m("add-agent") + 0.8, 2.3),
        play(m("add-agent") + 0.8, m("codex") + 0.6, 2.4),
        play(m("codex") + 0.6, m("added") + 0.4, 2.2),
        play(m("added") + 0.4, m("team-mention"), 2.5),
        // "@opus", then a beat on the message box showing Opus, then the line.
        play(m("team-mention"), m("team-recipient") + 0.6, 1.2),
        play(m("team-recipient") + 0.6, m("team-typing")),
        play(m("team-typing"), m("team-sent") + 0.3, 1.9),
      ];
    },
  },
  {
    id: "work-together",
    kicker: "WORK TOGETHER",
    caption: "Opus asks Astra. Astra finds the cause.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      return [
        play(m("team-sent") + 0.3, m("asked") + 0.8, 1.4),
        play(m("asked") + 0.8, m("answer-published") + 0.2, 1.25),
        // Astra's answer is the line the video is about.
        play(m("answer-published") + 0.2, m("repro") - 0.4),
        play(m("repro") - 0.4, m("fixed"), 1.7),
        play(m("fixed"), m("opus-done") + 0.3),
        // "One payment, one charge." holds, lit, with the camera settled.
        play(m("opus-done") + 0.3, m("check") - 0.4),
      ];
    },
  },
  {
    id: "talk-to-any-agent",
    kicker: "TALK TO ANY AGENT",
    caption: "Ask Astra to check the fix.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      return [
        play(m("check") - 0.4, m("check-recipient") + 0.5, 1.4),
        play(m("check-recipient") + 0.5, m("check-typing")),
        play(m("check-typing"), m("check-sent") + 0.3, 1.9),
        play(m("check-sent") + 0.3, m("astra-done"), 1.5),
        // Astra's answer holds, the camera still.
        play(m("astra-done"), m("end") - 0.6),
        hold(m("end") - 0.6, 0.6),
      ];
    },
  },
];

/** The scenes in order, numbered ("01  ADD A MODEL"). */
export const scenesIn = () =>
  SCENES.map((spec, index) => ({
    ...spec,
    kicker: `${String(index + 1).padStart(2, "0")}  ${spec.kicker}`,
  }));

/** A scene's footage plan over a format's take. */
export const scenePlan = (spec: SceneSpec, takeId: TakeId): Plan => {
  const take = TAKES[takeId];
  return planScene(take, spec.steps(take));
};

/** The poster PNG: this scene, when this mark has been on screen for `after` seconds. */
export const POSTER = { scene: "work-together" as SceneId, mark: "answer-published", after: 2.5 };

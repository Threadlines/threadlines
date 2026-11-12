// The themes story's scenes (0.10.0, ../../source/story-themes.ts): the
// starters' art on the new-thread screen, /theme, an agent's own theme, a
// change to it, and the Glass slider. Ranges
// are anchored to the marks of ../../source/story-themes.ts.
//
// The video renders at 60 a second and the art draws 20 times a second, so
// wherever art is the thing to look at the take plays at real speed (each
// art frame on three video frames). Typing and pointer travel play faster;
// what the agent offers and what you click hold long enough to read.
import { hold, play, skip, type Step } from "./plan";
import type { PosterSpec, SceneSpec } from "./scenes";
import { mark, type Take } from "./takes";

/** The opening's starters, in the order recorded, and the seconds of each shown. */
export const MONTAGE: ReadonlyArray<readonly [id: string, name: string, seconds: number]> = [
  ["lantern-lake", "Lantern Lake", 2.6],
  ["aurora", "Aurora", 2],
  ["meadow", "Meadow", 2],
  ["snowfield", "Snowfield", 2],
  ["tokyo-rain", "Tokyo Rain", 3.8],
];
/** Into each starter's recorded span before its shot starts. */
export const MONTAGE_LEAD = 0.6;

/** When your message shows in the chat: the moment it was sent. */
const sentAt = (take: Take, track: string, fallback: number) =>
  take.tracks[track]?.[0]?.[0] ?? fallback;

export const THEMES_SCENES: ReadonlyArray<SceneSpec> = [
  {
    id: "live-art",
    kicker: "STARTER THEMES",
    caption: "A few to start with. Yours can be anything.",
    steps: (take) => {
      const steps: Step[] = [];
      let last: number | null = null;
      for (const [id, , seconds] of MONTAGE) {
        const from = mark(take, `art-${id}-in`) + MONTAGE_LEAD;
        if (last !== null) steps.push(skip(last, from));
        steps.push(play(from, from + seconds));
        last = from + seconds;
      }
      return steps;
    },
  },
  {
    id: "type-theme",
    kicker: "TYPE /THEME",
    caption: "Arrow keys preview. Enter keeps one.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      return [
        play(m("slash") - 0.5, m("strip") + 0.6, 1.5),
        play(m("strip") + 0.6, m("theme-aurora") - 0.2, 2),
        // Each key press, and the art that comes with it, at real speed.
        play(m("theme-aurora") - 0.2, m("kept-theme") + 0.9),
        skip(m("kept-theme") + 0.9, m("ask")),
      ];
    },
  },
  {
    id: "ask-for-your-own",
    kicker: "MAKE YOUR OWN",
    caption: "Describe any theme. Your agent builds it.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      const sent = sentAt(take, "ask-msg", m("ask") + 5);
      return [
        play(m("ask"), sent + 0.3, 2.2),
        play(sent + 0.3, m("offered") + 0.2, 3),
        // The offer, long enough to read it, and its Try it button.
        play(m("offered") + 0.2, m("offered") + 2.7),
        skip(m("offered") + 2.7, m("trying") - 1.4),
        play(m("trying") - 1.4, m("trying") - 0.2),
        // Honu Lagoon arrives.
        play(m("trying") - 0.2, m("trying") + 3.6),
        skip(m("trying") + 3.6, m("kept-honu") - 1.3),
        play(m("kept-honu") - 1.3, m("kept-honu") + 0.9),
        skip(m("kept-honu") + 0.9, m("tweak")),
      ];
    },
  },
  {
    id: "make-it-yours",
    kicker: "CHANGE ANYTHING",
    caption: "Not quite right? Ask, then update your copy.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      const sent = sentAt(take, "tweak-msg", m("tweak") + 4);
      return [
        play(m("tweak"), sent + 0.3, 2.2),
        play(sent + 0.3, m("offered-update") + 0.2, 3),
        play(m("offered-update") + 0.2, m("offered-update") + 2.6),
        skip(m("offered-update") + 2.6, m("trying-update") - 1.4),
        // "Update Honu Lagoon?"
        play(m("trying-update") - 1.4, m("trying-update") + 2.4),
        skip(m("trying-update") + 2.4, m("updated") - 1.3),
        play(m("updated") - 1.3, m("updated") + 1.6),
        skip(m("updated") + 1.6, m("glass-slash")),
      ];
    },
  },
  {
    id: "set-the-glass",
    kicker: "GLASS",
    caption: "One slider sets how much of the art shows.",
    steps: (take) => {
      const m = (name: string) => mark(take, name);
      return [
        play(m("glass-slash"), m("glass-strip") + 0.4, 2.2),
        // The drag: the lagoon comes through as the knob moves.
        play(m("glass-strip") + 0.4, m("glass-clear") + 0.2, 1.5),
        play(m("glass-clear") + 0.2, m("glass-done") + 0.2, 1.5),
        // The lagoon behind the chat: the last thing the video shows.
        play(m("glass-done") + 0.2, m("glass-done") + 4.2),
        hold(m("glass-done") + 4.2, 0.6),
      ];
    },
  },
];

/**
 * Sharing a theme to the Showcase (Speedcube, in the take). Not in the main
 * video: after the lagoon it read as a second subject. Kept for a clip of its own.
 */
export const THEMES_SHARE_SCENE: SceneSpec = {
  id: "share-it",
  kicker: "SHARE IT",
  caption: "Put your own in the Showcase for everyone.",
  steps: (take) => {
    const m = (name: string) => mark(take, name);
    return [
      // Settings › Appearance: your theme's menu has Share to Showcase.
      play(m("menu") - 1.6, m("menu") + 0.2, 1.2),
      play(m("menu") + 0.2, m("share-dialog") + 0.3, 1.8),
      // The dialog: what gets published, a credit, Share.
      play(m("share-dialog") + 0.3, m("shared") - 1.6, 2.6),
      play(m("shared") - 1.6, m("shared") + 1.6, 1.3),
      // Back in the thread, on your own theme.
      skip(m("shared") + 1.6, m("back") + 0.6),
      play(m("back") + 0.6, m("back") + 3.4),
      hold(m("back") + 3.4, 0.6),
    ];
  },
};

export const THEMES_POSTER: PosterSpec = {
  scene: "live-art",
  mark: "art-tokyo-rain-in",
  after: 2,
};

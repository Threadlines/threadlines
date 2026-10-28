// The videos this project cuts. A story is its footage (two takes), its
// scenes, and the words on its title cards; the camera, labels, window and
// cards themselves are shared.
import { SITE_URL } from "./config";
import { type PosterSpec, ROOMS_POSTER, ROOMS_SCENES, type SceneSpec } from "./scenes";
import { FLEET_POSTER, FLEET_SCENES } from "./scenes-fleet";
import { THREADS_POSTER, THREADS_SCENES } from "./scenes-threads";
import { type StoryId, type Take, type TakeId, TAKES } from "./takes";

export type Story = {
  id: StoryId;
  /** The release the video announces: "NEW IN 0.5.0" in the intro, "v0.5.0" on the end card. */
  release: string;
  intro: { title: string; line: string };
  outro: { title: string; line: string; url: string };
  takes: Record<TakeId, Take>;
  scenes: ReadonlyArray<SceneSpec>;
  poster: PosterSpec;
  /** Its wide homepage clip shows the whole window, without the camera's close-ups. */
  siteWholeWindow?: true;
};

export const STORIES: Record<StoryId, Story> = {
  rooms: {
    id: "rooms",
    release: "0.5.0",
    intro: { title: "Rooms", line: "Your coding agents, working together in one thread." },
    outro: { title: "Rooms", line: "Claude, Codex and more, in one thread.", url: SITE_URL },
    takes: TAKES.rooms,
    scenes: ROOMS_SCENES,
    poster: ROOMS_POSTER,
    // The homepage hero: it shows the app's whole layout around the chat.
    siteWholeWindow: true,
  },
  threads: {
    id: "threads",
    release: "0.6.0",
    intro: {
      title: "Agents start threads",
      line: "Split a big job across threads. The answers come back.",
    },
    outro: {
      title: "Agents start threads",
      line: "Each in its own worktree. The answers come back.",
      url: SITE_URL,
    },
    takes: TAKES.threads,
    scenes: THREADS_SCENES,
    poster: THREADS_POSTER,
  },
  fleet: {
    id: "fleet",
    release: "0.8.0",
    intro: { title: "Fleet", line: "Your computers work as one." },
    outro: {
      title: "Fleet",
      line: "An agent on one computer can ask another.",
      url: SITE_URL,
    },
    takes: TAKES.fleet,
    scenes: FLEET_SCENES,
    poster: FLEET_POSTER,
  },
};

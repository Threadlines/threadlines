import type { ThreadStatusPill } from "../Sidebar.logic";

/**
 * Where each sidebar status stands with the user, for the surfaces that sort a
 * project's threads by it: the new-thread screen's map (ProjectThreadMap) and
 * the Threads panel (projectBoard.logic). One table, so the two can never put
 * the same thread in different places.
 */

export type ThreadStatusTone = "amber" | "red" | "violet" | "blue" | "cyan" | "emerald";

/**
 * How a status counts: stopped on the user, at work (or coming back by
 * itself), or finished and not yet looked at.
 */
export type ThreadStatusGroup = "needsYou" | "working" | "finished";

export interface ThreadStatusPresentation {
  readonly tone: ThreadStatusTone;
  readonly group: ThreadStatusGroup;
  /** The map's lane priority: lower claims a lane first. */
  readonly rank: number;
}

/**
 * One row per sidebar status, so these dots are the sidebar's dots. Keyed by
 * the label union: a status added there fails to compile here until it is
 * given a colour and a group.
 */
export const THREAD_STATUS_PRESENTATION: Readonly<
  Record<ThreadStatusPill["label"], ThreadStatusPresentation>
> = {
  "Pending Approval": { tone: "amber", group: "needsYou", rank: 0 },
  "Awaiting Input": { tone: "amber", group: "needsYou", rank: 0 },
  Failed: { tone: "red", group: "needsYou", rank: 0 },
  "Plan Ready": { tone: "violet", group: "needsYou", rank: 1 },
  Working: { tone: "blue", group: "working", rank: 2 },
  Starting: { tone: "blue", group: "working", rank: 2 },
  Answering: { tone: "blue", group: "working", rank: 2 },
  Waiting: { tone: "cyan", group: "working", rank: 2 },
  Completed: { tone: "emerald", group: "finished", rank: 3 },
  // Settled, and an agent will come back by itself: a wait, after a result.
  "Checking back": { tone: "cyan", group: "working", rank: 3 },
  // Stopped by a usage limit, and continues by itself once it resets.
  "Continues at reset": { tone: "cyan", group: "working", rank: 3 },
};

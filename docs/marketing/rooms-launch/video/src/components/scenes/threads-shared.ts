// Framings the "Slow checkout" scenes share, so one scene's last shot is the
// next one's first and the cut between them doesn't move.
import type { Layout } from "../../layout";
import { pad, type Rect, rectOf, type Take, union } from "../../takes";
import { threadBottom } from "./shared";

/** Your question down to the message box: the earlier work above is out of frame. */
export const questionFocus = (take: Take, t: number): Rect =>
  pad(union(rectOf(take, "prompt", t), rectOf(take, "composer", t)), 30);

/** Opus's row in the sidebar with its "3 threads" line and the three threads under it. */
export const familyRows = (take: Take, t: number): Rect =>
  union(
    rectOf(take, "parent-row", t),
    rectOf(take, "family", t),
    rectOf(take, "child-row-payments", t),
    rectOf(take, "child-row-queries", t),
    rectOf(take, "child-row-page", t),
  );

/**
 * The family in the sidebar. In the wide window the shot also takes in the
 * start of the chat beside it, down to "Started 3 threads", so the same three
 * names show in both places. At phone width the sidebar is a sheet as wide as
 * the take, so there is only room above and below.
 */
export const familyFocus = (take: Take, t: number): Rect => {
  const rows = familyRows(take, t);
  if (take.id === "tall") return pad(rows, 12, 90);
  const record = rectOf(take, "started-record", t);
  const top = rows.y - 70;
  return { x: 0, y: top, w: record.x + 560, h: record.y + record.h + 60 - top };
};

/** The newest rows of Opus's thread and the message box. */
export const newestFocus = (take: Take, t: number, layout: Layout): Rect =>
  threadBottom(take, t, layout);

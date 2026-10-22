/**
 * The launch mark on a thread's session (OrchestrationSession.startup): who
 * may write it, and which launch's mark is the newest.
 *
 * @module sessionLaunches
 */
import type { OrchestrationSession } from "@threadlines/contracts";
import * as Struct from "effect/Struct";

/**
 * Which launch's mark is the newest on each key. Each launch that marks a
 * thread gets a new generation; ending one only frees the key while it is
 * still the newest, so a late clear from an older launch can't wipe a newer
 * one's. In memory: a mark the process never cleared is settled at the next
 * start.
 */
export const makeSessionLaunchGenerations = <Key>() => {
  const newest = new Map<Key, number>();
  let last = 0;
  return {
    /** A launch marks `key`: its generation, now the newest. */
    begin: (key: Key): number => {
      last += 1;
      newest.set(key, last);
      return last;
    },
    /** True, and the key is free again, when `generation` is still the newest. */
    end: (key: Key, generation: number): boolean => {
      if (newest.get(key) !== generation) {
        return false;
      }
      newest.delete(key);
      return true;
    },
    /** True while a launch holds `key`'s mark. */
    holds: (key: Key): boolean => newest.has(key),
  };
};

/**
 * A session update built from a session read earlier, without its launch
 * mark: the projection then keeps whichever mark is current when the update
 * lands. Copying the mark it read could bring back one cleared since. Only
 * the code that launches the agent sets or clears the mark.
 */
export const withoutLaunchMark = (
  session: OrchestrationSession,
): Omit<OrchestrationSession, "startup"> => Struct.omit(session, ["startup"]);

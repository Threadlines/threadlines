/**
 * SystemWake - Whether this computer is fully awake, or woke only for upkeep
 * and is about to sleep again (a Mac's dark wake).
 *
 * Work Threadlines starts on its own (a scheduled run, an event task's run)
 * asks first: started in a dark wake, it would crawl along a few seconds per
 * wake. Work the user starts never asks; they are at the computer.
 *
 * @module SystemWake
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface SystemWakeShape {
  /**
   * False while this computer is awake only for upkeep. Always true off
   * macOS, and whenever the answer can't be read.
   */
  readonly fullyAwake: Effect.Effect<boolean>;
}

export class SystemWake extends Context.Service<SystemWake, SystemWakeShape>()(
  "threadlines/power/Services/SystemWake",
) {}

/**
 * sleepInhibitionState - Pure state for turn-scoped sleep inhibition.
 *
 * Folds provider runtime events and settings changes into the set of threads
 * with a turn in flight. The reducer always tracks active turns, even while
 * the setting is disabled, so re-enabling mid-turn engages the inhibitor
 * immediately.
 *
 * @module sleepInhibitionState
 */
import type { ProviderRuntimeEvent, ThreadId } from "@threadlines/contracts";

export type SleepInhibitionInput =
  | { readonly kind: "runtime-event"; readonly event: ProviderRuntimeEvent }
  | { readonly kind: "settings"; readonly enabled: boolean };

export interface SleepInhibitionState {
  readonly enabled: boolean;
  readonly activeThreadIds: ReadonlySet<ThreadId>;
}

export function initialSleepInhibitionState(enabled: boolean): SleepInhibitionState {
  return { enabled, activeThreadIds: new Set() };
}

export function shouldInhibitSleep(state: SleepInhibitionState): boolean {
  return state.enabled && state.activeThreadIds.size > 0;
}

/**
 * A thread holds at most one active turn, so activity is modeled as thread
 * membership rather than turn identity. `session.exited` also clears the
 * thread: a provider process that dies mid-turn never emits `turn.completed`.
 * Inputs that change nothing return the same state reference.
 */
export function reduceSleepInhibitionState(
  state: SleepInhibitionState,
  input: SleepInhibitionInput,
): SleepInhibitionState {
  if (input.kind === "settings") {
    if (input.enabled === state.enabled) {
      return state;
    }
    return { ...state, enabled: input.enabled };
  }

  const event = input.event;
  switch (event.type) {
    case "turn.started": {
      if (state.activeThreadIds.has(event.threadId)) {
        return state;
      }
      const activeThreadIds = new Set(state.activeThreadIds);
      activeThreadIds.add(event.threadId);
      return { ...state, activeThreadIds };
    }
    case "turn.completed":
    case "turn.aborted":
    case "session.exited": {
      if (!state.activeThreadIds.has(event.threadId)) {
        return state;
      }
      const activeThreadIds = new Set(state.activeThreadIds);
      activeThreadIds.delete(event.threadId);
      return { ...state, activeThreadIds };
    }
    default:
      return state;
  }
}

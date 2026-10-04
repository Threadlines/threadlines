/**
 * Which activities a thread keeps once its log outgrows the recent window.
 *
 * The live thread feed carries only the newest `MAX_THREAD_ACTIVITIES` per
 * thread, plus a few older rows that still drive UI state: open approvals and
 * questions (so their prompts stay answerable) and every plan update from the
 * turn that last updated the plan (so the task list in the activity popover
 * survives a long, chatty turn, and can still tell when each of its steps
 * started and finished). The
 * server projector, the snapshot SQL queries, and the web store all apply this
 * same rule; if they disagree, a reload shows different state than the live
 * feed. The chat reads older turns' steps separately, one turn at a time
 * (`orchestration.getTurnActivities`).
 */
import {
  APPROVAL_ACTIVITY_KINDS,
  USER_INPUT_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  type PendingRequestActivityLike,
} from "./pendingRequests.ts";

/** Activity kind carrying a thread's task list (TodoWrite / task tracker). */
export const PLAN_ACTIVITY_KIND = "turn.plan.updated";

/** At most this many of the latest plan turn's updates outlive the window, so
 *  a turn that rewrites its plan endlessly cannot grow the feed without
 *  bound. The newest are kept. */
export const MAX_RETAINED_PLAN_UPDATES = 100;

/**
 * Keeps the newest `recentLimit` of `orderedActivities` (callers pass them in
 * thread order) plus any older activity the UI still needs: open prompts and
 * the latest plan update, with the other plan updates of its turn.
 */
export function retainThreadActivities<
  A extends PendingRequestActivityLike & { readonly turnId?: string | null },
>(orderedActivities: ReadonlyArray<A>, recentLimit: number): A[] {
  if (orderedActivities.length <= recentLimit) return [...orderedActivities];
  const retained = new Set<A>(
    [
      ...collectOpenPendingRequests(orderedActivities, APPROVAL_ACTIVITY_KINDS),
      ...collectOpenPendingRequests(orderedActivities, USER_INPUT_ACTIVITY_KINDS),
    ].map(({ activity }) => activity),
  );
  const latestPlan = orderedActivities.findLast((activity) => activity.kind === PLAN_ACTIVITY_KIND);
  if (latestPlan) {
    retained.add(latestPlan);
    const planTurnId = latestPlan.turnId ?? null;
    if (planTurnId !== null) {
      let kept = 0;
      for (let index = orderedActivities.length - 1; index >= 0; index -= 1) {
        const activity = orderedActivities[index]!;
        if (activity.kind !== PLAN_ACTIVITY_KIND) continue;
        // The newest plan updates come first here, whatever their turn, which
        // is how the database ranks them too.
        kept += 1;
        if (kept > MAX_RETAINED_PLAN_UPDATES) break;
        if (activity.turnId === planTurnId) retained.add(activity);
      }
    }
  }
  const recentStart = orderedActivities.length - recentLimit;
  return orderedActivities.filter(
    (activity, index) => index >= recentStart || retained.has(activity),
  );
}

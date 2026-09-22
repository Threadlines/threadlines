/**
 * Which activities a thread keeps once its log outgrows the recent window.
 *
 * Clients only ever see the newest `MAX_THREAD_ACTIVITIES` per thread, plus
 * a few older rows that still drive UI state: open approvals and questions
 * (so their prompts stay answerable) and the latest plan update (so the task
 * list in the activity popover survives a long, chatty turn). The server
 * projector, the snapshot SQL queries, and the web store all apply this same
 * rule; if they disagree, a reload shows different state than the live feed.
 */
import {
  APPROVAL_ACTIVITY_KINDS,
  USER_INPUT_ACTIVITY_KINDS,
  collectOpenPendingRequests,
  type PendingRequestActivityLike,
} from "./pendingRequests.ts";

/** Activity kind carrying a thread's task list (TodoWrite / task tracker). */
export const PLAN_ACTIVITY_KIND = "turn.plan.updated";

/**
 * Keeps the newest `recentLimit` of `orderedActivities` (callers pass them in
 * thread order) plus any older activity the UI still needs: open prompts and
 * the latest plan update.
 */
export function retainThreadActivities<A extends PendingRequestActivityLike>(
  orderedActivities: ReadonlyArray<A>,
  recentLimit: number,
): A[] {
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
  }
  const recentStart = orderedActivities.length - recentLimit;
  return orderedActivities.filter(
    (activity, index) => index >= recentStart || retained.has(activity),
  );
}

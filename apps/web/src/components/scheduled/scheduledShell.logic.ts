/**
 * What the app shell needs of Scheduled (docs/design/fleet.md, Part 6) before
 * the page loads: which computers run scheduled tasks (lib/scheduledTasksState)
 * and the page's search params (its route). Apart from the page's own logic
 * (scheduled.logic.ts), which would bring the cadence and webhook code into
 * startup.
 */
import { type CapableComputer, capableEnvironmentsOf } from "../../lib/capableEnvironments";
import type { ScheduledTaskEnvironment } from "../../lib/scheduledTasksState";

export type ScheduledTaskComputer = CapableComputer;

/**
 * This computer and every connected saved computer whose server reports the
 * `scheduledTasks` capability, this one first and the rest by name, each
 * saying whether it runs event tasks (`eventTasks`). An absent capability (an
 * older Threadlines) is a no.
 */
export function scheduledTaskEnvironmentsOf(
  input: Parameters<typeof capableEnvironmentsOf>[1],
): ScheduledTaskEnvironment[] {
  return capableEnvironmentsOf("scheduledTasks", input).map((environment) => ({
    environmentId: environment.environmentId,
    isPrimary: environment.isPrimary,
    label: environment.label,
    eventTasks: environment.capabilities.eventTasks === true,
  }));
}

// ---------------------------------------------------------------------------
// Where the page is: its search params
// ---------------------------------------------------------------------------

export type ScheduledView = "new" | "edit";

export interface ScheduledSearch {
  /** The computer whose task is open. */
  readonly environment?: string;
  readonly task?: string;
  /** The form: a new task, or the open task being edited. */
  readonly view?: ScheduledView;
}

export function parseScheduledSearch(search: Record<string, unknown>): ScheduledSearch {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const environment = text(search.environment);
  const task = text(search.task);
  const view = search.view === "new" || search.view === "edit" ? search.view : undefined;
  return {
    ...(environment !== undefined && task !== undefined ? { environment, task } : {}),
    ...(view !== undefined ? { view } : {}),
  };
}

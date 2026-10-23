/**
 * What the app shell needs of Scheduled (docs/design/fleet.md, Part 6) before
 * the page loads: which computers run scheduled tasks (lib/scheduledTasksState)
 * and the page's search params (its route). Apart from the page's own logic
 * (scheduled.logic.ts), which would bring the cadence and webhook code into
 * startup.
 */
import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@threadlines/contracts";

import type { SavedEnvironmentConnectionState } from "../../environments/runtime/catalog";
import type { ScheduledTaskEnvironment } from "../../lib/scheduledTasksState";
import { resolveEnvironmentOptionLabel } from "../BranchToolbar.logic";

export interface ScheduledTaskComputer {
  readonly connectionState: SavedEnvironmentConnectionState;
  readonly descriptor: Pick<ExecutionEnvironmentDescriptor, "capabilities" | "label"> | null;
}

/**
 * This computer and every connected saved computer whose server reports the
 * `scheduledTasks` capability, this one first and the rest by name, each
 * saying whether it runs event tasks (`eventTasks`). An absent capability (an
 * older Threadlines) is a no.
 */
export function scheduledTaskEnvironmentsOf(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly primaryDescriptor: Pick<ExecutionEnvironmentDescriptor, "capabilities" | "label"> | null;
  readonly runtimeById: Readonly<Record<EnvironmentId, ScheduledTaskComputer>>;
  readonly savedLabelOf: (environmentId: EnvironmentId) => string | null;
}): ScheduledTaskEnvironment[] {
  const environments: ScheduledTaskEnvironment[] = [];
  const seen = new Set<EnvironmentId>();
  const { primaryEnvironmentId, primaryDescriptor } = input;
  if (primaryEnvironmentId && primaryDescriptor?.capabilities.scheduledTasks === true) {
    seen.add(primaryEnvironmentId);
    environments.push({
      environmentId: primaryEnvironmentId,
      isPrimary: true,
      eventTasks: primaryDescriptor.capabilities.eventTasks === true,
      label: resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: primaryEnvironmentId,
        runtimeLabel: primaryDescriptor.label,
      }),
    });
  }
  const others: ScheduledTaskEnvironment[] = [];
  for (const environmentId of Object.keys(input.runtimeById) as EnvironmentId[]) {
    if (seen.has(environmentId)) continue;
    const runtime = input.runtimeById[environmentId];
    if (!runtime || runtime.connectionState !== "connected") continue;
    if (runtime.descriptor?.capabilities.scheduledTasks !== true) continue;
    seen.add(environmentId);
    others.push({
      environmentId,
      isPrimary: false,
      eventTasks: runtime.descriptor.capabilities.eventTasks === true,
      label: resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId,
        runtimeLabel: runtime.descriptor.label,
        savedLabel: input.savedLabelOf(environmentId),
      }),
    });
  }
  return [...environments, ...others.toSorted((a, b) => a.label.localeCompare(b.label))];
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

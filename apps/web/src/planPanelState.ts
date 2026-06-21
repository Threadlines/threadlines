import { useMemo } from "react";
import type { ThreadId } from "@threadlines/contracts";

import { useStore } from "./store";
import type { Thread } from "./types";
import type { ActivePlanState, LatestProposedPlanState } from "./session-logic";

const EMPTY_PROPOSED_PLANS: Thread["proposedPlans"] = [];

export type ThreadPlanCatalogEntry = Pick<Thread, "id" | "proposedPlans">;

export interface PlanTaskBadgeState {
  label: string;
  ariaLabel: string;
  tone: "active" | "complete" | "ready" | "idle";
  pulse: boolean;
}

export function useThreadPlanCatalog(threadIds: readonly ThreadId[]): ThreadPlanCatalogEntry[] {
  return useStore(
    useMemo(() => {
      let previousThreadIds: readonly ThreadId[] = [];
      let previousResult: ThreadPlanCatalogEntry[] = [];
      let previousEntries = new Map<
        ThreadId,
        {
          shell: object | null;
          proposedPlanIds: readonly string[] | undefined;
          proposedPlansById: Record<string, Thread["proposedPlans"][number]> | undefined;
          entry: ThreadPlanCatalogEntry;
        }
      >();

      return (state) => {
        const sameThreadIds =
          previousThreadIds.length === threadIds.length &&
          previousThreadIds.every((id, index) => id === threadIds[index]);
        const nextEntries = new Map<
          ThreadId,
          {
            shell: object | null;
            proposedPlanIds: readonly string[] | undefined;
            proposedPlansById: Record<string, Thread["proposedPlans"][number]> | undefined;
            entry: ThreadPlanCatalogEntry;
          }
        >();
        const nextResult: ThreadPlanCatalogEntry[] = [];
        let changed = !sameThreadIds;

        for (const threadId of threadIds) {
          let shell: object | undefined;
          let proposedPlanIds: readonly string[] | undefined;
          let proposedPlansById: Record<string, Thread["proposedPlans"][number]> | undefined;

          for (const environmentState of Object.values(state.environmentStateById)) {
            const matchedShell = environmentState.threadShellById[threadId];
            if (!matchedShell) {
              continue;
            }
            shell = matchedShell;
            proposedPlanIds = environmentState.proposedPlanIdsByThreadId[threadId];
            proposedPlansById = environmentState.proposedPlanByThreadId[threadId] as
              | Record<string, Thread["proposedPlans"][number]>
              | undefined;
            break;
          }

          if (!shell) {
            const previous = previousEntries.get(threadId);
            if (
              previous &&
              previous.shell === null &&
              previous.proposedPlanIds === undefined &&
              previous.proposedPlansById === undefined
            ) {
              nextEntries.set(threadId, previous);
              continue;
            }
            changed = true;
            nextEntries.set(threadId, {
              shell: null,
              proposedPlanIds: undefined,
              proposedPlansById: undefined,
              entry: { id: threadId, proposedPlans: EMPTY_PROPOSED_PLANS },
            });
            continue;
          }

          const previous = previousEntries.get(threadId);
          if (
            previous &&
            previous.shell === shell &&
            previous.proposedPlanIds === proposedPlanIds &&
            previous.proposedPlansById === proposedPlansById
          ) {
            nextEntries.set(threadId, previous);
            nextResult.push(previous.entry);
            continue;
          }

          changed = true;
          const proposedPlans =
            proposedPlanIds && proposedPlanIds.length > 0 && proposedPlansById
              ? proposedPlanIds.flatMap((planId) => {
                  const proposedPlan = proposedPlansById?.[planId];
                  return proposedPlan ? [proposedPlan] : [];
                })
              : EMPTY_PROPOSED_PLANS;
          const entry = { id: threadId, proposedPlans };
          nextEntries.set(threadId, {
            shell,
            proposedPlanIds,
            proposedPlansById,
            entry,
          });
          nextResult.push(entry);
        }

        if (!changed && previousResult.length === nextResult.length) {
          return previousResult;
        }

        previousThreadIds = threadIds;
        previousEntries = nextEntries;
        previousResult = nextResult;
        return nextResult;
      };
    }, [threadIds]),
  );
}

export function derivePlanTaskBadge(input: {
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
}): PlanTaskBadgeState | null {
  const { activePlan, activeProposedPlan } = input;
  if (activePlan && activePlan.steps.length > 0) {
    const total = activePlan.steps.length;
    const activeStepIndex = activePlan.steps.findIndex((step) => step.status === "inProgress");
    const completedCount = activePlan.steps.filter((step) => step.status === "completed").length;
    const visibleStep = activeStepIndex >= 0 ? activeStepIndex + 1 : completedCount;
    const label = `${Math.max(visibleStep, 0)}/${total}`;
    const tone =
      completedCount === total
        ? "complete"
        : activeStepIndex >= 0
          ? "active"
          : completedCount > 0
            ? "idle"
            : "ready";

    return {
      label,
      ariaLabel:
        activeStepIndex >= 0
          ? `Tasks, working on step ${activeStepIndex + 1} of ${total}`
          : completedCount === total
            ? `Tasks complete, ${completedCount} of ${total}`
            : `Tasks, ${completedCount} of ${total} complete`,
      tone,
      pulse: activeStepIndex >= 0,
    };
  }

  if (activeProposedPlan && activeProposedPlan.implementedAt === null) {
    return {
      label: "Plan",
      ariaLabel: "Plan ready",
      tone: "ready",
      pulse: true,
    };
  }

  return null;
}

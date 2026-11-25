import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import type { ScheduledTaskRef } from "./scheduled.logic";

/** Moving around the Scheduled page. Opening a task from the overview is a step back undoes. */
export function useScheduledNavigation() {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      openTask: (ref: ScheduledTaskRef, options?: { readonly replace?: boolean }) =>
        void navigate({
          to: "/scheduled",
          search: { environment: ref.environmentId, task: ref.taskId },
          ...(options?.replace ? { replace: true } : {}),
        }),
      editTask: (ref: ScheduledTaskRef) =>
        void navigate({
          to: "/scheduled",
          search: { environment: ref.environmentId, task: ref.taskId, view: "edit" },
        }),
      newTask: () => void navigate({ to: "/scheduled", search: { view: "new" } }),
      showAll: (options?: { readonly replace?: boolean }) =>
        void navigate({
          to: "/scheduled",
          search: {},
          ...(options?.replace ? { replace: true } : {}),
        }),
    }),
    [navigate],
  );
}

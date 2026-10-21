import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ScheduledTask,
  ScheduledTaskId,
} from "@threadlines/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useEnvironmentProviders } from "../../hooks/useEnvironmentProviders";
import {
  type ScheduledTaskEnvironment,
  useScheduledTaskGroups,
} from "../../lib/scheduledTasksState";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import {
  parseScheduledSearch,
  type ScheduledSearch,
  type ScheduledTaskRef,
} from "./scheduled.logic";

/** Where the Scheduled page is, from its search params (the list beside the rail reads it too). */
export function useScheduledSearch(): ScheduledSearch {
  const search = useSearch({ strict: false });
  return useMemo(() => parseScheduledSearch(search as Record<string, unknown>), [search]);
}

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

/** A task with the computer it lives on. */
export interface LocatedTask {
  readonly environment: ScheduledTaskEnvironment;
  readonly task: ScheduledTask;
}

/** The task the search names, if a followed computer has it. */
export function useSelectedScheduledTask(search: ScheduledSearch): LocatedTask | null {
  const groups = useScheduledTaskGroups();
  return useMemo(() => {
    if (search.environment === undefined || search.task === undefined) return null;
    const group = groups.find((entry) => entry.environment.environmentId === search.environment);
    const task = group?.tasks?.find((entry) => entry.id === search.task);
    return group && task ? { environment: group.environment, task } : null;
  }, [groups, search.environment, search.task]);
}

export const taskRef = (located: LocatedTask): ScheduledTaskRef => ({
  environmentId: located.environment.environmentId,
  taskId: located.task.id as ScheduledTaskId,
});

/** A task's project name, as its computer has it. */
export function useProjectNames(): (environmentId: EnvironmentId, projectId: ProjectId) => string {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  return useCallback(
    (environmentId, projectId) => {
      const project = projects.find(
        (entry) => entry.environmentId === environmentId && entry.id === projectId,
      );
      if (project === undefined) return "A project that's gone";
      return project.kind === "general-chat" ? "General Chats" : project.name;
    },
    [projects],
  );
}

/** "Codex · GPT-6 Astra": the agent and model, as the task's computer names them. */
export function useAgentLabels(): (
  environmentId: EnvironmentId,
  selection: ModelSelection,
) => {
  readonly agent: string;
  readonly model: string;
  readonly driverKind: ProviderDriverKind | null;
} {
  const providersOn = useEnvironmentProviders();
  return useCallback(
    (environmentId, selection) => {
      const entry = deriveProviderInstanceEntries(providersOn(environmentId)).find(
        (candidate) => candidate.instanceId === selection.instanceId,
      );
      const model = entry?.models.find((candidate) => candidate.slug === selection.model);
      return {
        agent: entry?.displayName ?? selection.instanceId,
        model: model?.shortName ?? model?.name ?? selection.model,
        driverKind: entry?.driverKind ?? null,
      };
    },
    [providersOn],
  );
}

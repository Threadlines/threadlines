import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderDriverKind,
  RuntimeMode,
  ScheduledTask,
  ScheduledTaskGitHubContext,
  ScheduledTaskId,
  ThreadId,
  ThreadParticipantId,
} from "@threadlines/contracts";
import { roomAgentKey } from "@threadlines/shared/threadParticipants";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useEnvironmentApiAvailable } from "../../environmentApi";
import { readEnvironmentConnection } from "../../environments/runtime";
import { useEnvironmentProviders } from "../../hooks/useEnvironmentProviders";
import {
  type ScheduledTaskEnvironment,
  useScheduledTaskGroups,
} from "../../lib/scheduledTasksState";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { buildRoomAgentLabels } from "../../rooms";
import { deriveAccessLevel, runtimeModeConfig } from "../../runtimeModeOptions";
import { selectEnvironmentState, selectProjectsAcrossEnvironments, useStore } from "../../store";
import { getPickerModelName } from "../chat/providerIconUtils";
import type { ScheduledTaskRef } from "./scheduled.logic";
import { parseScheduledSearch, type ScheduledSearch } from "./scheduledShell.logic";

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
/**
 * A task's access level as the composer shows it for its agent: the level
 * it was set to, or the one the agent falls back to when it lacks that one.
 */
export function useAccessLabel(): (
  environmentId: EnvironmentId,
  selection: ModelSelection,
  mode: RuntimeMode,
) => string {
  const providersOn = useEnvironmentProviders();
  return useCallback(
    (environmentId, selection, mode) => {
      const providers = providersOn(environmentId);
      const entry = deriveProviderInstanceEntries(providers).find(
        (candidate) => candidate.instanceId === selection.instanceId,
      );
      const shown =
        entry === undefined
          ? mode
          : deriveAccessLevel({
              providers,
              provider: entry.driverKind,
              snapshot: entry.snapshot,
              models: entry.models,
              model: selection.model,
              mode,
            }).shown;
      return runtimeModeConfig[shown].label;
    },
    [providersOn],
  );
}

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

/** One agent a continued thread's runs can go to. */
export interface ContinuedAgent {
  /** Null: the thread's own agent. */
  readonly id: ThreadParticipantId | null;
  /** As the thread's room names it. */
  readonly name: string;
  readonly modelSelection: ModelSelection;
  /** It left the thread: listed only because a task still points at it. */
  readonly left: boolean;
}

/**
 * The agents a continued thread's runs can go to, named as its room names
 * them: the thread's own agent, then the agents in its room, and `kept` (the
 * one a task points at) even after it left. Empty when the thread never had
 * a room, or isn't loaded here: its runs go to its own agent.
 */
export function useContinuedAgents(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  kept: ThreadParticipantId | null,
): ReadonlyArray<ContinuedAgent> {
  const providersOn = useEnvironmentProviders();
  const shell = useStore((state) =>
    environmentId === null || threadId === null
      ? undefined
      : selectEnvironmentState(state, environmentId).threadShellById[threadId],
  );
  return useMemo(() => {
    if (shell === undefined || environmentId === null) return [];
    const labels = buildRoomAgentLabels(
      shell,
      deriveProviderInstanceEntries(providersOn(environmentId)),
      (model, entry) => getPickerModelName(model, entry.driverKind),
    );
    if (labels === null) return [];
    const nameOf = (id: ThreadParticipantId | null) =>
      labels.get(roomAgentKey(id))?.name ?? "An agent that left";
    return [
      { id: null, name: nameOf(null), modelSelection: shell.modelSelection, left: false },
      ...(shell.participants ?? [])
        .filter(
          (participant) =>
            (participant.leftAt === null && participant.guest !== true) || participant.id === kept,
        )
        .map((participant) => ({
          id: participant.id,
          name: nameOf(participant.id),
          modelSelection: participant.modelSelection,
          left: participant.leftAt !== null,
        })),
    ];
  }, [environmentId, kept, providersOn, shell]);
}

/** What the event pieces of the page know about a project's GitHub repository before the computer answers. */
const NO_GITHUB_CONTEXT: ScheduledTaskGitHubContext = {
  repository: null,
  login: null,
  canConnect: false,
};

/**
 * A project's GitHub repository and who `gh` is signed in as on its computer
 * (scheduledTasks.gitHubContext), for an event task's form and address
 * panel. Null until the computer answers; a computer that can't tell
 * answers as if there were none, so the form falls back to typing them.
 */
export function useGitHubContext(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
  enabled: boolean,
): ScheduledTaskGitHubContext | null {
  // Asked only once the computer's connection is up: asked before (right after
  // the app loads), it would read "can't connect" and keep that answer.
  const connected = useEnvironmentApiAvailable(environmentId);
  const query = useQuery({
    queryKey: ["scheduledTasks", "gitHubContext", environmentId, projectId],
    queryFn: async () => {
      const connection = environmentId === null ? null : readEnvironmentConnection(environmentId);
      if (!connection || projectId === null) return NO_GITHUB_CONTEXT;
      try {
        return await connection.client.scheduledTasks.gitHubContext({ projectId });
      } catch {
        return NO_GITHUB_CONTEXT;
      }
    },
    enabled: enabled && connected && environmentId !== null && projectId !== null,
    staleTime: 60_000,
  });
  return query.data ?? null;
}

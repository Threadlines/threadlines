import type { ScopedProjectRef } from "@threadlines/contracts";

import { selectProjectsAcrossEnvironments, useStore } from "../store";
import type { Project } from "../types";

const PROJECT_ARRIVAL_TIMEOUT_MS = 2_000;
const PROJECT_ARRIVAL_POLL_INTERVAL_MS = 200;

function readProject(projectRef: ScopedProjectRef): Project | null {
  return (
    selectProjectsAcrossEnvironments(useStore.getState()).find(
      (candidate) =>
        candidate.id === projectRef.projectId &&
        candidate.environmentId === projectRef.environmentId,
    ) ?? null
  );
}

/**
 * Waits briefly for a freshly created project to reach the client store.
 *
 * Anything that derives a project's identity right after dispatching
 * `project.create` (draft keys, navigation targets) otherwise runs against a
 * store that has not seen the project yet. Returns `null` once the wait window
 * is spent so callers proceed instead of blocking the interaction.
 */
export async function waitForProjectInStore(
  projectRef: ScopedProjectRef,
  options?: {
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
  },
): Promise<Project | null> {
  const timeoutMs = options?.timeoutMs ?? PROJECT_ARRIVAL_TIMEOUT_MS;
  const intervalMs = options?.intervalMs ?? PROJECT_ARRIVAL_POLL_INTERVAL_MS;
  const deadlineAt = Date.now() + timeoutMs;

  for (;;) {
    const project = readProject(projectRef);
    if (project) {
      return project;
    }
    if (Date.now() >= deadlineAt) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

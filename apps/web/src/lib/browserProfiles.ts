/**
 * The in-app browser's per-project profiles, from the renderer's side.
 *
 * Each project's tabs run in their own browser partition, so sign-ins and site
 * data never cross between projects. The desktop names the partition and
 * remembers it; the renderer asks once per environment and project and keeps
 * the answer, so a panel that mounts again renders its tabs on the first frame
 * instead of waiting on a round trip.
 */

import type { EnvironmentId, ProjectId } from "@threadlines/contracts";
import { useEffect, useState } from "react";

const partitionByProfileKey = new Map<string, string>();
const pendingByProfileKey = new Map<string, Promise<string | null>>();

function profileKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return JSON.stringify([environmentId, projectId]);
}

async function requestPartition(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): Promise<string | null> {
  const request = window.desktopBridge?.previewProfilePartition;
  if (request === undefined) {
    return null;
  }
  try {
    const { partition } = await request({ environmentId, projectId });
    partitionByProfileKey.set(profileKey(environmentId, projectId), partition);
    return partition;
  } catch (error) {
    console.warn("Failed to get the browser profile for a project", {
      environmentId,
      projectId,
      error,
    });
    return null;
  }
}

/**
 * The partition for a project's tabs, or null when the desktop could not give
 * one. Concurrent callers share one request; failures are not cached, so the
 * next caller tries again.
 */
export function loadBrowserProfilePartition(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): Promise<string | null> {
  const key = profileKey(environmentId, projectId);
  const cached = partitionByProfileKey.get(key);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const pending = pendingByProfileKey.get(key);
  if (pending !== undefined) {
    return pending;
  }
  const request = requestPartition(environmentId, projectId).finally(() => {
    pendingByProfileKey.delete(key);
  });
  pendingByProfileKey.set(key, request);
  return request;
}

/** Drops a remembered answer, so the next panel asks the desktop again. */
export function forgetCachedBrowserProfilePartition(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): void {
  partitionByProfileKey.delete(profileKey(environmentId, projectId));
}

export type BrowserProfilePartitionState =
  | { readonly status: "ready"; readonly partition: string }
  | { readonly status: "loading" }
  | { readonly status: "no-project" }
  | { readonly status: "failed" };

const LOADING: BrowserProfilePartitionState = { status: "loading" };
const NO_PROJECT: BrowserProfilePartitionState = { status: "no-project" };
const FAILED: BrowserProfilePartitionState = { status: "failed" };

/**
 * The partition a thread's browser tabs run in.
 *
 * There is no fallback to a shared profile: without a project there is
 * nothing to isolate by, and a tab in the wrong profile is the leak this
 * exists to prevent.
 */
export function useBrowserProfilePartition(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): BrowserProfilePartitionState {
  const key = projectId === null ? null : profileKey(environmentId, projectId);
  const [settled, setSettled] = useState<{ key: string; partition: string | null } | null>(null);

  useEffect(() => {
    if (projectId === null || key === null || partitionByProfileKey.has(key)) {
      return;
    }
    let active = true;
    void loadBrowserProfilePartition(environmentId, projectId).then((partition) => {
      if (active) {
        setSettled({ key, partition });
      }
    });
    return () => {
      active = false;
    };
  }, [environmentId, key, projectId]);

  if (key === null) {
    return NO_PROJECT;
  }
  const cached = partitionByProfileKey.get(key);
  if (cached !== undefined) {
    return { status: "ready", partition: cached };
  }
  if (settled !== null && settled.key === key) {
    return settled.partition === null ? FAILED : { status: "ready", partition: settled.partition };
  }
  return LOADING;
}

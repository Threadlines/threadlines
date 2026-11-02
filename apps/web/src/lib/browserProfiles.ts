/**
 * The in-app browser's profiles, from the renderer's side.
 *
 * With "Browser sign-ins" shared, every project on an environment browses in
 * that environment's profile, so a site signed in to once is signed in
 * everywhere. Separate, each project's tabs run in their own, so sign-ins and
 * site data never cross between projects. Either way a page carries its
 * project's scope, which the desktop holds it to (sites, certificates, tabs it
 * may open). The desktop names both and remembers the profile; the renderer
 * asks once per environment, project and mode and keeps the answer, so a
 * panel that mounts again renders its tabs on the first frame instead of
 * waiting on a round trip.
 */

import type {
  BrowserSignIns,
  DesktopPreviewProfileAssignment,
  EnvironmentId,
  ProjectId,
} from "@threadlines/contracts";
import { useEffect, useState } from "react";

import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { getSavedEnvironmentRecord } from "../environments/runtime/catalog";
import { useClientSettingsHydrated, useSettings } from "../hooks/useSettings";

const profileByKey = new Map<string, DesktopPreviewProfileAssignment>();
const pendingByKey = new Map<string, Promise<DesktopPreviewProfileAssignment | null>>();

const SIGN_IN_MODES: ReadonlyArray<BrowserSignIns> = ["shared", "separate"];

function profileKey(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  signIns: BrowserSignIns,
): string {
  return JSON.stringify([environmentId, projectId, signIns]);
}

async function requestProfile(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  signIns: BrowserSignIns,
): Promise<DesktopPreviewProfileAssignment | null> {
  const request = window.desktopBridge?.previewProfilePartition;
  if (request === undefined) {
    return null;
  }
  // Another computer's project: its pages' `localhost` is that computer's,
  // whatever its server can do today. An older one says so when a page tries,
  // rather than the page quietly opening this machine's port instead. A saved
  // computer's threads only exist once its record does, so this is known by
  // the time any of its pages are.
  const loopbackTunnel =
    getSavedEnvironmentRecord(environmentId) !== null &&
    readPrimaryEnvironmentDescriptor()?.environmentId !== environmentId;
  try {
    const profile = await request({
      environmentId,
      projectId,
      ...(signIns === "shared" ? { shared: true } : {}),
      ...(loopbackTunnel ? { loopbackTunnel: true } : {}),
    });
    profileByKey.set(profileKey(environmentId, projectId, signIns), profile);
    return profile;
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
 * Where a project's tabs run, or null when the desktop could not say.
 * Concurrent callers share one request; failures are not cached, so the next
 * caller tries again.
 */
function loadBrowserProfile(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  signIns: BrowserSignIns,
): Promise<DesktopPreviewProfileAssignment | null> {
  const key = profileKey(environmentId, projectId, signIns);
  const cached = profileByKey.get(key);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const pending = pendingByKey.get(key);
  if (pending !== undefined) {
    return pending;
  }
  const request = requestProfile(environmentId, projectId, signIns).finally(() => {
    pendingByKey.delete(key);
  });
  pendingByKey.set(key, request);
  return request;
}

/** Drops a project's remembered answers, so the next panel asks the desktop again. */
export function forgetCachedBrowserProfilePartition(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): void {
  for (const signIns of SIGN_IN_MODES) {
    profileByKey.delete(profileKey(environmentId, projectId, signIns));
  }
}

export type BrowserProfileState =
  | {
      readonly status: "ready";
      readonly partition: string;
      readonly scope: string;
      readonly shared: boolean;
    }
  | { readonly status: "loading" }
  | { readonly status: "no-project" }
  | { readonly status: "failed" };

const LOADING: BrowserProfileState = { status: "loading" };
const NO_PROJECT: BrowserProfileState = { status: "no-project" };
const FAILED: BrowserProfileState = { status: "failed" };

/**
 * The profile a thread's browser tabs run in, following the sign-ins setting.
 * Changing the setting hands out a different partition, and tabs keyed by it
 * come back in the new one.
 *
 * There is no fallback to some other profile: without a project there is
 * nothing to scope a page by, and a tab in the wrong profile is the leak this
 * exists to prevent.
 */
export function useBrowserProfile(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): BrowserProfileState {
  const signIns = useSettings((settings) => settings.browserSignIns);
  // Until the saved settings arrive the mode reads as the default, and a tab
  // loaded in the wrong profile has already sent that profile's cookies.
  const hydrated = useClientSettingsHydrated();
  const key =
    projectId === null || !hydrated ? null : profileKey(environmentId, projectId, signIns);
  const [settled, setSettled] = useState<{
    key: string;
    profile: DesktopPreviewProfileAssignment | null;
  } | null>(null);

  useEffect(() => {
    if (projectId === null || key === null || profileByKey.has(key)) {
      return;
    }
    let active = true;
    void loadBrowserProfile(environmentId, projectId, signIns).then((profile) => {
      if (active) {
        setSettled({ key, profile });
      }
    });
    return () => {
      active = false;
    };
  }, [environmentId, key, projectId, signIns]);

  if (projectId === null) {
    return NO_PROJECT;
  }
  if (key === null) {
    return LOADING;
  }
  const profile =
    profileByKey.get(key) ??
    (settled !== null && settled.key === key ? settled.profile : undefined);
  if (profile === undefined) {
    return LOADING;
  }
  return profile === null ? FAILED : { status: "ready", ...profile, shared: signIns === "shared" };
}

import type { ProjectId, ScopedThreadRef } from "@threadlines/contracts";
import { withBrowserApproval } from "@threadlines/shared/preview";
import { useCallback, useMemo } from "react";

import { getClientSettings, updateSettings, useSettings } from "../../hooks/useSettings";
import { selectEnvironmentState, useStore, type AppState } from "../../store";

/**
 * Which sites this thread's project has said yes to.
 *
 * Kept in one place because three surfaces need the same answer and would
 * otherwise each grow their own: the agent's `navigate` refuses on it, the main
 * process is handed it to enforce page-initiated navigation against, and the
 * approval bar writes to it.
 *
 * Scoped to the project rather than the thread: the sites a piece of work needs
 * belong to the work, and re-approving the same docs site in every new thread
 * would train people to click Allow without reading it.
 */

/** A stable identity for "nothing approved", so effects do not re-run on every read. */
const NO_APPROVALS: ReadonlyArray<string> = Object.freeze([]);

export interface BrowserApprovals {
  /** Null before the thread's shell has arrived; nothing can be approved yet. */
  readonly projectId: ProjectId | null;
  readonly approvedDomains: ReadonlyArray<string>;
  /**
   * Records a host for this project. A private or already-covered host is a
   * no-op. Returns the approvals in force afterwards, so a caller that is about
   * to load a page can arm the guest before it rather than after the settings
   * round trip has made its way back through React.
   */
  readonly approveHost: (hostname: string) => ReadonlyArray<string>;
}

/**
 * Hands one guest the allowlist the main process holds it to.
 *
 * Safe to call redundantly, and safe outside Electron: without a bridge there
 * is no guest to arm.
 */
export function pushNavigationPolicy(
  webContentsId: number,
  approvedDomains: ReadonlyArray<string>,
): void {
  void window.desktopBridge
    ?.previewSetNavigationPolicy?.({ webContentsId, approvedDomains: [...approvedDomains] })
    .catch(() => {});
}

/**
 * Records a host for a project, outside React.
 *
 * Reads at the moment of writing rather than from a captured render: approving
 * from the address bar and from a link in the transcript can land in the same
 * tick, and the second must not drop the first. A private or already-covered
 * host writes nothing.
 */
export function approveBrowserHostForProject(
  projectId: ProjectId,
  hostname: string,
): ReadonlyArray<string> {
  const current = getClientSettings().agentBrowserApprovedDomains;
  const existing = current[projectId] ?? NO_APPROVALS;
  const next = withBrowserApproval(existing, hostname);
  if (next === existing) {
    return existing;
  }
  updateSettings({ agentBrowserApprovedDomains: { ...current, [projectId]: next } });
  return next;
}

export function useBrowserApprovals(threadRef: ScopedThreadRef): BrowserApprovals {
  const projectId = useStore(
    useMemo(
      // The shell rather than the derived thread: this selector re-runs on every
      // store change, and deriving a whole thread to read one id off it would
      // rebuild the message list on every streamed token.
      () => (state: AppState) =>
        selectEnvironmentState(state, threadRef.environmentId).threadShellById[threadRef.threadId]
          ?.projectId ?? null,
      // The ref object is rebuilt on render; its parts are what identify a thread.
      [threadRef.environmentId, threadRef.threadId],
    ),
  );
  const approvedByProject = useSettings((settings) => settings.agentBrowserApprovedDomains);
  const approvedDomains =
    projectId === null ? NO_APPROVALS : (approvedByProject[projectId] ?? NO_APPROVALS);
  const approveHost = useCallback(
    (hostname: string): ReadonlyArray<string> =>
      projectId === null ? NO_APPROVALS : approveBrowserHostForProject(projectId, hostname),
    [projectId],
  );

  return { projectId, approvedDomains, approveHost };
}

import type { AgentBrowserSitePolicy, ProjectId, ScopedThreadRef } from "@threadlines/contracts";
import {
  resolveBrowserSiteAccess,
  withBrowserApproval,
  withoutBrowserApproval,
  type BrowserSiteAccess,
} from "@threadlines/shared/preview";
import { useCallback, useMemo } from "react";

import { getClientSettings, updateSettings, useSettings } from "../../hooks/useSettings";
import { selectEnvironmentState, useStore, type AppState } from "../../store";

/**
 * Which sites this thread's project may reach without asking.
 *
 * Kept in one place because three surfaces need the same answer and would
 * otherwise each grow their own: the agent's `navigate` checks it, the main
 * process is handed it to enforce page-initiated navigation against, and the
 * approval bar and the panel's site menu write to it.
 *
 * Two layers. The site policy -- "Ask first" or "Any site" -- is the user's
 * default with a per-project override. Under "Ask first", the approved list is
 * what has been allowed so far. Both are scoped to the project rather than the
 * thread: the sites a piece of work needs belong to the work, and re-approving
 * the same docs site in every new thread would train people to click Allow
 * without reading it.
 *
 * Kept on this computer, like the browser it governs: the pages, their logins
 * and their permissions all live with the desktop app that runs them.
 */

/** A stable identity for "nothing approved", so effects do not re-run on every read. */
const NO_APPROVALS: ReadonlyArray<string> = Object.freeze([]);

export interface BrowserApprovals {
  /** Null only when no shell has arrived and the caller knew no project either. */
  readonly projectId: ProjectId | null;
  readonly access: BrowserSiteAccess;
  /** The project's own choice, or null when it follows the default. */
  readonly projectPolicy: AgentBrowserSitePolicy | null;
  readonly defaultPolicy: AgentBrowserSitePolicy;
  /**
   * Records a host for this project. A private or already-covered host is a
   * no-op. Returns the access in force afterwards, so a caller that is about to
   * load a page can arm the guest before it rather than after the settings
   * round trip has made its way back through React.
   */
  readonly approveHost: (hostname: string) => BrowserSiteAccess;
  /** Lets every site through for this project, or hands it back to the default. */
  readonly setProjectPolicy: (policy: AgentBrowserSitePolicy | null) => BrowserSiteAccess;
  readonly removeHost: (hostname: string) => void;
}

/**
 * Hands one guest the access the main process holds it to.
 *
 * Safe to call redundantly, and safe outside Electron: without a bridge there
 * is no guest to arm.
 */
export function pushNavigationPolicy(webContentsId: number, access: BrowserSiteAccess): void {
  void window.desktopBridge
    ?.previewSetNavigationPolicy?.({
      webContentsId,
      approvedDomains: [...access.approvedHosts],
      allowAll: access.allowAll,
    })
    .catch(() => {});
}

/** The access a project has right now, read outside React. */
export function readBrowserSiteAccess(projectId: ProjectId | null): BrowserSiteAccess {
  const settings = getClientSettings();
  return resolveBrowserSiteAccess({
    defaultPolicy: settings.agentBrowserSitePolicy,
    projectPolicy:
      projectId === null ? undefined : settings.agentBrowserProjectSitePolicy[projectId],
    approvedHosts:
      projectId === null
        ? NO_APPROVALS
        : (settings.agentBrowserApprovedDomains[projectId] ?? NO_APPROVALS),
  });
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
): BrowserSiteAccess {
  const current = getClientSettings().agentBrowserApprovedDomains;
  const existing = current[projectId] ?? NO_APPROVALS;
  const next = withBrowserApproval(existing, hostname);
  if (next !== existing) {
    updateSettings({ agentBrowserApprovedDomains: { ...current, [projectId]: next } });
  }
  return readBrowserSiteAccess(projectId);
}

/** Sets or clears a project's own site policy, outside React. */
export function setBrowserSitePolicyForProject(
  projectId: ProjectId,
  policy: AgentBrowserSitePolicy | null,
): BrowserSiteAccess {
  const { [projectId]: _previous, ...others } = getClientSettings().agentBrowserProjectSitePolicy;
  updateSettings({
    agentBrowserProjectSitePolicy: policy === null ? others : { ...others, [projectId]: policy },
  });
  return readBrowserSiteAccess(projectId);
}

export function useBrowserApprovals(
  threadRef: ScopedThreadRef,
  /**
   * The project the caller already knows this thread belongs to.
   *
   * A new thread is a local draft until its first message reaches the server,
   * so it has no shell to look up -- and without this, typing an address in a
   * fresh thread recorded nothing and armed the guest with an empty allowlist,
   * which blocked the very page the user asked for at its first redirect.
   */
  knownProjectId?: ProjectId | null,
): BrowserApprovals {
  const shellProjectId = useStore(
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
  // The shell is authoritative once it exists; the caller's knowledge covers
  // the draft window before it does.
  const projectId = shellProjectId ?? knownProjectId ?? null;
  const approvedByProject = useSettings((settings) => settings.agentBrowserApprovedDomains);
  const defaultPolicy = useSettings((settings) => settings.agentBrowserSitePolicy);
  const policyByProject = useSettings((settings) => settings.agentBrowserProjectSitePolicy);
  const approvedHosts =
    projectId === null ? NO_APPROVALS : (approvedByProject[projectId] ?? NO_APPROVALS);
  const projectPolicy = projectId === null ? null : (policyByProject[projectId] ?? null);
  const access = useMemo(
    () =>
      resolveBrowserSiteAccess({
        defaultPolicy,
        projectPolicy: projectPolicy ?? undefined,
        approvedHosts,
      }),
    [approvedHosts, defaultPolicy, projectPolicy],
  );
  const approveHost = useCallback(
    (hostname: string): BrowserSiteAccess =>
      projectId === null
        ? readBrowserSiteAccess(null)
        : approveBrowserHostForProject(projectId, hostname),
    [projectId],
  );
  const setProjectPolicy = useCallback(
    (policy: AgentBrowserSitePolicy | null): BrowserSiteAccess =>
      projectId === null
        ? readBrowserSiteAccess(null)
        : setBrowserSitePolicyForProject(projectId, policy),
    [projectId],
  );
  const removeHost = useCallback(
    (hostname: string) => {
      if (projectId === null) return;
      const current = getClientSettings().agentBrowserApprovedDomains;
      const existing = current[projectId] ?? NO_APPROVALS;
      const next = withoutBrowserApproval(existing, hostname);
      if (next !== existing) {
        updateSettings({ agentBrowserApprovedDomains: { ...current, [projectId]: next } });
      }
    },
    [projectId],
  );

  return {
    projectId,
    access,
    projectPolicy,
    defaultPolicy,
    approveHost,
    setProjectPolicy,
    removeHost,
  };
}

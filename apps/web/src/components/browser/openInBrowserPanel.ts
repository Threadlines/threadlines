/**
 * Opening a link from the transcript in the thread's own browser.
 *
 * A link in what an agent wrote is nearly always about the work in front of
 * you -- the dev server it just started, the docs page it just cited -- so the
 * plain click keeps it in the thread rather than throwing it at another app.
 * Modified clicks still go outside, because that is what a modifier means
 * everywhere else.
 *
 * The same rule as the address bar applies: going somewhere yourself is
 * approval, so the site is recorded for the project without a prompt.
 */

import type { ProjectId, ScopedThreadRef } from "@threadlines/contracts";

import {
  callWhenReady,
  getPreviewWebview,
  selectActiveTab,
  selectThreadBrowserState,
  useBrowserPanelStore,
} from "../../browserPanelStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { selectEnvironmentState, useStore } from "../../store";
import { approveBrowserHostForProject, pushNavigationPolicy } from "./browserApprovals";
import { hostOf, normalizePreviewUrl } from "./previewUrl";

/** Only web pages belong in the panel; a mailto: or vscode: link is the shell's. */
export function isBrowserPanelHref(href: string | undefined | null): boolean {
  return typeof href === "string" && /^https?:\/\//i.test(href.trim());
}

/**
 * A scheme this browser has no business loading.
 *
 * Checked separately from `normalizePreviewUrl`, which is permissive on
 * purpose: it exists to make `localhost:5173` loadable, and it will just as
 * happily read `mailto:someone@example.com` as a host with a userinfo prefix.
 * The digit lookahead is what tells a scheme from a port.
 */
const EXPLICIT_SCHEME_REGEX = /^([a-z][a-z0-9+.-]*):(?!\d)/i;

function hasNonWebScheme(rawUrl: string): boolean {
  const scheme = EXPLICIT_SCHEME_REGEX.exec(rawUrl.trim())?.[1]?.toLowerCase();
  return scheme !== undefined && scheme !== "http" && scheme !== "https";
}

/**
 * Whether this click means "somewhere else": a modifier or any button but the
 * primary one keeps the anchor's own `target="_blank"` behaviour.
 */
export function isPlainPrimaryClick(event: {
  readonly button?: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return (
    (event.button ?? 0) === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/**
 * The project a thread belongs to, or null before its shell has arrived.
 *
 * Read imperatively: this answers a click, and a subscription would make every
 * rendered link a store subscriber for a question asked once in a while.
 */
function resolveThreadProject(
  threadRef: ScopedThreadRef,
): { projectId: ProjectId; kind: string | undefined } | null {
  const environmentState = selectEnvironmentState(useStore.getState(), threadRef.environmentId);
  const serverProjectId = environmentState.threadShellById[threadRef.threadId]?.projectId ?? null;
  const draftProjectId =
    serverProjectId === null
      ? (Object.values(useComposerDraftStore.getState().draftThreadsByThreadKey).find(
          (draft) =>
            draft.environmentId === threadRef.environmentId &&
            draft.threadId === threadRef.threadId,
        )?.projectId ?? null)
      : null;
  const projectId = serverProjectId ?? draftProjectId;
  if (projectId === null) {
    return null;
  }
  const project = environmentState.projectById[projectId];
  return project ? { projectId, kind: project.kind } : null;
}

/**
 * Puts a url in the thread's browser panel, opening the panel if it is closed.
 *
 * Returns false when the link cannot be shown here -- an address that is not
 * loadable, a thread whose project is unknown, or a General Chat thread, which
 * has no panel at all -- so the caller can leave the click alone and let the
 * link behave as it always has.
 */
export function openUrlInBrowserPanel(threadRef: ScopedThreadRef, rawUrl: string): boolean {
  if (hasNonWebScheme(rawUrl)) {
    return false;
  }
  const url = normalizePreviewUrl(rawUrl);
  if (url === null) {
    return false;
  }

  const project = resolveThreadProject(threadRef);
  if (project === null || project.kind === "general-chat") {
    return false;
  }

  const approvedDomains = approveBrowserHostForProject(project.projectId, hostOf(url));

  const store = useBrowserPanelStore.getState();
  const panel = selectThreadBrowserState(store.browserStateByThreadKey, threadRef);
  if (!panel.open) {
    store.setBrowserOpen(threadRef, true);
  }

  const activeTab = selectActiveTab(panel);
  if (activeTab === null || activeTab.url !== null) {
    // Something is already on screen, and replacing it would lose the page the
    // panel was opened for. A second link is a second tab, as it would be in
    // any browser.
    store.openTabWithUrl(threadRef, url);
    return true;
  }

  store.setTabUrl(threadRef, activeTab.id, url);
  // A panel that was closed has no element yet; its <webview> mounts with the
  // url we just stored as its source, so there is nothing to drive here.
  const webview = getPreviewWebview(threadRef, activeTab.id);
  if (webview !== null) {
    // The click is the approval, so arm an existing guest before asking it to
    // load. Waiting for the settings subscription to re-render leaves a race
    // where the main-process navigation guard still sees the old allowlist.
    const webContentsId = callWhenReady(() => webview.getWebContentsId());
    if (webContentsId !== null) {
      pushNavigationPolicy(webContentsId, approvedDomains);
    }
    callWhenReady(() => {
      void webview.loadURL(url).catch(() => {});
    });
  }
  return true;
}

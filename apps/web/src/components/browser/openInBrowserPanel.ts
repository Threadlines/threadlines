/**
 * Opening a link from the transcript in the thread's own browser.
 *
 * A link in what an agent wrote is nearly always about the work in front of
 * you -- the dev server it just started, the docs page it just cited -- so by
 * default the plain click keeps it in the thread rather than throwing it at
 * another app. Settings › General › Open links in can send it to the
 * computer's own browser instead; Cmd or Ctrl on the click always goes to the
 * other place, so neither is ever more than a modifier away.
 *
 * The same rule as the address bar applies: going somewhere yourself is
 * approval, so the site is recorded for the project without a prompt.
 *
 * The tabs a page in the browser asks for open here too (`openTabForPage`).
 * Those are the page's doing, not yours, so they ask first like any link the
 * page follows.
 */

import type { LinkOpenTarget, ProjectId, ScopedThreadRef } from "@threadlines/contracts";
import { isBrowserHostAllowed } from "@threadlines/shared/preview";

import {
  callWhenReady,
  getPreviewWebview,
  selectActiveTab,
  selectPendingBrowserApprovals,
  selectThreadBrowserState,
  useBrowserPanelStore,
} from "../../browserPanelStore";
import { useComposerDraftStore } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { getClientSettings } from "../../hooks/useSettings";
import { selectEnvironmentState, useStore } from "../../store";
import {
  approveBrowserHostForProject,
  pushNavigationPolicy,
  readBrowserSiteAccess,
} from "./browserApprovals";
import { nextBrowserApprovalId } from "./browserApprovalRequests";
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
 * Whether this is a plain click: the primary button, no modifier. Anything
 * else means "somewhere else" (see `webLinkClickTarget`).
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
 * Where a plain click on a web link opens on this computer (Settings ›
 * General › Open links in). Read when the click happens, for the same reason
 * as `resolveThreadProject`.
 */
export function readLinkOpenTarget(): LinkOpenTarget {
  return getClientSettings().openLinksIn;
}

/**
 * Where a click on a web link should go, or null when the click is the
 * anchor's own business (shift, alt, any button but the primary one), which
 * leaves it to the external browser as it always has. The plain click goes
 * where the user chose; Cmd or Ctrl sends it to the other place.
 */
export function webLinkClickTarget(
  event: {
    readonly button?: number;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
  },
  preference: LinkOpenTarget,
): LinkOpenTarget | null {
  if ((event.button ?? 0) !== 0 || event.shiftKey || event.altKey) {
    return null;
  }
  if (event.metaKey || event.ctrlKey) {
    return preference === "browser-panel" ? "external" : "browser-panel";
  }
  return preference;
}

/**
 * Whether a link in this thread can open in its browser panel at all: only in
 * the desktop app, and only once the thread's project is known and is not a
 * General Chat, which has no panel. A right-click menu asks this before
 * offering the panel, so it never lists a choice that does nothing.
 */
export function canOpenInBrowserPanel(threadRef: ScopedThreadRef | null): boolean {
  if (!isElectron || threadRef === null) {
    return false;
  }
  const project = resolveThreadProject(threadRef);
  return project !== null && project.kind !== "general-chat";
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

  const access = approveBrowserHostForProject(project.projectId, hostOf(url));

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
      pushNavigationPolicy(webContentsId, access);
    }
    callWhenReady(() => {
      void webview.loadURL(url).catch(() => {});
    });
  }
  return true;
}

/**
 * How many tabs pages may have open in one thread, counting those waiting on
 * a site question (allowing a site opens them all at once). The desktop slows
 * a page that opens tabs in a loop; this stops one that keeps going from
 * filling the strip, and memory, with tabs nobody asked for. Tabs the user
 * opens do not count.
 */
const PAGE_OPENED_TAB_LIMIT = 20;

/**
 * Opens a tab a page asked for (see `DesktopPreviewOpenTab`), beside the page.
 *
 * Held to the same sites as a link followed in the same tab: one the project
 * has not approved is asked about first, from the page that asked, and
 * allowing it opens the tab. It comes to the front only when the page that
 * asked is the tab in front: an agent working in a background tab must not
 * pull its links over the page the user is reading.
 */
export function openTabForPage(input: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly openerTabId: string;
  readonly url: string;
  readonly background: boolean;
}): void {
  const host = isBrowserPanelHref(input.url) ? hostOf(input.url) : "";
  if (host === "") {
    return;
  }
  const store = useBrowserPanelStore.getState();
  const panel = selectThreadBrowserState(store.browserStateByThreadKey, input.threadRef);
  const waitingOnQuestions = selectPendingBrowserApprovals(
    store.pendingApprovalsByThreadKey,
    input.threadRef,
  ).filter((question) => question.newTab !== undefined).length;
  if (
    panel.tabs.filter((tab) => tab.openerTabId !== undefined).length + waitingOnQuestions >=
    PAGE_OPENED_TAB_LIMIT
  ) {
    return;
  }
  if (!isBrowserHostAllowed(host, readBrowserSiteAccess(input.projectId))) {
    const opener = panel.tabs.find((tab) => tab.id === input.openerTabId);
    store.enqueueBrowserApproval(input.threadRef, {
      id: nextBrowserApprovalId(),
      // Nothing waits on a page's new tab: allowing opens it.
      waiting: false,
      host,
      url: input.url,
      source: "page",
      fromHost: opener?.url ? hostOf(opener.url) || null : null,
      tabId: input.openerTabId,
      newTab: { background: input.background },
    });
    if (!panel.open) {
      // A question nobody can see is a stall, not a prompt.
      store.setBrowserOpen(input.threadRef, true);
    }
    return;
  }
  store.openTabFromPage(input.threadRef, {
    openerTabId: input.openerTabId,
    url: input.url,
    activate: !input.background && panel.activeTabId === input.openerTabId,
  });
}

/**
 * Sign-in pop-ups: the one kind of page request that gets a real window.
 *
 * "Sign in with Google" and its kind open a small window with
 * `window.open(url, name, "width=...,height=...")` and wait for it to send the
 * result back through `window.opener`. As a panel tab that cannot happen:
 * `window.open` returns nothing to a page whose request became a tab, and the
 * sign-in fails. So a request with window features, which only pop-ups make,
 * opens a window above the app window, in the page's own profile.
 *
 * The page asks for the window but does not shape it. Only its size comes
 * from the request, so no page can take away the frame and the title that say
 * which site the window shows. It goes only where its opener may (see
 * `PreviewAutomation.guardPopup`), and asks about anywhere else on the window
 * itself: the panel's approval line is behind it, out of sight.
 */
import type * as Electron from "electron";

/** What a sign-in pop-up's question can be answered with. */
export type SignInPopupAnswer = "allowSite" | "allowAllSites" | "decline";

/** Pop-ups a profile's pages may have open at once; a sign-in needs one. */
export const MAX_SIGN_IN_POPUPS = 3;

const DEFAULT_SIZE = { width: 500, height: 640 };
const MIN_SIZE = 320;
const MAX_SIZE = { width: 1200, height: 1000 };

/**
 * Whether a page's request for a new window is a sign-in pop-up rather than a
 * tab: a new window asked for with window features, aimed at a web address or
 * at `about:blank`, which some sign-in libraries open first and point at the
 * provider once they know where to send it.
 */
export function isSignInPopupRequest(details: {
  readonly url: string;
  readonly disposition: string;
  readonly features: string;
}): boolean {
  if (details.disposition !== "new-window" || details.features.trim() === "") {
    return false;
  }
  if (details.url === "about:blank") {
    return true;
  }
  try {
    const protocol = new URL(details.url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Window options as Electron hands them to `createWindow`: with the new page in
 * `webContents`, an option its types leave out.
 */
export type SignInPopupWindowOptions = Electron.BrowserWindowConstructorOptions & {
  readonly webContents?: Electron.WebContents;
};

/**
 * The window a pop-up opens in, from what Electron made of the request.
 *
 * Electron reads the page's feature string into window options, frame and
 * always-on-top included. Only the size is kept, within bounds, and the window
 * is centred on the app window rather than wherever the page placed it. The
 * page's preferences are its opener's, already sandboxed; they are restated
 * rather than trusted, and the new page Electron made is handed on as it is.
 */
export function signInPopupWindowOptions(
  requested: SignInPopupWindowOptions,
  parent: Electron.BrowserWindow,
): SignInPopupWindowOptions {
  const width = clamp(requested.width ?? DEFAULT_SIZE.width, MIN_SIZE, MAX_SIZE.width);
  const height = clamp(requested.height ?? DEFAULT_SIZE.height, MIN_SIZE, MAX_SIZE.height);
  const area = parent.getBounds();
  const { preload: _preload, ...inherited } = requested.webPreferences ?? {};
  return {
    ...(requested.webContents === undefined ? {} : { webContents: requested.webContents }),
    webPreferences: {
      ...inherited,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
    },
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    parent,
    show: true,
    title: "Sign in",
    autoHideMenuBar: true,
    minimizable: false,
    fullscreenable: false,
    backgroundColor: "#ffffff",
  };
}

/** What a pop-up needs from the app around it. */
export interface SignInPopupHost {
  /** Holds the pop-up's navigations to its opener's sites; see `PreviewAutomation.guardPopup`. */
  readonly guard: (
    contents: Electron.WebContents,
    onRefused: (url: string, host: string) => void,
  ) => void;
  /**
   * Asks the user whether the pop-up may open `host`. Aborting the signal
   * takes the question back; what it then resolves with is ignored.
   */
  readonly ask: (
    popup: Electron.BrowserWindow,
    host: string,
    signal: AbortSignal,
  ) => Promise<SignInPopupAnswer>;
  /** Lets the opener, and so the pop-up, go to `host` now, and records it for the project. */
  readonly allow: (host: string, allowAll: boolean) => void;
  /** Opens what the pop-up itself asks to open as a tab beside its opener. */
  readonly openInTab: (url: string, background: boolean) => void;
  readonly showContextMenu: (
    contents: Electron.WebContents,
    params: Electron.ContextMenuParams,
  ) => void;
  /** Tells the panel the opener has this pop-up open, or no longer has. */
  readonly report: (popupId: number, url: string, open: boolean) => void;
}

/**
 * Makes a new pop-up window behave as one: guarded, asking about sites itself,
 * titled with the site it shows. Runs before its first page loads, so nothing
 * gets past the guard.
 */
export function setUpSignInPopup(
  popup: Electron.BrowserWindow,
  requestedUrl: string,
  host: SignInPopupHost,
): void {
  const contents = popup.webContents;
  const popupId = contents.id;

  // One question at a time, and an answer only ever lets in the site it
  // named. The page can move on while the user reads: to another address on
  // the same site, which the same answer covers, or to a different site,
  // which takes the question back and asks about that one instead.
  let asking: { host: string; url: string; controller: AbortController } | null = null;
  const askAbout = (url: string, site: string) => {
    if (asking !== null && asking.host === site) {
      asking.url = url;
      return;
    }
    asking?.controller.abort();
    const question = { host: site, url, controller: new AbortController() };
    asking = question;
    void host
      .ask(popup, site, question.controller.signal)
      .catch((): SignInPopupAnswer => "decline")
      .then((answer) => {
        if (asking !== question) return;
        asking = null;
        if (popup.isDestroyed()) return;
        if (answer === "decline") {
          // A sign-in that may not reach its provider has nothing left to show.
          popup.close();
          return;
        }
        host.allow(question.host, answer === "allowAllSites");
        // Loaded rather than let through, since the navigation was already
        // stopped. Its redirects still pass the guard.
        void contents.loadURL(question.url).catch(() => {});
      });
  };
  host.guard(contents, askAbout);

  // The site first, so a long page title cannot push it out of sight.
  const showSite = () => {
    if (popup.isDestroyed()) return;
    const url = contents.getURL();
    const site = siteOf(url);
    const title = contents.getTitle();
    popup.setTitle(
      site === "" ? "Sign in" : title === "" || title === url ? site : `${site} · ${title}`,
    );
  };
  popup.on("page-title-updated", (event) => {
    event.preventDefault();
    showSite();
  });
  contents.on("did-navigate", showSite);

  // Never a window from a window: whatever the pop-up opens goes to the panel.
  contents.setWindowOpenHandler(({ url, disposition }) => {
    host.openInTab(url, disposition === "background-tab");
    return { action: "deny" };
  });
  // Paste matters here more than anywhere: this is where passwords go.
  contents.on("context-menu", (event, params) => {
    event.preventDefault();
    host.showContextMenu(contents, params);
  });

  host.report(popupId, requestedUrl, true);
  popup.once("closed", () => {
    asking?.controller.abort();
    asking = null;
    host.report(popupId, requestedUrl, false);
  });
}

/** The site an address shows, port included, or "" for one that is not a web page. */
export function siteOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : "";
  } catch {
    return "";
  }
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
}

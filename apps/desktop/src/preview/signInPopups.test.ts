import { describe, expect, it, vi } from "vite-plus/test";
import type * as Electron from "electron";

import {
  isSignInPopupRequest,
  setUpSignInPopup,
  signInPopupWindowOptions,
  type SignInPopupAnswer,
  type SignInPopupHost,
} from "./signInPopups.ts";

describe("isSignInPopupRequest", () => {
  it("gives a window only to requests made with window features", () => {
    const popup = { disposition: "new-window", features: "width=500,height=600" };
    expect(isSignInPopupRequest({ ...popup, url: "https://accounts.example.com/o/auth" })).toBe(
      true,
    );
    // Opened blank and pointed at the provider once the library knows where.
    expect(isSignInPopupRequest({ ...popup, url: "about:blank" })).toBe(true);
    expect(isSignInPopupRequest({ ...popup, url: "javascript:alert(1)" })).toBe(false);
    // Shift-click asks for a window too, but with no features: a tab.
    expect(
      isSignInPopupRequest({ disposition: "new-window", features: "", url: "https://a.test/" }),
    ).toBe(false);
    expect(
      isSignInPopupRequest({ disposition: "foreground-tab", features: "", url: "https://a.test/" }),
    ).toBe(false);
  });
});

describe("signInPopupWindowOptions", () => {
  it("takes only the size from the page, so the frame and title always show", () => {
    const parent = {
      getBounds: () => ({ x: 100, y: 50, width: 1400, height: 900 }),
    } as Electron.BrowserWindow;

    const options = signInPopupWindowOptions(
      {
        width: 480,
        height: 20,
        x: -4000,
        y: -4000,
        frame: false,
        alwaysOnTop: true,
        titleBarStyle: "hidden",
        webPreferences: { sandbox: false, preload: "/evil.js", contextIsolation: false },
      },
      parent,
    );

    expect(options).toMatchObject({ width: 480, height: 320, x: 560, y: 340, parent });
    expect(options).not.toHaveProperty("frame");
    expect(options).not.toHaveProperty("alwaysOnTop");
    expect(options).not.toHaveProperty("titleBarStyle");
    expect(options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(options.webPreferences).not.toHaveProperty("preload");
  });
});

describe("setUpSignInPopup", () => {
  /** A pop-up window and the app around it, with each question's answer held until given. */
  function harness() {
    const contentsHandlers = new Map<string, (...args: unknown[]) => void>();
    let closedHandler = () => {};
    const contents = {
      id: 31,
      getURL: () => "about:blank",
      getTitle: () => "",
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        contentsHandlers.set(event, handler);
      }),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(() => Promise.resolve()),
    };
    let destroyed = false;
    const popup = {
      webContents: contents,
      on: vi.fn(),
      once: vi.fn((event: string, handler: () => void) => {
        if (event === "closed") closedHandler = handler;
      }),
      isDestroyed: () => destroyed,
      destroy: vi.fn(() => {
        destroyed = true;
        closedHandler();
      }),
      setTitle: vi.fn(),
    };
    let refuse: (url: string, host: string) => void = () => {};
    const questions: Array<{
      host: string;
      signal: AbortSignal;
      answer: (answer: SignInPopupAnswer) => Promise<void>;
    }> = [];
    const host = {
      guard: vi.fn((_contents, onRefused) => {
        refuse = onRefused;
      }),
      ask: vi.fn(
        (_popup, site: string, signal: AbortSignal) =>
          new Promise<SignInPopupAnswer>((resolve) => {
            questions.push({
              host: site,
              signal,
              // Settled, then a turn for the answer to be acted on.
              answer: (answer) => {
                resolve(answer);
                return new Promise((done) => setTimeout(done, 0));
              },
            });
          }),
      ),
      allow: vi.fn(),
      openInTab: vi.fn(),
      showContextMenu: vi.fn(),
      report: vi.fn(),
    } satisfies SignInPopupHost;
    setUpSignInPopup(
      popup as unknown as Electron.BrowserWindow,
      "https://accounts.example.com/o/auth",
      host,
    );
    return {
      popup,
      contents,
      host,
      questions,
      refuse: (url: string, site: string) => refuse(url, site),
      navigate: (url: string) =>
        contentsHandlers.get("did-start-navigation")?.({
          url,
          isMainFrame: true,
          isSameDocument: false,
        }),
    };
  }

  it("opens a refused site once the user allows it, and only that site", async () => {
    const { contents, host, questions, refuse } = harness();

    refuse("https://accounts.example.com/o/auth", "accounts.example.com");
    // The page moves on within the same site: the same question covers it.
    refuse("https://accounts.example.com/o/auth?step=2", "accounts.example.com");
    expect(questions.map((question) => question.host)).toEqual(["accounts.example.com"]);

    await questions[0]!.answer("allowSite");

    expect(host.allow).toHaveBeenCalledWith("accounts.example.com", false);
    expect(contents.loadURL).toHaveBeenCalledWith("https://accounts.example.com/o/auth?step=2");
  });

  it("asks again when the page moves to another site, and never loads the first", async () => {
    const { popup, contents, host, questions, refuse } = harness();

    refuse("https://accounts.example.com/o/auth", "accounts.example.com");
    refuse("https://elsewhere.test/login", "elsewhere.test");

    // The first question is taken back; an answer to it now does nothing.
    expect(questions[0]!.signal.aborted).toBe(true);
    await questions[0]!.answer("allowSite");
    expect(host.allow).not.toHaveBeenCalled();
    expect(contents.loadURL).not.toHaveBeenCalled();

    // Saying no to the site it is on now ends the sign-in.
    expect(questions[1]!.host).toBe("elsewhere.test");
    await questions[1]!.answer("decline");
    expect(popup.destroy).toHaveBeenCalled();
    expect(contents.loadURL).not.toHaveBeenCalled();
  });

  it("takes the question back when the page heads to another site, even an allowed one", async () => {
    const { contents, host, questions, refuse, navigate } = harness();

    refuse("https://accounts.example.com/o/auth", "accounts.example.com");
    navigate("http://localhost:5173/callback");

    expect(questions[0]!.signal.aborted).toBe(true);
    await questions[0]!.answer("allowSite");
    expect(host.allow).not.toHaveBeenCalled();
    expect(contents.loadURL).not.toHaveBeenCalled();
  });

  it("tells the panel when it opens and closes, and drops its question on closing", () => {
    const { popup, host, questions, refuse } = harness();
    expect(host.report).toHaveBeenCalledWith(31, "https://accounts.example.com/o/auth", true);

    refuse("https://accounts.example.com/o/auth", "accounts.example.com");
    popup.destroy();

    expect(questions[0]!.signal.aborted).toBe(true);
    expect(host.report).toHaveBeenLastCalledWith(31, "https://accounts.example.com/o/auth", false);
  });
});

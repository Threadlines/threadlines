import "../index.css";

import { THEME_FILE_FORMAT, type ThemeManifest } from "@threadlines/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import monoFontUrl from "@fontsource-variable/cascadia-mono/files/cascadia-mono-latin-wght-normal.woff2?url";

import { useAgentPageTheme } from "../components/chat/agentPageClient";
import { resetTestPage } from "../lib/testPage.browser-harness";
import { resolveThemeTokens } from "@threadlines/shared/themeTokens";

import { measureBackdropZones } from "./backdropZones";
import { cssGlassTints, glassFloors, glassTintCss } from "./glass";
import { applyGlassTints } from "./themeApply";
import {
  THEME_PAINT_STORAGE_KEY,
  THEME_STORAGE_KEY,
  serializeThemeChoice,
  themeChoiceKey,
} from "./themeChoice";
import { adoptStoredThemeChoice, chooseTheme, endThemeTrial, startThemeTrial } from "./themeStore";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const darkTheme = (foreground: string, extra: Partial<ThemeManifest> = {}): ThemeManifest => ({
  format: THEME_FILE_FORMAT,
  name: "Winter night",
  base: "dark",
  colors: {
    background: "#0a1029",
    foreground,
    mutedForeground: "#a3aed2",
    accent: "#2fd6b0",
    accentForeground: "#03231c",
  },
  ...extra,
});

const lightTheme: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Dunes",
  base: "light",
  colors: {
    background: "#fbf6ee",
    foreground: "#2a1f16",
    mutedForeground: "#6f5b48",
    accent: "#b8532a",
    accentForeground: "#fff7ef",
  },
};

const unsaved = (hash: string, name: string) => ({ kind: "unsaved" as const, hash, name });

const root = () => document.documentElement;
const token = (name: string) => getComputedStyle(root()).getPropertyValue(`--${name}`).trim();

/** What a built-in theme puts on the document: the tokens index.css declares and the classes. */
function builtinSnapshot() {
  return {
    dark: root().classList.contains("dark"),
    theme: root().getAttribute("data-theme"),
    glass: root().hasAttribute("data-glass"),
    style: document.getElementById("tl-theme"),
    background: token("background"),
    foreground: token("foreground"),
    surface: token("surface-solid"),
    sans: token("font-sans"),
  };
}

describe("theme store, applied", () => {
  afterEach(async () => {
    chooseTheme({ kind: "builtin", id: "light" });
    applyGlassTints(null);
    await resetTestPage();
  });

  it("puts a custom theme's tokens and base on the document, and a built-in back exactly as it was", async () => {
    chooseTheme({ kind: "builtin", id: "light" });
    const before = builtinSnapshot();
    expect(before).toMatchObject({ dark: false, theme: null, glass: false, style: null });

    const dark = startThemeTrial({
      choice: unsaved(HASH_A, "Winter night"),
      manifest: darkTheme("#e7ecff"),
    });
    // The first custom theme waits for the token code; later ones apply at once.
    await vi.waitFor(() => expect(root().getAttribute("data-theme-version")).toBe(HASH_A));
    expect(root().classList.contains("dark")).toBe(true);
    expect(token("background")).toBe("#0a1029");
    expect(token("foreground")).toBe("#e7ecff");
    expect(token("surface-solid")).toBe("#0a1029");

    const light = startThemeTrial({ choice: unsaved(HASH_B, "Dunes"), manifest: lightTheme });
    expect(root().classList.contains("dark")).toBe(false);
    expect(token("background")).toBe("#fbf6ee");

    endThemeTrial(light.id);
    endThemeTrial(dark.id);
    expect(builtinSnapshot()).toEqual(before);
  });

  it("draws glass only for a theme with art: clear canvas layers, tinted surfaces, opaque sticky headers, no fades", async () => {
    const screen = await render(
      <div data-slot="sidebar-wrapper" className="bg-frame">
        <div data-slot="app-titlebar" data-testid="title" className="bg-frame" />
        <div data-slot="app-panel" data-testid="panel" className="bg-background">
          <div data-chat-view="" data-testid="view" className="bg-background">
            <div data-chat-column="" data-testid="column">
              <div data-testid="sticky" className="surface-group-solid" />
              <div data-testid="fade" className="glass-fade" />
            </div>
          </div>
          <div data-empty-home="" data-testid="home" className="bg-background" />
        </div>
      </div>,
    );
    // ThemeBackdropLayer marks a page the art shows on; the home screen is one.
    root().setAttribute("data-glass-page", "chat");
    // How opaque a surface's fill is (color-mix() computes to color(srgb ... / a)).
    const alpha = (testId: string) => {
      const value = getComputedStyle(screen.getByTestId(testId).element()).backgroundColor;
      const slash = /\/\s*([\d.]+)\)$/.exec(value);
      if (slash) return Number(slash[1]);
      const rgba = /^rgba\(.*,\s*([\d.]+)\)$/.exec(value);
      return rgba ? Number(rgba[1]) : 1;
    };
    try {
      // A custom theme without art changes no surface.
      const plain = startThemeTrial({
        choice: unsaved(HASH_A, "Winter night"),
        manifest: darkTheme("#e7ecff"),
      });
      expect(root().hasAttribute("data-glass")).toBe(false);
      expect(alpha("panel")).toBe(1);
      endThemeTrial(plain.id);

      const glass = { frame: 0.7, list: 0.6, column: 0.5, composer: 0.8, blur: 16 };
      const withArt = darkTheme("#e7ecff", {
        glass,
        backdrop: { mode: "grid", script: "threadlines.backdrop({})", maxFps: 12 },
      });
      startThemeTrial({ choice: unsaved(HASH_B, "Aurora"), manifest: withArt });
      expect(root().hasAttribute("data-glass")).toBe(true);
      expect(alpha("panel")).toBe(0);
      expect(alpha("view")).toBe(0);
      // Before the art reports, text surfaces stay opaque.
      expect(alpha("title")).toBe(1);
      expect(getComputedStyle(screen.getByTestId("fade").element()).display).toBe("none");

      // The art runs: its frame tints the zones, so the surfaces turn clear.
      const floors = glassFloors(glass, "some");
      applyGlassTints(
        glassTintCss(
          cssGlassTints(
            floors,
            { kind: "running", fps: 12, msPerSecond: 3, energy: "light", throttled: false },
            false,
          ),
        ),
      );
      expect(alpha("title")).toBe(0);
      expect(alpha("column")).toBe(0);
      expect(alpha("home")).toBe(0);

      // The still instead: each surface paints its floor, raised to the still's minimum.
      applyGlassTints(
        glassTintCss(
          cssGlassTints(floors, { kind: "still", reason: "motion", minimumTint: 0.65 }, false),
        ),
      );
      expect(alpha("title")).toBeCloseTo(0.7, 2);
      expect(alpha("column")).toBeCloseTo(0.65, 2);
      // The home screen's text keeps a tint over the still too.
      expect(alpha("home")).toBeCloseTo(0.65, 2);
      // Sticky headers hide what scrolls under them.
      expect(alpha("sticky")).toBe(1);
    } finally {
      root().removeAttribute("data-glass-page");
      await screen.unmount();
    }
  });

  it("loads a theme's fonts when its content arrives after its colors", async () => {
    // Another window keeps a theme this window has never held: its colors come
    // from the paint record at once, its content only once IndexedDB answers.
    const bytes = new Uint8Array(await (await fetch(monoFontUrl)).arrayBuffer());
    const data = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
    const manifest = darkTheme("#e7ecff", {
      fonts: { mono: { family: "Cascadia Mono", source: "google", weight: 400, data } },
    });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("threadlines-themes", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("contents", { keyPath: "hash" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("contents", "readwrite");
      transaction.objectStore("contents").put({ hash: HASH_C, manifest, usedAt: Date.now() });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
    const choice = unsaved(HASH_C, "Winter night");
    const tokens = resolveThemeTokens(manifest);
    localStorage.setItem(THEME_STORAGE_KEY, serializeThemeChoice(choice, "dark"));
    localStorage.setItem(
      THEME_PAINT_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        key: themeChoiceKey(choice),
        hash: HASH_C,
        base: "dark",
        surface: tokens["surface-solid"],
        tokens,
        glass: false,
      }),
    );

    adoptStoredThemeChoice();
    const family = `TL Theme Mono ${HASH_C.slice(0, 12)}`;
    await expect
      .poll(() =>
        Array.from(document.fonts).some(
          (face) => face.family === family && face.status === "loaded",
        ),
      )
      .toBe(true);
    expect(token("font-mono").startsWith(`"${family}"`)).toBe(true);
  });

  it("hands agent pages new tokens on a same-base switch", async () => {
    function Probe() {
      return <output>{useAgentPageTheme().variables["--foreground"]}</output>;
    }
    const screen = await render(<Probe />);
    const pageForeground = screen.getByRole("status");
    try {
      startThemeTrial({ choice: unsaved(HASH_A, "Winter night"), manifest: darkTheme("#e7ecff") });
      await expect.element(pageForeground).toHaveTextContent("#e7ecff");
      // Another dark theme: the light-or-dark doesn't move, the page's colors must.
      const second = startThemeTrial({
        choice: unsaved(HASH_B, "Ink"),
        manifest: darkTheme("#ffd6e8"),
      });
      await expect.element(pageForeground).toHaveTextContent("#ffd6e8");
      endThemeTrial(second.id);
    } finally {
      await screen.unmount();
    }
  });
});

describe("backdrop zones", () => {
  afterEach(async () => {
    await resetTestPage();
  });

  it("lets the art show on the home screen, frosting each block of its text", async () => {
    const screen = await render(
      <div style={{ position: "fixed", inset: 0 }}>
        <div data-slot="app-panel" style={{ position: "absolute", inset: 0 }}>
          <div
            data-empty-home=""
            style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              {/* Mid fade-in: invisible and 7 px below where it settles. */}
              <h2 style={{ margin: 0, opacity: 0, transform: "translateY(7px)" }}>
                Start your first thread
              </h2>
              <p style={{ margin: "8px 0 28px" }}>Start a general chat, or add a project.</p>
              <button type="button">New general chat</button>
              <p style={{ marginTop: 120 }}>Star on GitHub</p>
            </div>
          </div>
        </div>
      </div>,
    );
    try {
      const { zones, chatShown } = measureBackdropZones(
        document,
        { width: window.innerWidth, height: window.innerHeight },
        resolveThemeTokens(darkTheme("#e7ecff")),
        glassFloors({ frame: 0.7, list: 0.6, column: 0.5, composer: 0.8, blur: 16 }, "some"),
      );
      expect(chatShown).toBe(true);
      const contains = (id: string, text: string, shift = 0) => {
        const zone = zones.find((candidate) => candidate.id === id);
        const element = [...document.querySelectorAll("h2, p, button")].find(
          (candidate) => candidate.textContent === text,
        )!;
        // The patch hugs the text itself, not the element's padding.
        const range = document.createRange();
        range.selectNodeContents(element);
        const box = range.getBoundingClientRect();
        const core = zone!.core;
        return (
          core.x <= box.left + 1 &&
          core.y <= box.top + shift + 1 &&
          core.x + core.w >= box.right - 1 &&
          core.y + core.h >= box.bottom + shift - 1
        );
      };
      // The heading, its line and the button share a patch; the links far below get their own.
      expect(zones.map((zone) => zone.id)).toEqual(["home-0", "home-1"]);
      // The fading heading counts, where it is now and where it settles.
      expect(contains("home-0", "Start your first thread")).toBe(true);
      expect(contains("home-0", "Start your first thread", -7)).toBe(true);
      expect(contains("home-0", "New general chat")).toBe(true);
      expect(contains("home-1", "Star on GitHub")).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("frosts the frame, list and composer hard (the composer rounded like its outline), and the reading column soft around the messages", async () => {
    const at = (left: number, top: number, width: number, height: number) =>
      ({ position: "absolute", left, top, width, height }) as const;
    const screen = await render(
      <div style={{ position: "fixed", inset: 0 }}>
        <div data-slot="app-titlebar" style={at(0, 0, 1000, 38)} />
        <nav data-slot="navigation-rail" style={at(0, 38, 48, 600)} />
        <div data-slot="app-panel" style={{ ...at(48, 38, 952, 600), overflow: "hidden" }}>
          <div data-slot="sidebar">
            <div data-slot="sidebar-container">
              <div data-slot="sidebar-inner" style={at(0, 0, 250, 600)} />
            </div>
          </div>
          <div data-chat-view="" style={at(250, 0, 702, 600)}>
            <div data-chat-column="" style={{ position: "absolute", inset: 0 }}>
              <div data-timeline-root="" style={at(151, 0, 400, 500)} />
              <form data-chat-composer-form="" style={at(151, 510, 400, 80)}>
                {/* Something stacked above the composer's outline, which has its own surface. */}
                <div
                  data-chat-composer-frame=""
                  style={{ ...at(0, 20, 400, 60), borderRadius: "13px 13px 13px 0" }}
                />
              </form>
            </div>
          </div>
        </div>
      </div>,
    );
    try {
      const tokens = resolveThemeTokens(darkTheme("#e7ecff"));
      const floors = glassFloors(
        { frame: 0.7, list: 0.6, column: 0.5, composer: 0.8, blur: 16 },
        "some",
      );
      const { zones, chatShown } = measureBackdropZones(
        document,
        { width: window.innerWidth, height: window.innerHeight },
        tokens,
        floors,
      );
      expect(chatShown).toBe(true);
      const byId = Object.fromEntries(zones.map((zone) => [zone.id, zone]));
      // Hard zones reach one px past their boxes, so the borders between them frost too.
      expect(byId.title).toMatchObject({
        edge: "hard",
        rect: { x: -1, y: -1, w: 1002, h: 40 },
        tint: 0.7,
      });
      expect(byId["rail-0"]).toMatchObject({ rect: { x: -1, y: 37, w: 50, h: 602 } });
      expect(byId.list).toMatchObject({ rect: { x: 47, y: 37, w: 252, h: 602 }, tint: 0.6 });
      expect(byId.column).toMatchObject({
        edge: "soft",
        // The messages and the composer, the full height of the column...
        core: { x: 449, y: 38, w: 400, h: 600 },
        // ...frosted a margin wider on each side.
        rect: { x: 401, y: 38, w: 496, h: 600 },
        tint: 0.5,
        tintColor: "#0a1029",
      });
      // The composer's outline, not the whole form; its rounded corners grow a px with it.
      expect(byId.composer).toMatchObject({
        edge: "hard",
        rect: { x: 448, y: 567, w: 402, h: 62 },
        radii: [14, 14, 14, 0],
        tint: 0.8,
      });
    } finally {
      await screen.unmount();
    }
  });
});

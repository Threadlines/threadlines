import { describe, expect, it } from "vite-plus/test";

import { color, contrastRatio } from "./color.ts";
import { checkThemeManifest } from "./manifest.ts";
import { themeForSharing } from "./sharing.ts";
import { themeShowcaseProblems } from "./showcase.ts";
import {
  convertVsCodeTheme,
  isVsCodeThemeFile,
  joinThemePath,
  parseJsonWithComments,
  readVsCodeTheme,
  vsCodeThemeLicense,
} from "./vscode.ts";

const files = (entries: Record<string, string>) => async (path: string) => entries[path] ?? null;

describe("VS Code themes", () => {
  it("reads theme files the way VS Code does: comments, trailing commas, a byte-order mark", () => {
    expect(
      parseJsonWithComments(
        '﻿{\n // a note\n "a": "http://x // not a comment", /* block */\n "b": [1, 2,],\n}',
      ),
    ).toEqual({ a: "http://x // not a comment", b: [1, 2] });
    expect(() => parseJsonWithComments("{ nope }")).toThrow();
  });

  it("follows include chains inside the extension, the including file winning", async () => {
    const theme = await readVsCodeTheme(
      "extension/themes/storm.json",
      files({
        "extension/themes/storm.json": JSON.stringify({
          include: "./base.json",
          colors: { "editor.background": "#24283b" },
          tokenColors: [{ scope: "comment", settings: { foreground: "#565f89" } }],
        }),
        "extension/themes/base.json": JSON.stringify({
          type: "dark",
          colors: { "editor.background": "#1a1b26", "editor.foreground": "#a9b1d6" },
          tokenColors: [{ scope: "comment", settings: { foreground: "#444b6a" } }],
        }),
      }),
    );
    expect(theme.type).toBe("dark");
    expect(theme.colors).toEqual({
      "editor.background": "#24283b",
      "editor.foreground": "#a9b1d6",
    });
    // The including file's rule comes later, so it wins.
    expect(theme.tokenColors.map((rule) => rule.settings.foreground)).toEqual([
      "#444b6a",
      "#565f89",
    ]);

    expect(joinThemePath("extension/package.json", "./themes/a.json")).toBe(
      "extension/themes/a.json",
    );
    expect(joinThemePath("extension/package.json", "../../etc/passwd")).toBeNull();
    expect(joinThemePath("extension/package.json", "/etc/passwd")).toBeNull();
    await expect(
      readVsCodeTheme("extension/a.json", files({ "extension/a.json": '{"include":"./a.json"}' })),
    ).rejects.toThrow(/too deeply/);
  });

  it("brings over the editor's colors, the syntax colors and the terminal, and stays readable", () => {
    const terminal = Object.fromEntries(
      ["Black", "Red", "Green", "Yellow", "Blue", "Magenta", "Cyan", "White"].flatMap((name, i) => [
        [
          `terminal.ansi${name}`,
          ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6"][
            i
          ]!,
        ],
        [
          `terminal.ansiBright${name}`,
          ["#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"][
            i
          ]!,
        ],
      ]),
    );
    const result = convertVsCodeTheme({
      label: "Night",
      uiTheme: "vs-dark",
      source: {
        extension: "someone.night",
        version: "1.0.0",
        license: "MIT",
        author: "Someone",
        link: "https://example.com/night",
      },
      theme: {
        colors: {
          "editor.background": "#1a1b26",
          "editor.foreground": "#a9b1d6",
          descriptionForeground: "#9699a3",
          // A gray button is passed over for a color with some color in it.
          "button.background": "#3b3e52",
          focusBorder: "#7aa2f7",
          "sideBar.background": "#16161e",
          ...terminal,
        },
        tokenColors: [
          { scope: "keyword", settings: { foreground: "#bb9af7" } },
          { scope: "keyword.operator", settings: { foreground: "#89ddff" } },
          { scope: ["string", "string.quoted.double"], settings: { foreground: "#9ece6a" } },
          // Language-specific rules don't count.
          { scope: "source.js keyword.control", settings: { foreground: "#ff0000" } },
          { scope: "comment, punctuation.definition.comment", settings: { foreground: "#565f89" } },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { manifest } = result;
    expect(checkThemeManifest(manifest).ok).toBe(true);
    expect(manifest).toMatchObject({
      name: "Night",
      base: "dark",
      // The background never moves; the text may, a step brighter, to read on cards and menus.
      colors: { background: "#1a1b26", accent: "#7aa2f7" },
      overrides: { sidebar: "#16161e" },
      code: { keyword: "#bb9af7", operator: "#89ddff", string: "#9ece6a" },
      credits: { author: "Someone", link: "https://example.com/night", license: "MIT" },
      createdBy: {
        kind: "imported",
        vscode: { extension: "someone.night", theme: "Night", license: "MIT" },
      },
    });
    expect(manifest.terminal).toHaveLength(16);
    // The comment color, too dim on this background, was moved until it reads, hue kept.
    const comment = color(manifest.code!.comment!);
    expect(contrastRatio(comment, color("#1a1b26"))).toBeGreaterThan(2.9);
    expect(result.adjusted).toBeGreaterThan(0);
  });

  it("draws a pale theme as light, fills what's missing, and only credits licenses a theme can carry", () => {
    const result = convertVsCodeTheme({
      label: "Paper",
      // Declared dark, but its editor is pale.
      uiTheme: "vs-dark",
      source: { license: "Apache-2.0", author: "Someone" },
      theme: { colors: { "editor.background": "#fdf6e3" }, tokenColors: [] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.base).toBe("light");
    expect(result.manifest.terminal).toBeUndefined();
    // Marked as from VS Code even with no extension named: a file on its own.
    expect(result.manifest.credits).toEqual({ author: "Someone", vscode: "file" });
    expect(result.manifest.createdBy).toMatchObject({ vscode: { license: "Apache-2.0" } });
  });

  it("uses a theme's unscoped token rule as its text, and credits a name, never an address", () => {
    const result = convertVsCodeTheme({
      label: "Plain",
      source: { author: "ann@example.com Ann Lee", license: "MIT" },
      theme: {
        colors: { "editor.background": "#101010" },
        tokenColors: [{ settings: { foreground: "#e0e0b0" } }],
      },
    });
    if (!result.ok) return expect.fail(result.problem);
    expect(result.manifest.colors.foreground).toBe("#e0e0b0");
    // Code text too, though the theme sets no other syntax color.
    expect(result.manifest.code).toEqual({ foreground: "#e0e0b0" });
    expect(result.manifest.credits?.author).toBe("Ann Lee");
  });

  it("keeps where it came from in a shared file, so the Showcase still turns it away", () => {
    const result = convertVsCodeTheme({
      label: "Night",
      source: { extension: "someone.night", license: "MIT", author: "Someone" },
      theme: { colors: { "editor.background": "#1a1b26" }, tokenColors: [] },
    });
    if (!result.ok) return expect.fail(result.problem);
    const shared = themeForSharing(result.manifest, {
      name: "Mine now",
      includePrompt: false,
      credits: { author: "Me", license: "CC0-1.0" },
    });
    expect(shared.credits?.vscode).toBe("someone.night");
    expect(themeShowcaseProblems(shared).some((problem) => problem.includes("VS Code"))).toBe(true);
  });

  it("tells VS Code theme files and open licenses apart", () => {
    expect(isVsCodeThemeFile({ colors: {}, tokenColors: [] })).toBe(true);
    expect(isVsCodeThemeFile({ format: "threadlines-theme@1", colors: {} })).toBe(false);
    expect(vsCodeThemeLicense("mit")).toBe("MIT");
    expect(vsCodeThemeLicense("SEE LICENSE IN LICENSE.txt")).toBeNull();
    expect(vsCodeThemeLicense("GPL-3.0")).toBeNull();
  });
});

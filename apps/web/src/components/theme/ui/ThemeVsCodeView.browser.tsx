import "../../../index.css";

import {
  THEME_FILE_FORMAT,
  type ThemeManifest,
  type ThemeVsCodeExtension,
  type ThemeVsCodePackage,
} from "@threadlines/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { resetTestPage } from "../../../lib/testPage.browser-harness";

const extension: ThemeVsCodeExtension = {
  namespace: "someone",
  name: "night",
  version: "1.0.0",
  displayName: "Night Pack",
  publisher: "someone",
  description: "",
  downloads: 10,
  license: "MIT",
  themeCount: 2,
};

const theme = (label: string, background: string, adjusted: number) => {
  const manifest: ThemeManifest = {
    format: THEME_FILE_FORMAT,
    name: label,
    base: "dark",
    colors: {
      background,
      foreground: "#e7ecff",
      mutedForeground: "#a3aed2",
      accent: "#2fd6b0",
      accentForeground: "#03231c",
    },
    credits: { author: "Someone", license: "MIT" },
  };
  return {
    label,
    file: `extension/themes/${background}.json`,
    base: "dark" as const,
    colors: { background, foreground: "#e7ecff", accent: "#2fd6b0" },
    manifest,
    adjusted,
  };
};

const pack: ThemeVsCodePackage = {
  extension,
  themes: [theme("Night", "#0a1029", 0), theme("Night Storm", "#24283b", 3)],
  skipped: [{ label: "Night Glow", reason: "Its file is outside the extension." }],
};
const twins: ThemeVsCodePackage = {
  extension,
  themes: [theme("Night", "#0a1029", 0), theme("Night", "#24283b", 0)],
  skipped: [],
};
let shown: ThemeVsCodePackage = pack;

const vscode = vi.hoisted(() => ({ tryTheme: vi.fn(), addThemes: vi.fn() }));
vi.mock("~/themeLibrary/themeVsCode", () => ({
  useVsCodeEnvironments: () => [{ environmentId: "env-1" }],
  useVsCodeSearch: () => ({
    extensions: [extension],
    loading: false,
    error: null,
    incomplete: false,
    more: null,
    retry: () => {},
  }),
  useVsCodePackage: () => shown,
  loadVsCodePackage: () => Promise.resolve(pack),
  vsCodeExtensionKey: (entry: ThemeVsCodeExtension) => `${entry.namespace}.${entry.name}`,
  tryVsCodeTheme: vscode.tryTheme,
  addVsCodeThemes: vscode.addThemes,
}));

const { ThemeVsCodeView } = await import("./ThemeVsCodeView");

describe("ThemeVsCodeView", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    shown = pack;
    await resetTestPage();
  });

  it("tries the one theme picked, adds several straight to the library, and says what can't come over", async () => {
    vscode.tryTheme.mockResolvedValue(undefined);
    vscode.addThemes.mockResolvedValue(2);
    await render(<ThemeVsCodeView switcher={null} />);
    await page.getByRole("button", { name: /Night Pack/ }).click();

    await expect.element(page.getByText("Passes as it is.")).toBeVisible();
    await expect.element(page.getByText(/Night Glow/)).toBeVisible();
    await expect.element(page.getByText("MIT · Someone credited on the theme")).toBeVisible();
    await page.getByRole("button", { name: "Try Night" }).click();
    expect(vscode.tryTheme).toHaveBeenCalledWith(pack.themes[0]);

    await page.getByRole("button", { name: /Night Pack/ }).click();
    await page.getByRole("checkbox").nth(1).click();
    await expect
      .element(page.getByText("3 colors moved a little to stay readable", { exact: false }))
      .toBeVisible();
    await page.getByRole("button", { name: "Add 2 themes" }).click();
    expect(vscode.addThemes).toHaveBeenCalledWith(pack.themes);
  });

  it("picks two themes of the same name one at a time", async () => {
    shown = twins;
    await render(<ThemeVsCodeView switcher={null} />);
    await page.getByRole("button", { name: /Night Pack/ }).click();
    await expect.element(page.getByRole("button", { name: "Try Night" })).toBeVisible();
    await page.getByRole("checkbox").nth(1).click();
    await expect.element(page.getByRole("button", { name: "Add 2 themes" })).toBeVisible();
  });

  it("can't confirm with nothing picked", async () => {
    await render(<ThemeVsCodeView switcher={null} />);
    await page.getByRole("button", { name: /Night Pack/ }).click();
    await page.getByRole("checkbox").first().click();
    await expect.element(page.getByRole("button", { name: "Try it" })).toBeDisabled();
  });
});

import "../../../index.css";

import { THEME_FILE_FORMAT, type ThemeManifest } from "@threadlines/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { resetTestPage } from "../../../lib/testPage.browser-harness";
import { chooseTheme, startThemeTrial, useThemeChoice } from "../../../theme/themeStore";
import { ThemeTrialBar } from "./ThemeTrialBar";

const glare: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Glare",
  base: "light",
  colors: {
    background: "#fffbe6",
    foreground: "#1f1a00",
    mutedForeground: "#5c5200",
    accent: "#7a5c00",
    accentForeground: "#ffffff",
  },
};

const token = (element: Element, name: string) =>
  getComputedStyle(element).getPropertyValue(`--${name}`).trim();

function Committed() {
  const choice = useThemeChoice();
  return (
    <output data-testid="committed">{choice.kind === "builtin" ? choice.id : choice.kind}</output>
  );
}

describe("ThemeTrialBar", () => {
  afterEach(() => {
    chooseTheme({ kind: "builtin", id: "dark" });
    resetTestPage();
  });

  it("asks to keep a trial in the built-in colors, and Undo puts the old theme back", async () => {
    chooseTheme({ kind: "builtin", id: "dark" });
    await render(
      <>
        <ThemeTrialBar />
        <Committed />
      </>,
    );
    startThemeTrial({
      choice: { kind: "unsaved", hash: "c".repeat(64), name: "Glare" },
      manifest: glare,
    });

    const bar = page.getByRole("alertdialog", { name: "Keep Glare?" });
    await expect.element(bar).toBeVisible();
    const secondsLeft = Number(/back in (\d+)s/.exec(bar.element().textContent ?? "")?.[1]);
    expect(secondsLeft).toBeGreaterThanOrEqual(13);
    // The candidate repaints the app; the bar keeps the built-in look of its base.
    expect(token(document.documentElement, "background")).toBe("#fffbe6");
    expect(token(bar.element(), "background")).toBe("oklch(0.98 0 0)");

    await page.getByRole("button", { name: "Undo" }).click();
    await expect.element(bar).not.toBeInTheDocument();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await expect.element(page.getByTestId("committed")).toHaveTextContent("dark");
  });

  it("keeps a built-in trial on Keep", async () => {
    chooseTheme({ kind: "builtin", id: "dark" });
    await render(
      <>
        <ThemeTrialBar />
        <Committed />
      </>,
    );
    startThemeTrial({ choice: { kind: "builtin", id: "light" }, manifest: null });
    await page.getByRole("button", { name: "Keep" }).click();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("committed")).toHaveTextContent("light");
  });
});

import "../../../index.css";

import { THEME_FILE_FORMAT, type ThemeManifest } from "@threadlines/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { resetTestPage } from "../../../lib/testPage.browser-harness";
import { ThemeExportDialog } from "./ThemeExportDialog";

const made: ThemeManifest = {
  format: THEME_FILE_FORMAT,
  name: "Winter Night",
  base: "dark",
  colors: {
    background: "#0b1020",
    foreground: "#e6ecff",
    mutedForeground: "#9aa6c8",
    accent: "#5fb3ff",
    accentForeground: "#04121f",
  },
  prompt: "a winter night over a quiet town",
  createdBy: { kind: "agent", agent: "Claude", threadId: "thread-private" },
};

/** Catches the file an export writes instead of downloading it. */
function catchExports() {
  const files: Blob[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((file) => {
    files.push(file as Blob);
    return "blob:caught";
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return async () => JSON.parse(await files.at(-1)!.text()) as Record<string, unknown>;
}

describe("ThemeExportDialog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem("threadlines:theme-export-credits");
    resetTestPage();
  });

  it("writes a file without the thread or the prompt, with the credit given, and remembers it", async () => {
    const exported = catchExports();
    const closed = vi.fn();
    const first = await render(
      <ThemeExportDialog manifest={made} name="Winter" onClose={closed} />,
    );
    await page.getByRole("textbox", { name: "Credit" }).fill("Will");
    // Only an https address passes.
    await page.getByRole("textbox", { name: "Link" }).fill("http://example.com");
    await expect.element(page.getByRole("button", { name: "Export" })).toBeDisabled();
    await page.getByRole("textbox", { name: "Link" }).fill("https://example.com/will");
    await page.getByRole("button", { name: "Export" }).click();

    const file = await exported();
    expect(file.name).toBe("Winter");
    expect(file).not.toHaveProperty("createdBy");
    expect(file).not.toHaveProperty("prompt");
    expect(file.credits).toEqual({
      author: "Will",
      link: "https://example.com/will",
      license: "CC-BY-4.0",
    });
    expect(closed).toHaveBeenCalled();
    await first.unmount();

    // Next time: the credit is filled in, and the prompt goes along when asked.
    await render(<ThemeExportDialog manifest={made} name="Winter" onClose={() => {}} />);
    await expect.element(page.getByRole("textbox", { name: "Credit" })).toHaveValue("Will");
    await page.getByRole("switch", { name: "Include the prompt" }).click();
    await page.getByRole("button", { name: "Export" }).click();
    expect((await exported()).prompt).toBe(made.prompt);
  });

  it("keeps the credit a theme already carries", async () => {
    const exported = catchExports();
    await render(
      <ThemeExportDialog
        manifest={{ ...made, credits: { author: "Mira", license: "CC0-1.0" } }}
        name="Winter"
        onClose={() => {}}
      />,
    );
    const credits = page.getByTestId("theme-export-credits");
    await expect.element(credits).toBeVisible();
    expect(credits.element().textContent).toBe("By Mira · CC0. The file keeps its credit.");
    await expect.element(page.getByRole("textbox", { name: "Credit" })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Export" }).click();
    expect((await exported()).credits).toEqual({ author: "Mira", license: "CC0-1.0" });
  });
});

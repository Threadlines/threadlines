import "../../../index.css";

import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { resetTestPage } from "../../../lib/testPage.browser-harness";

const library = vi.hoisted(() => ({ save: vi.fn(), replace: vi.fn(), rename: vi.fn() }));
vi.mock("~/themeLibrary/themeLibraryState", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  saveThemeToLibrary: library.save,
  replaceLibraryTheme: library.replace,
  renameLibraryTheme: library.rename,
}));

const { readThemeState, startThemeTrial } = await import("~/theme/themeStore");
const { ThemeColorEditor } = await import("./ThemeColorEditor");
const { useThemeEditorStore } = await import("./themeEditorState");
const { useThemePickerOpenStore } = await import("./themePickerOpen");

const dark = {
  key: "builtin:dark",
  name: "Dark",
  detail: "Built in",
  group: "builtin" as const,
  choice: { kind: "builtin" as const, id: "dark" as const },
  swatch: { base: "dark" as const, background: "#000", foreground: "#fff", accent: "#00f" },
  thumbnail: null,
};

const setHex = async (label: string, value: string) => {
  const input = page.getByRole("textbox", { name: `${label} hex`, exact: true });
  await input.fill(value);
  await input
    .element()
    .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
};

describe("ThemeColorEditor", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    useThemeEditorStore.getState().close();
    await resetTestPage();
  });

  it("previews each change, won't save what's hard to read until fixed, and saves a built-in as a new theme", async () => {
    library.save.mockResolvedValue({
      entry: { entryId: "e1", hash: "a".repeat(64), name: "Mine" },
      environmentId: "env-1",
    });
    useThemeEditorStore.getState().open(dark);
    // As the app mounts it: React's development double mount included.
    await render(
      <StrictMode>
        <ThemeColorEditor tile={dark} />
      </StrictMode>,
    );
    await expect
      .element(page.getByRole("textbox", { name: "Accent hex", exact: true }))
      .toBeVisible();

    await setHex("Accent", "#e0e0e0");
    await expect.element(page.getByText(/Hard to read on the accent/)).toBeVisible();
    await expect.poll(() => readThemeState().trial?.manifest?.colors.accent).toBe("#e0e0e0");
    await expect.element(page.getByRole("button", { name: "Save as new theme" })).toBeDisabled();

    await page.getByRole("button", { name: "Fix for me" }).click();
    await expect.element(page.getByText(/Moved \d+ colors? a little/)).toBeVisible();
    await page.getByRole("textbox", { name: "Theme name" }).fill("Mine");
    await page.getByRole("button", { name: "Save as new theme" }).click();
    await expect.poll(() => library.save.mock.calls.length).toBe(1);
    const [saved, name] = library.save.mock.calls[0]!;
    expect(name).toBe("Mine");
    expect(saved.colors.accent).toBe("#e0e0e0");
    expect(saved.colors.accentForeground).not.toBe("#ffffff");
  });

  it("puts back what was there when cancelled", async () => {
    const before = readThemeState().committed;
    useThemeEditorStore.getState().open(dark);
    await render(<ThemeColorEditor tile={dark} />);
    await setHex("Accent", "#ff8800");
    await expect.poll(() => readThemeState().trial?.manifest?.colors.accent).toBe("#ff8800");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => readThemeState().trial).toBeNull();
    expect(readThemeState().committed).toEqual(before);
  });

  it("leaves the theme alone when a save finishes after Cancel", async () => {
    let finish: (value: unknown) => void = () => {};
    library.save.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const before = readThemeState().committed;
    useThemeEditorStore.getState().open(dark);
    await render(<ThemeColorEditor tile={dark} />);
    await setHex("Accent", "#1d4fa8");
    await page.getByRole("button", { name: "Save as new theme" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    finish({
      entry: { entryId: "e1", hash: "b".repeat(64), name: "Dark edited" },
      environmentId: "env-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readThemeState().committed).toEqual(before);
    expect(readThemeState().trial).toBeNull();
  });

  it("closes when another theme takes over the preview", async () => {
    useThemeEditorStore.getState().open(dark);
    await render(<ThemeColorEditor tile={dark} />);
    await setHex("Accent", "#1d4fa8");
    await expect.poll(() => useThemeEditorStore.getState().trialId).not.toBeNull();
    // Another theme's Try, say.
    startThemeTrial({ choice: { kind: "builtin", id: "light" }, manifest: null });
    await expect.poll(() => useThemeEditorStore.getState().tile).toBeNull();
    expect(readThemeState().trial?.choice).toEqual({ kind: "builtin", id: "light" });
  });

  it("won't run beside an open /theme strip, and opening the same theme again keeps the preview", async () => {
    useThemeEditorStore.getState().open(dark);
    await render(<ThemeColorEditor tile={dark} />);
    await setHex("Accent", "#1d4fa8");
    await expect.poll(() => useThemeEditorStore.getState().trialId).not.toBeNull();
    const preview = useThemeEditorStore.getState().trialId;
    useThemeEditorStore.getState().open({ ...dark });
    expect(useThemeEditorStore.getState().trialId).toBe(preview);

    useThemePickerOpenStore.getState().setOpen(true);
    await expect.poll(() => useThemeEditorStore.getState().tile).toBeNull();
    expect(readThemeState().trial).toBeNull();
    useThemePickerOpenStore.getState().setOpen(false);
  });

  it("closes at once when opened with the /theme strip already open", async () => {
    useThemePickerOpenStore.getState().setOpen(true);
    useThemeEditorStore.getState().open(dark);
    await render(<ThemeColorEditor tile={dark} />);
    await expect.poll(() => useThemeEditorStore.getState().tile).toBeNull();
    useThemePickerOpenStore.getState().setOpen(false);
  });
});

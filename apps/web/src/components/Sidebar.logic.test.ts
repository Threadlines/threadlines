import { describe, expect, it } from "vitest";
import { shouldOpenProjectFolderPickerImmediately } from "./Sidebar.logic";

describe("shouldOpenProjectFolderPickerImmediately", () => {
  it("opens the folder picker immediately in Electron", () => {
    expect(
      shouldOpenProjectFolderPickerImmediately({
        isElectron: true,
      }),
    ).toBe(true);
  });

  it("still opens the folder picker immediately for mobile-width Electron layouts", () => {
    expect(
      shouldOpenProjectFolderPickerImmediately({
        isElectron: true,
      }),
    ).toBe(true);
  });

  it("keeps manual project entry outside Electron", () => {
    expect(shouldOpenProjectFolderPickerImmediately({ isElectron: false })).toBe(false);
  });
});

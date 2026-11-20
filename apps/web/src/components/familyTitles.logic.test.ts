import { describe, expect, it } from "vite-plus/test";

import { shortFamilyTitles } from "./familyTitles.logic";

describe("short titles", () => {
  it("drops a topic two or more siblings share, and leaves the rest whole", () => {
    expect(
      shortFamilyTitles([
        "Panel Jam animation timing review",
        "Panel Jam: council round two",
        "Review: last three commits on main",
        "Pull Station restructure: start the split",
        "Pull Station: Android toolchain setup",
        "pull station - iOS build",
      ]),
    ).toEqual([
      "Animation timing review",
      "Council round two",
      "Review: last three commits on main",
      "Restructure: start the split",
      "Android toolchain setup",
      "iOS build",
    ]);
  });

  it("needs a separator to call shared words a topic, and a name to drop it without one", () => {
    const plain = ["Fix the flaky test", "Fix the build"];
    expect(shortFamilyTitles(plain)).toEqual(plain);
    expect(shortFamilyTitles([...plain, "Fix: release notes", "Fix: docs"])).toEqual([
      ...plain,
      "Release notes",
      "Docs",
    ]);
  });

  it("keeps the full title where the rest would read the same as another tab, or say nothing", () => {
    expect(shortFamilyTitles(["CLI: --verbose", "CLI: verbose", "Docs"])).toEqual([
      "--verbose",
      "Verbose",
      "Docs",
    ]);
    expect(
      shortFamilyTitles(["Android: Build", "Android: Test", "iOS: Build", "iOS: Test", "Test"]),
    ).toEqual(["Android: Build", "Android: Test", "iOS: Build", "iOS: Test", "Test"]);
    expect(shortFamilyTitles(["Release: QA", "Release: Staging", "Release: x"])).toEqual([
      "QA",
      "Staging",
      "Release: x",
    ]);
    expect(shortFamilyTitles(["Docs: İstanbul setup", "Docs: Ankara setup"])).toEqual([
      "İstanbul setup",
      "Ankara setup",
    ]);
    expect(shortFamilyTitles(["İstanbul: Android setup", "İstanbul: UI polish"])).toEqual([
      "Android setup",
      "UI polish",
    ]);
    expect(
      shortFamilyTitles(["Docs: Build", "Docs: Test", "Build", "Work: Docs: Build", "Work: Notes"]),
    ).toEqual(["Docs: Build", "Test", "Build", "Work: Docs: Build", "Notes"]);
  });
});

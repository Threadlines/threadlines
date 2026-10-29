import { describe, expect, it } from "vite-plus/test";

import { readReleaseNotesEntries } from "../releaseNotesPlugin";

describe("readReleaseNotesEntries", () => {
  it("reads every reviewed changelog file, newest first, in the app's copy rules", () => {
    const entries = readReleaseNotesEntries();
    expect(entries.length).toBeGreaterThan(10);
    expect(entries[0]!.version).not.toBe(entries.at(-1)!.version);
    const v080 = entries.find((entry) => entry.version === "0.8.0");
    expect(v080?.title).toBe("Fleet: your computers work as one");
    expect(v080?.video?.src).toBe("/changelog/v0.8.0/fleet-promo.mp4");
    // Only what the app shows survives the decode.
    expect(Object.keys(v080?.highlights[0] ?? {})).toEqual(["title", "description"]);
    // The app shows every one of these, so none may break the no-em-dash rule.
    expect(JSON.stringify(entries)).not.toContain("—");
  });
});

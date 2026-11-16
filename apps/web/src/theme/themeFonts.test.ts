import { describe, expect, it } from "vite-plus/test";

import { themeFontFamily } from "./themeFonts";

const font = { family: "Inter", source: "google" as const, weight: 400, data: "d09GMgABAAAAAA" };

describe("theme font names", () => {
  it("names a font by its own bytes, so themes that differ only in color share one face", () => {
    const first = themeFontFamily({ ui: font }, "ui", "a".repeat(64));
    expect(themeFontFamily({ ui: font }, "ui", "b".repeat(64))).toBe(first);
    expect(themeFontFamily({ ui: { ...font, weight: 700 } }, "ui", "a".repeat(64))).not.toBe(first);
    expect(themeFontFamily({ mono: font }, "mono", "a".repeat(64))).not.toBe(first);
  });
});

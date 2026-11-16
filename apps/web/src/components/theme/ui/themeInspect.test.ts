import { deriveThemeTokens } from "@threadlines/shared/themeTokens";
import { describe, expect, it } from "vite-plus/test";

import { parseCssColor, pickedRoles } from "./themeInspect";

const tokens = deriveThemeTokens(
  {
    background: "#1c1c1c",
    foreground: "#e8e8e8",
    mutedForeground: "#989898",
    accent: "#3aa0e0",
    accentForeground: "#000000",
  },
  "dark",
);
const style = (patch: Partial<Record<string, string>>) => ({
  backgroundColor: "rgba(0, 0, 0, 0)",
  color: "rgb(232, 232, 232)",
  borderTopColor: "rgba(0, 0, 0, 0)",
  borderTopWidth: "0px",
  ...patch,
});

describe("what a picked spot is painted with", () => {
  it("reads computed colors", () => {
    expect(parseCssColor("rgba(232, 232, 232, 0.1)")).toEqual({ r: 232, g: 232, b: 232, a: 0.1 });
    expect(parseCssColor("rgb(1 2 3 / 50%)")).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(parseCssColor("#3aa0e0")).toEqual({ r: 58, g: 160, b: 224, a: 1 });
    // How a browser gives a mixed color, a glass tint say.
    expect(parseCssColor("color(srgb 0.9098 0.9098 0.9098 / 0.14)")).toEqual({
      r: 232,
      g: 232,
      b: 232,
      a: 0.14,
    });
    expect(parseCssColor("oklch(1 0 0)")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("lab(50 0 0)")).toBeNull();
  });

  it("names the theme color behind a button's hover, its text and its border, even when two app colors match", () => {
    const roles = pickedRoles({
      // The hover wash and the borders are the same color in this theme.
      style: style({
        backgroundColor: "rgba(232, 232, 232, 0.14)",
        borderTopColor: "rgba(232, 232, 232, 0.14)",
        borderTopWidth: "1px",
      }),
      behind: [],
      tokens,
      base: "dark",
      overrides: {},
    });
    expect(roles.map((role) => [role.part, role.color])).toEqual([
      ["background", { kind: "seed", key: "foreground" }],
      ["text", { kind: "seed", key: "foreground" }],
      ["border", { kind: "seed", key: "border" }],
    ]);
  });

  it("looks behind a see-through element, and names an override the theme sets directly", () => {
    const roles = pickedRoles({
      style: style({ color: "rgb(152, 152, 152)" }),
      behind: [style({ backgroundColor: "rgb(17, 17, 17)" })],
      tokens: { ...tokens, sidebar: "#111111" },
      base: "dark",
      overrides: { sidebar: "#111111" },
    });
    expect(roles.map((role) => [role.part, role.color])).toEqual([
      ["background", { kind: "override", token: "sidebar" }],
      ["text", { kind: "seed", key: "mutedForeground" }],
    ]);
  });
});

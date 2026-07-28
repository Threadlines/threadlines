import { describe, expect, it } from "vitest";

import { toCdpKeyDefinition, toCdpModifierBitmask } from "./keyEvents.ts";

describe("preview key events", () => {
  it("combines CDP modifier flags without counting duplicates twice", () => {
    expect(toCdpModifierBitmask(["Alt", "Control", "Meta", "Shift"])).toBe(15);
    expect(toCdpModifierBitmask(["Control", "Control", "Shift"])).toBe(10);
  });

  it.each([
    ["Enter", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }],
    ["Escape", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
    ["Tab", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }],
    ["Backspace", { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }],
    ["ArrowLeft", { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 }],
    ["ArrowUp", { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 }],
    ["ArrowRight", { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }],
    ["ArrowDown", { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }],
  ])("maps the named %s key to Chromium's keyboard fields", (key, expected) => {
    expect(toCdpKeyDefinition(key)).toEqual(expected);
  });

  it("includes text and physical-key fields for printable characters", () => {
    expect(toCdpKeyDefinition("a")).toEqual({
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      text: "a",
    });
    expect(toCdpKeyDefinition("?")).toEqual({
      key: "?",
      code: "Slash",
      windowsVirtualKeyCode: 191,
      text: "?",
    });
  });
});

import { describe, expect, it } from "vite-plus/test";

import { isEditableEventTarget } from "./editableTarget";

describe("isEditableEventTarget", () => {
  const editableTarget = { closest: (selector: string) => ({ selector }) };
  const plainTarget = { closest: () => null };

  it("recognizes targets inside editable surfaces via closest()", () => {
    expect(isEditableEventTarget(editableTarget as unknown as EventTarget)).toBe(true);
    expect(isEditableEventTarget(plainTarget as unknown as EventTarget)).toBe(false);
  });

  it("treats non-element targets (window, document, null) as non-editable", () => {
    expect(isEditableEventTarget(null)).toBe(false);
    expect(isEditableEventTarget(undefined)).toBe(false);
    expect(isEditableEventTarget({} as EventTarget)).toBe(false);
  });
});

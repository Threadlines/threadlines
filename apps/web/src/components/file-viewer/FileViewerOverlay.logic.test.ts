import { describe, expect, it } from "vite-plus/test";

import {
  applyEditSeedToEditor,
  countRenderableTextLines,
  formatRevealLineNoticeLabel,
  formatSelectedLineRangeLabel,
  isEditableEventTarget,
  isPrintableKeydown,
  isTypeToEditKeydown,
  lineEndCharacter,
  resolveCoarseLineSelection,
  resolveDoubleClickEditTarget,
  resolveRevealLineRange,
  resolveRevealLineTarget,
} from "./FileViewerOverlay.logic";

describe("countRenderableTextLines", () => {
  it("does not count a trailing final newline as a rendered extra line", () => {
    expect(countRenderableTextLines("one\ntwo\nthree\n")).toBe(3);
    expect(countRenderableTextLines("one\ntwo\nthree")).toBe(3);
  });

  it("keeps empty files addressable as one line", () => {
    expect(countRenderableTextLines("")).toBe(1);
  });
});

describe("resolveRevealLineRange", () => {
  it("clamps line targets into the rendered file range", () => {
    expect(resolveRevealLineRange({ line: 42, totalLines: 100 })).toEqual({ start: 42, end: 42 });
    expect(resolveRevealLineRange({ line: 0, totalLines: 100 })).toEqual({ start: 1, end: 1 });
    expect(resolveRevealLineRange({ line: 120, totalLines: 100 })).toEqual({
      start: 100,
      end: 100,
    });
  });

  it("keeps reveal ranges inclusive and ordered from the target line", () => {
    expect(resolveRevealLineRange({ line: 7, endLine: 11, totalLines: 20 })).toEqual({
      start: 7,
      end: 11,
    });
    expect(resolveRevealLineRange({ line: 7, endLine: 3, totalLines: 20 })).toEqual({
      start: 7,
      end: 7,
    });
    expect(resolveRevealLineRange({ line: 7, endLine: 30, totalLines: 20 })).toEqual({
      start: 7,
      end: 20,
    });
  });
});

describe("formatSelectedLineRangeLabel", () => {
  it("formats single-line and multi-line selections", () => {
    expect(formatSelectedLineRangeLabel({ start: 42, end: 42 })).toBe("L42 selected");
    expect(formatSelectedLineRangeLabel({ start: 42, end: 45 })).toBe("L42-L45 selected");
    expect(formatSelectedLineRangeLabel({ start: 45, end: 42 })).toBe("L42-L45 selected");
  });
});

describe("formatRevealLineNoticeLabel", () => {
  it("explains when a requested line is outside the current file", () => {
    expect(
      formatRevealLineNoticeLabel({
        requestedLine: 87,
      }),
    ).toBe("L87 is not available in this file");
  });
});

describe("resolveRevealLineTarget", () => {
  it("selects valid requested lines", () => {
    expect(resolveRevealLineTarget({ line: 42, totalLines: 100 })).toEqual({
      scrollRange: { start: 42, end: 42 },
      selectedRange: { start: 42, end: 42 },
      notice: null,
    });
  });

  it("scrolls near unavailable requested lines without selecting a replacement line", () => {
    expect(resolveRevealLineTarget({ line: 87, totalLines: 53 })).toEqual({
      scrollRange: { start: 53, end: 53 },
      selectedRange: null,
      notice: { requestedLine: 87 },
    });
  });
});

describe("resolveCoarseLineSelection", () => {
  it("clears when pierre reports no selection", () => {
    expect(resolveCoarseLineSelection({ start: 3, end: 3 }, null)).toBeNull();
  });

  it("passes multi-line input through untouched (managed drag / restore)", () => {
    expect(resolveCoarseLineSelection(null, { start: 2, end: 6 })).toEqual({ start: 2, end: 6 });
    expect(resolveCoarseLineSelection({ start: 1, end: 1 }, { start: 9, end: 4 })).toEqual({
      start: 9,
      end: 4,
    });
  });

  it("selects a single line on the first tap", () => {
    expect(resolveCoarseLineSelection(null, { start: 5, end: 5 })).toEqual({ start: 5, end: 5 });
  });

  it("extends from the anchor when tapping below the selection", () => {
    expect(resolveCoarseLineSelection({ start: 5, end: 5 }, { start: 9, end: 9 })).toEqual({
      start: 5,
      end: 9,
    });
  });

  it("extends into a reversed range when tapping above the anchor", () => {
    expect(resolveCoarseLineSelection({ start: 5, end: 8 }, { start: 2, end: 2 })).toEqual({
      start: 5,
      end: 2,
    });
  });

  it("keeps the original anchor when re-extending a reversed range", () => {
    expect(resolveCoarseLineSelection({ start: 5, end: 2 }, { start: 11, end: 11 })).toEqual({
      start: 5,
      end: 11,
    });
  });

  it("clears when tapping inside the selection, including its edges", () => {
    expect(resolveCoarseLineSelection({ start: 4, end: 8 }, { start: 6, end: 6 })).toBeNull();
    expect(resolveCoarseLineSelection({ start: 4, end: 8 }, { start: 4, end: 4 })).toBeNull();
    expect(resolveCoarseLineSelection({ start: 4, end: 8 }, { start: 8, end: 8 })).toBeNull();
    expect(resolveCoarseLineSelection({ start: 8, end: 4 }, { start: 5, end: 5 })).toBeNull();
  });

  it("clears when tapping the only selected line", () => {
    expect(resolveCoarseLineSelection({ start: 7, end: 7 }, { start: 7, end: 7 })).toBeNull();
  });

  it("preserves selection sides when extending", () => {
    expect(
      resolveCoarseLineSelection({ start: 3, end: 3, side: "additions" }, { start: 6, end: 6 }),
    ).toEqual({ start: 3, end: 6, side: "additions" });
  });
});

function keydown(key: string, modifiers?: Partial<Record<"alt" | "ctrl" | "meta", boolean>>) {
  return {
    key,
    altKey: modifiers?.alt ?? false,
    ctrlKey: modifiers?.ctrl ?? false,
    metaKey: modifiers?.meta ?? false,
  };
}

describe("isPrintableKeydown", () => {
  it("accepts space — mid-burst it is ordinary typing", () => {
    expect(isPrintableKeydown(keydown(" "))).toBe(true);
    expect(isPrintableKeydown(keydown("a"))).toBe(true);
  });

  it("rejects modifier chords and multi-character keys", () => {
    expect(isPrintableKeydown(keydown("a", { meta: true }))).toBe(false);
    expect(isPrintableKeydown(keydown("Enter"))).toBe(false);
    expect(isPrintableKeydown(keydown("Backspace"))).toBe(false);
  });
});

describe("isTypeToEditKeydown", () => {
  it("accepts plain printable characters, including shifted ones", () => {
    expect(isTypeToEditKeydown(keydown("a"))).toBe(true);
    expect(isTypeToEditKeydown(keydown("A"))).toBe(true);
    expect(isTypeToEditKeydown(keydown("/"))).toBe(true);
    expect(isTypeToEditKeydown(keydown("é"))).toBe(true);
  });

  it("leaves space to scrolling and multi-character keys to navigation", () => {
    expect(isTypeToEditKeydown(keydown(" "))).toBe(false);
    expect(isTypeToEditKeydown(keydown("Enter"))).toBe(false);
    expect(isTypeToEditKeydown(keydown("Escape"))).toBe(false);
    expect(isTypeToEditKeydown(keydown("ArrowDown"))).toBe(false);
    expect(isTypeToEditKeydown(keydown("F5"))).toBe(false);
  });

  it("leaves modifier chords to their hotkeys", () => {
    expect(isTypeToEditKeydown(keydown("k", { meta: true }))).toBe(false);
    expect(isTypeToEditKeydown(keydown("c", { ctrl: true }))).toBe(false);
    expect(isTypeToEditKeydown(keydown("x", { alt: true }))).toBe(false);
  });
});

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

function fakeElement(attributes: Record<string, string>): EventTarget {
  return {
    getAttribute: (name: string) => (name in attributes ? (attributes[name] ?? null) : null),
    hasAttribute: (name: string) => name in attributes,
  } as unknown as EventTarget;
}

describe("resolveDoubleClickEditTarget", () => {
  it("resolves the clicked line from the innermost data-line-index element", () => {
    const path = [
      fakeElement({}),
      fakeElement({ "data-line": "8", "data-line-index": "7" }),
      fakeElement({ "data-content": "" }),
    ];
    expect(resolveDoubleClickEditTarget(path)).toEqual({ kind: "code", lineIndex: 7 });
  });

  it("keeps line numbers and the gutter reserved for line selection", () => {
    expect(
      resolveDoubleClickEditTarget([
        fakeElement({ "data-column-number": "8", "data-line-index": "7" }),
      ]),
    ).toEqual({ kind: "line-number-gutter" });
    expect(resolveDoubleClickEditTarget([fakeElement({ "data-gutter": "" })])).toEqual({
      kind: "line-number-gutter",
    });
  });

  it("reports padding clicks (window, host, wrappers) as code without a line", () => {
    expect(resolveDoubleClickEditTarget([])).toEqual({ kind: "code", lineIndex: null });
    expect(resolveDoubleClickEditTarget([{} as EventTarget, fakeElement({})])).toEqual({
      kind: "code",
      lineIndex: null,
    });
  });
});

describe("lineEndCharacter", () => {
  it("returns the length of the addressed 0-based line", () => {
    expect(lineEndCharacter("one\nlonger line\n", 1)).toBe("longer line".length);
    expect(lineEndCharacter("one\nlonger line\n", 0)).toBe(3);
  });

  it("clamps out-of-range lines into the file", () => {
    expect(lineEndCharacter("one\ntwo", 99)).toBe(3);
    expect(lineEndCharacter("one\ntwo", -1)).toBe(3);
    expect(lineEndCharacter("", 0)).toBe(0);
  });
});

describe("applyEditSeedToEditor", () => {
  function recordingEditor() {
    const calls: string[] = [];
    return {
      calls,
      setSelections: (selections: { start: { line: number; character: number } }[]) => {
        const caret = selections[0]?.start;
        calls.push(`select ${caret?.line}:${caret?.character}`);
      },
      applyEdits: (
        edits: { range: { start: { line: number; character: number } }; newText: string }[],
        updateHistory?: boolean,
      ) => {
        const edit = edits[0];
        calls.push(
          `insert "${edit?.newText}" at ${edit?.range.start.line}:${edit?.range.start.character} history=${updateHistory}`,
        );
      },
    };
  }

  it("places the caret, replays the keystroke as an undoable edit, and advances the caret", () => {
    const editor = recordingEditor();
    applyEditSeedToEditor(editor, {
      path: "a.ts",
      line: 4,
      character: 2,
      insertText: "x",
    });
    expect(editor.calls).toEqual(["select 4:2", 'insert "x" at 4:2 history=true', "select 4:3"]);
  });

  it("replays buffered multi-keystroke input and advances the caret past all of it", () => {
    const editor = recordingEditor();
    applyEditSeedToEditor(editor, {
      path: "a.ts",
      line: 4,
      character: 2,
      insertText: "xyz",
    });
    expect(editor.calls).toEqual(["select 4:2", 'insert "xyz" at 4:2 history=true', "select 4:5"]);
  });

  it("only places the caret for seeds without replayed input (double-click entry)", () => {
    const editor = recordingEditor();
    applyEditSeedToEditor(editor, { path: "a.ts", line: 9, character: 14 });
    expect(editor.calls).toEqual(["select 9:14"]);
  });
});

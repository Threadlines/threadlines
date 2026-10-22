import { describe, expect, it } from "vite-plus/test";

import {
  placeTranscriptSelectionPopover,
  type TranscriptSelectionBox,
} from "./TranscriptSelectionPopover.logic";

const viewport = { width: 600, height: 400 };
const actions = { width: 140, height: 32 };
const note = { width: 320, height: 150 };

function textAt(top: number, height = 20) {
  return { top, bottom: top + height, left: 100, right: 300 };
}

describe("placeTranscriptSelectionPopover", () => {
  it("sits below its text, and above it once below runs out of room", () => {
    const place = (top: number) =>
      placeTranscriptSelectionPopover({
        text: textAt(top),
        clips: [],
        viewport,
        popover: actions,
        pinned: false,
        previous: null,
      });

    expect(place(100)).toEqual({ left: 130, top: 128, visible: true });
    // Scrolled 40px up, the popover moves with the text.
    expect(place(60)).toEqual({ left: 130, top: 88, visible: true });
    // Near the bottom edge it flips above instead of covering the text.
    expect(place(350)).toEqual({ left: 130, top: 310, visible: true });
  });

  it("hides the actions once their text leaves the view, and pins a note to the nearest edge", () => {
    const place = (input: {
      text: TranscriptSelectionBox | null;
      pinned: boolean;
      clips?: TranscriptSelectionBox[];
      previous?: { left: number; top: number };
    }) =>
      placeTranscriptSelectionPopover({
        text: input.text,
        clips: input.clips ?? [],
        viewport,
        popover: input.pinned ? note : actions,
        pinned: input.pinned,
        previous: input.previous ?? null,
      });

    expect(place({ text: textAt(-60), pinned: false }).visible).toBe(false);
    expect(place({ text: textAt(420), pinned: false }).visible).toBe(false);
    // A code block scrolled sideways hides the text without moving it off the list.
    const codeBlock = { top: 80, bottom: 200, left: 320, right: 580 };
    expect(place({ text: textAt(100), clips: [codeBlock], pinned: false }).visible).toBe(false);

    expect(place({ text: textAt(-60), pinned: true })).toMatchObject({ top: 12, visible: true });
    expect(place({ text: textAt(420), pinned: true })).toMatchObject({ top: 238, visible: true });
    // A note whose row the list has not drawn stays where it was last shown.
    expect(place({ text: null, pinned: true, previous: { left: 40, top: 12 } })).toEqual({
      left: 40,
      top: 12,
      visible: true,
    });
  });
});

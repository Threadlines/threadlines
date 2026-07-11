import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleTranscriptHighlightNoteFormSubmit,
  handleTranscriptHighlightNoteKeyDown,
} from "./TranscriptHighlightContextCard";

function makeKeyEvent(overrides: {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
}): ReactKeyboardEvent<HTMLTextAreaElement> & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    key: overrides.key,
    shiftKey: overrides.shiftKey ?? false,
    nativeEvent: { isComposing: overrides.isComposing ?? false },
    preventDefault: vi.fn(),
  } as unknown as ReactKeyboardEvent<HTMLTextAreaElement> & {
    preventDefault: ReturnType<typeof vi.fn>;
  };
}

describe("handleTranscriptHighlightNoteKeyDown", () => {
  it("submits and prevents a newline on Enter", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const event = makeKeyEvent({ key: "Enter" });

    handleTranscriptHighlightNoteKeyDown(event, { onSubmit, onCancel });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("inserts a newline on Shift+Enter instead of submitting", () => {
    const onSubmit = vi.fn();
    const event = makeKeyEvent({ key: "Enter", shiftKey: true });

    handleTranscriptHighlightNoteKeyDown(event, { onSubmit, onCancel: vi.fn() });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit while an IME composition is active", () => {
    const onSubmit = vi.fn();
    const event = makeKeyEvent({ key: "Enter", isComposing: true });

    handleTranscriptHighlightNoteKeyDown(event, { onSubmit, onCancel: vi.fn() });

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    const event = makeKeyEvent({ key: "Escape" });

    handleTranscriptHighlightNoteKeyDown(event, { onSubmit: vi.fn(), onCancel });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("handleTranscriptHighlightNoteFormSubmit", () => {
  it("keeps note form submits local to the highlight editor", () => {
    const onSubmit = vi.fn();
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    handleTranscriptHighlightNoteFormSubmit(event, onSubmit);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

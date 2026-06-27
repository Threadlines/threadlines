import { describe, expect, it } from "vitest";
import { MessageId } from "@threadlines/contracts";

import {
  appendTranscriptHighlightContextsToPrompt,
  extractTrailingTranscriptHighlightContexts,
  formatTranscriptHighlightContextLabel,
  formatTranscriptHighlightContextPreview,
  normalizeTranscriptHighlightContextSelection,
} from "./transcriptHighlightContext";

describe("transcriptHighlightContext", () => {
  it("normalizes highlighted text and notes", () => {
    expect(
      normalizeTranscriptHighlightContextSelection({
        sourceMessageId: MessageId.make("assistant-1"),
        sourceRole: "assistant",
        selectedText: "\n  quoted text\r\n",
        note: "\nanswer this part\n",
      }),
    ).toEqual({
      sourceMessageId: MessageId.make("assistant-1"),
      sourceRole: "assistant",
      selectedText: "  quoted text",
      note: "answer this part",
    });
  });

  it("rejects empty notes", () => {
    expect(
      normalizeTranscriptHighlightContextSelection({
        sourceMessageId: MessageId.make("assistant-1"),
        sourceRole: "assistant",
        selectedText: "quoted text",
        note: " ",
      }),
    ).toBeNull();
  });

  it("appends and extracts highlighted transcript context", () => {
    const prompt = appendTranscriptHighlightContextsToPrompt("Here is my answer", [
      {
        sourceMessageId: MessageId.make("assistant-1"),
        sourceRole: "assistant",
        selectedText: "Can you clarify this?\nAnd this line?",
        note: "This should be treated as my answer.",
      },
    ]);

    expect(prompt).toContain("<highlight_contexts>");
    expect(prompt).toContain("The user is responding to highlighted transcript text.");

    const extracted = extractTrailingTranscriptHighlightContexts(prompt);
    expect(extracted.promptText).toBe("Here is my answer");
    expect(extracted.contexts).toEqual([
      {
        sourceRole: "assistant",
        sourceMessageId: "assistant-1",
        selectedText: "Can you clarify this?\nAnd this line?",
        note: "This should be treated as my answer.",
      },
    ]);
  });

  it("formats source labels", () => {
    expect(formatTranscriptHighlightContextLabel({ sourceRole: "assistant" })).toBe(
      "Assistant highlight",
    );
    expect(formatTranscriptHighlightContextLabel({ sourceRole: "user" })).toBe("User highlight");
  });

  it("previews highlighted text on a single collapsed line", () => {
    expect(
      formatTranscriptHighlightContextPreview({
        selectedText: "  Want me to keep   poking\n  at it?  ",
      }),
    ).toBe("Want me to keep poking at it?");
  });

  it("truncates long highlight previews with an ellipsis", () => {
    const preview = formatTranscriptHighlightContextPreview({ selectedText: "x".repeat(120) });
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(56);
  });
});

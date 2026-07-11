import { MessageId, ThreadId } from "@threadlines/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import "../../index.css";

import { ComposerPendingTranscriptHighlightContexts } from "./ComposerPendingTranscriptHighlightContexts";
import type { TranscriptHighlightContextDraft } from "~/lib/transcriptHighlightContext";

function makeHighlightContext(): TranscriptHighlightContextDraft {
  return {
    id: "highlight-1",
    threadId: ThreadId.make("thread-1"),
    sourceMessageId: MessageId.make("message-1"),
    sourceRole: "assistant",
    selectedText: "The selected assistant text that needs more context.",
    note: "original note",
    createdAt: "2026-03-17T18:42:05.449Z",
  };
}

describe("ComposerPendingTranscriptHighlightContexts", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("saves an edited note without submitting the surrounding composer form", async () => {
    const onSubmit = vi.fn();
    const onUpdateNote = vi.fn();
    const screen = await render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <input name="prompt" defaultValue="send this later" />
        <ComposerPendingTranscriptHighlightContexts
          contexts={[makeHighlightContext()]}
          onRemove={vi.fn()}
          onUpdateNote={onUpdateNote}
        />
      </form>,
    );

    await page.getByLabelText("Edit note on highlighted assistant text").click();
    await page.getByLabelText("Your note").fill("updated note");
    await page.getByRole("button", { name: "Save" }).click();

    expect(onUpdateNote).toHaveBeenCalledWith("highlight-1", "updated note");
    expect(onSubmit).not.toHaveBeenCalled();

    await screen.unmount();
  });
});

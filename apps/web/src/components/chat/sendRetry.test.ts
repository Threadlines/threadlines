import { describe, expect, it } from "vite-plus/test";

import type { ComposerThreadDraftState } from "../../composerDraftStore";
import { composerContentsKey } from "./sendRetry";

const draft = (overrides: Partial<ComposerThreadDraftState> = {}) => ({
  prompt: "Explain this repo",
  attachments: [],
  terminalContexts: [],
  transcriptHighlightContexts: [],
  fileSelectionContexts: [],
  pickedElementContexts: [],
  drawingContexts: [],
  ...overrides,
});

describe("composerContentsKey", () => {
  it("changes when a highlight's note changes under the same id", () => {
    const highlight = (note: string) =>
      ({
        id: "highlight-1",
        note,
      }) as unknown as ComposerThreadDraftState["transcriptHighlightContexts"][number];
    expect(
      composerContentsKey(draft({ transcriptHighlightContexts: [highlight("shorter")] })),
    ).not.toBe(composerContentsKey(draft({ transcriptHighlightContexts: [highlight("longer")] })));
    expect(composerContentsKey(draft())).toBe(composerContentsKey(draft()));
  });
});

import { ThreadId } from "@threadlines/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingTerminalContextChip } from "./ComposerPendingTerminalContexts";

describe("ComposerPendingTerminalContextChip", () => {
  it("renders a preview trigger for terminal contexts attached to the composer", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingTerminalContextChip
        context={{
          id: "ctx-terminal",
          threadId: ThreadId.make("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 2,
          lineEnd: 4,
          text: "vp lint\npassed",
          createdAt: "2026-03-17T18:42:05.449Z",
        }}
      />,
    );

    expect(markup).toContain('aria-label="Preview Terminal 1 lines 2-4"');
    expect(markup).toContain("Terminal 1 lines 2-4");
    expect(markup).not.toContain('data-terminal-context-expired="true"');
  });

  it("renders a compact remove affordance when removal is enabled", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingTerminalContextChip
        context={{
          id: "ctx-terminal",
          threadId: ThreadId.make("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 2,
          lineEnd: 4,
          text: "vp lint\npassed",
          createdAt: "2026-03-17T18:42:05.449Z",
        }}
        onRemove={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Preview Terminal 1 lines 2-4"');
    expect(markup).toContain('aria-label="Remove Terminal 1 lines 2-4"');
  });

  it("renders expired terminal contexts with error styling", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingTerminalContextChip
        context={{
          id: "ctx-expired",
          threadId: ThreadId.make("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 2,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T18:42:05.449Z",
        }}
      />,
    );

    expect(markup).toContain('data-terminal-context-expired="true"');
    expect(markup).toContain("border-destructive/35");
    expect(markup).toContain("Terminal 1 lines 2-4");
  });
});

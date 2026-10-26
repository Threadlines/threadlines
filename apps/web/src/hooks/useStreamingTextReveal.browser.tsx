import { ASSISTANT_STREAM_FLUSH_INTERVAL_MS } from "@threadlines/shared/threadLimits";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { useStreamingTextReveal } from "./useStreamingTextReveal";

const FULL_TEXT = "First paragraph of a streamed reply. Second sentence with more words to reveal.";

function Harness({
  onApi,
}: {
  onApi: (api: { push: (text: string, streaming: boolean) => void }) => void;
}) {
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const { revealing } = useStreamingTextReveal(ref, streaming);
  onApi({
    push: (next, live) => {
      setText(next);
      setStreaming(live);
    },
  });
  return (
    <div>
      <div ref={ref} data-testid="body">
        <p>{text}</p>
        <p>{text.length > 40 ? "Trailing block" : ""}</p>
      </div>
      <span data-testid="state">{revealing ? "revealing" : "settled"}</span>
      <span data-testid="committed">{text.length}</span>
    </div>
  );
}

describe("useStreamingTextReveal", () => {
  it("reveals streamed text gradually and lands on the full text once streaming ends", async () => {
    // The reveal advances on animation frames timed by performance.now(). The
    // test drives both, so a busy machine that delays frames or folds the two
    // flushes into one render cannot leave nothing revealed at the check.
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    try {
      let api: { push: (text: string, streaming: boolean) => void } | null = null;
      const screen = await render(
        <Harness
          onApi={(next) => {
            api = next;
          }}
        />,
      );
      const body = screen.getByTestId("body").element();
      const committed = screen.getByTestId("committed");

      // Two flushes one interval apart: the second one must trail the real text.
      api!.push(FULL_TEXT.slice(0, 20), true);
      await expect.element(committed).toHaveTextContent("20");
      vi.advanceTimersByTime(ASSISTANT_STREAM_FLUSH_INTERVAL_MS);
      api!.push(FULL_TEXT.slice(0, 60), true);
      await expect.element(committed).toHaveTextContent("60");
      vi.advanceTimersByTime(16);
      const shown = body.textContent?.length ?? 0;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThan(60);
      await expect.element(screen.getByTestId("state")).toMatchTextContent("revealing");

      api!.push(FULL_TEXT, false);
      await expect.element(committed).toHaveTextContent(String(FULL_TEXT.length));
      // The rest lands within the 120 ms drain.
      vi.advanceTimersByTime(200);
      await expect.element(screen.getByTestId("state")).toMatchTextContent("settled");
      expect(body.textContent).toBe(`${FULL_TEXT}Trailing block`);
      expect(body.querySelectorAll<HTMLElement>("p")[1]?.style.display).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});

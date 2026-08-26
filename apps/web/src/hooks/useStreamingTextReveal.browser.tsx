import { useRef, useState } from "react";
import { describe, expect, it } from "vite-plus/test";
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
    </div>
  );
}

describe("useStreamingTextReveal", () => {
  it("reveals streamed text gradually and lands on the full text once streaming ends", async () => {
    let api: { push: (text: string, streaming: boolean) => void } | null = null;
    const screen = await render(
      <Harness
        onApi={(next) => {
          api = next;
        }}
      />,
    );
    const body = screen.getByTestId("body").element();

    // Two flushes 50 ms apart: the second one must trail the real text.
    api!.push(FULL_TEXT.slice(0, 20), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    api!.push(FULL_TEXT.slice(0, 60), true);
    await new Promise((resolve) => setTimeout(resolve, 16));
    const shown = body.textContent?.length ?? 0;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(60);
    await expect.element(screen.getByTestId("state")).toHaveTextContent("revealing");

    api!.push(FULL_TEXT, false);
    await expect.element(screen.getByTestId("state")).toHaveTextContent("settled");
    expect(body.textContent).toBe(`${FULL_TEXT}Trailing block`);
    expect(body.querySelectorAll<HTMLElement>("p")[1]?.style.display).toBe("");
  });
});

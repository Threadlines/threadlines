import "../../index.css";

import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import type { SelectedLineRange } from "@pierre/diffs";
import { File as PierreFile } from "@pierre/diffs/react";

import { DIFF_PANEL_UNSAFE_CSS } from "../DiffPanel.styles";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";

// Mirrors FileViewerPreview's pierre usage so lifecycle regressions in the
// wrapper (mount/unmount assertions, stale renders on file switch) surface in
// isolation instead of crashing the app's error boundary.
function Harness({
  path,
  contents,
  selection,
}: {
  path: string;
  contents: string;
  selection: SelectedLineRange | null;
}) {
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(selection);
  return (
    <DiffWorkerPoolProvider>
      <div style={{ height: 300, overflow: "auto" }}>
        <PierreFile
          key={path}
          file={{ name: path, contents, cacheKey: `test:${path}:${contents.length}` }}
          selectedLines={selectedLines}
          options={{
            disableFileHeader: true,
            overflow: "scroll" as const,
            theme: "pierre-dark",
            themeType: "dark",
            unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
            enableLineSelection: true,
            enableGutterUtility: true,
            lineHoverHighlight: "both" as const,
            onLineSelected: (range: SelectedLineRange | null) => {
              setSelectedLines(range);
            },
          }}
          renderGutterUtility={(getHoveredLine) => (
            <button
              type="button"
              title="Select line"
              className="flex size-4 items-center justify-center"
              onClick={() => {
                const hovered = getHoveredLine();
                if (hovered) {
                  setSelectedLines({ start: hovered.lineNumber, end: hovered.lineNumber });
                }
              }}
            >
              +
            </button>
          )}
        />
      </div>
    </DiffWorkerPoolProvider>
  );
}

async function settle(ms = 250) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("FileViewer pierre integration", () => {
  const pageErrors: unknown[] = [];
  const onError = (event: ErrorEvent) => {
    pageErrors.push(event.error ?? event.message);
  };

  afterEach(() => {
    window.removeEventListener("error", onError);
    pageErrors.length = 0;
    document.body.innerHTML = "";
  });

  it("mounts with a selection, switches files, and unmounts cleanly", async () => {
    window.addEventListener("error", onError);

    const screen = await render(
      <Harness
        path="a.ts"
        contents={"const a = 1;\nconst b = 2;\n"}
        selection={{ start: 1, end: 1 }}
      />,
    );
    await settle();

    // Switch file contents/name in place (what tab switching does now).
    screen.rerender(
      <Harness path="b.json" contents={'{\n  "b": true\n}\n'} selection={{ start: 2, end: 2 }} />,
    );
    await settle();

    // Unmount the whole tree (dialog close / chip re-open path).
    screen.unmount();
    await settle(100);

    expect(pageErrors).toEqual([]);
  });

  it("mounts and unmounts cleanly without the worker pool", async () => {
    const screen = await render(
      <DiffWorkerPoolProvider>
        <PierreFile
          file={{ name: "w.ts", contents: "const w = 9;\n" }}
          selectedLines={{ start: 1, end: 1 }}
          disableWorkerPool
          options={{ disableFileHeader: true, theme: "pierre-dark", themeType: "dark" }}
        />
      </DiffWorkerPoolProvider>,
    );
    await settle();
    screen.unmount();
  });

  it("mounts and unmounts cleanly with minimal options", async () => {
    const screen = await render(
      <DiffWorkerPoolProvider>
        <PierreFile
          file={{ name: "m.ts", contents: "const m = 3;\n" }}
          options={{ disableFileHeader: true, theme: "pierre-dark", themeType: "dark" }}
        />
      </DiffWorkerPoolProvider>,
    );
    await settle();
    screen.unmount();
  });

  it("survives mount-then-immediate-unmount (fast open/close)", async () => {
    window.addEventListener("error", onError);

    const screen = await render(<Harness path="c.ts" contents={"export {};\n"} selection={null} />);
    screen.unmount();
    await settle(100);

    expect(pageErrors).toEqual([]);
  });
});

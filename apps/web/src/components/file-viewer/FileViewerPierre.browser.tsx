import "../../index.css";

import { StrictMode, useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { SelectedLineRange } from "@pierre/diffs";
import { getFiletypeFromFileName, preloadHighlighter } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/editor";
import { EditorProvider, File as PierreFile } from "@pierre/diffs/react";

import { DIFF_PANEL_UNSAFE_CSS } from "../DiffPanel.styles";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { findRenderedPierreLineElement } from "./FileViewerOverlay.logic";

// Mirrors FileViewerPreview's pierre usage so lifecycle regressions in the
// wrapper (mount/unmount assertions, stale renders on file switch) surface in
// isolation instead of crashing the app's error boundary.
function Harness({
  path,
  contents,
  selection,
  disableWorkerPool = false,
}: {
  path: string;
  contents: string;
  selection: SelectedLineRange | null;
  disableWorkerPool?: boolean;
}) {
  const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(selection);
  return (
    <DiffWorkerPoolProvider>
      <div style={{ height: 300, overflow: "auto" }}>
        <PierreFile
          key={path}
          file={{ name: path, contents, cacheKey: `test:${path}:${contents.length}` }}
          selectedLines={selectedLines}
          disableWorkerPool={disableWorkerPool}
          options={{
            disableFileHeader: true,
            overflow: "scroll" as const,
            theme: "pierre-dark",
            themeType: "dark",
            unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
            enableLineSelection: true,
            lineHoverHighlight: "both" as const,
            onLineSelected: (range: SelectedLineRange | null) => {
              setSelectedLines(range);
            },
          }}
        />
      </div>
    </DiffWorkerPoolProvider>
  );
}

async function settle(ms = 250) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function countRenderedRows(): { rows: number; spans: number } {
  const host = [...document.querySelectorAll("diffs-container")].at(-1);
  const root = host?.shadowRoot;
  return {
    rows: root?.querySelectorAll("[data-line]").length ?? -1,
    spans: root?.querySelectorAll("[data-line] span").length ?? -1,
  };
}

/**
 * Wait until pierre has painted rows. Rendering is async (worker pool or
 * shared-highlighter init) and heavily CPU-bound, so under a full parallel
 * suite run it can take seconds that a fixed settle cannot cover.
 */
async function waitForRenderedRows(timeoutMs = 15_000): Promise<{ rows: number; spans: number }> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const counts = countRenderedRows();
    if (counts.rows > 0) {
      return counts;
    }
    if (performance.now() > deadline) {
      return counts;
    }
    await settle(150);
  }
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

    // Rows must actually render — a silently empty mount is the failure mode
    // pierre 1.3 exhibits when a render request is lost, and it throws no
    // error (see the StrictMode test below).
    expect((await waitForRenderedRows()).rows).toBeGreaterThan(0);

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

  it("paints highlighted rows under StrictMode with the pool disabled (app parity)", async () => {
    // The app runs StrictMode, which double-mounts the File. On pierre 1.3
    // two silent failure modes leave a plain File permanently blank: the
    // worker-pool render loses its request after the doubled mount, and the
    // sync path's lazy highlighter init never triggers a re-render on a cold
    // start. The viewer therefore preloads the shared highlighter and mounts
    // with `disableWorkerPool` (see usePierreHighlighterReady); this test
    // pins that exact combination.
    await preloadHighlighter({
      themes: ["pierre-dark"],
      langs: [getFiletypeFromFileName("strict-view.ts") ?? "ts"],
    });

    const screen = await render(
      <StrictMode>
        <Harness
          path="strict-view.ts"
          contents={"const a = 1;\nconst b = 2;\nconst c = 3;\n"}
          selection={null}
          disableWorkerPool
        />
      </StrictMode>,
    );

    const counts = await waitForRenderedRows();
    screen.unmount();
    // spans > rows means tokens rendered, i.e. highlighting worked too.
    expect(counts.rows).toBeGreaterThan(0);
    expect(counts.spans).toBeGreaterThan(counts.rows);
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

  it("finds rendered line elements inside pierre's shadow root", () => {
    const host = document.createElement("diffs-container");
    const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `
      <pre data-file>
        <code data-code>
          <div data-gutter>
            <div data-column-number="2" data-line-index="1"></div>
          </div>
          <div data-content>
            <div data-line="2" data-line-index="1"></div>
          </div>
        </code>
      </pre>
    `;
    document.body.append(host);

    const lineElement = findRenderedPierreLineElement(document, 1);
    expect(lineElement?.getAttribute("data-line")).toBe("2");
  });

  it("survives mount-then-immediate-unmount (fast open/close)", async () => {
    window.addEventListener("error", onError);

    const screen = await render(<Harness path="c.ts" contents={"export {};\n"} selection={null} />);
    screen.unmount();
    await settle(100);

    expect(pageErrors).toEqual([]);
  });
});

// Mirrors the editable-file wiring (EditorProvider + contentEditable File) so
// editor attachment regressions surface here instead of in the app.
function EditableHarness({
  path,
  contents,
  editor,
}: {
  path: string;
  contents: string;
  editor: Editor<undefined>;
}) {
  return (
    <DiffWorkerPoolProvider>
      <EditorProvider editor={editor}>
        <div style={{ height: 300, overflow: "auto" }}>
          <PierreFile
            key={path}
            file={{ name: path, contents, cacheKey: `test:${path}:${contents.length}` }}
            contentEditable
            options={{
              disableFileHeader: true,
              theme: "pierre-dark",
              themeType: "dark",
              unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
            }}
          />
        </div>
      </EditorProvider>
    </DiffWorkerPoolProvider>
  );
}

/** Wait until the editor has adopted the file's document (attach is async). */
async function waitForEditorDocument(editor: Editor<undefined>, timeoutMs = 15_000) {
  const deadline = performance.now() + timeoutMs;
  const ready = () => {
    try {
      return editor.getState().file != null;
    } catch {
      return false;
    }
  };
  while (!ready()) {
    if (performance.now() > deadline) {
      throw new Error("editor never adopted a document");
    }
    await settle(150);
  }
}

describe("FileViewer pierre editing", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("applies programmatic edits and reports changes with undo support", async () => {
    const changes: string[] = [];
    const editor = new Editor<undefined>({
      onChange: (file) => {
        changes.push(file.contents);
      },
    });

    const screen = await render(
      <EditableHarness path="e.ts" contents={"const value = 1;\n"} editor={editor} />,
    );
    await waitForEditorDocument(editor);

    editor.applyEdits(
      [
        {
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
          newText: "answer",
        },
      ],
      true,
    );
    await settle(100);

    expect(changes.at(-1)).toContain("const answer = 1;");
    expect(editor.canUndo).toBe(true);

    editor.undo();
    await settle(100);
    expect(changes.at(-1)).toContain("const value = 1;");

    screen.unmount();
  });

  it("accepts typed input through the contentEditable surface", async () => {
    const changes: string[] = [];
    const editor = new Editor<undefined>({
      onChange: (file) => {
        changes.push(file.contents);
      },
    });

    const screen = await render(
      <EditableHarness path="t.ts" contents={"start\n"} editor={editor} />,
    );
    await waitForEditorDocument(editor);

    editor.setSelections([
      { start: { line: 0, character: 5 }, end: { line: 0, character: 5 }, direction: "none" },
    ]);
    editor.focus();
    await userEvent.keyboard("!");
    const deadline = performance.now() + 10_000;
    while (!(changes.at(-1) ?? "").includes("start!") && performance.now() < deadline) {
      await settle(150);
    }

    expect(changes.at(-1)).toContain("start!");

    screen.unmount();
  });

  it("keeps the edited document across option-driven re-renders (word wrap)", async () => {
    const editor = new Editor<undefined>({});
    // Constant cacheKey mirrors FileEditorPane: option changes force a
    // repaint without rebuilding the editor's document, so edits and undo
    // history survive a wrap/theme toggle mid-session.
    function WrapHarness({ wrap }: { wrap: boolean }) {
      return (
        <DiffWorkerPoolProvider>
          <EditorProvider editor={editor}>
            <div style={{ height: 300, overflow: "auto" }}>
              <PierreFile
                file={{ name: "w2.ts", contents: "const w = 0;\n", cacheKey: "edit:w2.ts" }}
                contentEditable
                options={{
                  disableFileHeader: true,
                  theme: "pierre-dark",
                  themeType: "dark",
                  overflow: wrap ? ("wrap" as const) : ("scroll" as const),
                }}
              />
            </div>
          </EditorProvider>
        </DiffWorkerPoolProvider>
      );
    }

    const screen = await render(<WrapHarness wrap={false} />);
    await waitForEditorDocument(editor);

    editor.applyEdits(
      [
        {
          range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } },
          newText: "7",
        },
      ],
      true,
    );
    await settle(100);
    expect(editor.getState().file.contents).toContain("const w = 7;");

    screen.rerender(<WrapHarness wrap={true} />);
    await settle();

    expect(editor.getState().file.contents).toContain("const w = 7;");
    expect(editor.canUndo).toBe(true);

    screen.unmount();
  });

  it("survives StrictMode double-mounting with a deferred editor attach", async () => {
    // Attaching during mount is unsafe under StrictMode: the doubled mount
    // effect runs edit → cleanUp → edit, and pierre's re-attach render sync
    // short-circuits on cached content, leaving the editor without a
    // document. Deferring `contentEditable` to a post-mount effect makes the
    // attach a dep-change effect run, which StrictMode does not double.
    let editorRef: Editor<undefined> | null = null;
    function DeferredEditableHarness({ path, contents }: { path: string; contents: string }) {
      const [editor] = useState(() => new Editor<undefined>({}));
      const [editableReady, setEditableReady] = useState(false);
      useEffect(() => {
        setEditableReady(true);
      }, []);
      editorRef = editor;
      return (
        <DiffWorkerPoolProvider>
          <EditorProvider editor={editor}>
            <div style={{ height: 300, overflow: "auto" }}>
              <PierreFile
                key={path}
                file={{ name: path, contents, cacheKey: `test:${path}:${contents.length}` }}
                contentEditable={editableReady}
                options={{ disableFileHeader: true, theme: "pierre-dark", themeType: "dark" }}
              />
            </div>
          </EditorProvider>
        </DiffWorkerPoolProvider>
      );
    }

    const screen = await render(
      <StrictMode>
        <DeferredEditableHarness path="s.ts" contents={"const s = 0;\n"} />
      </StrictMode>,
    );
    await settle();

    const editor = editorRef as unknown as Editor<undefined>;
    expect(editor).not.toBeNull();
    await waitForEditorDocument(editor);
    editor.applyEdits(
      [
        {
          range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } },
          newText: "9",
        },
      ],
      true,
    );
    await settle(100);
    expect(editor.getState().file.contents).toContain("const s = 9;");

    screen.unmount();
  });
});

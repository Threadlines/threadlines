/**
 * Editable surface for the file viewer's edit mode.
 *
 * Wraps a `contentEditable` pierre File in an `EditorProvider`. The attach is
 * deferred to a post-mount effect: attaching during mount is unsafe under
 * StrictMode (the doubled mount effect runs edit → cleanUp → edit and
 * pierre's re-attach render sync short-circuits on cached content, leaving
 * the editor without a document). The dep-change effect run that flips
 * `contentEditable` on is not doubled, so the editor attaches exactly once —
 * see FileViewerPierre.browser.tsx for the regression test.
 *
 * The pierre editor owns the document after mount: React never feeds edited
 * contents back in (the file prop's cacheKey stays constant for the session,
 * so option-driven re-renders repaint from the latest buffer without
 * rebuilding the document and dropping undo history). Edits stream to the
 * save coordinator, which debounces writes and keeps the read cache current.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Editor } from "@pierre/diffs/editor";
import { EditorProvider, File as PierreFile } from "@pierre/diffs/react";

import { useFileViewerStore, type FileViewerContext } from "../../fileViewerStore";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { DIFF_PANEL_UNSAFE_CSS } from "../DiffPanel.styles";
import { applyEditSeedToEditor } from "./FileViewerOverlay.logic";
import { flushFileEdits, queueFileEdit } from "./fileEditorSaveCoordinator";

export function FileEditorPane({
  context,
  path,
  initialContents,
  initialContentHash,
  wordWrap,
}: {
  context: FileViewerContext;
  /** Workspace-relative path; the parent keys this pane per (cwd, path). */
  path: string;
  initialContents: string;
  /** sha256 baseline from the read; writes assert against it. */
  initialContentHash: string;
  wordWrap: boolean;
}) {
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const latestContentsRef = useRef(initialContents);
  const handleChangeRef = useRef<(contents: string) => void>(() => undefined);
  const handleAttachRef = useRef<(attached: Editor<undefined>) => void>(() => undefined);
  const [editor] = useState(
    () =>
      new Editor<undefined>({
        onChange: (file) => {
          handleChangeRef.current(file.contents);
        },
        onAttach: (attached) => {
          handleAttachRef.current(attached);
        },
      }),
  );
  const [editableReady, setEditableReady] = useState(false);

  // Entry gestures (type-to-edit, double-click) stash a caret seed in the
  // store; land it once the document exists, then focus so typing continues
  // uninterrupted. preventScroll keeps the scroll position carried over from
  // view mode (the preview scrolls the seed line into view itself).
  handleAttachRef.current = (attached) => {
    const seed = useFileViewerStore.getState().claimEditSeed(path);
    if (seed) {
      applyEditSeedToEditor(attached, seed);
    }
    attached.focus({ preventScroll: true });
  };

  handleChangeRef.current = (contents) => {
    latestContentsRef.current = contents;
    queueFileEdit({
      environmentId: context.environmentId,
      cwd: context.cwd,
      path,
      contents,
      baselineHash: initialContentHash,
      queryClient,
    });
  };

  useEffect(() => {
    setEditableReady(true);
  }, []);

  // Flush pending edits when the pane goes away (tab switch and close, mode
  // exit, overlay close all unmount it) and when the window loses focus —
  // finished thoughts publish immediately when the user switches apps.
  useEffect(() => {
    const target = { environmentId: context.environmentId, cwd: context.cwd, path };
    const onWindowBlur = () => {
      void flushFileEdits(target);
    };
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      void flushFileEdits(target);
    };
  }, [context.cwd, context.environmentId, path]);

  // Cmd+S / Ctrl+S writes the buffer immediately instead of the browser's
  // save-page dialog. Captured on window so it wins inside the shadow DOM.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void flushFileEdits({
          environmentId: context.environmentId,
          cwd: context.cwd,
          path,
        });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [context.cwd, context.environmentId, path]);

  const pierreOptions = useMemo(
    () => ({
      disableFileHeader: true,
      overflow: wordWrap ? ("wrap" as const) : ("scroll" as const),
      theme: resolveDiffThemeName(resolvedTheme),
      themeType: resolvedTheme,
      // Diff-panel tones only: the view mode's selection/hover affordances
      // don't apply while an editor is attached (pierre disables them).
      unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
    }),
    [resolvedTheme, wordWrap],
  );

  return (
    <EditorProvider editor={editor}>
      <PierreFile
        file={{
          name: path,
          // Option-driven re-renders (wrap, theme) repaint from the latest
          // buffer; the constant cacheKey keeps the editor's document (and
          // undo history) intact across them.
          contents: latestContentsRef.current,
          cacheKey: `edit:${context.cwd}:${path}`,
        }}
        contentEditable={editableReady}
        // The editor re-tokenizes synchronously through its token
        // transformer; the async worker-pool highlighter cannot serve those
        // per-keystroke updates and lines degrade to plain text.
        disableWorkerPool
        options={pierreOptions}
      />
    </EditorProvider>
  );
}

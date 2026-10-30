/**
 * Editable surface for the file viewer's edit mode.
 *
 * Wraps an `edit` pierre File in an `EditProvider` whose factory hands back
 * the single Editor this pane owns. The attach is
 * deferred to a post-mount effect: attaching during mount is unsafe under
 * StrictMode (the doubled mount effect runs edit → cleanUp → edit and
 * pierre's re-attach render sync short-circuits on cached content, leaving
 * the editor without a document). The dep-change effect run that flips
 * `edit` on is not doubled, so the editor attaches exactly once —
 * see FileViewerPierre.browser.tsx for the regression test.
 *
 * The pierre editor owns the document after mount: React never feeds edited
 * contents back in. Pierre tells an outside replacement from a re-render by
 * the file's cacheKey alone, so the key stays constant for the session and
 * option-driven re-renders (wrap, theme) keep the draft and its undo history.
 * Edits stream to the save coordinator, which debounces writes and keeps the
 * read cache current.
 *
 * The session never ends while the pane is mounted (`edit` only turns on), and
 * the coordinator already holds every change when it does, so there is no
 * completion handler. No `editStateKey` either: a retained draft would win
 * over the disk contents a "Reload file" remounts the pane with.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Editor } from "@pierre/diffs/edit";
import { EditProvider, File as PierreFile, type EditorFactory } from "@pierre/diffs/react";

import { useFileViewerStore, type FileViewerContext } from "../../fileViewerStore";
import { useTheme } from "../../hooks/useTheme";
import { resolveDiffThemeName } from "../../lib/diffRendering";
import { DIFF_PANEL_UNSAFE_CSS } from "../DiffPanel.styles";
import { applyEditSeedToEditor } from "./FileViewerOverlay.logic";
import { flushFileEdits, queueFileEdit } from "./fileEditorSaveCoordinator";

/** A fresh editor per attach; the pane attaches once per mount. */
const createEditor: EditorFactory<undefined, undefined> = (editorType, options, editStateKey) =>
  new Editor(editorType, options, editStateKey);

export function FileEditorPane({
  context,
  path,
  initialContents,
  initialContentHash,
  as,
  wordWrap,
}: {
  context: FileViewerContext;
  /**
   * Workspace-relative path, or absolute outside the project; the parent keys
   * this pane per (cwd, path).
   */
  path: string;
  /** Editing the source of a picture that is text underneath (SVG). */
  as?: "text" | undefined;
  initialContents: string;
  /** sha256 baseline from the read; writes assert against it. */
  initialContentHash: string;
  wordWrap: boolean;
}) {
  const queryClient = useQueryClient();
  const { resolvedTheme } = useTheme();
  const latestContentsRef = useRef(initialContents);
  const handleChangeRef = useRef<(contents: string) => void>(() => undefined);
  const handleAttachRef = useRef<(attached: Editor<"file">) => void>(() => undefined);
  const [editorOptions] = useState(() => ({
    onAttach: (attached: Editor<"file">) => {
      handleAttachRef.current(attached);
    },
  }));
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
      as,
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
    const target = { environmentId: context.environmentId, cwd: context.cwd, path, as };
    const onWindowBlur = () => {
      void flushFileEdits(target);
    };
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("blur", onWindowBlur);
      void flushFileEdits(target);
    };
  }, [as, context.cwd, context.environmentId, path]);

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
          as,
        });
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [as, context.cwd, context.environmentId, path]);

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
    <EditProvider createEditor={createEditor}>
      <PierreFile
        file={{
          name: path,
          // The constant cacheKey marks every re-render as the same file, so
          // pierre keeps the session's document (and undo history).
          contents: latestContentsRef.current,
          cacheKey: `edit:${context.cwd}:${path}`,
        }}
        edit={editableReady}
        editorOptions={editorOptions}
        onEditChange={(event) => {
          handleChangeRef.current(event.file.contents);
        }}
        // The editor re-tokenizes synchronously through its token
        // transformer; the async worker-pool highlighter cannot serve those
        // per-keystroke updates and lines degrade to plain text.
        disableWorkerPool
        options={pierreOptions}
      />
    </EditProvider>
  );
}

/**
 * A patch rendered as one virtualized list of files, with room for a remark on
 * any line.
 *
 * The Diff panel keeps its per-file `FileDiff` viewer: it opens files in an
 * editor and hangs its own chrome off each card. This is the surface for
 * review, where a conversation has to sit inside the diff, which per-file
 * instances cannot do — an annotation change would remount the file. Both
 * wear the same styling, so a diff reads the same wherever it is shown.
 */
import type {
  CodeViewDiffItem,
  CodeViewItem,
  DiffLineAnnotation,
  SelectedLineRange,
} from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useMemo, type ReactNode, type Ref } from "react";

import { useSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { computeFileDiffStat } from "../DiffPanel.logic";
import { DIFF_PANEL_HOST_STYLE, DIFF_PANEL_UNSAFE_CSS } from "../DiffPanel.styles";
import { FileDiffHeader, resolveFileDiffPath } from "./fileDiffPresentation";

/**
 * The viewer draws each file's header itself and this one is fully ours, so
 * the container only has to reserve the row. It has to match `FileDiffHeader`
 * (h-9) plus its hairline, or the virtualizer reserves the wrong height and
 * the end of the list sits past the reachable scroll range.
 */
const FILE_HEADER_HEIGHT = 37;

/**
 * On top of the shared diff styling: a hairline over each file so the list
 * reads as sections, and an annotation that fills the row rather than sitting
 * in the code column's padding.
 */
const ANNOTATED_DIFF_UNSAFE_CSS = `
[data-diffs-header] {
  border-top: 1px solid var(--border) !important;
}

[data-annotation-content] {
  width: 100% !important;
  left: 0 !important;
}
`;

export type AnnotatedDiffViewHandle<TAnnotation> = CodeViewHandle<TAnnotation>;

export function AnnotatedDiffView<TAnnotation>({
  items,
  onToggleCollapsed,
  renderAnnotation,
  renderFooter,
  selectedLines,
  onSelectedLinesChange,
  onLineSelectionEnd,
  enableLineSelection = false,
  viewerRef,
  className,
}: {
  readonly items: readonly CodeViewDiffItem<TAnnotation>[];
  readonly onToggleCollapsed: (id: string) => void;
  readonly renderAnnotation: (annotation: DiffLineAnnotation<TAnnotation>) => ReactNode;
  /** Drawn after the last file, inside the same scroller. Keep the identity stable. */
  readonly renderFooter?: () => ReactNode;
  readonly selectedLines?: { readonly id: string; readonly range: SelectedLineRange } | null;
  readonly onSelectedLinesChange?: (
    selection: { readonly id: string; readonly range: SelectedLineRange } | null,
  ) => void;
  /** Called when a drag over the line numbers settles, with the item it landed in. */
  readonly onLineSelectionEnd?: (
    range: SelectedLineRange | null,
    context: { readonly item: CodeViewItem<TAnnotation> },
  ) => void;
  readonly enableLineSelection?: boolean;
  readonly viewerRef?: Ref<AnnotatedDiffViewHandle<TAnnotation>>;
  readonly className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const renderMode = useSettings((settings) => settings.diffRenderMode);
  const wordWrap = useSettings((settings) => settings.diffWordWrap);

  // The viewer memoizes each visible file's header and annotation portal on
  // these render props and on `options`; a fresh identity on any of them
  // rebuilds every portal on screen on any re-render, including a keystroke in
  // an open draft.
  const renderCustomHeader = useCallback(
    (item: CodeViewItem<TAnnotation>) => {
      if (item.type !== "diff") return null;
      const filePath = resolveFileDiffPath(item.fileDiff);
      const collapsed = item.collapsed === true;
      return (
        <FileDiffHeader
          fileDiff={item.fileDiff}
          filePath={filePath}
          collapsed={collapsed}
          onToggleCollapsed={() => onToggleCollapsed(item.id)}
          stat={computeFileDiffStat(item.fileDiff)}
        />
      );
    },
    [onToggleCollapsed],
  );

  const renderItemAnnotation = useCallback(
    (annotation: DiffLineAnnotation<TAnnotation> | { lineNumber: number }) =>
      "side" in annotation ? renderAnnotation(annotation) : null,
    [renderAnnotation],
  );

  const options = useMemo(
    () => ({
      diffStyle: renderMode === "split" ? ("split" as const) : ("unified" as const),
      lineDiffType: "none" as const,
      overflow: wordWrap ? ("wrap" as const) : ("scroll" as const),
      theme: resolveDiffThemeName(resolvedTheme),
      themeType: resolvedTheme,
      stickyHeaders: true,
      enableLineSelection,
      enableGutterUtility: enableLineSelection,
      unsafeCSS: `${DIFF_PANEL_UNSAFE_CSS}\n${ANNOTATED_DIFF_UNSAFE_CSS}`,
      itemMetrics: { diffHeaderHeight: FILE_HEADER_HEIGHT },
      // Two gestures reach the same place: dragging the line numbers marks a
      // run, and the gutter's own button marks the one line it sits on. The
      // viewer keeps them apart, so a reader who only ever presses the button
      // gets nothing unless both are wired.
      ...(onLineSelectionEnd
        ? { onLineSelectionEnd, onGutterUtilityClick: onLineSelectionEnd }
        : {}),
    }),
    [enableLineSelection, onLineSelectionEnd, renderMode, resolvedTheme, wordWrap],
  );

  return (
    <CodeView<TAnnotation>
      {...(viewerRef ? { ref: viewerRef } : {})}
      items={items}
      // The viewer virtualizes against its own scroll box, so this element has
      // to be the one that scrolls; otherwise the tab grows to its content and
      // nothing scrolls at all.
      className={cn("diff-render-surface overflow-auto", className)}
      style={DIFF_PANEL_HOST_STYLE}
      options={options}
      selectedLines={selectedLines ?? null}
      {...(onSelectedLinesChange ? { onSelectedLinesChange } : {})}
      renderCustomHeader={renderCustomHeader}
      renderAnnotation={renderItemAnnotation}
      {...(renderFooter ? { renderCodeViewFooter: renderFooter } : {})}
    />
  );
}

import { useCallback, useRef } from "react";

import { clampBrowserSplitFraction } from "../../browserPanelStore";

/**
 * Drag handle between the chat column and the browser panel.
 *
 * Reports a fraction rather than a width so the split survives window resizing:
 * a stored pixel width would leave the chat column the wrong size on a
 * different display. The store clamps, so a hard drag cannot collapse a pane.
 */
export function BrowserSplitHandle({
  chatFraction,
  onChange,
}: {
  chatFraction: number;
  onChange: (fraction: number) => void;
}) {
  const draggingRef = useRef(false);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) {
        return;
      }
      const row = event.currentTarget.parentElement;
      if (row === null) {
        return;
      }
      const bounds = row.getBoundingClientRect();
      if (bounds.width === 0) {
        return;
      }
      onChange(clampBrowserSplitFraction((event.clientX - bounds.left) / bounds.width));
    },
    [onChange],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 0.1 : 0.02;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        onChange(clampBrowserSplitFraction(chatFraction - step));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onChange(clampBrowserSplitFraction(chatFraction + step));
      }
    },
    [chatFraction, onChange],
  );

  return (
    <div
      // Wider than it looks: a 1px target is a hairline to hit, so the hit area
      // is padded while only the rule itself is painted.
      className="group relative w-1 shrink-0 cursor-col-resize touch-none after:absolute after:inset-y-0 after:-left-1 after:-right-1 hover:bg-border"
      data-testid="browser-split-handle"
      role="separator"
      aria-label="Resize browser panel"
      aria-orientation="vertical"
      aria-valuenow={Math.round(chatFraction * 100)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    />
  );
}

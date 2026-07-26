import { useCallback, useRef } from "react";

import { clampBrowserSplitFraction } from "../../browserPanelStore";
import { cn } from "../../lib/utils";

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
  orientation = "vertical",
}: {
  chatFraction: number;
  onChange: (fraction: number) => void;
  /** "vertical" splits left/right; "horizontal" splits top/bottom. */
  orientation?: "vertical" | "horizontal";
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
      const extent = orientation === "vertical" ? bounds.width : bounds.height;
      if (extent === 0) {
        return;
      }
      const offset =
        orientation === "vertical" ? event.clientX - bounds.left : event.clientY - bounds.top;
      onChange(clampBrowserSplitFraction(offset / extent));
    },
    [onChange, orientation],
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
      const decrease = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
      const increase = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
      if (event.key === decrease) {
        event.preventDefault();
        onChange(clampBrowserSplitFraction(chatFraction - step));
      } else if (event.key === increase) {
        event.preventDefault();
        onChange(clampBrowserSplitFraction(chatFraction + step));
      }
    },
    [chatFraction, onChange, orientation],
  );

  return (
    <div
      // Wider than it looks: a 1px target is a hairline to hit, so the hit area
      // is padded while only the rule itself is painted.
      className={cn(
        "group relative shrink-0 touch-none hover:bg-border",
        orientation === "vertical"
          ? "w-1 cursor-col-resize after:absolute after:inset-y-0 after:-left-1 after:-right-1"
          : "h-1 cursor-row-resize after:absolute after:inset-x-0 after:-top-1 after:-bottom-1",
      )}
      data-testid="browser-split-handle"
      role="separator"
      aria-label="Resize browser panel"
      aria-orientation={orientation}
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

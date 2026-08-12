"use client";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

function ScrollArea({
  className,
  children,
  scrollFade = false,
  scrollbarGutter = false,
  hideScrollbars = false,
  chainVerticalScroll = false,
  observeContentResize = false,
  contentClassName,
  horizontalWheelScroll = false,
  ...props
}: ScrollAreaPrimitive.Root.Props & {
  scrollFade?: boolean;
  scrollbarGutter?: boolean;
  hideScrollbars?: boolean;
  chainVerticalScroll?: boolean;
  /**
   * Re-measure overflow when the content itself grows or shrinks (Base UI only
   * watches the viewport by default, so e.g. a tab strip gaining a tab would
   * not update the scrollbar or edge fades until the panel resizes). Wraps
   * children in the primitive's Content div; size it via `contentClassName`
   * (`h-full` for horizontal strips) so the observer tracks the real content
   * box.
   */
  observeContentResize?: boolean;
  contentClassName?: string;
  /** Translate vertical wheel motion into horizontal scrolling. For rows that
   * only ever overflow sideways, where plain wheel input would otherwise do
   * nothing. */
  horizontalWheelScroll?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!horizontalWheelScroll || viewport === null) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      // Trackpads and shift+wheel already produce horizontal deltas; only
      // repurpose pure vertical motion, and only when there is somewhere to go.
      if (event.deltaY === 0 || event.deltaX !== 0) {
        return;
      }
      if (viewport.scrollWidth <= viewport.clientWidth) {
        return;
      }
      viewport.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    // Native listener: React registers wheel as passive, which would make
    // preventDefault a no-op.
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", onWheel);
    };
  }, [horizontalWheelScroll]);

  return (
    <ScrollAreaPrimitive.Root
      className={cn("relative size-full min-h-0 overflow-hidden rounded-[inherit]", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        className={cn(
          "h-full max-h-[inherit] overflow-auto overscroll-contain rounded-[inherit] outline-none transition-shadows focus-ring data-has-overflow-x:overscroll-x-contain",
          chainVerticalScroll && "overscroll-y-auto",
          scrollFade &&
            "mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] [--fade-size:1.5rem]",
          scrollbarGutter && "[scrollbar-gutter:stable]",
          hideScrollbars &&
            "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
        data-slot="scroll-area-viewport"
      >
        {observeContentResize ? (
          <ScrollAreaPrimitive.Content className={contentClassName}>
            {children}
          </ScrollAreaPrimitive.Content>
        ) : (
          children
        )}
      </ScrollAreaPrimitive.Viewport>
      {!hideScrollbars && (
        <>
          <ScrollBar orientation="vertical" />
          <ScrollBar orientation="horizontal" />
          <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
        </>
      )}
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ScrollAreaPrimitive.Scrollbar.Props) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      className={cn(
        "m-1 flex opacity-0 transition-opacity delay-300 data-[orientation=horizontal]:h-1.5 data-[orientation=vertical]:w-1.5 data-[orientation=horizontal]:flex-col data-hovering:opacity-100 data-scrolling:opacity-100 data-hovering:delay-0 data-scrolling:delay-0 data-hovering:duration-100 data-scrolling:duration-100",
        className,
      )}
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      {...props}
    >
      <ScrollAreaPrimitive.Thumb
        className="relative flex-1 rounded-full bg-foreground/20"
        data-slot="scroll-area-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  );
}

/**
 * A horizontal strip's scrollbar: a hairline overlay, shown whenever the strip
 * overflows rather than only while it is hovered or scrolled. Overlaid, so it
 * costs the row no height -- a native bar would eat into it and then force a
 * vertical one too. Used by every scrolling tab strip, so the four
 * measurements live here instead of being retyped per strip.
 */
const MINI_HORIZONTAL_SCROLLBAR_CLASS =
  "[&_[data-slot=scroll-area-scrollbar][data-orientation=horizontal]]:mx-1 [&_[data-slot=scroll-area-scrollbar][data-orientation=horizontal]]:my-0.5 [&_[data-slot=scroll-area-scrollbar][data-orientation=horizontal]]:h-1 [&_[data-slot=scroll-area-scrollbar][data-orientation=horizontal]]:opacity-100";

export { MINI_HORIZONTAL_SCROLLBAR_CLASS, ScrollArea, ScrollBar };

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  closeExpandedImagePreview,
  type ExpandedImagePreview,
  registerExpandedImageHost,
  useExpandedImagePreview,
} from "./ExpandedImagePreview";

/**
 * The app's one image viewer, mounted in the root layout so a picture
 * anywhere can open it (openExpandedImagePreview).
 */
export function ExpandedImageViewerHost() {
  const preview = useExpandedImagePreview();
  useEffect(() => registerExpandedImageHost(), []);
  return preview ? (
    <ExpandedImageDialog preview={preview} onClose={closeExpandedImagePreview} />
  ) : null;
}

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
}

/**
 * The full-screen image viewer: a picture fitted to the window, arrows through
 * the pictures it came with, and zoom (see ZoomableImage). Its keys are read
 * on the way down, ahead of everything else in the app, so Escape closes the
 * viewer and not a dialog under it (a page opened full size). It takes focus
 * as it opens, since a picture in an agent page is clicked inside the page's
 * frame, where the app hears no keys.
 */
export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview: initialPreview,
  onClose,
}: ExpandedImageDialogProps) {
  const [preview, setPreview] = useState(initialPreview);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Sync when the parent hands us a new preview reference.
  useEffect(() => {
    setPreview(initialPreview);
  }, [initialPreview]);

  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      // Never back into a frame: that is a page taking focus (AgentPageFrame).
      if (
        previous instanceof HTMLElement &&
        !(previous instanceof HTMLIFrameElement) &&
        previous.isConnected
      ) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  const navigateImage = useCallback((direction: -1 | 1) => {
    setPreview((existing) => {
      if (existing.images.length <= 1) return existing;
      const nextIndex =
        (existing.index + direction + existing.images.length) % existing.images.length;
      if (nextIndex === existing.index) return existing;
      return { ...existing, index: nextIndex };
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        // Focus stays in the viewer: past it lies a dialog under it, or a
        // page's frame, where the viewer would hear no keys.
        event.preventDefault();
        event.stopPropagation();
        const dialog = dialogRef.current;
        const controls = dialog
          ? [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled)")]
          : [];
        if (controls.length === 0) return;
        const at = controls.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey
          ? at <= 0
            ? controls.length - 1
            : at - 1
          : (at + 1) % controls.length;
        controls[next]?.focus();
        return;
      }
      if (preview.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateImage(1);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [navigateImage, onClose, preview.images.length]);

  const item = preview.images[preview.index];
  if (!item) return null;

  // Portaled to <body> so the overlay's no-drag rect resolves after every
  // titlebar drag-region in DOM order (see FilePreviewDialog for the details).
  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex touch-none items-center justify-center overflow-hidden bg-black/75 px-4 py-6 outline-none [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded image preview"
    >
      {/* Pressed with a pointer, it closes through ZoomableImage, which can
          tell a click from the end of a pinch; this click is the keyboard's. */}
      <button
        type="button"
        data-image-viewer-backdrop
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close image preview"
        onClick={(event) => {
          if (event.detail === 0) onClose();
        }}
      />
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
          aria-label="Previous image"
          onClick={() => navigateImage(-1)}
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
      )}
      <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          className="absolute right-2 top-2 z-10"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <XIcon />
        </Button>
        {/* A new picture opens fitted, whatever the last one was zoomed to. */}
        <ZoomableImage
          key={`${preview.index}:${item.src}`}
          src={item.src}
          alt={item.name}
          overlayRef={dialogRef}
          onClose={onClose}
        />
        <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
          {item.name}
          {preview.images.length > 1 ? ` (${preview.index + 1}/${preview.images.length})` : ""}
        </p>
      </div>
      {preview.images.length > 1 && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
          aria-label="Next image"
          onClick={() => navigateImage(1)}
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      )}
    </div>,
    document.body,
  );
});

/** Zoom over the fitted size, and the picture's offset from its fitted place, CSS px. */
interface ImageView {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
  /** Eased to, for a click or a key; followed exactly, for a gesture. */
  readonly animate: boolean;
}

const FITTED: ImageView = { zoom: 1, x: 0, y: 0, animate: true };
const KEY_ZOOM_STEP = 1.5;
const WHEEL_ZOOM_MAX_DELTA = 25;
// A press that moves less than this is a click, not a drag.
const CLICK_SLOP_PX = 4;

/** The picture's fitted box, and how far it can zoom: to twice its own pixels, or 4x. */
function measure(box: HTMLElement, image: HTMLImageElement) {
  const rect = box.getBoundingClientRect();
  const pixels = rect.width > 0 ? image.naturalWidth / rect.width : 1;
  return {
    rect,
    maxZoom: Math.max(4, pixels * 2),
    // A click shows the picture's own pixels, or doubles one already shown at them.
    clickZoom: Math.max(2, pixels),
  };
}

/**
 * Keeps a zoomed picture from leaving the window: one wider than the window
 * cannot be dragged past its own edges, one narrower cannot be dragged out.
 */
function clampView(view: ImageView, rect: DOMRect): ImageView {
  if (view.zoom <= 1) return { ...FITTED, animate: view.animate };
  const axis = (offset: number, size: number, start: number, viewport: number) => {
    const center = start + size / 2;
    const half = (size * view.zoom) / 2;
    const leadingEdgeAtStart = half - center;
    const trailingEdgeAtEnd = viewport - center - half;
    const low = Math.min(leadingEdgeAtStart, trailingEdgeAtEnd);
    const high = Math.max(leadingEdgeAtStart, trailingEdgeAtEnd);
    return Math.min(Math.max(offset, low), high);
  };
  return {
    ...view,
    x: axis(view.x, rect.width, rect.left, window.innerWidth),
    y: axis(view.y, rect.height, rect.top, window.innerHeight),
  };
}

/** `view` zoomed to `zoom`, keeping the point of the picture under (clientX, clientY) there. */
function zoomAt(
  view: ImageView,
  zoom: number,
  clientX: number,
  clientY: number,
  rect: DOMRect,
  animate: boolean,
): ImageView {
  const fromCenterX = clientX - (rect.left + rect.width / 2);
  const fromCenterY = clientY - (rect.top + rect.height / 2);
  const ratio = zoom / view.zoom;
  return clampView(
    {
      zoom,
      x: fromCenterX - (fromCenterX - view.x) * ratio,
      y: fromCenterY - (fromCenterY - view.y) * ratio,
      animate,
    },
    rect,
  );
}

/**
 * A picture the reader can zoom: click to see it at its own pixels and click
 * again to fit it, pinch or Ctrl/⌘-scroll to zoom by degrees, + and - and 0
 * from the keyboard. Zoomed, it moves with a drag or a scroll. The picture
 * keeps its fitted place in the layout and is drawn scaled over it.
 *
 * Gestures are read on the whole viewer, so a pinch may start beside the
 * picture; a plain click beside it closes the viewer.
 */
function ZoomableImage(props: {
  readonly src: string;
  readonly alt: string;
  readonly overlayRef: React.RefObject<HTMLDivElement | null>;
  readonly onClose: () => void;
}) {
  const { overlayRef, onClose } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [view, setView] = useState(FITTED);
  const [dragging, setDragging] = useState(false);

  const measured = useCallback(() => {
    const box = boxRef.current;
    const image = imageRef.current;
    return box && image ? measure(box, image) : null;
  }, []);

  const zoomBy = useCallback(
    (factor: number, clientX: number | null, clientY: number | null, animate: boolean) => {
      const size = measured();
      if (!size) return;
      const { rect, maxZoom } = size;
      setView((current) =>
        zoomAt(
          current,
          Math.min(maxZoom, Math.max(1, current.zoom * factor)),
          clientX ?? rect.left + rect.width / 2,
          clientY ?? rect.top + rect.height / 2,
          rect,
          animate,
        ),
      );
    },
    [measured],
  );

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "+" || event.key === "=") zoomBy(KEY_ZOOM_STEP, null, null, true);
      else if (event.key === "-" || event.key === "_") zoomBy(1 / KEY_ZOOM_STEP, null, null, true);
      else if (event.key === "0") setView(FITTED);
      else return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [zoomBy]);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    // Pointers down in the viewer, and the press that may still be a click.
    const pointers = new Map<number, { x: number; y: number }>();
    let press: { x: number; y: number; onImage: boolean; moved: boolean; multi: boolean } | null =
      null;

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const onImage = target === imageRef.current;
      // The viewer's own buttons keep their clicks.
      if (!onImage && target?.closest("[data-image-viewer-backdrop]") === null) return;
      overlay.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) {
        press = { x: event.clientX, y: event.clientY, onImage, moved: false, multi: false };
      } else if (press) {
        press.multi = true;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const last = pointers.get(event.pointerId);
      if (!last) return;
      const next = { x: event.clientX, y: event.clientY };
      if (press && Math.hypot(next.x - press.x, next.y - press.y) > CLICK_SLOP_PX) {
        press.moved = true;
      }
      const size = measured();
      if (!size) return;
      pointers.set(event.pointerId, next);
      if (pointers.size >= 2) {
        // A pinch: the two pointers' spread zooms about their midpoint, and
        // the picture moves with the midpoint.
        const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
        if (!other) return;
        const before = Math.hypot(last.x - other.x, last.y - other.y);
        const after = Math.hypot(next.x - other.x, next.y - other.y);
        const fromX = (last.x + other.x) / 2;
        const fromY = (last.y + other.y) / 2;
        const toX = (next.x + other.x) / 2;
        const toY = (next.y + other.y) / 2;
        setView((current) => {
          const zoom = Math.min(
            size.maxZoom,
            Math.max(1, before > 0 ? current.zoom * (after / before) : current.zoom),
          );
          const zoomed = zoomAt(current, zoom, fromX, fromY, size.rect, false);
          return clampView(
            { ...zoomed, x: zoomed.x + toX - fromX, y: zoomed.y + toY - fromY },
            size.rect,
          );
        });
        return;
      }
      if (!press?.moved) return;
      setDragging(true);
      setView((current) =>
        current.zoom <= 1
          ? current
          : clampView(
              {
                ...current,
                x: current.x + next.x - last.x,
                y: current.y + next.y - last.y,
                animate: false,
              },
              size.rect,
            ),
      );
    };

    const onPointerEnd = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId) || pointers.size > 0) return;
      setDragging(false);
      const ended = press;
      press = null;
      if (event.type !== "pointerup" || !ended || ended.moved || ended.multi) return;
      if (!ended.onImage) {
        onClose();
        return;
      }
      const size = measured();
      if (!size) return;
      setView((current) =>
        current.zoom > 1
          ? FITTED
          : zoomAt(
              current,
              Math.min(size.maxZoom, size.clickZoom),
              event.clientX,
              event.clientY,
              size.rect,
              true,
            ),
      );
    };

    // A trackpad pinch arrives as a wheel with Ctrl held, as Ctrl-scroll
    // does. Not passive, so the browser does not zoom the whole app.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const lineScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      if (event.ctrlKey || event.metaKey) {
        // A pinch's small deltas zoom as the fingers spread; a mouse wheel's
        // notch (100px) is held to a step of about 1.3x.
        const delta = Math.min(WHEEL_ZOOM_MAX_DELTA, Math.abs(event.deltaY * lineScale));
        zoomBy(
          Math.exp(-Math.sign(event.deltaY) * delta * 0.01),
          event.clientX,
          event.clientY,
          false,
        );
        return;
      }
      const size = measured();
      if (!size) return;
      setView((current) =>
        current.zoom <= 1
          ? current
          : clampView(
              {
                ...current,
                x: current.x - event.deltaX * lineScale,
                y: current.y - event.deltaY * lineScale,
                animate: false,
              },
              size.rect,
            ),
      );
    };

    overlay.addEventListener("pointerdown", onPointerDown);
    overlay.addEventListener("pointermove", onPointerMove);
    overlay.addEventListener("pointerup", onPointerEnd);
    overlay.addEventListener("pointercancel", onPointerEnd);
    overlay.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      overlay.removeEventListener("pointerdown", onPointerDown);
      overlay.removeEventListener("pointermove", onPointerMove);
      overlay.removeEventListener("pointerup", onPointerEnd);
      overlay.removeEventListener("pointercancel", onPointerEnd);
      overlay.removeEventListener("wheel", onWheel);
    };
  }, [measured, onClose, overlayRef, zoomBy]);

  const zoomed = view.zoom > 1;
  return (
    // Shrunk to the picture, so it measures the picture's fitted place
    // however wide the caption under it is.
    <div ref={boxRef} className="mx-auto w-fit">
      <img
        ref={imageRef}
        src={props.src}
        alt={props.alt}
        className={cn(
          "block max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl",
          zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in",
        )}
        style={{
          transform: zoomed ? `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` : undefined,
          transition: view.animate ? "transform 150ms ease-out" : undefined,
        }}
        draggable={false}
      />
    </div>
  );
}

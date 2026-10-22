import { memo } from "react";

import { openFileInActiveViewer } from "../../fileViewerStore";
import { cn } from "../../lib/utils";
import { openExpandedImagePreview } from "./ExpandedImagePreview";
import { usePinchToExpand } from "./usePinchToExpand";

/** The one thumbnail shape every chat surface shows a local image at. */
const THUMBNAIL_BUTTON_CLASS_NAME =
  "block max-w-[420px] cursor-zoom-in overflow-hidden rounded-lg border border-border/80 bg-background/70";

interface LocalImageThumbnailProps {
  /** The image's bytes, as loaded by `useLocalImagePreview`. */
  readonly dataUrl: string;
  /** Absolute or workspace-relative path to the image on the agent's machine. */
  readonly filePath: string;
  /** Alt text and the caption in the expanded viewer. */
  readonly name: string;
  readonly className?: string | undefined;
}

/**
 * A picture for a path an agent referred to, once its bytes are here. Clicking
 * or pinching it opens the full-screen preview. The caller owns the loading, so it can lay
 * the reference out differently while there is no picture to show.
 */
export const LocalImageThumbnail = memo(function LocalImageThumbnail({
  dataUrl,
  filePath,
  name,
  className,
}: LocalImageThumbnailProps) {
  const expand = () => {
    if (openExpandedImagePreview({ images: [{ src: dataUrl, name }], index: 0 })) {
      return;
    }
    // No image viewer is mounted; the file viewer shows the same image and
    // is always reachable.
    openFileInActiveViewer({ path: filePath });
  };
  const pinchRef = usePinchToExpand(expand);
  return (
    <button
      ref={pinchRef}
      type="button"
      className={cn(THUMBNAIL_BUTTON_CLASS_NAME, className)}
      aria-label={`Preview ${name}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        expand();
      }}
    >
      <img
        src={dataUrl}
        alt={name}
        className="block h-auto max-h-[260px] w-full object-contain"
        draggable={false}
      />
    </button>
  );
});

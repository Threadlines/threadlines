import type { EnvironmentId } from "@threadlines/contracts";
import { memo } from "react";

import { openFileInActiveViewer } from "../../fileViewerStore";
import { useLocalImagePreview } from "../../hooks/useLocalImagePreview";
import { cn } from "../../lib/utils";
import { openExpandedImagePreview } from "./ExpandedImagePreview";

/** The one thumbnail shape every chat surface shows a local image at. */
const THUMBNAIL_BUTTON_CLASS_NAME =
  "block max-w-[420px] cursor-zoom-in overflow-hidden rounded-lg border border-border/80 bg-background/70";

interface LocalImageThumbnailProps {
  readonly environmentId: EnvironmentId | undefined;
  readonly cwd: string | undefined;
  /** Absolute or workspace-relative path to the image on the agent's machine. */
  readonly filePath: string;
  /** Alt text and the caption in the expanded viewer. */
  readonly name: string;
  readonly className?: string | undefined;
}

/**
 * A picture for a path an agent referred to, or nothing at all.
 *
 * Renders nothing while the bytes are in flight and nothing when they never
 * arrive, so a reference whose file is gone reads exactly as it did before the
 * preview existed rather than growing an error box. Whatever the caller renders
 * alongside (a file chip) stays the visible thing in both cases.
 */
export const LocalImageThumbnail = memo(function LocalImageThumbnail({
  environmentId,
  cwd,
  filePath,
  name,
  className,
}: LocalImageThumbnailProps) {
  const preview = useLocalImagePreview({ environmentId, cwd, path: filePath });
  const dataUrl = preview.status === "ready" ? preview.dataUrl : undefined;
  if (!dataUrl) {
    return null;
  }

  return (
    <button
      type="button"
      className={cn(THUMBNAIL_BUTTON_CLASS_NAME, className)}
      aria-label={`Preview ${name}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (openExpandedImagePreview({ images: [{ src: dataUrl, name }], index: 0 })) {
          return;
        }
        // No view owns the full-screen dialog right now; the file viewer shows
        // the same image and is always reachable.
        openFileInActiveViewer({ path: filePath });
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

export interface ExpandedImageItem {
  src: string;
  name: string;
}

export interface ExpandedImagePreview {
  images: ExpandedImageItem[];
  index: number;
}

export function buildExpandedImagePreview(
  images: ReadonlyArray<{ id: string; name: string; previewUrl?: string | undefined }>,
  selectedImageId: string,
): ExpandedImagePreview | null {
  const previewableImages = images.flatMap((image) =>
    image.previewUrl ? [{ id: image.id, src: image.previewUrl, name: image.name }] : [],
  );
  if (previewableImages.length === 0) {
    return null;
  }
  const selectedIndex = previewableImages.findIndex((image) => image.id === selectedImageId);
  if (selectedIndex < 0) {
    return null;
  }
  return {
    images: previewableImages.map((image) => ({
      src: image.src,
      name: image.name,
    })),
    index: selectedIndex,
  };
}

let activeExpandedImageOpener: ((preview: ExpandedImagePreview) => void) | null = null;

/**
 * Registered by the view that owns the full-screen image dialog.
 *
 * Same reasoning as `setActiveFileViewerContext`: a picture can be rendered
 * far below the dialog's owner (a chat markdown thumbnail inside a subagent
 * excerpt), and prop-drilling the opener through every renderer in between
 * buys nothing.
 */
export function setActiveExpandedImageOpener(
  opener: ((preview: ExpandedImagePreview) => void) | null,
): void {
  activeExpandedImageOpener = opener;
}

/** Opens the full-screen viewer; false when no view owns one right now. */
export function openExpandedImagePreview(preview: ExpandedImagePreview): boolean {
  if (!activeExpandedImageOpener) {
    return false;
  }
  activeExpandedImageOpener(preview);
  return true;
}

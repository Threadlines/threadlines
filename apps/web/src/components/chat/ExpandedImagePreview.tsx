import { create } from "zustand";

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

// The picture the full-screen viewer shows, if any, and how many viewer
// hosts are mounted (ExpandedImageViewerHost, once, in the app's root).
const useExpandedImageStore = create<{ readonly preview: ExpandedImagePreview | null }>(() => ({
  preview: null,
}));
let mountedHosts = 0;

/**
 * Opens the full-screen viewer from anywhere: a picture can be rendered far
 * below anything that could own the dialog (a chat markdown thumbnail inside a
 * subagent excerpt, a pull request description, a page's frame), and
 * prop-drilling an opener through every renderer in between buys nothing.
 * False when no viewer host is mounted.
 */
export function openExpandedImagePreview(preview: ExpandedImagePreview): boolean {
  if (mountedHosts === 0) {
    return false;
  }
  useExpandedImageStore.setState({ preview });
  return true;
}

export function closeExpandedImagePreview(): void {
  useExpandedImageStore.setState({ preview: null });
}

/** The picture the viewer shows; read by the viewer host. */
export const useExpandedImagePreview = () => useExpandedImageStore((state) => state.preview);

/** Marks a viewer host mounted; the returned function marks it gone. */
export function registerExpandedImageHost(): () => void {
  mountedHosts += 1;
  return () => {
    mountedHosts -= 1;
    if (mountedHosts === 0) closeExpandedImagePreview();
  };
}

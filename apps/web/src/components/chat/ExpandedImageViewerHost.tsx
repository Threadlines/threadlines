import { Suspense, useEffect } from "react";

import { lazyWithPreload } from "../../lib/lazyWithPreload";
import {
  closeExpandedImagePreview,
  registerExpandedImageHost,
  useExpandedImagePreview,
} from "./ExpandedImagePreview";

// The viewer's body is a chunk of its own, fetched after the first paint
// (AppShellIdlePreloads): startup only needs to know a picture was opened.
const ExpandedImageDialog = lazyWithPreload(() =>
  import("./ExpandedImageDialog").then((module) => module.ExpandedImageDialog),
);

/** Fetches the viewer ahead of its first open. */
export const preloadExpandedImageDialog = ExpandedImageDialog.preload;

/**
 * The app's one image viewer, mounted in the root layout so a picture
 * anywhere can open it (openExpandedImagePreview).
 */
export function ExpandedImageViewerHost() {
  const preview = useExpandedImagePreview();
  useEffect(() => registerExpandedImageHost(), []);
  return preview ? (
    <Suspense fallback={null}>
      <ExpandedImageDialog.Component preview={preview} onClose={closeExpandedImagePreview} />
    </Suspense>
  ) : null;
}

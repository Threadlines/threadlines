import { Component, type ReactNode, Suspense } from "react";

class OptionalChunkBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Renders a lazily loaded background piece (lazyWithPreload) the window works
 * without, such as a theme's art or the theme library's sync: nothing while
 * its code downloads, and nothing if the download or its render fails,
 * instead of the root error screen. A reload fetches it again. UI the user
 * asked for keeps the plain Suspense boundary and the error screen.
 */
export function OptionalChunk({ children }: { children: ReactNode }) {
  return (
    <OptionalChunkBoundary>
      <Suspense fallback={null}>{children}</Suspense>
    </OptionalChunkBoundary>
  );
}

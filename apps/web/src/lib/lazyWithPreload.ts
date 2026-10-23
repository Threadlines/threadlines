import { lazy, type ComponentType } from "react";

/**
 * A component whose code is a chunk of its own, so startup never downloads
 * it: React fetches it the first time it renders (under a Suspense boundary),
 * or `preload` fetches it earlier, so the first open can still be instant.
 * A failed preload is forgotten, so the first render fetches again.
 *
 *   const Body = lazyWithPreload(() => import("./DialogBody").then((m) => m.DialogBody));
 *   <Suspense fallback={null}><Body.Component /></Suspense>
 */
export function lazyWithPreload<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  let loading: Promise<ComponentType<Props>> | null = null;
  const fetchComponent = () =>
    (loading ??= load().catch((error: unknown) => {
      loading = null;
      throw error;
    }));
  return {
    Component: lazy(() => fetchComponent().then((component) => ({ default: component }))),
    /** Fetches the code ahead of the first render; never rejects. */
    preload: (): Promise<void> =>
      fetchComponent().then(
        () => undefined,
        () => undefined,
      ),
  };
}

import {
  useCallback,
  useEffect,
  useSyncExternalStore,
  type ComponentPropsWithRef,
  type RefCallback,
} from "react";

/**
 * Notices sit below the app's overlay layer so a menu that opens into their
 * corner keeps its clicks. A dimmed backdrop is different: the user is in a
 * dialog or a sheet, and a notice raised then (a failed save, a bad path typed
 * into the command palette) has to stay readable and clickable above it.
 *
 * Every backdrop wrapper in `components/ui` renders through `CoveringBackdrop`,
 * which counts itself while open; the notice viewport rises while the count is
 * above zero. Clicking a raised notice doesn't close the dialog: a modal only
 * closes on a press that lands on its own backdrop.
 */
let openBackdropCount = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changeOpenBackdropCount(delta: number) {
  openBackdropCount += delta;
  for (const listener of listeners) listener();
}

/** True while any dialog, sheet or drawer backdrop is open. */
export function useNoticesRaisedAboveBackdrops(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => openBackdropCount > 0,
    () => false,
  );
}

/**
 * The element a backdrop renders, for its `render` prop:
 * `render={(props, state) => <CoveringBackdrop {...props} open={state.open} />}`.
 */
export function CoveringBackdrop({
  open,
  ...props
}: ComponentPropsWithRef<"div"> & { open: boolean }) {
  useEffect(() => {
    if (!open) return;
    changeOpenBackdropCount(1);
    return () => changeOpenBackdropCount(-1);
  }, [open]);
  return <div {...props} />;
}

/** How far down the page notices start, in viewport px; 0px leaves them at their usual spot. */
export const NOTICE_TOP_CLEARANCE_CSS_VAR = "--notice-top-clearance";

/** Bottom edge of each element notices stay below; the lowest one wins. */
const clearanceBottoms = new Map<HTMLElement, number>();

function publishNoticeClearance() {
  const bottom = Math.max(0, ...clearanceBottoms.values());
  document.documentElement.style.setProperty(
    NOTICE_TOP_CLEARANCE_CSS_VAR,
    `${Math.round(bottom)}px`,
  );
}

function closestScroller(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/**
 * Keeps notices below the element this ref is on: a page's title row and the
 * buttons beside it, which sit in the corner notices land in (Settings pages,
 * the phone's Settings header). Measures the element's bottom edge as it sits
 * with its page scrolled to the top, so notices stay put while the page
 * scrolls; with several on screen, notices clear the lowest. Put it on the
 * whole block, so anything that grows inside it moves the line too.
 */
export function useNoticeClearanceRef(): RefCallback<HTMLElement> {
  return useCallback((node: HTMLElement | null) => {
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const scroller = closestScroller(node);
    const measure = () => {
      // A hidden element (the phone header on a wide window) measures 0.
      clearanceBottoms.set(node, node.getBoundingClientRect().bottom + (scroller?.scrollTop ?? 0));
      publishNoticeClearance();
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      clearanceBottoms.delete(node);
      publishNoticeClearance();
    };
  }, []);
}

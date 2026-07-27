import { useEffect, useRef } from "react";

/**
 * Folds the sidebar down to its rail when the chat is squeezed between two
 * panels, and then gets out of the way.
 *
 * With source control and the browser both open the chat column is the thing
 * that pays, and it is the column the work is actually in. The rail gives back
 * around two hundred pixels without losing anything: the destinations and the
 * projects are all still there as glyphs.
 *
 * The restraint is the important half. It collapses once, on the way in, and
 * never fights you: expand the sidebar yourself and it stays expanded, even
 * with both panels still open. Auto-behaviour that re-applies itself is worse
 * than none, because the second time it happens you stop trusting the control.
 */
export function resolveAutoCollapse(input: {
  /** Both panels open, and the chat is worth protecting. */
  readonly squeezed: boolean;
  /** Whether the sidebar is expanded right now. */
  readonly expanded: boolean;
  /** Whether this hook is what collapsed it. */
  readonly collapsedByUs: boolean;
  /** Whether the user has since overruled us. */
  readonly overruled: boolean;
}): { readonly collapse: boolean; readonly overrule: boolean } {
  if (input.overruled) {
    return { collapse: false, overrule: false };
  }
  // Expanded while squeezed, having been folded by us, means somebody reached
  // for it deliberately. That is the last time we touch it.
  if (input.squeezed && input.expanded && input.collapsedByUs) {
    return { collapse: false, overrule: true };
  }
  return { collapse: input.squeezed && input.expanded && !input.collapsedByUs, overrule: false };
}

export function useAutoCollapseSidebar(input: {
  readonly squeezed: boolean;
  readonly expanded: boolean;
  readonly setExpanded: (expanded: boolean) => void;
}): void {
  const { squeezed, expanded, setExpanded } = input;
  const collapsedByUs = useRef(false);
  const overruled = useRef(false);

  useEffect(() => {
    // Leaving the squeeze resets the arrangement: the next time both panels are
    // open is a new situation, not a continuation of the one you overruled.
    if (!squeezed) {
      collapsedByUs.current = false;
      overruled.current = false;
      return;
    }
    const next = resolveAutoCollapse({
      squeezed,
      expanded,
      collapsedByUs: collapsedByUs.current,
      overruled: overruled.current,
    });
    if (next.overrule) {
      overruled.current = true;
      return;
    }
    if (next.collapse) {
      collapsedByUs.current = true;
      setExpanded(false);
    }
  }, [squeezed, expanded, setExpanded]);
}

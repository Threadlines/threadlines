import { EnvironmentId } from "@threadlines/contracts";
import type { PlaceId } from "@threadlines/shared/appPlaces";
import { useLocation, useSearch } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { placeIdFromArrivalHash, placeScopeFromSearch } from "../appPlaceLinks";

/** How long a page may take to draw the place before the arrival gives up. */
const PLACE_ARRIVAL_WAIT_MS = 3_000;
/** The overlay's fade (`place-arrival-fade` in index.css), and a little to spare. */
const PLACE_ARRIVAL_HIGHLIGHT_MS = 1_600;
/** What can draw a place that is already in the page: a tab or section opening. */
const REVEAL_ATTRIBUTES = ["data-place", "hidden", "class", "style"];

/** The place's element that is drawn now (a page may keep a hidden copy, e.g. a phone layout). */
function findDrawnPlace(placeId: PlaceId): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(
    `[data-place="${CSS.escape(placeId)}"]`,
  )) {
    if (element.getClientRects().length > 0) return element;
  }
  return null;
}

/**
 * Lays a tint over the place that fades once (`.place-arrival-overlay`).
 * Returns what takes it away early.
 */
function playArrivalHighlight(element: HTMLElement): () => void {
  const overlay = document.createElement("span");
  overlay.className = "place-arrival-overlay";
  overlay.setAttribute("aria-hidden", "true");
  // The overlay covers its nearest positioned box, so the place becomes one
  // for as long as the tint shows.
  const wasStatic = getComputedStyle(element).position === "static";
  const inlinePosition = element.style.position;
  if (wasStatic) element.style.position = "relative";
  element.append(overlay);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    overlay.remove();
    if (wasStatic) element.style.position = inlinePosition;
  };
  const timer = setTimeout(finish, PLACE_ARRIVAL_HIGHLIGHT_MS);
  return finish;
}

/**
 * Waits (bounded) for `[data-place=<id>]` to be drawn, scrolls it into view and
 * highlights it. Pages that keep a place out of the DOM until revealed (a tab, a
 * provider card) reveal it from the search params the link opened them with;
 * this only waits. Returns the cleanup.
 */
export function arriveAtPlace(placeId: PlaceId): () => void {
  let observer: MutationObserver | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  let stopHighlight: (() => void) | null = null;

  const stopWaiting = () => {
    observer?.disconnect();
    observer = null;
    if (waitTimer !== null) clearTimeout(waitTimer);
    waitTimer = null;
  };

  const arrive = (element: HTMLElement) => {
    stopWaiting();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A whole section taller than half the screen shows from its top, not its middle.
    const tall = element.getBoundingClientRect().height > window.innerHeight / 2;
    element.scrollIntoView({
      block: tall ? "start" : "center",
      behavior: reducedMotion ? "auto" : "smooth",
    });
    if (!reducedMotion) stopHighlight = playArrivalHighlight(element);
  };

  const drawn = findDrawnPlace(placeId);
  if (drawn !== null) {
    arrive(drawn);
  } else {
    observer = new MutationObserver(() => {
      const element = findDrawnPlace(placeId);
      if (element !== null) arrive(element);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: REVEAL_ATTRIBUTES,
    });
    waitTimer = setTimeout(stopWaiting, PLACE_ARRIVAL_WAIT_MS);
  }

  return () => {
    stopWaiting();
    stopHighlight?.();
  };
}

/**
 * Plays the arrival a place link asked for: the route hash `place=<id>&n=<click>`
 * (appPlaceLinks.ts). Each click carries a new `n`, so the same link clicked
 * again plays it again. Mounted by the layouts place links open: Settings and Fleet.
 */
export function usePlaceArrival(): void {
  const hash = useLocation({ select: (location) => location.hash });
  useEffect(() => {
    const placeId = placeIdFromArrivalHash(hash);
    return placeId === null ? undefined : arriveAtPlace(placeId);
  }, [hash]);
}

/**
 * Applies the computer and project a place link named (`?environment=&project=`,
 * placeScopeFromSearch) once per arrival, for pages that pick their own
 * (Plugins & Skills, Agent Instructions). Each click carries a new `#place=`
 * counter, so following a link again applies it again, while a pick made on
 * the page in between stands. `apply` returns false when the page can't take
 * it yet (its projects still loading), and is asked again on the next render.
 */
export function usePlaceScopeArrival(
  apply: (scope: {
    readonly environmentId: EnvironmentId;
    readonly project: string | null;
  }) => boolean,
): void {
  const scopeKey = useSearch({
    strict: false,
    select: (search) => {
      const scope = placeScopeFromSearch(search as Record<string, unknown>);
      return scope === null ? null : `${scope.environmentId}\n${scope.project ?? ""}`;
    },
  });
  const hash = useLocation({ select: (location) => location.hash });
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (scopeKey === null) return;
    const arrival = `${scopeKey}\n${hash}`;
    if (applied.current === arrival) return;
    const [environmentId = "", project = ""] = scopeKey.split("\n");
    if (
      apply({
        environmentId: EnvironmentId.make(environmentId),
        project: project.length > 0 ? project : null,
      })
    ) {
      applied.current = arrival;
    }
  });
}

import { useEffect, useRef, useState } from "react";

import { FindBar } from "../FindBar";

import type { PreviewWebview } from "./PreviewTabFrame";

/** Electron's found-in-page DOM event, which plain Event typing does not know. */
interface FoundInPageEvent extends Event {
  result?: {
    requestId: number;
    activeMatchOrdinal: number;
    matches: number;
    finalUpdate: boolean;
  };
}

/**
 * Find-in-page for the preview, in the corner of the page it searches.
 *
 * Electron's own find drives it: the guest highlights matches natively and
 * reports the tally back, so this is just an input and the count. The matches
 * live in the document, so the panel closes the bar whenever the page or the
 * tab changes, and closing clears the highlights.
 */
export function BrowserFindBar({
  webview,
  onClose,
}: {
  webview: PreviewWebview;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [tally, setTally] = useState<{ active: number; matches: number } | null>(null);
  // Typing quickly leaves several find requests in flight, and their results
  // arrive in whatever order the page answers. Only the newest one may speak
  // for the bar, or the tally describes a match the view is no longer on.
  const requestIdRef = useRef<number | null>(null);

  useEffect(() => {
    const onFound = (event: Event) => {
      const result = (event as FoundInPageEvent).result;
      if (result === undefined || result.requestId !== requestIdRef.current) {
        return;
      }
      setTally({ active: result.activeMatchOrdinal, matches: result.matches });
    };
    webview.addEventListener("found-in-page", onFound);
    return () => {
      webview.removeEventListener("found-in-page", onFound);
      webview.stopFindInPage("clearSelection");
    };
  }, [webview]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  const search = (text: string) => {
    setQuery(text);
    if (text === "") {
      requestIdRef.current = null;
      setTally(null);
      webview.stopFindInPage("clearSelection");
      return;
    }
    // Cleared before each refined query: a find continues from wherever the
    // previous request anchored, so without this, typing more letters hunts
    // onward from the last jump instead of taking the first match from the
    // top -- which is the one being asked about.
    webview.stopFindInPage("clearSelection");
    requestIdRef.current = webview.findInPage(text);
  };

  const step = (forward: boolean) => {
    if (query === "") {
      return;
    }
    // Stepping past the last match wraps the counter, but inside a webview
    // Chromium does not reliably scroll back to the wrapped-to match. A wrap
    // is therefore issued as a fresh search from a cleared anchor -- which
    // does scroll -- and find-next only walks the steps inside the run.
    const wrapping =
      tally !== null &&
      tally.matches > 0 &&
      (forward ? tally.active >= tally.matches : tally.active <= 1);
    if (wrapping) {
      webview.stopFindInPage("clearSelection");
      requestIdRef.current = webview.findInPage(query, { forward });
      return;
    }
    requestIdRef.current = webview.findInPage(query, { forward, findNext: true });
  };

  return (
    <FindBar
      query={query}
      onQueryChange={search}
      onStep={(direction) => step(direction === 1)}
      onClose={onClose}
      tally={
        query === ""
          ? null
          : tally === null
            ? { kind: "pending" }
            : {
                kind: "matches",
                current: tally.matches === 0 ? 0 : tally.active,
                total: tally.matches,
              }
      }
      placeholder="Find in page"
      inputRef={inputRef}
      testIdPrefix="browser-find"
      className="absolute top-2 right-2 z-20"
      // The page finds on its own clock: a step taken before its count
      // arrives still walks from the first match.
      canStep={query !== ""}
    />
  );
}

import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { PreviewWebview } from "./BrowserPanel";

/** Electron's found-in-page DOM event, which plain Event typing does not know. */
interface FoundInPageEvent extends Event {
  result?: {
    requestId: number;
    activeMatchOrdinal: number;
    matches: number;
    finalUpdate: boolean;
  };
}

const FIND_BUTTON_CLASS_NAME =
  "inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground";

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
    <div
      className="absolute top-2 right-2 z-20 flex items-center gap-1 rounded-md border border-border bg-background py-1 pr-1 pl-2"
      data-testid="browser-find-bar"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => search(event.target.value)}
        onKeyDown={(event) => {
          // Enter walks forward through the matches; shift walks back.
          if (event.key === "Enter") {
            event.preventDefault();
            step(!event.shiftKey);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in page"
        className="h-6 w-44 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
        data-testid="browser-find-input"
      />
      {query === "" ? null : (
        <span
          className="shrink-0 font-mono text-[10px] text-muted-foreground"
          data-testid="browser-find-tally"
        >
          {tally === null ? "…" : `${tally.matches === 0 ? 0 : tally.active}/${tally.matches}`}
        </span>
      )}
      <span className="h-3.5 w-px shrink-0 bg-border" />
      <button
        type="button"
        aria-label="Previous match"
        data-testid="browser-find-previous"
        className={FIND_BUTTON_CLASS_NAME}
        onClick={() => step(false)}
      >
        <ChevronUpIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Next match"
        data-testid="browser-find-next"
        className={FIND_BUTTON_CLASS_NAME}
        onClick={() => step(true)}
      >
        <ChevronDownIcon className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label="Close find"
        data-testid="browser-find-close"
        className={FIND_BUTTON_CLASS_NAME}
        onClick={onClose}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

import type { SearchAddon, ISearchOptions } from "@xterm/addon-search";
import { useEffect, useRef, useState } from "react";

import { FindBar } from "../FindBar";

// Decoration colors must be #RRGGBB for xterm. Amber reads as "found" on
// both themes without looking like a selection or an error.
const DARK_DECORATIONS: NonNullable<ISearchOptions["decorations"]> = {
  matchBackground: "#5c4a14",
  matchOverviewRuler: "#b38600",
  activeMatchBackground: "#b38600",
  activeMatchColorOverviewRuler: "#ffd34d",
};
const LIGHT_DECORATIONS: NonNullable<ISearchOptions["decorations"]> = {
  matchBackground: "#ffe9a8",
  matchOverviewRuler: "#e0a800",
  activeMatchBackground: "#ffc93c",
  activeMatchColorOverviewRuler: "#b37f00",
};

function searchOptions(incremental: boolean): ISearchOptions {
  const dark = document.documentElement.classList.contains("dark");
  return {
    caseSensitive: false,
    incremental,
    decorations: dark ? DARK_DECORATIONS : LIGHT_DECORATIONS,
  };
}

/**
 * Find in a terminal's output (scrollback included), in the corner of the
 * tab it searches. xterm's search addon finds and highlights; this is the
 * field and the count. Closing clears the highlights.
 */
export function TerminalFindBar({
  searchAddon,
  onClose,
}: {
  searchAddon: SearchAddon;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [tally, setTally] = useState<{ current: number; total: number } | null>(null);

  useEffect(() => {
    const results = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setTally({ current: resultIndex < 0 ? 0 : resultIndex + 1, total: resultCount });
    });
    return () => {
      results.dispose();
      searchAddon.clearDecorations();
    };
  }, [searchAddon]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  const search = (text: string) => {
    setQuery(text);
    if (text === "") {
      setTally(null);
      searchAddon.clearDecorations();
      return;
    }
    searchAddon.findNext(text, searchOptions(true));
  };

  const step = (direction: 1 | -1) => {
    if (query === "") return;
    if (direction === 1) {
      searchAddon.findNext(query, searchOptions(false));
    } else {
      searchAddon.findPrevious(query, searchOptions(false));
    }
  };

  return (
    <FindBar
      query={query}
      onQueryChange={search}
      onStep={step}
      onClose={onClose}
      tally={
        query === ""
          ? null
          : tally === null
            ? { kind: "pending" }
            : { kind: "matches", current: tally.current, total: tally.total }
      }
      placeholder="Find in terminal"
      inputRef={inputRef}
      testIdPrefix="terminal-find"
      className="absolute top-2 right-3 z-20"
      canStep={query !== ""}
    />
  );
}

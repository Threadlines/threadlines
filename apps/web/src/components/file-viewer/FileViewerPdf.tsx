import { MinusIcon, MoveHorizontalIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import type { MountedPdf } from "./pdfViewerRuntime";

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * A PDF in the file viewer: its pages at the panel's width, zoom, and find in
 * the text. The renderer loads the first time a PDF opens.
 */
export function FileViewerPdf({ base64, name }: { base64: string; name: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [pdf, setPdf] = useState<MountedPdf | null>(null);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Fresh elements for every document, so a load cancelled late can never
    // draw into the next document's pages.
    const container = document.createElement("div");
    container.className = "absolute inset-0 overflow-auto";
    const viewer = document.createElement("div");
    viewer.className = "pdfViewer";
    container.append(viewer);
    host.append(container);
    const controller = new AbortController();
    setPdf(null);
    setFailed(false);
    setPage(1);
    void import("./pdfViewerRuntime")
      .then(({ mountPdf }) =>
        mountPdf({
          container,
          viewer,
          bytes: bytesFromBase64(base64),
          signal: controller.signal,
          onPageChange: setPage,
        }),
      )
      .then((next) => {
        if (!controller.signal.aborted) setPdf(next);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      container.remove();
    };
  }, [base64]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-3 py-1">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {pdf ? `Page ${page} of ${pdf.pageCount}` : failed ? "" : `Loading ${name}`}
        </span>
        <span className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom out"
          tooltip="Zoom out"
          disabled={!pdf}
          onClick={() => pdf?.zoomOut()}
        >
          <MinusIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom in"
          tooltip="Zoom in"
          disabled={!pdf}
          onClick={() => pdf?.zoomIn()}
        >
          <PlusIcon aria-hidden className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Fit to width"
          tooltip="Fit to width"
          disabled={!pdf}
          onClick={() => pdf?.fitWidth()}
        >
          <MoveHorizontalIcon aria-hidden className="size-3.5" />
        </Button>
        <div className="ml-1 flex w-44 items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-0.5 transition-colors focus-within:border-border">
          <SearchIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
          <input
            value={query}
            disabled={!pdf}
            aria-label={`Find in ${name}`}
            placeholder="Find in document"
            spellCheck={false}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setQuery(next);
              pdf?.find(next);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && query.length > 0) {
                event.preventDefault();
                pdf?.find(query, { again: true, previous: event.shiftKey });
              }
            }}
            className="w-full border-0 bg-transparent text-xs text-foreground outline-none pointer-coarse:text-base"
          />
        </div>
      </div>
      <div className="relative min-h-0 flex-1 [background:color-mix(in_srgb,var(--card)_90%,var(--background))]">
        {/* pdf.js lays pages out inside an absolutely positioned scroller. */}
        <div ref={hostRef} className="absolute inset-0" />
        {failed ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Couldn't show {name}.
          </div>
        ) : null}
      </div>
    </div>
  );
}

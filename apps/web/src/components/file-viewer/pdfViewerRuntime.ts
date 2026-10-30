/**
 * pdf.js, loaded only when a PDF opens in the file viewer: the library and
 * its worker are large and nothing else in the app needs them. One renderer
 * for every client (desktop, browser, phone), so a PDF looks and behaves the
 * same everywhere.
 */
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  EventBus,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";

GlobalWorkerOptions.workerSrc = workerUrl;

export interface MountedPdf {
  readonly pageCount: number;
  zoomIn(): void;
  zoomOut(): void;
  fitWidth(): void;
  /** Highlights every match and moves to the next (or previous) one. */
  find(query: string, options?: { readonly again?: boolean; readonly previous?: boolean }): void;
}

/**
 * Lays the document out in `container` (which pdf.js requires to be
 * absolutely positioned and scrollable) with a text layer, so words can be
 * selected and searched. Aborting `signal` tears it all down: the load if it
 * is still running, else the viewer's listeners, its pages and the document.
 */
export async function mountPdf(input: {
  readonly container: HTMLDivElement;
  readonly viewer: HTMLDivElement;
  readonly bytes: Uint8Array;
  readonly signal: AbortSignal;
  readonly onPageChange: (page: number) => void;
}): Promise<MountedPdf> {
  input.signal.throwIfAborted();
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  const loadingTask = getDocument({ data: input.bytes.slice() });
  let detachViewer: (() => void) | null = null;
  input.signal.addEventListener(
    "abort",
    () => {
      detachViewer?.();
      void loadingTask.destroy();
    },
    { once: true },
  );
  const pdfDocument = await loadingTask.promise.catch((error: unknown) => {
    void loadingTask.destroy();
    throw error;
  });
  input.signal.throwIfAborted();

  const eventBus = new EventBus();
  // A link in the document opens beside the app, never in its window.
  const linkService = new PDFLinkService({
    eventBus,
    externalLinkTarget: LinkTarget.BLANK,
    externalLinkRel: "noopener noreferrer nofollow",
  });
  const findController = new PDFFindController({ eventBus, linkService });
  // `abortSignal` disconnects the viewer's resize and scroll watchers; pdf.js
  // reads it but leaves it out of its typings.
  const options: ConstructorParameters<typeof PDFViewer>[0] & {
    readonly abortSignal: AbortSignal;
  } = {
    container: input.container,
    viewer: input.viewer,
    eventBus,
    linkService,
    findController,
    abortSignal: input.signal,
  };
  const pdfViewer = new PDFViewer(options);
  linkService.setViewer(pdfViewer);
  eventBus.on("pagesinit", () => {
    pdfViewer.currentScaleValue = "page-width";
  });
  eventBus.on("pagechanging", (event: { pageNumber: number }) => {
    input.onPageChange(event.pageNumber);
  });
  pdfViewer.setDocument(pdfDocument);
  linkService.setDocument(pdfDocument, null);
  detachViewer = () => {
    pdfViewer.setDocument(null);
    linkService.setDocument(null);
  };

  return {
    pageCount: pdfDocument.numPages,
    zoomIn: () => pdfViewer.increaseScale(),
    zoomOut: () => pdfViewer.decreaseScale(),
    fitWidth: () => {
      pdfViewer.currentScaleValue = "page-width";
    },
    find: (query, options) => {
      eventBus.dispatch("find", {
        source: null,
        type: options?.again ? "again" : "",
        query,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious: options?.previous ?? false,
        matchDiacritics: false,
      });
    },
  };
}

/**
 * A PDF's first page as a small picture, for tiles: a composer attachment and
 * the Media tab. pdf.js comes along only when a caller imports this module
 * (always dynamically), the same library the file viewer renders PDFs with,
 * so a page looks the same in its tile and opened.
 */
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfFirstPage {
  readonly blob: Blob;
  /** The rendered size, CSS-pixel aspect of the page. */
  readonly width: number;
  readonly height: number;
  readonly pageCount: number;
}

/**
 * Renders page one `width` pixels wide. Null when the bytes are not a PDF
 * pdf.js can open (damaged, encrypted). Aborting stops the work and frees the
 * document.
 */
export async function renderPdfFirstPage(input: {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly signal?: AbortSignal | undefined;
}): Promise<PdfFirstPage | null> {
  input.signal?.throwIfAborted();
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  const loadingTask = getDocument({ data: input.bytes.slice() });
  const abort = () => void loadingTask.destroy();
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    const pdfDocument = await loadingTask.promise;
    const page = await pdfDocument.getPage(1);
    const unscaled = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: input.width / Math.max(1, unscaled.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    await page.render({ canvas, viewport }).promise;
    input.signal?.throwIfAborted();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.85),
    );
    return blob
      ? { blob, width: canvas.width, height: canvas.height, pageCount: pdfDocument.numPages }
      : null;
  } catch (error) {
    if (input.signal?.aborted) {
      throw error;
    }
    return null;
  } finally {
    input.signal?.removeEventListener("abort", abort);
    void loadingTask.destroy();
  }
}

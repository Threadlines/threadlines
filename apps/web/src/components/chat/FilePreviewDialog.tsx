import { memo, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircleIcon, XIcon } from "lucide-react";
import type { ChatFileAttachmentKind } from "@threadlines/contracts";
import { Button } from "../ui/button";

/**
 * A request to preview a non-image file attachment. `loadBlob` abstracts over
 * where the bytes live: composer drafts hold an in-memory `File`, sent
 * messages fetch the stored attachment from the server.
 */
export interface FilePreviewRequest {
  name: string;
  kind: ChatFileAttachmentKind;
  loadBlob: () => Promise<Blob>;
}

/** Text previews beyond this many characters are truncated for render cost. */
const TEXT_PREVIEW_MAX_CHARS = 1_000_000;

type FilePreviewContent =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "pdf"; objectUrl: string }
  | { status: "text"; text: string; truncated: boolean };

/**
 * Full-screen preview for file attachments, mirroring ExpandedImageDialog.
 * PDFs render through the browser's built-in viewer (object URL in an
 * iframe); text kinds render as plain text.
 *
 * The close control lives in a header bar above the content rather than
 * floating over it: the embedded PDF viewer draws its own toolbar in the
 * top-right corner, and overlaid buttons on an iframe get their hover/click
 * events swallowed by the frame.
 */
export const FilePreviewDialog = memo(function FilePreviewDialog(props: {
  request: FilePreviewRequest;
  onClose: () => void;
}) {
  const { request, onClose } = props;
  const [content, setContent] = useState<FilePreviewContent>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setContent({ status: "loading" });
    request
      .loadBlob()
      .then(async (blob) => {
        if (request.kind === "pdf") {
          objectUrl = URL.createObjectURL(blob);
          if (!cancelled) {
            setContent({ status: "pdf", objectUrl });
          }
          return;
        }
        const text = await blob.text();
        if (!cancelled) {
          const truncated = text.length > TEXT_PREVIEW_MAX_CHARS;
          setContent({
            status: "text",
            text: truncated ? text.slice(0, TEXT_PREVIEW_MAX_CHARS) : text,
            truncated,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setContent({
            status: "error",
            message: error instanceof Error ? error.message : "The attachment could not be loaded.",
          });
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [request]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Portaled to <body>: Chromium resolves -webkit-app-region rects in DOM
  // order, so an inline overlay rendered before a titlebar's `drag-region`
  // loses its top strip to window dragging (clicks and hover never arrive).
  // Appending to <body> puts this no-drag rect last, punching the dialog out.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${request.name}`}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close file preview"
        onClick={onClose}
      />
      <div className="relative isolate z-10 flex max-h-[92vh] flex-col overflow-hidden rounded-lg border border-border/70 bg-background shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 py-1.5 pl-3 pr-1.5">
          <span className="truncate text-xs text-muted-foreground">{request.name}</span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
            aria-label="Close file preview"
          >
            <XIcon />
          </Button>
        </div>
        {content.status === "loading" && (
          <div className="flex h-64 w-[min(88vw,40rem)] items-center justify-center">
            <LoaderCircleIcon
              className="size-5 animate-spin text-muted-foreground"
              aria-label="Loading preview"
            />
          </div>
        )}
        {content.status === "error" && (
          <div className="flex h-64 w-[min(88vw,40rem)] items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {content.message}
          </div>
        )}
        {content.status === "pdf" && (
          // No sandbox on purpose: sandboxed frames deny plugin instantiation,
          // which blanks Chromium's built-in PDF viewer. The frame only ever
          // loads same-origin blobs explicitly typed application/pdf, so the
          // browser renders them with the PDF plugin, never as HTML.
          // oxlint-disable-next-line react/iframe-missing-sandbox
          <iframe
            src={content.objectUrl}
            title={request.name}
            className="h-[84vh] w-[min(92vw,64rem)] bg-background"
          />
        )}
        {content.status === "text" && (
          <pre className="max-h-[84vh] w-[min(92vw,56rem)] overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-relaxed">
            {content.text}
            {content.truncated ? "\n\n[Preview truncated]" : ""}
          </pre>
        )}
      </div>
    </div>,
    document.body,
  );
});

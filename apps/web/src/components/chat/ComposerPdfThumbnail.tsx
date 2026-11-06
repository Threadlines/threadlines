/**
 * An attached PDF's first page, for its tile in the composer. The file is
 * already on this device, so nothing travels: pdf.js (loaded only now) draws
 * the page from the File the user picked. Until it has, or if it can't (a
 * damaged or locked PDF), the tile keeps its document icon.
 */
import { FileTextIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

/** Twice the 64px tile, for a 2x screen. */
const THUMBNAIL_WIDTH = 128;

export const ComposerPdfThumbnail = memo(function ComposerPdfThumbnail(props: {
  readonly file: Blob;
  readonly name: string;
}) {
  const { file, name } = props;
  const [picture, setPicture] = useState<{ readonly file: Blob; readonly url: string } | null>(
    null,
  );

  useEffect(() => {
    const controller = new AbortController();
    let url: string | null = null;
    void (async () => {
      const [{ renderPdfFirstPage }, buffer] = await Promise.all([
        import("../../lib/pdfThumbnail"),
        file.arrayBuffer(),
      ]);
      const page = await renderPdfFirstPage({
        bytes: new Uint8Array(buffer),
        width: THUMBNAIL_WIDTH,
        signal: controller.signal,
      });
      if (page && !controller.signal.aborted) {
        url = URL.createObjectURL(page.blob);
        setPicture({ file, url });
      }
    })().catch(() => undefined);
    return () => {
      controller.abort();
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  }, [file]);

  if (picture?.file === file) {
    return (
      <span className="relative block size-full bg-white">
        <img
          src={picture.url}
          alt={`First page of ${name}`}
          className="size-full object-cover object-top"
          draggable={false}
        />
        <span className="absolute bottom-1 left-1 rounded bg-black/60 px-1 font-mono text-[8px] leading-3 text-white">
          PDF
        </span>
      </span>
    );
  }
  // The tile drops its own margin for a drawn page, so the name keeps one here.
  return (
    <>
      <FileTextIcon className="size-5 text-muted-foreground" />
      <span className="w-full truncate px-1 text-[9px] leading-tight text-muted-foreground/80">
        {name}
      </span>
    </>
  );
});

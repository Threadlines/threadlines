import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { pageErrorsAttachment, type PageErrorItem } from "./pageErrors";

/**
 * A quiet tally of the distinct problems the page reported, next to the
 * toolbar's other page-level controls. Absent when the page is clean: an
 * always-there zero would just be noise. The popover shows the problems
 * themselves, and one click hands them to the composer as a small text
 * attachment, so "this button errors" arrives with the actual messages
 * rather than a paraphrase.
 */
export function BrowserPageErrorsButton({
  url,
  items,
  onAttach,
}: {
  url: string | null;
  items: ReadonlyArray<PageErrorItem>;
  onAttach?: ((attachment: { name: string; text: string }) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const count = items.length;
  if (count === 0) {
    return null;
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`${count} page ${count === 1 ? "error" : "errors"}`}
            data-testid="browser-page-errors"
            className="inline-flex h-6 shrink-0 items-center gap-1 self-center rounded-md px-1.5 text-destructive hover:bg-accent"
          >
            <TriangleAlertIcon className="size-3.5" />
            {/* Nudged down a pixel: small mono digits centre on their line
                box rather than their glyphs and read as riding high. */}
            <span className="translate-y-px font-mono text-xs leading-none">{count}</span>
          </button>
        }
      />
      <PopoverPopup
        className="w-80"
        viewportClassName="p-2 [--viewport-inline-padding:--spacing(2)]"
        side="bottom"
        align="end"
      >
        <p className="text-xs font-medium text-foreground">
          The page reported {count === 1 ? "an error" : `${count} errors`}
        </p>
        <ul
          className="mt-0.5 flex max-h-56 flex-col overflow-y-auto"
          data-testid="browser-page-errors-list"
        >
          {items.map((item, index) => (
            <li key={index} className="border-b border-border/40 py-1 last:border-b-0">
              <p className="line-clamp-3 font-mono text-[10px] leading-snug text-muted-foreground">
                {item.text}
                {item.count > 1 ? ` ×${item.count}` : ""}
              </p>
            </li>
          ))}
        </ul>
        {onAttach === undefined ? null : (
          <div className="mt-1.5 flex">
            <Button
              type="button"
              size="sm"
              className="ms-auto"
              data-testid="browser-page-errors-attach"
              onClick={() => {
                onAttach(pageErrorsAttachment(url, items));
                setOpen(false);
              }}
            >
              Attach to message
            </Button>
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}

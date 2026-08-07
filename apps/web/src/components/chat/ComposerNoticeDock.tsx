/**
 * The notice row docked to the top of the composer.
 *
 * It shares the composer's left and right edges and squares off its top
 * corners, so it reads as a statement about sending rather than as another
 * piece of chat content. Only the worst active notice is on screen; the rest
 * sit behind a count that expands them in place.
 *
 * @module ComposerNoticeDock
 */
import { ChevronDownIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import type { ComposerNotice, ComposerNoticeSeverity } from "./composerNotices";

const SEVERITY_DOT_CLASS: Record<ComposerNoticeSeverity, string> = {
  error: "bg-destructive",
  info: "bg-muted-foreground/55",
  warning: "bg-warning",
};

export function ComposerNoticeDock({ notices }: { notices: ReadonlyArray<ComposerNotice> }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const hiddenCount = Math.max(0, notices.length - 1);

  useEffect(() => {
    if (hiddenCount === 0) {
      setIsExpanded(false);
    }
  }, [hiddenCount]);

  useEffect(() => {
    if (!isExpanded) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && dockRef.current?.contains(target)) {
        return;
      }
      setIsExpanded(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [isExpanded]);

  const frontNotice = notices[0];
  if (!frontNotice) {
    return null;
  }
  const stackedNotices = isExpanded ? notices.slice(1) : [];

  return (
    // The dock is always exactly as wide as the composer it docks to, so its
    // inline size is contained: without that, the row's fixed chrome raises
    // the composer's minimum width and can hold its footer out of the compact
    // layout that narrow widths depend on.
    <div
      ref={dockRef}
      data-composer-notice-dock="true"
      className="rounded-t-xl border border-b-0 border-border bg-card [contain:inline-size]"
    >
      {stackedNotices.map((notice) => (
        <ComposerNoticeRow key={notice.id} notice={notice} divided />
      ))}
      <ComposerNoticeRow
        notice={frontNotice}
        expander={
          hiddenCount > 0 ? (
            <button
              type="button"
              aria-expanded={isExpanded}
              className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 text-muted-foreground/80 transition-colors hover:text-foreground focus-ring"
              onClick={() => setIsExpanded((expanded) => !expanded)}
            >
              {hiddenCount} more
              <ChevronDownIcon
                className={cn("size-3 transition-transform", isExpanded && "rotate-180")}
              />
            </button>
          ) : null
        }
      />
    </div>
  );
}

function ComposerNoticeRow({
  notice,
  divided = false,
  expander = null,
}: {
  notice: ComposerNotice;
  divided?: boolean;
  expander?: ReactNode;
}) {
  return (
    <div
      role={notice.severity === "error" ? "alert" : "status"}
      data-composer-notice-severity={notice.severity}
      className={cn(
        "flex min-w-0 items-center gap-2.5 px-3 py-1.5 text-xs",
        divided && "border-b border-border/60",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-[7px] shrink-0 rounded-full", SEVERITY_DOT_CLASS[notice.severity])}
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{notice.lead}</span>
        {notice.detail ? <span className="text-muted-foreground"> {notice.detail}</span> : null}
      </span>
      {notice.actions ? (
        <span className="flex shrink-0 items-center gap-1">{notice.actions}</span>
      ) : null}
      {expander}
      {notice.onDismiss ? (
        <button
          type="button"
          aria-label={notice.dismissLabel ?? "Dismiss notice"}
          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:text-foreground focus-ring"
          onClick={notice.onDismiss}
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

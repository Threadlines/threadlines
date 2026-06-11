import type * as React from "react";

import { cn } from "~/lib/utils";

/**
 * Brand primitives for the Threadlines design language.
 *
 * The system rule: every surface is a thread, and every surface gets at most
 * ONE live node. Accent color means "current / live / now" — nothing else.
 */

/**
 * The live node: a small accent dot with a soft halo ping. Marks where work
 * is happening right now. Limit to one per visible surface. Size it via
 * `className` (defaults to an 8px dot); the halo scales with the dot.
 */
function LiveNode({ className, ...props }: React.ComponentPropsWithoutRef<"span">) {
  return (
    <span
      aria-hidden="true"
      {...props}
      className={cn("relative inline-flex size-2 shrink-0", className)}
    >
      <span className="thread-halo absolute inset-0 rounded-full bg-primary-graph" />
      <span className="relative size-full rounded-full bg-primary-graph" />
    </span>
  );
}

/**
 * Section voice: tiny uppercase tracked label prefixed by a hairline tick
 * that ends in a node — a 14px fragment of the brand threadline.
 */
function SectionLabel({
  as: Comp = "div",
  className,
  children,
  tick = true,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & {
  as?: "div" | "span" | "h2" | "h3" | "h4";
  tick?: boolean;
}) {
  return (
    <Comp
      {...props}
      className={cn(
        "flex min-w-0 items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55",
        className,
      )}
    >
      {tick ? <SectionTick /> : null}
      <span className="min-w-0 truncate">{children}</span>
    </Comp>
  );
}

function SectionTick({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("flex shrink-0 items-center", className)}>
      <span className="h-px w-2.5 rounded-full bg-border" />
      <span className="ml-[3px] size-[3px] rounded-full bg-muted-foreground/50" />
    </span>
  );
}

/**
 * Current marker: a short rounded accent segment marking the selected item
 * in a list or rail. The parent needs `relative`; override the edge/offsets
 * via `className` (defaults to the left edge, vertically centered).
 */
function CurrentMarker({ className, ...props }: React.ComponentPropsWithoutRef<"span">) {
  return (
    <span
      aria-hidden="true"
      {...props}
      className={cn(
        "pointer-events-none absolute left-0 top-1/2 z-10 h-3.5 w-0.5 -translate-y-1/2 rounded-full bg-primary-graph",
        className,
      )}
    />
  );
}

export { CurrentMarker, LiveNode, SectionLabel, SectionTick };

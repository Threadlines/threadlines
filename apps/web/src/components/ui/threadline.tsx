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
function LiveNode({
  className,
  dotClassName,
  haloClassName,
  ...props
}: React.ComponentPropsWithoutRef<"span"> & {
  dotClassName?: string;
  haloClassName?: string;
}) {
  return (
    <span
      aria-hidden="true"
      {...props}
      className={cn("relative inline-flex size-2 shrink-0", className)}
    >
      <span
        className={cn(
          "thread-halo absolute inset-0 rounded-full",
          haloClassName ?? "bg-primary-graph",
        )}
      />
      <span className={cn("relative size-full rounded-full", dotClassName ?? "bg-primary-graph")} />
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
  icon,
  tick = true,
  ...props
}: React.ComponentPropsWithoutRef<"div"> & {
  as?: "div" | "span" | "h2" | "h3" | "h4";
  icon?: React.ReactNode;
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
      {icon ?? null}
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
 * One row on an activity thread: a gutter that draws a continuous vertical line
 * through a centered node, beside the row content. Stack `SpineRow`s with no
 * vertical gap and they read as one unbroken spine; drop `connectTop` on the
 * first row and `connectBottom` on the last (the live terminus). Colour the
 * line by setting the `--spine` custom property on any ancestor; it falls back
 * to the hairline border colour. For row-specific accents, set `--spine-top`
 * and/or `--spine-bottom` on the row to override each connector segment.
 *
 * The node sits `nodeOffset` px below the top of the row's content box, and the
 * connectors meet it there. The default suits rows whose first line is 20px
 * tall on 4px of top padding; a row with a different first line (denser prose,
 * say) passes its own offset so the node lands on that line rather than on
 * whatever the row happens to render first.
 */
const SPINE_NODE_OFFSET_PX = 14;
const SPINE_TOP_STYLE = {
  background: "var(--spine-top, var(--spine, var(--border)))",
} satisfies React.CSSProperties;
const SPINE_BOTTOM_STYLE = {
  background: "var(--spine-bottom, var(--spine, var(--border)))",
} satisfies React.CSSProperties;

function SpineRow({
  node,
  connectTop = true,
  connectBottom = true,
  nodeOffset = SPINE_NODE_OFFSET_PX,
  className,
  style,
  children,
}: {
  node: React.ReactNode;
  connectTop?: boolean;
  connectBottom?: boolean;
  /** Distance in px from the top of the row's content box to the node's centre. */
  nodeOffset?: number;
  className?: string | undefined;
  style?: React.CSSProperties | undefined;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex gap-2", className)} style={style}>
      <div className="relative flex w-4 shrink-0 justify-center self-stretch">
        {connectTop ? (
          <span
            aria-hidden="true"
            className="absolute top-0 left-1/2 w-px -translate-x-1/2"
            style={{ ...SPINE_TOP_STYLE, height: nodeOffset }}
          />
        ) : null}
        {connectBottom ? (
          <span
            aria-hidden="true"
            className="absolute bottom-0 left-1/2 w-px -translate-x-1/2"
            style={{ ...SPINE_BOTTOM_STYLE, top: nodeOffset }}
          />
        ) : null}
        {/* Centring the node in a box of twice the offset puts its centre on the
            offset without taking the row out of flow. */}
        <span
          className="relative z-10 flex items-center justify-center"
          style={{ height: nodeOffset * 2 }}
        >
          {node}
        </span>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * Accent fade for the connectors approaching a live terminus: the spine warms
 * toward accent as it nears the row where work is happening now, and settles
 * to the hairline colour a row and a half away.
 *
 * @param distanceFromLive Rows between this row and the live terminus.
 */
function spineAccentRowStyle(distanceFromLive: number): React.CSSProperties {
  return {
    ["--spine-top"]: spineAccentSegment(distanceFromLive + 0.5, distanceFromLive),
    ["--spine-bottom"]: spineAccentSegment(distanceFromLive, Math.max(0, distanceFromLive - 0.5)),
  } as React.CSSProperties;
}

function spineAccentColor(distanceFromLive: number): string {
  if (distanceFromLive >= 1.5) {
    return "var(--border)";
  }
  const primaryMix = Math.round(82 - distanceFromLive * 48);
  return `color-mix(in oklab, var(--primary-graph) ${primaryMix}%, var(--border))`;
}

function spineAccentSegment(fromDistance: number, toDistance: number): string {
  const from = spineAccentColor(fromDistance);
  const to = spineAccentColor(toDistance);
  return from === to ? from : `linear-gradient(to bottom, ${from}, ${to})`;
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

export { CurrentMarker, LiveNode, SectionLabel, SectionTick, SpineRow, spineAccentRowStyle };

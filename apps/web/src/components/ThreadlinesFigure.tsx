import type * as React from "react";

export function riseDelay(delay: string): React.CSSProperties {
  return { "--no-thread-delay": delay } as React.CSSProperties;
}

/* Decorative thread graph: branches draw themselves in, commits surface
   left-to-right, and the one still-open branch ends on a live accent node. */
export function ThreadlinesFigure() {
  return (
    <div aria-hidden="true" className="no-thread-rise relative mb-7" style={riseDelay("0.05s")}>
      <div className="pointer-events-none absolute -inset-x-14 -inset-y-8 rounded-full bg-primary-graph/[0.05] blur-2xl dark:bg-primary-graph/[0.07]" />
      <svg
        className="relative h-auto w-[300px] sm:w-[336px] lg:w-[384px]"
        fill="none"
        viewBox="0 0 360 120"
      >
        <defs>
          <linearGradient
            gradientUnits="userSpaceOnUse"
            id="no-thread-live-stroke"
            x1="150"
            x2="300"
            y1="62"
            y2="90"
          >
            <stop offset="0" stopColor="var(--muted-foreground)" stopOpacity="0.4" />
            <stop offset="1" stopColor="var(--primary-graph)" stopOpacity="0.85" />
          </linearGradient>
        </defs>
        <g strokeLinecap="round" strokeWidth="1.25">
          <path
            className="no-thread-line text-muted-foreground/45"
            d="M 16 62 L 344 62"
            pathLength={1}
            stroke="currentColor"
            style={riseDelay("0.3s")}
          />
          <path
            className="no-thread-line text-muted-foreground/35"
            d="M 96 62 C 118 62 118 34 140 34 L 224 34 C 246 34 246 62 268 62"
            pathLength={1}
            stroke="currentColor"
            style={{ ...riseDelay("0.75s"), animationDuration: "0.7s" }}
          />
          <path
            className="no-thread-line"
            d="M 150 62 C 172 62 172 90 194 90 L 296 90"
            pathLength={1}
            stroke="url(#no-thread-live-stroke)"
            style={{ ...riseDelay("0.95s"), animationDuration: "0.7s" }}
          />
        </g>
        <g fill="currentColor">
          <circle
            className="no-thread-node text-muted-foreground/40"
            cx="44"
            cy="62"
            r="2"
            style={riseDelay("0.5s")}
          />
          <circle
            className="no-thread-node text-muted-foreground/55"
            cx="96"
            cy="62"
            r="2.5"
            style={riseDelay("0.65s")}
          />
          <circle
            className="no-thread-node text-muted-foreground/55"
            cx="150"
            cy="62"
            r="2.5"
            style={riseDelay("0.8s")}
          />
          <circle
            className="no-thread-node text-muted-foreground/40"
            cx="182"
            cy="34"
            r="2"
            style={riseDelay("1.15s")}
          />
          <circle
            className="no-thread-node text-muted-foreground/40"
            cx="322"
            cy="62"
            r="2"
            style={riseDelay("1.25s")}
          />
          <circle
            className="no-thread-node text-muted-foreground/55"
            cx="268"
            cy="62"
            r="2.5"
            style={riseDelay("1.35s")}
          />
        </g>
        <circle
          className="no-thread-halo text-primary-graph"
          cx="300"
          cy="90"
          fill="currentColor"
          r="5"
        />
        <circle
          className="no-thread-node text-primary-graph"
          cx="300"
          cy="90"
          fill="currentColor"
          r="3"
          style={riseDelay("1.5s")}
        />
      </svg>
    </div>
  );
}

import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

/**
 * Where the agent just touched the page.
 *
 * An agent driving a browser the user is watching should be visible doing it.
 * Without this, a page changes under you with no way to tell whether the agent
 * did it, the page did it, or nothing happened at all -- and "did the click
 * land?" is the question every one of these turns ends on.
 *
 * Drawn over the webview rather than inside the page: it is a thing our UI is
 * saying about the page, not a thing on the page. That also keeps it out of
 * screenshots, which should show what the user would see, not our annotations.
 */

/** Long enough to notice, short enough not to sit over the thing it points at. */
const POINTER_VISIBLE_MS = 1400;

export interface AgentPointerPosition {
  /** Page coordinates, as the agent's click was dispatched. */
  readonly x: number;
  readonly y: number;
  /** Distinguishes two clicks in the same spot, which should read as two. */
  readonly sequence: number;
}

export function AgentPointer({
  position,
  scale,
  className,
}: {
  position: AgentPointerPosition | null;
  /** Page pixels to panel pixels, so the mark lands where the user sees it. */
  scale: number;
  className?: string;
}) {
  if (position === null) {
    return null;
  }
  return (
    <AgentPointerMark
      key={position.sequence}
      position={position}
      scale={scale}
      {...(className === undefined ? {} : { className })}
    />
  );
}

function AgentPointerMark({
  position,
  scale,
  className,
}: {
  position: AgentPointerPosition;
  scale: number;
  className?: string;
}) {
  // Fades rather than vanishes: something that disappears between glances
  // leaves you unsure it was ever there.
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setFaded(true), POINTER_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      aria-hidden="true"
      data-testid="agent-pointer"
      className={cn(
        "pointer-events-none absolute left-0 top-0 z-30 transition-opacity duration-500 ease-out motion-reduce:transition-none",
        faded ? "opacity-0" : "opacity-100",
        className,
      )}
      style={{ transform: `translate3d(${position.x * scale}px, ${position.y * scale}px, 0)` }}
    >
      {/* The click itself, as a ring that expands once from where it landed. */}
      <span className="absolute -left-3 -top-3 size-6 animate-ping rounded-full bg-primary-readable/30 motion-reduce:hidden" />
      {/* The same arrow the pick cursor uses, so the agent pointing at
          something and the user pointing at something read as one language --
          heavier, and lit, because this one is not under anybody's hand. */}
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        className="relative drop-shadow-[0_0_6px_var(--color-primary-readable)]"
      >
        <path
          d="M3.688 3.037a.497.497 0 0 0-.651.651l6.5 15.999a.501.501 0 0 0 .947-.062l1.569-6.083a2 2 0 0 1 1.448-1.479l6.124-1.579a.5.5 0 0 0 .063-.947z"
          className="fill-background stroke-primary-readable"
          strokeWidth="2.4"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

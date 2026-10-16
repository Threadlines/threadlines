import { useEffect, useRef } from "react";

/**
 * Text that updates itself every second while `active`, by writing its own
 * text node: an elapsed clock must not make React commit every second. When
 * inactive it renders `compute()` once and stops.
 */
export function TickingText({
  compute,
  active,
  className,
}: {
  readonly compute: () => string;
  readonly active: boolean;
  readonly className?: string | undefined;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const computeRef = useRef(compute);
  computeRef.current = compute;

  useEffect(() => {
    if (!active) return;
    const update = () => {
      if (ref.current) ref.current.textContent = computeRef.current();
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [active]);

  return (
    <span ref={ref} className={className}>
      {compute()}
    </span>
  );
}

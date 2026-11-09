import { useRelativeTimeTick } from "../hooks/useRelativeTimeTick";
import { formatRelativeTimeLabel } from "../timestampFormat";

/**
 * "5m ago" for a moment, kept current by its own minute clock. Use it in place
 * of calling `formatRelativeTimeLabel(at)` in a component: the React Compiler
 * caches that call by `at` alone, so the label would freeze until the moment
 * itself changed, however often the row around it re-rendered. Only this
 * label re-renders as time passes, never the row or list it sits in.
 */
export function RelativeTimeLabel({ at }: { at: string }) {
  const nowMs = useRelativeTimeTick(60_000);
  return <>{formatRelativeTimeLabel(at, nowMs)}</>;
}

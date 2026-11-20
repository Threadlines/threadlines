import { useEffect, useState } from "react";

/**
 * Re-render every `intervalMs`; return a stable timestamp snapshot for render-time relative labels.
 * Each caller keeps its own clock, fresh when it mounts. Views that must agree on the time use
 * `useSharedTimeTick`.
 */
export function useRelativeTimeTick(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

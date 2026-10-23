import { useEffect, useState } from "react";

import { startOfLocalDayMs } from "../timestampFormat";

/**
 * Local midnight of the current day. Re-renders only when the day turns, so
 * a "today" label moves on at midnight without a ticking clock.
 */
export function useLocalDayStartMs(): number {
  const [dayStartMs, setDayStartMs] = useState(() => startOfLocalDayMs(Date.now()));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Checks the day, then waits until just past the next midnight. A timer's
    // clock stops while the machine sleeps, so waking up (focus, a tab shown
    // again) checks too, and sets a fresh timer.
    const sync = () => {
      // One reading of the clock: two could fall either side of midnight,
      // and keep yesterday until the day after.
      const nowMs = Date.now();
      setDayStartMs(startOfLocalDayMs(nowMs));
      clearTimeout(timer);
      timer = setTimeout(sync, startOfLocalDayMs(nowMs, -1) - nowMs + 1_000);
    };
    sync();
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return dayStartMs;
}

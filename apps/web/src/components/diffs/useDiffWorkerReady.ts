import { useWorkerPool } from "@pierre/diffs/react";
import { useEffect, useState } from "react";

/**
 * Whether the diff worker pool can draw. A pool starts loading its worker and
 * syntax files the moment its provider mounts, and the viewer shows nothing
 * until that lands; on a slow connection that is seconds of blank space after
 * the patch itself has arrived. Callers keep a loading line up until this
 * turns true. A pool whose workers failed counts as ready too, since the
 * viewer then falls back to plain text and waiting would be forever. Without a
 * provider there is nothing to wait for.
 */
export function useDiffWorkerReady(): boolean {
  const pool = useWorkerPool();
  const [ready, setReady] = useState(() => pool === undefined || pool.isInitialized());
  useEffect(() => {
    if (pool === undefined) return;
    // The pool reports its state on subscribe and after every change, so this
    // both reads the current answer and hears the one that matters.
    return pool.subscribeToStatChanges((stats) => {
      if (stats.managerState === "initialized" || stats.workersFailed) {
        setReady(true);
      }
    });
  }, [pool]);
  return ready;
}

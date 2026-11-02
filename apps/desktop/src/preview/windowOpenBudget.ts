/**
 * How fast a project's browser pages may open new tabs and windows.
 *
 * Electron has no pop-up blocker: Chromium leaves "only after a click" to the
 * app embedding it, so a page calling `window.open` in a loop would get a tab
 * per call, each its own renderer process, until the app falls over. A page
 * that opens copies of itself would multiply. So the budget belongs to the
 * project, which every page of it and every tab they open share: a burst of a
 * few, as Cmd-clicking a handful of links needs, then one every few seconds.
 * What the user asks for from a menu does not draw on it.
 */
export interface WindowOpenBudget {
  /** Spends one request for the project, or says it has none left. */
  readonly take: (project: string) => boolean;
}

export function makeWindowOpenBudget({
  burst = 6,
  refillMs = 3_000,
  now = Date.now,
}: { burst?: number; refillMs?: number; now?: () => number } = {}): WindowOpenBudget {
  // A handful of entries: one per project with pages open this run.
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take: (project) => {
      const time = now();
      const bucket = buckets.get(project) ?? { tokens: burst, at: time };
      const tokens = Math.min(burst, bucket.tokens + (time - bucket.at) / refillMs);
      const allowed = tokens >= 1;
      buckets.set(project, { tokens: allowed ? tokens - 1 : tokens, at: time });
      return allowed;
    },
  };
}

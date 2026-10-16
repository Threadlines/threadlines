/**
 * How fast a browser profile's pages may open new tabs and windows.
 *
 * Electron has no pop-up blocker: Chromium leaves "only after a click" to the
 * app embedding it, so a page calling `window.open` in a loop would get a tab
 * per call, each its own renderer process, until the app falls over. A page
 * that opens copies of itself would multiply. So the budget belongs to the
 * profile, which every page of a project and every tab they open share: a
 * burst of a few, as Cmd-clicking a handful of links needs, then one every few
 * seconds. What the user asks for from a menu does not draw on it.
 */
export interface WindowOpenBudget {
  /** Spends one request for the profile, or says it has none left. */
  readonly take: (profile: object) => boolean;
}

export function makeWindowOpenBudget({
  burst = 6,
  refillMs = 3_000,
  now = Date.now,
}: { burst?: number; refillMs?: number; now?: () => number } = {}): WindowOpenBudget {
  const buckets = new WeakMap<object, { tokens: number; at: number }>();
  return {
    take: (profile) => {
      const time = now();
      const bucket = buckets.get(profile) ?? { tokens: burst, at: time };
      const tokens = Math.min(burst, bucket.tokens + (time - bucket.at) / refillMs);
      const allowed = tokens >= 1;
      buckets.set(profile, { tokens: allowed ? tokens - 1 : tokens, at: time });
      return allowed;
    },
  };
}

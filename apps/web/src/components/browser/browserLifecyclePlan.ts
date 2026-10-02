/**
 * What to do with browser pages nobody is looking at, decided from facts.
 *
 * Pages in threads you are not viewing, and tabs you are not on, keep running
 * so an agent can come back to them. Each costs memory, and some keep costing
 * processor time even hidden (Chromium slows a hidden page's timers but not
 * its other work). So pages step down as they sit idle:
 *
 * - drawn: an agent touched it recently. Invisible but still painted, so a
 *   screenshot works -- Chromium produces no picture of a hidden page at all.
 * - background: idle for {@link LIFECYCLE_LIMITS.drawnForMs}, or off screen
 *   with no agent on it. Not painted, and run like a background tab: timers
 *   slowed to once a second.
 * - frozen: idle for {@link LIFECYCLE_LIMITS.freezeAfterMs}. Nothing runs; the
 *   page stays in memory exactly as it was and wakes in a millisecond.
 * - evicted: closed to keep memory in bounds, oldest first, when more pages are
 *   open than {@link LIFECYCLE_LIMITS.maxBackgroundPages} or they use more than
 *   {@link LIFECYCLE_LIMITS.memoryBudgetKb}. Its tab stays, and reloads its
 *   address when next used -- what every page did on a thread switch before
 *   pages were kept.
 *
 * Pure so the rules can be read and tested apart from the timers and the
 * desktop calls that carry them out.
 */

export interface LifecycleLimits {
  readonly drawnForMs: number;
  readonly freezeAfterMs: number;
  readonly agentGraceMs: number;
  readonly maxBackgroundPages: number;
  readonly memoryBudgetKb: number;
}

export const LIFECYCLE_LIMITS: LifecycleLimits = {
  /** How long a page stays painted after an agent last touched it. */
  drawnForMs: 60_000,
  /**
   * How long a page must sit idle and unseen before it is frozen. Short,
   * because Chromium slows a background page's timers but not all of its work,
   * and a busy page out of sight would otherwise burn a core until then; waking
   * one takes a millisecond.
   */
  freezeAfterMs: 2 * 60_000,
  /** An agent that touched a page this recently may come back: never close it. */
  agentGraceMs: 2 * 60_000,
  /** Open pages nobody is looking at, before the oldest idle one closes. */
  maxBackgroundPages: 8,
  /**
   * Memory all browser pages may use before idle background ones close. A
   * soft target: pages on screen, or in use by an agent, are never closed to
   * meet it.
   */
  memoryBudgetKb: 2 * 1024 * 1024,
};

/** How the desktop runs a page; see `DesktopPreviewLifecycleInputSchema`. */
export type PageRunState = "active" | "background" | "frozen";

export interface LifecyclePage {
  readonly key: string;
  /** On screen right now. */
  readonly shown: boolean;
  readonly drawn: boolean;
  readonly state: PageRunState;
  /** Agent requests on it still running. */
  readonly inFlight: number;
  /** A question about this page is waiting for the user. */
  readonly awaitingUser: boolean;
  /** When an agent last touched it; 0 for never. */
  readonly lastAgentAt: number;
  /** When it was last on screen, or when it opened. */
  readonly lastShownAt: number;
  /** This page's share of its process's memory, when known. */
  readonly memoryKb: number | null;
}

export interface LifecyclePlan {
  /** Stop painting and run as a background tab: no agent has touched it for a while. */
  readonly background: ReadonlyArray<string>;
  readonly freeze: ReadonlyArray<string>;
  /** Close, oldest first. */
  readonly evict: ReadonlyArray<string>;
}

export function planBrowserLifecycle(
  pages: ReadonlyArray<LifecyclePage>,
  now: number,
  limits: LifecycleLimits = LIFECYCLE_LIMITS,
): LifecyclePlan {
  const background: string[] = [];
  const freeze: string[] = [];
  const evictable: LifecyclePage[] = [];
  let backgroundPages = 0;
  let memoryKb = 0;

  for (const page of pages) {
    memoryKb += page.memoryKb ?? 0;
    if (page.shown) {
      continue;
    }
    backgroundPages += 1;
    const busy = page.inFlight > 0 || page.awaitingUser;
    const sinceAgent = now - page.lastAgentAt;
    const idleFor = now - Math.max(page.lastAgentAt, page.lastShownAt);
    if ((page.drawn || page.state === "active") && !busy && sinceAgent >= limits.drawnForMs) {
      background.push(page.key);
    }
    if (page.state !== "frozen" && !busy && idleFor >= limits.freezeAfterMs) {
      freeze.push(page.key);
    }
    if (!busy && sinceAgent >= limits.agentGraceMs) {
      evictable.push(page);
    }
  }

  const evict: string[] = [];
  const oldestFirst = evictable.toSorted(
    (left, right) =>
      Math.max(left.lastAgentAt, left.lastShownAt) - Math.max(right.lastAgentAt, right.lastShownAt),
  );
  for (const page of oldestFirst) {
    if (backgroundPages <= limits.maxBackgroundPages && memoryKb <= limits.memoryBudgetKb) {
      break;
    }
    evict.push(page.key);
    backgroundPages -= 1;
    memoryKb -= page.memoryKb ?? 0;
  }

  const evicted = new Set(evict);
  return {
    background: background.filter((key) => !evicted.has(key)),
    freeze: freeze.filter((key) => !evicted.has(key)),
    evict,
  };
}

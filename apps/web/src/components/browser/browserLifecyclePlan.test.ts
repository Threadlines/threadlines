import { describe, expect, it } from "vite-plus/test";

import { LIFECYCLE_LIMITS, planBrowserLifecycle, type LifecyclePage } from "./browserLifecyclePlan";

const NOW = 10 * 60 * 60_000;
const page = (key: string, overrides: Partial<LifecyclePage> = {}): LifecyclePage => ({
  key,
  shown: false,
  drawn: false,
  state: "background",
  inFlight: 0,
  awaitingUser: false,
  lastAgentAt: 0,
  lastShownAt: NOW,
  memoryKb: 100_000,
  ...overrides,
});

describe("planBrowserLifecycle", () => {
  it("steps an idle background page down: run as a background tab, then freeze", () => {
    const touched = NOW - 2 * 60_000;
    const plan = planBrowserLifecycle(
      [
        // An agent's page a minute and a bit later: no longer painted, not yet frozen.
        page("recent", { drawn: true, state: "active", lastAgentAt: NOW - 61_000, lastShownAt: 0 }),
        // An agent's page it touched a moment ago keeps running in full.
        page("in-use", { drawn: true, state: "active", lastAgentAt: NOW - 5_000, lastShownAt: 0 }),
        // Unseen and untouched for long enough: frozen.
        page("idle", { lastAgentAt: 0, lastShownAt: NOW - LIFECYCLE_LIMITS.freezeAfterMs }),
        // Busy pages keep running however old they look.
        page("busy", { drawn: true, inFlight: 1, lastAgentAt: touched, lastShownAt: 0 }),
        page("asking", { awaitingUser: true, lastShownAt: 0 }),
        // What is on screen is never touched.
        page("shown", { shown: true, lastShownAt: 0 }),
      ],
      NOW,
    );

    expect(plan).toEqual({ background: ["recent"], freeze: ["idle"], evict: [] });
  });

  it("closes the oldest idle background pages to stay inside the limits, never busy or shown ones", () => {
    const limits = { ...LIFECYCLE_LIMITS, maxBackgroundPages: 2, memoryBudgetKb: 10_000_000 };
    const pages = [
      page("shown", { shown: true, lastShownAt: 0 }),
      page("oldest", { lastShownAt: NOW - 50 * 60_000 }),
      page("busy-but-old", { inFlight: 1, lastShownAt: NOW - 60 * 60_000 }),
      page("agent-just-left", { lastAgentAt: NOW - 30_000, lastShownAt: NOW - 70 * 60_000 }),
      page("older", { lastShownAt: NOW - 40 * 60_000 }),
      page("newest", { lastShownAt: NOW - 1 * 60_000 }),
    ];

    expect(planBrowserLifecycle(pages, NOW, limits).evict).toEqual(["oldest", "older", "newest"]);

    // Memory alone is a reason too: three pages at 1 GB each against a 2 GB budget.
    const heavy = [
      page("a", { memoryKb: 1024 * 1024, lastShownAt: NOW - 30 * 60_000 }),
      page("b", { memoryKb: 1024 * 1024, lastShownAt: NOW - 20 * 60_000 }),
      page("c", { memoryKb: 1024 * 1024, lastShownAt: NOW - 10 * 60_000 }),
    ];
    expect(planBrowserLifecycle(heavy, NOW).evict).toEqual(["a"]);
  });
});

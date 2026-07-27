import { describe, expect, it } from "vite-plus/test";

import {
  getAutoArchiveThreadInactiveSince,
  isAutoArchiveProtectedThread,
  selectAutoArchiveCandidates,
  type AutoArchiveThreadFields,
} from "./threadAutoArchive.ts";

const NOW_MS = Date.parse("2026-06-18T12:00:00.000Z");

function daysAgo(days: number): string {
  return new Date(NOW_MS - days * 24 * 60 * 60 * 1_000).toISOString();
}

function thread(
  id: string,
  overrides: Partial<AutoArchiveThreadFields> = {},
): AutoArchiveThreadFields & { readonly id: string } {
  return {
    id,
    createdAt: daysAgo(45),
    updatedAt: daysAgo(45),
    latestUserMessageAt: daysAgo(45),
    archivedAt: null,
    pinnedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    latestTurn: null,
    session: null,
    ...overrides,
  };
}

describe("thread auto-archive rules", () => {
  it("returns no candidates when inactive auto-archive is off", () => {
    expect(
      selectAutoArchiveCandidates({
        threads: [thread("inactive")],
        inactiveDays: 0,
        nowMs: NOW_MS,
      }),
    ).toEqual([]);
  });

  it("includes the cutoff boundary and preserves equal-timestamp input order", () => {
    const candidates = selectAutoArchiveCandidates({
      threads: [
        thread("boundary-first", { updatedAt: daysAgo(30) }),
        thread("recent", {
          updatedAt: new Date(NOW_MS - 30 * 24 * 60 * 60 * 1_000 + 1).toISOString(),
        }),
        thread("boundary-second", { updatedAt: daysAgo(30) }),
      ],
      inactiveDays: 30,
      nowMs: NOW_MS,
    });

    expect(candidates.map(({ id }) => id)).toEqual(["boundary-first", "boundary-second"]);
  });

  it.each([
    ["archived", { archivedAt: daysAgo(1) }],
    ["pinned", { pinnedAt: daysAgo(1) }],
    ["pending approval", { hasPendingApprovals: true }],
    ["pending user input", { hasPendingUserInput: true }],
    ["actionable proposed plan", { hasActionableProposedPlan: true }],
    ["running latest turn", { latestTurn: { state: "running" } }],
    ["running session", { session: { status: "running" } }],
    [
      "running orchestration session",
      { session: { status: "ready", orchestrationStatus: "running" } },
    ],
    ["active session turn", { session: { status: "ready", activeTurnId: "turn-active" } }],
    ["pending background task", { session: { status: "ready", pendingBackgroundTaskCount: 1 } }],
  ] satisfies ReadonlyArray<readonly [string, Partial<AutoArchiveThreadFields>]>)(
    "protects a thread with %s",
    (_label, overrides) => {
      expect(isAutoArchiveProtectedThread(thread("protected", overrides))).toBe(true);
    },
  );

  it("uses updatedAt, then latest user message, then creation time for inactivity", () => {
    expect(
      getAutoArchiveThreadInactiveSince(
        thread("updated", {
          createdAt: daysAgo(90),
          latestUserMessageAt: daysAgo(60),
          updatedAt: daysAgo(10),
        }),
      ),
    ).toBe(daysAgo(10));
    expect(
      getAutoArchiveThreadInactiveSince(
        thread("messaged", {
          createdAt: daysAgo(90),
          latestUserMessageAt: daysAgo(60),
          updatedAt: undefined,
        }),
      ),
    ).toBe(daysAgo(60));
    expect(
      getAutoArchiveThreadInactiveSince(
        thread("created", {
          createdAt: daysAgo(90),
          latestUserMessageAt: null,
          updatedAt: undefined,
        }),
      ),
    ).toBe(daysAgo(90));
  });

  it("honors the exclusion callback", () => {
    const candidates = selectAutoArchiveCandidates({
      threads: [thread("excluded"), thread("included")],
      inactiveDays: 30,
      nowMs: NOW_MS,
      isExcluded: ({ id }) => id === "excluded",
    });

    expect(candidates.map(({ id }) => id)).toEqual(["included"]);
  });
});

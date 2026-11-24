import { describe, expect, it } from "vite-plus/test";

import {
  deriveProjectBoard,
  foldProjectBoardGroup,
  formatProjectBoardCounts,
  PROJECT_BOARD_GROUP_FOLD_AT,
  type ProjectBoardPullRequestInput,
  type ProjectBoardThreadInput,
} from "./projectBoard.logic";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const NOW_MS = Date.parse("2026-11-16T20:00:00.000Z");
const ago = (ms: number) => new Date(NOW_MS - ms).toISOString();

function thread(
  key: string,
  overrides: Partial<ProjectBoardThreadInput> = {},
): ProjectBoardThreadInput {
  return {
    key,
    statusLabel: null,
    isDone: false,
    doneAt: null,
    activityAt: ago(HOUR_MS),
    pullRequests: [],
    ...overrides,
  };
}

function openPullRequest(
  overrides: Partial<ProjectBoardPullRequestInput> = {},
): ProjectBoardPullRequestInput {
  return {
    state: "open",
    isDraft: false,
    autoMergeEnabled: false,
    reviewReason: null,
    ...overrides,
  };
}

/** The board as group id → thread keys, in drawing order. */
function board(threads: readonly ProjectBoardThreadInput[]) {
  return deriveProjectBoard(threads, NOW_MS).groups.map((group) => [
    group.id,
    group.rows.map((row) => row.thread.key),
  ]);
}

describe("deriveProjectBoard", () => {
  it("sorts threads into the plan's groups and draws them in its order", () => {
    expect(
      board([
        thread("wrapped", { isDone: true, doneAt: ago(DAY_MS) }),
        thread("idle"),
        thread("landing", { pullRequests: [openPullRequest({ autoMergeEnabled: true })] }),
        thread("working", { statusLabel: "Waiting" }),
        thread("review", { pullRequests: [openPullRequest()] }),
        thread("approval", { statusLabel: "Pending Approval" }),
        thread("limited", { statusLabel: "Continues at reset" }),
        thread("plan", { statusLabel: "Plan Ready" }),
      ]),
    ).toEqual([
      ["needsYou", ["approval", "plan"]],
      ["readyForReview", ["review"]],
      ["working", ["limited", "working"]],
      ["landing", ["landing"]],
      ["idle", ["idle"]],
      ["done", ["wrapped"]],
    ]);
  });

  it("files a wrapped failed thread under Done, not Needs you", () => {
    expect(
      board([thread("failed", { statusLabel: "Failed", isDone: true, doneAt: ago(HOUR_MS) })]),
    ).toEqual([["done", ["failed"]]]);
  });

  it("keeps a wrapped child with an open pull request up for review or landing", () => {
    expect(
      board([
        thread("handed-back", {
          statusLabel: "Completed",
          isDone: true,
          doneAt: ago(HOUR_MS),
          pullRequests: [openPullRequest({ reviewReason: "Checks failing" })],
        }),
        thread("auto-merging", {
          isDone: true,
          doneAt: ago(HOUR_MS),
          pullRequests: [openPullRequest({ autoMergeEnabled: true })],
        }),
        // A draft is not up for review, so the wrap stands.
        thread("draft", {
          isDone: true,
          doneAt: ago(HOUR_MS),
          pullRequests: [openPullRequest({ isDraft: true })],
        }),
      ]),
    ).toEqual([
      ["readyForReview", ["handed-back"]],
      ["landing", ["auto-merging"]],
      ["done", ["draft"]],
    ]);
  });

  it("leaves a thread wrapped more than 7 days ago off the board", () => {
    expect(
      board([
        thread("last-week", { isDone: true, doneAt: ago(8 * DAY_MS) }),
        thread("yesterday", { isDone: true, doneAt: ago(DAY_MS) }),
      ]),
    ).toEqual([["done", ["yesterday"]]]);
  });

  it("puts a thread at work ahead of its pull request, and a merged one in Idle", () => {
    expect(
      board([
        thread("fixing", { statusLabel: "Working", pullRequests: [openPullRequest()] }),
        thread("merged", { pullRequests: [{ ...openPullRequest(), state: "merged" }] }),
      ]),
    ).toEqual([
      ["working", ["fixing"]],
      ["idle", ["merged"]],
    ]);
  });

  it("words a review row with the Pull requests page's reason", () => {
    const { groups } = deriveProjectBoard(
      [
        thread("changes", {
          pullRequests: [openPullRequest({ reviewReason: "Changes requested" })],
        }),
      ],
      NOW_MS,
    );
    expect(groups[0]?.rows[0]?.pullRequestWord).toBe("changes requested");
  });

  it("counts what the header names", () => {
    const { counts } = deriveProjectBoard(
      [
        thread("a", { statusLabel: "Awaiting Input" }),
        thread("b", { statusLabel: "Failed" }),
        thread("c", { statusLabel: "Working" }),
        thread("d", { pullRequests: [openPullRequest()] }),
      ],
      NOW_MS,
    );
    expect(formatProjectBoardCounts(counts)).toBe("2 need you · 1 to review · 1 working");
    expect(formatProjectBoardCounts({ needsYou: 0, readyForReview: 0, working: 0 })).toBe(
      "Nothing needs you",
    );
  });
});

describe("foldProjectBoardGroup", () => {
  it("folds a long group behind Show N more until it is expanded", () => {
    const rows = Array.from({ length: PROJECT_BOARD_GROUP_FOLD_AT + 3 }, (_, index) => index);
    expect(foldProjectBoardGroup(rows, false)).toEqual({
      shown: rows.slice(0, PROJECT_BOARD_GROUP_FOLD_AT),
      hiddenCount: 3,
    });
    expect(foldProjectBoardGroup(rows, true)).toEqual({ shown: rows, hiddenCount: 0 });
  });
});

import {
  EnvironmentId,
  type OrchestrationCheckBack,
  ProviderDriverKind,
  ThreadId,
} from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../types";
import {
  countStillGoingInReach,
  describeThreadMenu,
  describeThreadSelectionMenu,
  type ThreadMenuFacts,
} from "./threadMenu.logic";

const facts = (overrides: Partial<ThreadMenuFacts> = {}): ThreadMenuFacts => ({
  pinned: false,
  inbox: { isDone: false, canMarkDone: true },
  attachedChild: false,
  putBack: null,
  stillGoingCount: 0,
  moveOffered: false,
  running: false,
  ...overrides,
});

/** The menu as it reads: labels, with "--" where a group starts. */
const read = (items: ReturnType<typeof describeThreadMenu>) =>
  items.flatMap((item) => (item.separatorBefore ? ["--", item.label] : [item.label]));

describe("the thread menu", () => {
  it("groups the thread, its family, the move, copying, and filing it away", () => {
    expect(
      read(
        describeThreadMenu(
          facts({
            attachedChild: true,
            stillGoingCount: 2,
            moveOffered: true,
          }),
        ),
      ),
    ).toEqual([
      "Rename",
      "Pin",
      "Mark unread",
      "Wrap up",
      "--",
      "Make it its own thread",
      "Stop 2 working threads",
      "--",
      "Move to another computer",
      "--",
      "Copy path",
      "Copy thread ID",
      "--",
      "Archive",
      "Delete",
    ]);
  });

  it("offers Reopen for a wrapped thread, nothing of the inbox's outside it, and waits on a running one to archive", () => {
    expect(
      read(describeThreadMenu(facts({ inbox: { isDone: true, canMarkDone: false } }))),
    ).toContain("Reopen");
    // A general chat: the inbox doesn't list it, so neither Wrap up nor Reopen.
    const arranged = describeThreadMenu(
      facts({ customOrder: { canMoveUp: false, canMoveDown: true } }),
    );
    expect(read(arranged).slice(3, 7)).toEqual(["Wrap up", "--", "Move up", "Move down"]);
    expect(arranged.find((item) => item.id === "move-up")?.disabled).toBe(true);
    expect(arranged.find((item) => item.id === "move-down")?.disabled).toBe(false);
    expect(read(describeThreadMenu(facts()))).not.toContain("Move up");
    const chat = read(describeThreadMenu(facts({ inbox: null, pinned: true })));
    expect(chat).toContain("Unpin");
    expect(chat).not.toContain("Wrap up");
    expect(chat).not.toContain("Reopen");
    const running = describeThreadMenu(facts({ running: true }));
    expect(running.find((item) => item.id === "archive")?.disabled).toBe(true);
    // A parent that can't take it back says why, and can't be chosen.
    const refused = describeThreadMenu(
      facts({ putBack: { parentTitle: "Ship it", refusal: "It already has 4 threads." } }),
    ).find((item) => item.id === "attach");
    expect(refused).toMatchObject({
      label: "Put back under Ship it: it already has 4 threads",
      disabled: true,
    });
  });

  it("over several threads, pins (or unpins when all are) and wraps up together", () => {
    expect(
      describeThreadSelectionMenu({ count: 3, allPinned: false }).map((item) => item.label),
    ).toEqual(["Mark unread (3)", "Pin (3)", "Wrap up (3)", "Archive (3)", "Delete (3)"]);
    expect(describeThreadSelectionMenu({ count: 2, allPinned: true })[1]?.label).toBe("Unpin (2)");
  });
});

describe("what Stop N working threads counts", () => {
  const environmentId = EnvironmentId.make("environment-local");
  const NOW = "2026-11-23T12:00:00.000Z";
  const idleSession: NonNullable<SidebarThreadSummary["session"]> = {
    provider: ProviderDriverKind.make("claude"),
    status: "ready",
    orchestrationStatus: "ready",
    createdAt: "2026-11-23T10:00:00.000Z",
    updatedAt: "2026-11-23T10:00:00.000Z",
  };
  const savedJob: OrchestrationCheckBack = {
    id: "every-5m",
    participantId: null,
    scheduledFor: "2026-11-23T12:05:00.000Z",
    exact: false,
    recurring: true,
    durable: true,
  };
  const thread = (
    id: string,
    overrides: Partial<SidebarThreadSummary> = {},
  ): SidebarThreadSummary => ({
    id: ThreadId.make(id),
    environmentId,
    projectId: "project" as SidebarThreadSummary["projectId"],
    title: id,
    interactionMode: "default",
    session: idleSession,
    createdAt: "2026-11-23T10:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    doneOverride: null,
    lastSeenAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    effectiveCwd: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    cumulativeDiffStat: null,
    ...overrides,
  });
  const childOf = (parent: string, id: string, overrides: Partial<SidebarThreadSummary> = {}) =>
    thread(id, { parentThreadId: ThreadId.make(parent), attachedToParent: true, ...overrides });
  const looseOf = (parent: string, id: string, overrides: Partial<SidebarThreadSummary> = {}) =>
    thread(id, {
      parentThreadId: ThreadId.make(parent),
      attachedToParent: false,
      stopsWithParent: true,
      session: { ...idleSession, status: "running", orchestrationStatus: "running" },
      ...overrides,
    });
  const count = (threads: readonly SidebarThreadSummary[], root = "lead") =>
    countStillGoingInReach(threads, { environmentId, id: ThreadId.make(root) }, NOW);

  it("counts a child that only checks back, until its check-back goes dormant", () => {
    // Sequence 1: M answered and sits idle with a saved, recurring check-back.
    const before = [thread("lead"), childOf("lead", "m", { checkBacks: [savedJob] })];
    expect(count(before)).toBe(1);
    expect(read(describeThreadMenu(facts({ stillGoingCount: count(before) })))).toContain(
      "Stop 1 working thread",
    );
    // After the Stop its runtime ended, so the job is dormant: nothing to stop.
    const after = [
      thread("lead"),
      childOf("lead", "m", { checkBacks: [{ ...savedJob, dormant: true }] }),
    ];
    expect(count(after)).toBe(0);
    expect(read(describeThreadMenu(facts({ stillGoingCount: count(after) })))).not.toContain(
      "Stop 0 working threads",
    );
  });

  it("counts threads started without report back until the user writes in one", () => {
    // Sequence 3: five loose threads still at work; then the user made one theirs.
    const loose = ["a", "b", "c", "d", "e"].map((id) => looseOf("lead", id));
    expect(count([thread("lead"), ...loose])).toBe(5);
    const madeOwn = loose.map((child, index) => {
      if (index !== 0) return child;
      const { stopsWithParent: _written, ...own } = child;
      return own;
    });
    expect(count([thread("lead"), ...madeOwn])).toBe(4);
    // Another thread's loose threads, and the thread itself, are not its to stop.
    expect(
      count([
        thread("lead", { session: { ...idleSession, status: "running" } }),
        looseOf("other", "f"),
      ]),
    ).toBe(0);
  });

  it("reads a summary's own words for a starting turn, a queue and a message no turn took yet", () => {
    const children = [
      childOf("lead", "idle"),
      childOf("lead", "starting", { session: { ...idleSession, status: "connecting" } }),
      childOf("lead", "queued", { queuedFollowUpCount: 1 }),
      // Sent a minute ago and newer than its last turn: about to start.
      childOf("lead", "sent", { latestUserMessageAt: "2026-11-23T11:59:00.000Z" }),
      childOf("lead", "waiting", { awaitedChildThreadCount: 1 }),
    ];
    expect(count([thread("lead"), ...children])).toBe(4);
  });
});

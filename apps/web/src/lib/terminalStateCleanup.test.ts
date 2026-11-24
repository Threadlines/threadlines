import { scopedThreadKey, scopeThreadRef } from "@threadlines/client-runtime";
import { TERMINALS_PAGE_THREAD_ID, ThreadId } from "@threadlines/contracts";
import { describe, expect, it } from "vite-plus/test";

import { collectActiveTerminalThreadIds } from "./terminalStateCleanup";

const threadId = (id: string): ThreadId => ThreadId.make(id);
const threadKey = (environmentId: string, id: string): string =>
  scopedThreadKey(scopeThreadRef(environmentId as never, threadId(id)));

describe("collectActiveTerminalThreadIds", () => {
  it("retains non-deleted server threads", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [
        { key: threadKey("env-a", "server-1"), deletedAt: null, archivedAt: null },
        { key: threadKey("env-b", "server-2"), deletedAt: null, archivedAt: null },
      ],
      draftThreadKeys: [],
      environmentIds: [],
    });

    expect(activeThreadIds).toEqual(
      new Set([threadKey("env-a", "server-1"), threadKey("env-b", "server-2")]),
    );
  });

  it("ignores deleted and archived server threads and keeps local draft threads", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [
        { key: threadKey("env-a", "server-active"), deletedAt: null, archivedAt: null },
        {
          key: threadKey("env-a", "server-deleted"),
          deletedAt: "2026-03-05T08:00:00.000Z",
          archivedAt: null,
        },
        {
          key: threadKey("env-a", "server-archived"),
          deletedAt: null,
          archivedAt: "2026-03-05T09:00:00.000Z",
        },
      ],
      draftThreadKeys: [threadKey("env-a", "local-draft")],
      environmentIds: [],
    });

    expect(activeThreadIds).toEqual(
      new Set([threadKey("env-a", "server-active"), threadKey("env-a", "local-draft")]),
    );
  });

  it("does not keep draft-linked terminal state for archived server threads", () => {
    const archivedThreadId = threadKey("env-a", "server-archived");

    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [
        {
          key: archivedThreadId,
          deletedAt: null,
          archivedAt: "2026-03-05T09:00:00.000Z",
        },
      ],
      draftThreadKeys: [archivedThreadId, threadKey("env-a", "local-draft")],
      environmentIds: [],
    });

    expect(activeThreadIds).toEqual(new Set([threadKey("env-a", "local-draft")]));
  });

  it("keeps the Terminals page's tabs of every known computer, and no other's", () => {
    const activeThreadIds = collectActiveTerminalThreadIds({
      snapshotThreads: [],
      draftThreadKeys: [],
      environmentIds: ["env-a" as never],
    });

    expect(activeThreadIds.has(threadKey("env-a", TERMINALS_PAGE_THREAD_ID))).toBe(true);
    expect(activeThreadIds.has(threadKey("env-gone", TERMINALS_PAGE_THREAD_ID))).toBe(false);
  });
});

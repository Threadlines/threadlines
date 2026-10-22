import { describe, expect, it } from "vite-plus/test";

import {
  describeThreadMenu,
  describeThreadSelectionMenu,
  type ThreadMenuFacts,
} from "./threadMenu.logic";

const facts = (overrides: Partial<ThreadMenuFacts> = {}): ThreadMenuFacts => ({
  pinned: false,
  inbox: { isDone: false, canMarkDone: true },
  attachedChild: false,
  putBack: null,
  workingChildCount: 0,
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
            workingChildCount: 2,
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

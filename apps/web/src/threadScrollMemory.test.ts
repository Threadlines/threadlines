import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  THREAD_SCROLL_MEMORY_LIMIT,
  anchorFromListPlace,
  forgetThreadScroll,
  initialScrollForThread,
  readThreadScroll,
  rememberThreadScroll,
} from "./threadScrollMemory";

const used = new Set<string>();
const remember = (key: string, rowKey = "row-1", offsetPx = 40) => {
  used.add(key);
  rememberThreadScroll(key, { rowKey, offsetPx });
};

afterEach(() => {
  for (const key of used) forgetThreadScroll(key);
  used.clear();
});

describe("threadScrollMemory", () => {
  it("keeps the most recently left threads, dropping the one left longest ago", () => {
    for (let index = 0; index < THREAD_SCROLL_MEMORY_LIMIT; index += 1) {
      remember(`thread-${index}`);
    }
    // Left again, thread-0 is now the newest.
    remember("thread-0");
    remember("thread-new");

    expect(readThreadScroll("thread-0")).not.toBeNull();
    expect(readThreadScroll("thread-1")).toBeNull();
    expect(readThreadScroll("thread-new")).not.toBeNull();
  });

  it("forgets a chat left at its end", () => {
    remember("thread-a");
    const place = { firstRowKey: "row-9", viewTopBelowRowTop: 12 };
    rememberThreadScroll("thread-a", anchorFromListPlace({ ...place, isAtEnd: true }));
    expect(readThreadScroll("thread-a")).toBeNull();

    rememberThreadScroll("thread-a", anchorFromListPlace({ ...place, isAtEnd: false }));
    expect(readThreadScroll("thread-a")).toEqual({ rowKey: "row-9", offsetPx: 12 });
  });

  it("opens at the remembered row, or at the end when there is news or the row is gone", () => {
    const indexOfRowKey = (rowKey: string) => ["row-0", "row-1", "row-2"].indexOf(rowKey);

    remember("thread-a", "row-2", 30);
    expect(
      initialScrollForThread({ threadKey: "thread-a", hasNews: false, indexOfRowKey }),
    ).toEqual({ kind: "anchor", index: 2, offsetPx: 30 });

    expect(initialScrollForThread({ threadKey: "thread-a", hasNews: true, indexOfRowKey })).toEqual(
      { kind: "end" },
    );
    expect(readThreadScroll("thread-a")).toBeNull();

    remember("thread-b", "row-reverted");
    expect(
      initialScrollForThread({ threadKey: "thread-b", hasNews: false, indexOfRowKey }),
    ).toEqual({ kind: "end" });
    expect(readThreadScroll("thread-b")).toBeNull();
  });
});

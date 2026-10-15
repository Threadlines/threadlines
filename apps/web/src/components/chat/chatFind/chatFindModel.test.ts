import { describe, expect, it } from "vite-plus/test";

import {
  carryChatFindMatch,
  type ChatFindRow,
  chatFindMatchNumber,
  createChatFindPattern,
  searchChatFindRows,
  stepChatFindMatch,
} from "./chatFindModel";

const pattern = (query: string) => createChatFindPattern(query)!;

const rows: ChatFindRow[] = [
  { id: "a", blocks: ["one cat", "no match here", "cat and cat"] },
  { id: "b", blocks: ["nothing"] },
  { id: "c", blocks: ["a last Cat"] },
];

describe("createChatFindPattern", () => {
  it("matches the words as a phrase, any case, across any whitespace", () => {
    const found = searchChatFindRows(
      [{ id: "x", blocks: ["Hello\n  World, hello world"] }],
      pattern("hello world"),
    );
    expect(found.total).toBe(2);
    expect(createChatFindPattern("   ")).toBeNull();
  });

  it("finds punctuation literally", () => {
    const found = searchChatFindRows([{ id: "x", blocks: ["a.b a*b (a+b)"] }], pattern("(a+b)"));
    expect(found.total).toBe(1);
  });
});

describe("stepping through matches", () => {
  const result = searchChatFindRows(rows, pattern("cat"));

  it("walks every match in reading order and wraps at both ends", () => {
    const seen: string[] = [];
    let match = stepChatFindMatch(result, null, 1);
    for (let index = 0; index < 5; index += 1) {
      seen.push(`${match!.rowId}:${match!.blockIndex}:${match!.occurrence}`);
      match = stepChatFindMatch(result, match, 1);
    }
    expect(seen).toEqual(["a:0:0", "a:2:0", "a:2:1", "c:0:0", "a:0:0"]);
    expect(stepChatFindMatch(result, { rowId: "a", blockIndex: 0, occurrence: 0 }, -1)).toEqual({
      rowId: "c",
      blockIndex: 0,
      occurrence: 0,
    });
  });

  it("numbers a match by its place in the whole chat", () => {
    expect(result.total).toBe(4);
    expect(chatFindMatchNumber(result, { rowId: "a", blockIndex: 2, occurrence: 1 })).toBe(3);
    expect(chatFindMatchNumber(result, { rowId: "c", blockIndex: 0, occurrence: 0 })).toBe(4);
  });
});

describe("carrying the current match through new results", () => {
  const order = ["a", "b", "c"];

  it("keeps the same words current while matches above it come and go", () => {
    const previous = searchChatFindRows(rows, pattern("cat"));
    const current = { rowId: "c", blockIndex: 0, occurrence: 0 };
    const grown = searchChatFindRows(
      [{ id: "a", blocks: ["cat cat cat cat"] }, ...rows.slice(1)],
      pattern("cat"),
    );
    const carried = carryChatFindMatch({ previous, next: grown, current, rowOrder: order });
    expect(carried).toEqual(current);
    expect(chatFindMatchNumber(grown, carried)).toBe(5);
  });

  it("moves to the next match after the old place when its row goes", () => {
    const previous = searchChatFindRows(rows, pattern("cat"));
    const current = { rowId: "a", blockIndex: 2, occurrence: 1 };
    const withoutA = searchChatFindRows(rows.slice(1), pattern("cat"));
    expect(carryChatFindMatch({ previous, next: withoutA, current, rowOrder: ["b", "c"] })).toEqual(
      { rowId: "c", blockIndex: 0, occurrence: 0 },
    );
  });

  it("moves to the next match in the same row when its own words go", () => {
    const previous = searchChatFindRows(rows, pattern("cat"));
    const current = { rowId: "a", blockIndex: 2, occurrence: 1 };
    const shrunk = searchChatFindRows(
      [{ id: "a", blocks: ["one cat", "no match here", "cat and dog"] }, ...rows.slice(1)],
      pattern("cat"),
    );
    expect(carryChatFindMatch({ previous, next: shrunk, current, rowOrder: order })).toEqual({
      rowId: "c",
      blockIndex: 0,
      occurrence: 0,
    });
  });
});

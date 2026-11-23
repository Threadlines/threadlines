import { describe, expect, it } from "vite-plus/test";

import { moveAmongPeers } from "./projectPickerOrder";

describe("moveAmongPeers", () => {
  it("rearranges only the shown rows, so a row a search hid keeps its slot", () => {
    // "hidden" is searched out; B moves above A among the two still shown.
    expect(moveAmongPeers(["A", "hidden", "B"], ["A", "B"], 1, 0)).toEqual(["B", "hidden", "A"]);
  });
});

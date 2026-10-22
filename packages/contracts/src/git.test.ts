import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { VcsApplyStashInput } from "./git.ts";
const decodeApplyStashInput = Schema.decodeUnknownSync(VcsApplyStashInput);

describe("VcsStash", () => {
  it("binds stash mutations to an exact selector and full object id", () => {
    const parsed = decodeApplyStashInput({
      cwd: "/repo",
      selector: "stash@{2}",
      expectedStashId: "0123456789abcdef0123456789abcdef01234567",
      dropAfterApply: true,
    });

    expect(parsed.selector).toBe("stash@{2}");
    expect(parsed.dropAfterApply).toBe(true);
    expect(() =>
      decodeApplyStashInput({
        cwd: "/repo",
        selector: "stash@{2}",
        expectedStashId: "0123456",
        dropAfterApply: true,
      }),
    ).toThrow();
  });
});

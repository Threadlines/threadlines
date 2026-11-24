import { describe, expect, it } from "vite-plus/test";

import { estimatePartialFileChangeStat } from "./claudePartialToolInput.ts";

describe("estimatePartialFileChangeStat", () => {
  it("returns null for non-file tools and until the path has fully streamed", () => {
    expect(estimatePartialFileChangeStat("Bash", '{"command":"ls"}')).toBeNull();
    expect(estimatePartialFileChangeStat("Edit", '{"file_path":"/tmp/a.')).toBeNull();
  });

  it("estimates an appending edit as pure additions once the copied prefix streams through", () => {
    // old_string complete; new_string starts with the same two lines, then
    // keeps streaming new material (unterminated value).
    const buffer =
      '{"file_path":"/tmp/a.ts","old_string":"line1\\nline2","new_string":"line1\\nline2\\nline3\\nline4';
    const estimate = estimatePartialFileChangeStat("Edit", buffer);
    expect(estimate?.stat).toEqual({
      path: "/tmp/a.ts",
      kind: "update",
      additions: 2,
      deletions: 0,
    });
    expect(estimate?.input).toEqual({ file_path: "/tmp/a.ts" });
  });

  it("counts the old side as deletions while the replacement has not streamed yet", () => {
    const buffer = '{"file_path":"/tmp/a.ts","old_string":"a\\nb\\nc';
    const estimate = estimatePartialFileChangeStat("Edit", buffer);
    expect(estimate?.stat.additions).toBe(0);
    expect(estimate?.stat.deletions).toBe(3);
  });

  it("trims the common suffix once both sides of a pair are complete", () => {
    const buffer = '{"file_path":"/tmp/a.ts","old_string":"a\\nb\\nc","new_string":"a\\nX\\nc"}';
    const estimate = estimatePartialFileChangeStat("Edit", buffer);
    expect(estimate?.stat.additions).toBe(1);
    expect(estimate?.stat.deletions).toBe(1);
  });

  it("pairs MultiEdit old/new values by occurrence order", () => {
    const buffer =
      '{"file_path":"/tmp/a.ts","edits":[{"old_string":"x","new_string":"y"},{"old_string":"p\\nq","new_string":"p';
    const estimate = estimatePartialFileChangeStat("MultiEdit", buffer);
    expect(estimate?.stat.additions).toBe(1);
    expect(estimate?.stat.deletions).toBe(2);
  });

  it("counts streamed Write content as additions", () => {
    const buffer = '{"file_path":"/tmp/new.ts","content":"l1\\nl2\\nl3';
    const estimate = estimatePartialFileChangeStat("Write", buffer);
    expect(estimate?.stat.additions).toBe(3);
    expect(estimate?.stat.deletions).toBe(0);
  });

  it("decodes JSON escapes when comparing lines", () => {
    // a is "a": the escaped old line must match the plain new line so
    // the prefix trim sees them as identical.
    const buffer =
      '{"file_path":"/tmp/a.ts","old_string":"\\u0061\\n\\"quoted\\"","new_string":"a\\n\\"quoted\\"\\nadded"}';
    const estimate = estimatePartialFileChangeStat("Edit", buffer);
    expect(estimate?.stat.additions).toBe(1);
    expect(estimate?.stat.deletions).toBe(0);
  });

  it("handles dangling escapes and many escaped newlines cleanly", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `const x${index} = "v${index}";`);
    const escaped = lines.map((line) => line.replaceAll('"', '\\"')).join("\\n");
    const buffer = `{"file_path":"/tmp/many.ts","content":"${escaped}\\`;
    const estimate = estimatePartialFileChangeStat("Write", buffer);
    expect(estimate?.stat).toEqual({
      path: "/tmp/many.ts",
      kind: "update",
      additions: 50,
      deletions: 0,
    });
  });

  it("handles large escape-free MultiEdit inputs in linear time", () => {
    const count = 4_000;
    const edits = Array.from(
      { length: count },
      (_, index) => `{"old_string":"old_${index}","new_string":"new_${index}"}`,
    ).join(",");
    const buffer = `{"file_path":"/tmp/big.ts","edits":[${edits}`;
    const estimate = estimatePartialFileChangeStat("MultiEdit", buffer);
    expect(estimate?.stat).toEqual({
      path: "/tmp/big.ts",
      kind: "update",
      additions: count,
      deletions: count,
    });
  });
});

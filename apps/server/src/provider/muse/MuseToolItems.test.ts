import { describe, expect, it } from "vite-plus/test";

import type { MuseItem } from "./MuseProtocol.ts";
import {
  identifyMuseTool,
  museCommandOutput,
  museFileChanges,
  museToolData,
  museToolFailed,
} from "./MuseToolItems.ts";

const ROOT = "/work/project";

const edit = (fields: Partial<MuseItem>): MuseItem => ({
  itemId: "item-1",
  kind: "toolCall",
  revision: 2,
  status: "completed",
  ...fields,
});

describe("museFileChanges", () => {
  it("counts each file of an apply_patch body exactly, relative to the workspace", () => {
    const patch = [
      "*** Begin Patch",
      `*** Update File: ${ROOT}/src/a.ts`,
      "@@",
      "-old",
      "+new",
      "+more",
      "*** Add File: src/b.ts",
      "+hello",
      "*** End Patch",
    ].join("\n");
    expect(
      museFileChanges({
        item: edit({ tool: "apply_patch", args: JSON.stringify({ input: patch }) }),
        root: ROOT,
      }),
    ).toEqual([
      { path: "src/a.ts", kind: "update", additions: 2, deletions: 1 },
      { path: "src/b.ts", kind: "add", additions: 1, deletions: 0 },
    ]);
  });

  it("prefers the stored patch, and takes Muse's counts only for a one-file edit", () => {
    const stored = JSON.stringify({
      files: [
        { path: `${ROOT}/src/c.ts`, status: "modified", hunks: [{ lines: [" a", "-b", "+c"] }] },
      ],
    });
    expect(
      museFileChanges({ item: edit({ tool: "edit_file" }), root: ROOT, storedPatch: stored }),
    ).toEqual([{ path: "src/c.ts", kind: "update", additions: 1, deletions: 1 }]);

    const args = JSON.stringify({ path: "src/d.ts", old_string: "x", new_string: "y" });
    expect(
      museFileChanges({
        item: edit({ tool: "edit_file", args, patchSummary: { files: 1, added: 3, removed: 2 } }),
        root: ROOT,
      }),
    ).toEqual([{ path: "src/d.ts", kind: "update", additions: 3, deletions: 2 }]);
    // Totals over several files say nothing exact about this one.
    expect(
      museFileChanges({
        item: edit({ tool: "edit_file", args, patchSummary: { files: 2, added: 3, removed: 2 } }),
        root: ROOT,
      }),
    ).toEqual([{ path: "src/d.ts", kind: "update" }]);
  });
});

describe("shell runs", () => {
  it("reads a finished run's output and exit code from Muse's run record", () => {
    // The shape Muse 1.4.9 sends when a `bash` call completes.
    const run = edit({
      tool: "bash",
      args: JSON.stringify({ command: "node tip.test.js", description: "Run tests" }),
      visibleOutput: JSON.stringify({
        chunk_id: "exec-2-1",
        command: "node tip.test.js",
        exit_code: 1,
        terminal_status: "completed",
        output: "AssertionError: 1500 !== 15\n",
        truncated: false,
      }),
    });
    const identity = identifyMuseTool(run);

    expect(museCommandOutput(run)).toBe("AssertionError: 1500 !== 15\n");
    expect(museToolFailed(run, identity)).toBe(true);
    expect(museToolData({ item: run, identity, root: ROOT }).item).toMatchObject({
      exitCode: 1,
      status: "failed",
    });
    // Streamed text while it runs is shown as it is.
    const running = { ...run, status: "inProgress" as const, visibleOutput: "AssertionError" };
    expect(museCommandOutput(running)).toBe("AssertionError");
    expect(museToolFailed(running, identity)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import type { WorkLogEntry } from "../../session-logic";
import {
  activityStepFromTranscriptTool,
  activityStepFromWorkLogEntry,
  liveActivityLabel,
  newestThoughtSentence,
  partitionActivitySteps,
  plainAgentStep,
  summarizeRoutineSteps,
} from "./activitySteps";
import { describeAgentLabel } from "./activityWording";
import { analyzeShellCommand } from "./shellCommands";

function entry(overrides: Partial<WorkLogEntry>): WorkLogEntry {
  return {
    id: overrides.id ?? `entry-${Math.random()}`,
    createdAt: "2026-09-24T02:50:00.000Z",
    label: "Tool call",
    tone: "tool",
    executionState: "completed",
    ...overrides,
  };
}

function command(
  commandText: string,
  overrides: Partial<WorkLogEntry> = {},
): ReturnType<typeof activityStepFromWorkLogEntry> {
  return activityStepFromWorkLogEntry(
    entry({
      label: "Ran command",
      itemType: "command_execution",
      command: commandText,
      ...overrides,
    }),
  );
}

describe("shell commands", () => {
  it("folds a read-only lookup under the label the agent wrote", () => {
    const step = command(
      "cd /c/repo && gh pr view 292 --json number,headRefName && gh pr view 291 --json number",
      { description: "Check both PRs' branches on GitHub" },
    );

    expect(step).toMatchObject({
      routine: true,
      label: "Checked both PRs' branches on GitHub",
      liveLabel: "Checking both PRs' branches on GitHub",
      tallies: [{ tally: "github" }, { tally: "github" }],
    });
  });

  it("reads Codex's unlabeled PowerShell batches statement by statement", () => {
    const step = command(
      "git status --short; Get-Content package.json; rg --files -g AGENTS.md | Select-Object -First 20",
    );

    expect(step).toMatchObject({
      routine: true,
      label: "Checked git status, read package.json, and 1 more step",
    });
    expect(step?.tallies.map((mark) => mark.tally)).toEqual(["git", "read", "list"]);
  });

  it("gives commands that change something a line of their own", () => {
    expect(
      command('git add -A && git commit -m "fix(web): stale PR status" && git push origin fix/pr')
        ?.label,
    ).toBe("Pushed fix/pr and 2 more steps");
    expect(command("gh pr merge 292 --squash")).toMatchObject({
      routine: false,
      label: "Merged PR #292",
    });
    expect(command("pnpm install --frozen-lockfile")?.label).toBe("Installed dependencies");
    expect(command("node C:/Temp/pr-probe/count-prs.mjs")?.label).toBe("Ran count-prs.mjs");
    expect(command("sed -i 's/a/b/' src/app.ts")?.label).toBe("Edited app.ts");
  });

  it("treats setup statements and harmless redirects as looking around", () => {
    const step = command(
      '$env:PATH = "C:\\node24;$env:PATH"; cd apps/web; rg -n "useQuery" src 2>&1',
    );

    expect(step).toMatchObject({ routine: true, label: "Searched for useQuery" });
    expect(command("rg -n TODO src > todos.txt")?.routine).toBe(false);
  });

  it("reports a check by its result, with the failing test on the second line", () => {
    const failed = command(
      "pnpm exec vp run --cache '@threadlines/server#test' PullRequestAutomationWatcher",
      {
        executionState: "failed",
        description: "Run the PR watcher tests",
        outputPreview: [
          "FAIL  src/orchestration/PullRequestAutomationWatcher.test.ts > refreshes status after a server-side merge",
          "AssertionError: expected 'open' to be 'merged'",
          " Test Files  1 failed (1)",
          "      Tests  1 failed | 11 passed (12)",
        ].join("\n"),
      },
    );

    expect(failed).toMatchObject({
      routine: false,
      tone: "fail",
      label: "1 of 12 tests failed",
      liveLabel: "Running the PR watcher tests",
      note: "refreshes status after a server-side merge: expected 'open' to be 'merged'",
    });

    const passed = command("pnpm exec vp run typecheck && pnpm exec vp lint", {
      outputPreview: "Found 0 warnings and 0 errors.",
    });
    expect(passed).toMatchObject({ tone: "pass", label: "Typecheck and lint passed" });
  });

  it("never words a failed step as if it worked", () => {
    expect(
      command('Remove-Item "C:\\repo\\scratch.md"', { executionState: "failed" }),
    ).toMatchObject({
      tone: "fail",
      label: "Couldn't delete scratch.md",
    });
    expect(
      command("gh pr view 292", {
        executionState: "failed",
        description: "Check both PRs' branches on GitHub",
      })?.label,
    ).toBe("Couldn't check both PRs' branches on GitHub");
    // rg exits non-zero when nothing matches: an answer, not a failure.
    expect(command("rg -n useQuery src", { executionState: "failed" })?.label).toBe(
      "Searched for useQuery (no matches)",
    );
  });

  it("recognizes a rerun of the same check", () => {
    const first = command("pnpm exec vp run typecheck", { executionState: "failed" });
    const rerun = command("cd apps/web && pnpm exec vp run typecheck");
    const other = command("pnpm exec vp run --cache '@threadlines/web#test'");

    expect(first?.checkKey).toBe(rerun?.checkKey);
    expect(other?.checkKey).not.toBe(first?.checkKey);
  });

  it("counts typecheck errors from tsc output", () => {
    const step = command("npx tsc --noEmit", {
      executionState: "failed",
      outputPreview:
        "src/a.ts(3,1): error TS2322: Type 'string' is not assignable.\nFound 3 errors in 2 files.",
    });

    expect(step).toMatchObject({ label: "Typecheck found 3 errors" });
    expect(step?.note).toContain("error TS2322");
  });

  it("recognizes test runs started through a script runner", () => {
    expect(analyzeShellCommand("pnpm exec tsx --test scripts/pdf-stamps.test.ts").checks).toEqual([
      "test",
    ]);
    expect(analyzeShellCommand("python -m pytest tests").checks).toEqual(["test"]);
  });
});

describe("agent labels", () => {
  it("turns the lead verb when nothing else in the label needs it", () => {
    expect(describeAgentLabel("Rerun the shot with the Pull request tab")).toEqual({
      past: "Reran the shot with the Pull request tab",
      live: "Rerunning the shot with the Pull request tab",
    });
    expect(describeAgentLabel("Confirm #279 merged and none remain open").past).toBe(
      "Confirmed #279 merged and none remain open",
    );
  });

  it("keeps labels that join a second verb exactly as written", () => {
    for (const label of [
      "Push the branch and open the pull request",
      "Verify the branch, update the PR description, check auto-merge",
      "Read s3-manager client setup; check upload headers",
      "Update the memory index and return the checkout to main",
    ]) {
      expect(describeAgentLabel(label)).toEqual({ past: label, live: label });
    }
  });
});

describe("other steps", () => {
  it("words reads, searches and edits the way a person would", () => {
    const read = activityStepFromWorkLogEntry(
      entry({
        itemType: "dynamic_tool_call",
        toolTitle: "Read file",
        detail: "C:/repo/apps/web/src/ChatWebLink.tsx",
      }),
    );
    const search = activityStepFromWorkLogEntry(
      entry({
        itemType: "dynamic_tool_call",
        toolTitle: "Search",
        detail:
          "export function resolveThreadPullRequest|export interface ThreadPullRequest in apps/web/src",
      }),
    );
    const edit = activityStepFromWorkLogEntry(
      entry({
        itemType: "file_change",
        changedFiles: ["apps/server/src/Watcher.ts"],
        changedFileStats: [{ path: "apps/server/src/Watcher.ts", additions: 31, deletions: 8 }],
      }),
    );

    expect(read).toMatchObject({
      routine: true,
      label: "Read ChatWebLink.tsx",
      liveLabel: "Reading ChatWebLink.tsx",
    });
    expect(search).toMatchObject({
      routine: true,
      label: "Searched for resolveThreadPullRequest and 1 more",
    });
    expect(edit).toMatchObject({
      routine: false,
      label: "Edited Watcher.ts",
      diff: { additions: 31, deletions: 8 },
    });
  });

  it("keeps an edit that did not apply out of the reader's way", () => {
    const step = activityStepFromWorkLogEntry(
      entry({ itemType: "file_change", executionState: "failed", changedFiles: ["src/a.ts"] }),
    );

    expect(step).toMatchObject({ routine: true, label: "Couldn't edit a.ts", tallies: [] });
  });

  it("words a tool call that failed as a failure", () => {
    const step = activityStepFromWorkLogEntry(
      entry({
        itemType: "mcp_tool_call",
        executionState: "failed",
        detail: "github · create_issue: title=Crash on save",
      }),
    );

    expect(step).toMatchObject({
      routine: false,
      tone: "fail",
      label: "Couldn't use Github: create issue",
    });
  });

  it("folds approved auto-reviews and surfaces denied ones", () => {
    const approved = activityStepFromWorkLogEntry(
      entry({ label: "Auto-approved command", tone: "info", activityKind: "task.completed" }),
    );
    const denied = activityStepFromWorkLogEntry(
      entry({
        label: "Auto-review denied mcpToolCall",
        tone: "info",
        activityKind: "task.completed",
      }),
    );

    expect(approved).toMatchObject({ routine: true, tallies: [] });
    expect(denied).toMatchObject({
      routine: false,
      tone: "warning",
      label: "Auto-review blocked a step",
    });
  });

  it("stays quiet about progress chatter the live line already covers", () => {
    expect(
      activityStepFromWorkLogEntry(
        entry({ label: "Reasoning update", tone: "thinking", activityKind: "task.progress" }),
      ),
    ).toBeNull();
    expect(
      activityStepFromWorkLogEntry(
        entry({ label: "Thinking", tone: "thinking", redactedThinking: true }),
      ),
    ).toBeNull();
  });
});

describe("groups", () => {
  it("sums up the looking around in one sentence", () => {
    const steps = [
      command("cat apps/a.ts"),
      command("rg foo src"),
      command("Get-Content apps/b.ts"),
      command("rg bar src"),
      command("gh pr view 12"),
      command("cat apps/a.ts"),
    ].filter((step) => step !== null);

    expect(summarizeRoutineSteps(steps)).toBe("Read 2 files, searched twice, and checked GitHub");
    expect(summarizeRoutineSteps(steps.slice(0, 1))).toBe("Read a.ts");
  });

  it("splits a group into the summary and the lines worth noticing, leaving running steps to the live line", () => {
    const steps = [
      command("cat a.ts"),
      command("pnpm install"),
      command("rg foo src", { executionState: "running" }),
    ].filter((step) => step !== null);
    const { routine, notable } = partitionActivitySteps(steps);

    expect(routine.map((step) => step.label)).toEqual(["Read a.ts"]);
    expect(notable.map((step) => step.label)).toEqual(["Installed dependencies"]);
    expect(liveActivityLabel(steps)).toBe("Searching for foo");
  });

  it("says how many files are being read at once", () => {
    const steps = ["a.ts", "b.ts", "c.ts"].map((file) =>
      activityStepFromWorkLogEntry(
        entry({
          itemType: "dynamic_tool_call",
          toolTitle: "Read file",
          detail: file,
          executionState: "running",
        }),
      ),
    );

    expect(liveActivityLabel(steps.filter((step) => step !== null))).toBe("Reading 3 files");
  });

  it("keeps a live thought to its newest sentence, without dropping to a word or two", () => {
    const thought =
      "The logs only span about 21 minutes since they rotate quickly. Converting the UTC timestamp to local time shows the server restarted.";

    expect(newestThoughtSentence(thought)).toBe(
      "Converting the UTC timestamp to local time shows the server restarted.",
    );
    // A sentence that has barely started keeps the one before it.
    expect(newestThoughtSentence("Reading service.ts closely. So the")).toBe(
      "Reading service.ts closely. So the",
    );
  });
});

describe("agent transcripts", () => {
  it("words an agent's stored tool calls like the conversation's", () => {
    expect(
      activityStepFromTranscriptTool({
        id: "1",
        name: "Bash",
        summary: "git status",
        description: "Check git status",
      }),
    ).toMatchObject({ routine: true, label: "Checked git status" });
    expect(
      activityStepFromTranscriptTool({ id: "2", name: "Edit", summary: "src/game/van.ts" }),
    ).toMatchObject({
      routine: false,
      label: "Edited van.ts",
    });
    expect(
      activityStepFromTranscriptTool({
        id: "3",
        name: "mcp__threadlines_browser__browser_screenshot",
        summary: "",
      }),
    ).toMatchObject({ routine: true, label: "Took a screenshot", tallies: [{ tally: "browser" }] });
  });

  it("keeps a call's result one click away and words a failed call as a failure", () => {
    const read = activityStepFromTranscriptTool({
      id: "1",
      name: "Read",
      summary: "Read: src/router.tsx",
      output: "export const routes = []",
    });
    const missing = activityStepFromTranscriptTool({
      id: "2",
      name: "Read",
      summary: "src/gone.ts",
      output: "<tool_use_error>File does not exist.</tool_use_error>",
      failed: true,
    });
    const issue = activityStepFromTranscriptTool({
      id: "3",
      name: "mcp__github__create_issue",
      summary: "",
      output: "<tool_use_error>Bad credentials</tool_use_error>",
      failed: true,
    });

    expect(read).toMatchObject({
      label: "Read router.tsx",
      detail: { output: "export const routes = []" },
    });
    expect(missing).toMatchObject({ routine: true, label: "Couldn't read gone.ts" });
    expect(issue).toMatchObject({
      tone: "fail",
      label: "Couldn't use Github: create issue",
      note: "Bad credentials",
    });
  });

  it("shortens an agent's reported step to the words the conversation uses", () => {
    expect(plainAgentStep("Editing src\\game\\hq\\paint\\workVan.ts")).toBe("Editing workVan.ts");
    expect(plainAgentStep("Running Render all three tiers at phone size")).toBe(
      "Rendering all three tiers at phone size",
    );
    expect(plainAgentStep("Running Recheck and re-time after switching to rectangles")).toBe(
      "Recheck and re-time after switching to rectangles",
    );
    expect(plainAgentStep("Running Check the van tests")).toBe("Checking the van tests");
    // A task's own label reads in the present while it runs. A verb whose past
    // looks the same, or one we do not know, stays as written.
    expect(plainAgentStep("Run the timing script once with debug output")).toBe(
      "Running the timing script once with debug output",
    );
    expect(plainAgentStep("Read the config")).toBe("Read the config");
    expect(plainAgentStep("Repaint building exterior art")).toBe("Repaint building exterior art");
  });
});
